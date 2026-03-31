# Undo/Redo & History View — Implementation Plan

## Overview

Three features, built as parallel work packages:

1. **Rust reverse-op engine** — compute inverse ops from the op log
2. **Rust Tauri commands** — `list_page_history`, `revert_ops`, `undo_page_op`, `redo_page_op`
3. **Frontend History View** — new sidebar view with multi-select, filters, batch revert
4. **Frontend undo/redo store + keyboard shortcuts** — Ctrl+Z / Ctrl+Y per-page

---

## Undo/Redo Model Specification

### Core Invariant

Undo = append a reverse op to the log. Never mutate or delete existing ops.

### Keyboard Behavior

| Context | Ctrl+Z | Ctrl+Y |
|---------|--------|--------|
| TipTap editor focused | TipTap undo (no change) | TipTap redo (no change) |
| Editor NOT focused, on a page | Op-level undo: reverse most recent undoable op on this page | Op-level redo: re-apply most recently undone op |
| No page open (sidebar view) | No-op | No-op |

### Undo/Redo Stack Semantics

Session-scoped, per-page. In-memory only (reset on page navigation or app restart).

**State:**
```
undoableOps: OpRef[]   // page ops from op log, newest first, loaded lazily
undoPointer: number    // index into undoableOps; starts at 0 (most recent)
redoStack: OpRef[]     // ops that were undone, available for redo
```

**Ctrl+Z (undo):**
1. Find the op at `undoableOps[undoPointer]`, skipping any ops that are themselves undo/redo-generated.
2. Call backend `undo_page_op(page_id, device_id, seq)`.
3. Backend computes reverse payload, appends reverse op to log, applies to blocks table.
4. Frontend pushes the undone op ref onto `redoStack`.
5. Advance `undoPointer` to next older op.
6. If `undoPointer` reaches end of loaded batch, fetch next page from backend.

**Ctrl+Y (redo):**
1. Pop from `redoStack`.
2. Call backend `redo_page_op(page_id, original_device_id, original_seq)`.
3. Backend computes the re-apply op (reverse of the reverse), appends to log.
4. Frontend moves pointer back.

**New user action (any mutation on this page):**
- Clear `redoStack` entirely (standard behavior — new action invalidates redo history).
- The new op becomes the most recent in `undoableOps`.

### Identifying Undo/Redo Ops

The backend marks reverse ops with a metadata convention: the payload includes an `_undo_ref` field
containing the `(device_id, seq)` of the op being reversed. This field is:
- Included in the canonical JSON for hashing (it's part of the payload).
- Used by the frontend to skip undo-generated ops when walking the undo stack.
- Used by the History View to show "reverted by" links.

For redo ops, the payload includes `_redo_ref` pointing to the undo op being reversed.

---

## Reverse Op Mapping

| Original Op | Reverse Op | Prior State Lookup Required |
|------------|-----------|---------------------------|
| `create_block` | `delete_block(block_id)` | No |
| `delete_block` | `restore_block(block_id, deleted_at)` | Yes — read `blocks.deleted_at` |
| `edit_block` | `edit_block(block_id, prior_to_text)` | Yes — walk `prev_edit` chain to find prior `to_text` |
| `move_block` | `move_block(block_id, old_parent, old_pos)` | Yes — find previous move/create op for this block |
| `add_tag` | `remove_tag(block_id, tag_id)` | No |
| `remove_tag` | `add_tag(block_id, tag_id)` | No |
| `set_property` | `set_property(old_value)` or `delete_property` | Yes — find previous set_property or absence |
| `delete_property` | `set_property(block_id, key, prior_value)` | Yes — find previous set_property |
| `add_attachment` | `delete_attachment(attachment_id)` | No |
| `delete_attachment` | **Non-reversible** (file may be gone) | N/A |
| `restore_block` | `delete_block(block_id)` | No |
| `purge_block` | **Non-reversible** (data destroyed) | N/A |

Non-reversible ops: the backend returns an error, the frontend shows them as non-selectable
in the History View with a lock icon.

### Prior State Lookup Strategy

All lookups are single indexed queries against the op log:

**edit_block:** Query op_log for the most recent `edit_block` or `create_block` for this `block_id`
that precedes the op being reversed. Return its `to_text` (or `content` for create_block).

**move_block:** Query op_log for the most recent `move_block` or `create_block` for this `block_id`
that precedes the target op. Return `(parent_id, position)`.

**set_property / delete_property:** Query op_log for the most recent `set_property` for this
`(block_id, key)` that precedes the target op. If none found, the reverse of `set_property` is
`delete_property`; the reverse of `delete_property` is an error (no prior value to restore).

---

## Work Packages (Parallel Subagents)

### Package A: Rust — Reverse Op Engine + Unit Tests

**Worktree:** `worktrees/pkg-a-reverse-engine`

**Files to create:**
- `src-tauri/src/reverse.rs` — the reverse op computation module

**Files to modify:**
- `src-tauri/src/lib.rs` — add `mod reverse;`

**Scope:**
```rust
/// Given an op's (device_id, seq), query the op log for prior state and return
/// the reverse OpPayload. Returns Err for non-reversible ops (purge, delete_attachment).
pub async fn compute_reverse(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
) -> Result<OpPayload, AppError>
```

Handles all 12 op types. For types requiring prior state, queries the op log within the same
read transaction.

**Tests:** (in `#[cfg(test)] mod tests` inside `reverse.rs`)
- Happy path for each of the 10 reversible op types
- Error path for `purge_block` and `delete_attachment`
- Edge case: reverse `edit_block` when it's the first edit (prior state = `create_block.content`)
- Edge case: reverse `set_property` when no prior value exists (= delete_property)
- Edge case: reverse `delete_block` produces `restore_block` with correct `deleted_at_ref`
- Edge case: reverse `move_block` when prior state is from `create_block`

**Verification:** `cd src-tauri && cargo test reverse`

**Does NOT touch:** commands.rs, tauri.ts, any frontend files, materializer.rs

---

### Package B: Rust — New Tauri Commands + Bindings

**Worktree:** `worktrees/pkg-b-commands`

**Depends on:** Package A (needs `reverse.rs` — copy it into worktree after A completes,
or merge A's branch first).

**Files to modify:**
- `src-tauri/src/commands.rs` — add 4 new command functions
- `src-tauri/src/lib.rs` — register commands in `tauri::Builder`
- `src-tauri/src/pagination.rs` — add `list_page_history` query (recursive CTE for page descendants)
- `src-tauri/src/op.rs` — add `_undo_ref` / `_redo_ref` optional fields to relevant payloads

**New Tauri Commands:**

```rust
/// List all ops for blocks descended from a page. Cursor-paginated, newest first.
/// Optional op_type filter.
#[tauri::command]
#[specta::specta]
async fn list_page_history(
    page_id: String,
    op_type_filter: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError>

/// Batch revert: given a list of (device_id, seq) pairs, compute and apply
/// reverse ops in reverse chronological order (newest first).
/// Returns the list of newly created reverse op records.
/// Rejects if any op is non-reversible (returns error listing which ones).
#[tauri::command]
#[specta::specta]
async fn revert_ops(
    ops: Vec<OpRef>,
) -> Result<Vec<OpRecord>, AppError>

/// Undo a single op on a page. Finds the most recent non-undo op, computes
/// reverse, appends it. Returns the reverse op record + the ref of what was undone.
#[tauri::command]
#[specta::specta]
async fn undo_page_op(
    page_id: String,
    target_device_id: Option<String>,
    target_seq: Option<i64>,
) -> Result<UndoResult, AppError>

/// Redo: re-apply an op that was previously undone.
/// Takes the (device_id, seq) of the UNDO op, computes its reverse, appends it.
#[tauri::command]
#[specta::specta]
async fn redo_page_op(
    undo_device_id: String,
    undo_seq: i64,
) -> Result<UndoResult, AppError>
```

**New Types:**
```rust
#[derive(Serialize, Deserialize, specta::Type)]
pub struct OpRef {
    pub device_id: String,
    pub seq: i64,
}

#[derive(Serialize, Deserialize, specta::Type)]
pub struct UndoResult {
    pub reversed_op: OpRef,      // the op that was undone/redone
    pub new_op: OpRecord,        // the reverse op that was appended
    pub is_redo: bool,
}
```

**Page History Query (recursive CTE):**
```sql
WITH RECURSIVE page_blocks(id) AS (
    SELECT id FROM blocks WHERE id = ?1
    UNION ALL
    SELECT b.id FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id
)
SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at
FROM op_log ol
WHERE json_extract(ol.payload, '$.block_id') IN (SELECT id FROM page_blocks)
  AND (?2 IS NULL OR ol.op_type = ?2)
  AND (?3 IS NULL OR (ol.created_at, ol.seq) < (?3_created_at, ?3_seq))
ORDER BY ol.created_at DESC, ol.seq DESC
LIMIT ?4
```

**Tests:**
- `list_page_history`: returns ops for page descendants only, respects filters
- `revert_ops`: batch reversal in correct order, rejects non-reversible
- `undo_page_op`: finds correct op, appends reverse, returns UndoResult
- `redo_page_op`: reverses the undo op
- Integration: undo then redo produces original state

**Verification:** `cd src-tauri && cargo test` + `cargo test -- specta_tests --ignored` (regenerate bindings)

**Does NOT touch:** any frontend component files, materializer.rs core logic

---

### Package C: Frontend — History View Component + Tests

**Worktree:** `worktrees/pkg-c-history-view`

**Files to create:**
- `src/components/HistoryView.tsx` — the main History sidebar view
- `src/components/__tests__/HistoryView.test.tsx` — tests

**Files to modify:**
- `src/App.tsx` — add `'history'` to NAV_ITEMS, render `<HistoryView />`
- `src/stores/navigation.ts` — add `'history'` to `View` type
- `src/components/KeyboardShortcuts.tsx` — add history view shortcut docs
- `src/lib/tauri.ts` — add wrapper functions for new commands
- `src/lib/tauri-mock.ts` — add mock implementations

**Component Design:**

```
HistoryView
├── FilterBar
│   ├── Page filter (dropdown: "All pages" | current page | specific page)
│   ├── Op type filter (multi-select: edit, create, delete, move, tag, property)
│   └── Time range (today / this week / all time)
├── SelectionToolbar (appears when items selected)
│   ├── "N selected" count
│   ├── "Revert selected" button
│   ├── "Select all" / "Clear selection"
│   └── Keyboard hint: "Space to toggle, Enter to revert"
└── HistoryList (virtualized, cursor-paginated)
    └── HistoryItem (repeated)
        ├── Checkbox (left)
        ├── Op type badge
        ├── Block content preview (truncated)
        ├── Timestamp (relative: "2 min ago", absolute on hover)
        ├── Reversibility indicator (lock icon if non-reversible)
        └── "Reverted by op #N" link (if this op was undone)
```

**Interaction Model:**

| Input | Action |
|-------|--------|
| Click checkbox | Toggle selection |
| Click row (not checkbox) | Toggle selection |
| Shift+Click | Range select (from last clicked to this one) |
| Ctrl/Cmd+Click | Toggle individual (standard multi-select) |
| Arrow Up/Down or j/k | Move focus highlight |
| Space | Toggle checkbox on focused item |
| Ctrl/Cmd+A | Select all loaded items |
| Enter | Revert selected (with confirmation dialog) |
| Escape | Clear selection |
| Tap (touch) | Toggle selection |

**Non-reversible ops:** Shown with `opacity-50`, lock icon, checkbox disabled, tooltip
explaining why ("Purge operations cannot be undone").

**Confirmation dialog:** "Revert N operations? This will append N reverse operations to the
log. The original operations remain in history." [Cancel] [Revert]

**Loading states:**
- Initial load: skeleton placeholders (existing pattern)
- Load more: "Load more" button at bottom (existing pattern)
- Revert in progress: button shows spinner, items locked

**Tests:**
- Renders empty state when no history
- Renders entries with correct badges, timestamps, previews
- Checkbox toggle (click, space key)
- Range select (shift+click)
- Arrow key navigation
- Revert button calls `revertOps` with correct op refs in reverse chronological order
- Non-reversible ops have disabled checkboxes
- Confirmation dialog appears before revert
- axe a11y audit (no violations)
- Cursor-based pagination ("Load more" button)
- Filter controls update the query

**Mock backend:** Uses `tauri-mock.ts` stubs. Tests don't need real Rust backend.

**Verification:** `npx vitest run src/components/__tests__/HistoryView`

**Does NOT touch:** any Rust files, editor files, block store logic

---

### Package D: Frontend — Undo/Redo Store + Keyboard Shortcuts + Tests

**Worktree:** `worktrees/pkg-d-undo-store`

**Files to create:**
- `src/stores/undo.ts` — Zustand undo/redo store
- `src/stores/__tests__/undo.test.ts` — tests
- `src/hooks/useUndoShortcuts.ts` — Ctrl+Z / Ctrl+Y handler hook
- `src/hooks/__tests__/useUndoShortcuts.test.ts` — tests

**Files to modify:**
- `src/lib/tauri.ts` — add `undoPageOp`, `redoPageOp` wrappers
- `src/lib/tauri-mock.ts` — add mock implementations

**Undo Store Design:**

```typescript
interface UndoStore {
  // Per-page state, keyed by page ID
  stacks: Map<string, PageUndoState>

  // Actions
  initPage: (pageId: string) => void
  recordOp: (pageId: string, opRef: OpRef) => void
  undo: (pageId: string) => Promise<UndoResult | null>
  redo: (pageId: string) => Promise<UndoResult | null>
  canUndo: (pageId: string) => boolean
  canRedo: (pageId: string) => boolean
  clearPage: (pageId: string) => void
}

interface PageUndoState {
  /** Ops available for undo, newest first. Lazily loaded from op log. */
  undoableOps: OpRef[]
  /** Current position in undoableOps. 0 = most recent, N = N ops undone. */
  undoDepth: number
  /** Ops that were undone, available for redo. */
  redoStack: OpRef[]
  /** Cursor for loading more ops from backend. */
  nextCursor: string | null
  /** Whether more ops exist beyond what's loaded. */
  hasMore: boolean
}
```

**Keyboard Shortcut Hook:**

```typescript
export function useUndoShortcuts(): void {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip if inside editor, input, or textarea
      const target = e.target as HTMLElement
      if (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      // Get current page from navigation store
      const { currentView, pageStack } = useNavigationStore.getState()
      if (currentView !== 'page-editor' || pageStack.length === 0) return
      const pageId = pageStack[pageStack.length - 1].pageId

      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        useUndoStore.getState().undo(pageId)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault()
        useUndoStore.getState().redo(pageId)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])
}
```

**Integration with block store:**
- When `blocks.ts` performs any mutation (create, edit, delete, move, tag, property), it calls
  `useUndoStore.getState().recordOp(pageId, opRef)`.
- `recordOp` clears the `redoStack` and adds the op to `undoableOps`.

**Tests:**
- `undo()` calls `undoPageOp` and updates stacks correctly
- `redo()` calls `redoPageOp` and updates stacks correctly
- `recordOp()` clears redo stack
- `canUndo()` / `canRedo()` return correct booleans
- Multiple undo calls walk back through ops
- Undo then redo restores state
- Undo then new action clears redo
- Keyboard handler fires undo on Ctrl+Z when editor not focused
- Keyboard handler does NOT fire when editor is focused
- Keyboard handler does NOT fire when not on page-editor view
- Keyboard handler does NOT fire in input/textarea elements

**Verification:** `npx vitest run src/stores/__tests__/undo && npx vitest run src/hooks/__tests__/useUndoShortcuts`

**Does NOT touch:** any Rust files, HistoryView component, BlockTree rendering

---

### Package E: Integration (Sequential, After A-D Complete)

**Runs in main worktree after merging packages A-D.**

**Tasks:**
1. Merge all 4 branches into the integration branch
2. Regenerate specta bindings: `cd src-tauri && cargo test -- specta_tests --ignored`
3. Update `src/lib/tauri.ts` with final command wrappers (reconcile A+B types with C+D mocks)
4. Update `src/lib/tauri-mock.ts` with reconciled mocks
5. Wire `useUndoShortcuts()` into `App.tsx`
6. Wire `recordOp()` calls into `blocks.ts` mutations
7. Wire `HistoryView` revert button to call real `revertOps` command
8. Update `KeyboardShortcuts.tsx` with Ctrl+Z / Ctrl+Y documentation
9. Run full test suite: `npm run test && cd src-tauri && cargo nextest run`
10. Run `prek run --all-files`
11. Update `AGENTS.md` keyboard shortcuts documentation
12. Commit

---

## Parallelism Map

```
Time ──────────────────────────────────────────────────────►

Package A (Rust reverse engine)     ████████████░░░░░░░░░░░░
Package C (Frontend History View)   ████████████████████░░░░
Package D (Frontend undo store)     ████████████████████░░░░
                                              ▼
Package B (Rust commands)           ░░░░░░░░░░████████████░░
                                                          ▼
Package E (Integration)             ░░░░░░░░░░░░░░░░░░░░████
```

- **A, C, D** start simultaneously (no dependencies between them)
- **B** starts after **A** completes (needs `reverse.rs`)
- **E** starts after **all** complete (merge + integration)

Packages C and D use mock backends and don't need Rust code to compile.

---

## File Change Summary

| File | Package | Change |
|------|---------|--------|
| `src-tauri/src/reverse.rs` | A | **NEW** — reverse op computation |
| `src-tauri/src/lib.rs` | A, B | Add `mod reverse;` + register commands |
| `src-tauri/src/commands.rs` | B | Add 4 new Tauri commands |
| `src-tauri/src/pagination.rs` | B | Add `list_page_history` query |
| `src-tauri/src/op.rs` | B | Add `OpRef`, `UndoResult` types; `_undo_ref`/`_redo_ref` optional fields |
| `src/components/HistoryView.tsx` | C | **NEW** — sidebar history view |
| `src/components/__tests__/HistoryView.test.tsx` | C | **NEW** — tests |
| `src/App.tsx` | C, E | Add nav item + render HistoryView + useUndoShortcuts |
| `src/stores/navigation.ts` | C | Add `'history'` to View type |
| `src/stores/undo.ts` | D | **NEW** — undo/redo Zustand store |
| `src/stores/__tests__/undo.test.ts` | D | **NEW** — tests |
| `src/hooks/useUndoShortcuts.ts` | D | **NEW** — keyboard handler hook |
| `src/hooks/__tests__/useUndoShortcuts.test.ts` | D | **NEW** — tests |
| `src/lib/tauri.ts` | C, D, E | Add wrappers for new commands |
| `src/lib/tauri-mock.ts` | C, D, E | Add mock implementations |
| `src/lib/bindings.ts` | E | Regenerated by specta |
| `src/stores/blocks.ts` | E | Wire `recordOp()` calls into mutations |
| `src/components/KeyboardShortcuts.tsx` | E | Add Ctrl+Z / Ctrl+Y docs |
| `AGENTS.md` | E | Document new commands + shortcuts |

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `edit_block` prior state lookup is slow for long edit chains | Low | Index on `json_extract(payload, '$.block_id')` + `op_type` + `seq DESC`. Walk is bounded by edit chain length, not total ops. |
| Position conflicts on `move_block` reversal | Medium | Backend bumps positions to make room (same logic as `create_block` position computation). |
| Stale undo stack after concurrent edits (future sync) | Low (Phase 4) | Session-scoped stack is ephemeral. Sync invalidation will clear it. |
| `_undo_ref` field changes payload schema | Low | Optional field, backward compatible. Old ops don't have it. New ops include it only if they are undo/redo generated. |
| History View performance with large op logs | Medium | Cursor-based pagination (never loads all). Virtualized list with viewport observer (existing pattern). |
