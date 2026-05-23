# PEND-57 — Pages view: multi-select + bulk operations + saved views

> **Plan 2 of 3** in the Pages-view triage redesign. **PEND-56** ships the density-rows +
> sort foundation this plan overlays a selection layer on; **PEND-58** ships the compound
> filter primitives that "saved views" snapshot. This plan turns Pages from a navigator
> into a **triage/grooming surface**: multi-select pages, run one bulk op (tag / star /
> move-to-space / trash / set-property) under a single `BEGIN IMMEDIATE`, then snapshot
> the resulting filter+sort+density combo as a **saved view** in localStorage.

## TL;DR

- **Backend:** ~M (~6-8 h). Five new `*_by_ids` RW commands in
  `src-tauri/src/commands/blocks/crud.rs` + `src-tauri/src/commands/tags.rs` +
  `src-tauri/src/commands/properties.rs`, all mirroring the existing
  `restore_blocks_by_ids_inner` / `set_todo_state_batch_inner` cancellation-safe shape
  (single `CommandTx::begin_immediate` + `MAX_BATCH_BLOCK_IDS` cap + one op-log seq range
  per call). Each bulk op surfaces its `OpRef` chain via the standing `LAST_APPEND`
  task-local so the activity feed sees one entry per bulk op.
- **Frontend:** ~M-L (~9-12 h). Wire `useListMultiSelect` + `BatchActionToolbar` (both
  already used verbatim by TrashView / HistoryView) into `PageBrowser.tsx`. New
  `PageBrowserBatchToolbar` sibling. New `useSavedPagesViews` hook +
  `SavedViewsDropdown` in `PageBrowserHeader`. Saved-views state machine = pure reducer
  - localStorage adapter.
- **Docs:** ~S (~1.5 h). New `docs/PAGES_VIEW.md` skeleton; extend `AGENTS.md` with the
  "Pages bulk ops share `MAX_BATCH_BLOCK_IDS` and one `CommandTx`" invariant.
- **Migration story:** Zero schema migrations. Saved views live in localStorage v1 under
  a versioned key (`agaric:pages:savedViews:v1`). Backend graduation is its own future
  plan (out of scope).

## Current state

- **Pages view delete is single-row.** `src/components/PageBrowser.tsx` drives
  `usePageDelete` (line 96) which calls a single-block delete behind a `ConfirmDialog`.
  No selection state. No multi-row trash, no batch tag, no batch move. Single-row delete
  stays as-is; this plan adds a *parallel* selection mode that does **not** alter the
  existing per-row trash button.
- **Multi-select primitives already exist, generic, verbatim-reusable.**
  - `src/hooks/useListMultiSelect.ts` (149 LOC) — Cmd/Ctrl-click toggle, Shift-click
    range with UX-140 *target-state propagation*, `selectAll` / `clearSelection`,
    `handleRowClick` dispatcher. Generic over the row type via `getItemId(item: T)`.
    **Used today by TrashView and HistoryView; works against any flat row array.**
  - `src/components/BatchActionToolbar.tsx` (71 LOC) — selection-count Badge, optional
    shift-click range-select hint, `role="toolbar"` + `aria-label` with i18n'd count.
    Children-as-actions API.
  - `src/hooks/useTrashListShortcuts.ts` — precedent for document-level keyboard
    handling: delegates to `useListKeyboardNavigation`, adds Space (toggle), Cmd/Ctrl+A
    (select all), Esc (clear), plus context-specific Shift+R / Shift+Del shortcuts.
- **Bulk-op backend shape already exists for trash.** `restore_blocks_by_ids_inner` /
  `purge_blocks_by_ids_inner` (`src-tauri/src/commands/blocks/crud.rs:1785` and `:1935`)
  define the pattern: empty-list rejection, `MAX_BATCH_BLOCK_IDS = 1000` cap
  (`src-tauri/src/commands/properties.rs:394`), uppercase ULID normalisation,
  `json_each(?1)` resolve in one query, single `CommandTx::begin_immediate`.
  `set_todo_state_batch_inner` (`properties.rs:428`) is the property-write precedent.
- **Activity feed surfaces multi-op tools via `LAST_APPEND` + `additional_op_refs`.**
  `src-tauri/src/mcp/activity.rs:121` and `:413` document the contract: the dispatch
  layer drains `LAST_APPEND` into the entry's primary `OpRef` + `additionalOpRefs`.
  **A bulk op already serialises correctly today** — no activity-feed changes required,
  only the invariant that each bulk command emits its op-log writes inside the same
  task scope.
- **Saved views = greenfield.** No existing storage layer, no UI affordance, no
  component. Sort preference today lives in `usePageBrowserSort` (per-tab, ephemeral).
  Star state lives in `useStarredPages` (localStorage under `starred-pages` key, custom
  event-broadcast).
- **i18n.** `batch.selectedCount` exists today (consumed by `BatchActionToolbar`). The
  Pages-specific keys (`pages.bulkTag`, `pages.bulkMove`, `pages.savedViews.save`, etc.)
  are new.

## Design

### Multi-select UX

The selection layer **overlays** the PEND-56 density rows — it does not replace them.
Mouse and keyboard parity, with the gestures the codebase already implements in
`useListMultiSelect`:

| Gesture | Effect |
|---|---|
| Click row | Select the row, navigate to it (existing behaviour, unchanged when **no** selection is active) |
| Cmd/Ctrl-click row | Toggle row in selection, do **not** navigate |
| Shift-click row | Range-select from last-clicked to clicked, applies the clicked row's *target state* (UX-140 propagation in `useListMultiSelect.ts:125-131`) |
| Cmd/Ctrl+A | Select all currently-visible (post-filter, post-sort) pages |
| Esc | Clear selection (no-op if empty) |
| Space (focused row) | Toggle the focused row's selection |
| Click in empty list area | Clear selection |

**When `selected.size > 0`**, the `<BatchActionToolbar>` mounts above the virtualizer
(sticky, inside the existing `ViewHeader` flow), replacing the single-row
click-to-navigate semantics with click-to-toggle while the toolbar is visible. Pressing
Esc returns the view to navigation mode.

The selection-count chip already lives in `BatchActionToolbar` via
`t('batch.selectedCount', { count })`. The desktop-only "Shift+Click to range-select"
hint already renders unless `suppressRangeSelectHint` is passed; we leave it on for Pages.

### Bulk operations — initial cut

Five actions in the initial toolbar, each backed by one `*_by_ids` RW command:

| Action | Backend command | Why in v1 |
|---|---|---|
| **Bulk star / unstar** | None — `useStarredPages` is localStorage-only | Cheapest action; star is per-device. Resolves a recurring grooming gesture without any backend churn. |
| **Bulk trash** | `delete_blocks_by_ids_inner` (new) | Mirrors the existing single-row delete the view already supports; the most-requested grooming action. |
| **Bulk tag** | `add_tags_to_blocks_inner` + `remove_tags_from_blocks_inner` (new) | Tag triage (adding `#review`, removing stale tags) is the canonical grooming gesture; per-row IPC loop is unacceptable at 50+ selections. |
| **Bulk move-to-space** | `move_blocks_to_space_inner` (new) | Space hygiene — moving a stray draft into the right space — is a friction point today because the only path is open-each-page-and-edit. |
| **Bulk set-property** | `set_property_batch_inner` (new, generalises `set_todo_state_batch_inner` to arbitrary `(name, value)` pairs from a fixed allowlist) | Sets `todo_state` / `priority` / due / scheduled across the selection. Mechanically identical to the existing `set_todo_state_batch_inner` body; this plan just extends the surface. |

**Deferred** (not in v1, locked-in rationale):

- **Bulk rename / regex-rename.** Requires a destination-name resolver per row; outside
  the "one tx, N rows, identical payload" shape. Defer to a dedicated plan.
- **Bulk archive.** No "archived" state exists yet; this is its own data-model addition.
- **Bulk export.** Read-only; doesn't fit the bulk-op-toolbar mental model.
- **Bulk duplicate.** N inserts with content-rewriting; significantly more complex tx
  than the in-place mutations above.

### Bulk-tag UX

Tag picker over the selection has **additive semantics by default**, with explicit
remove. The chip-picker UI exposes **three states per tag**:

- **`applied-to-all`** — every selected page carries this tag. Click → remove from all.
- **`applied-to-some`** — at least one but not all carry this tag. Click → add to the
  remaining (resolves to `applied-to-all`); long-press or shift-click → remove from all.
- **`applied-to-none`** — no selected page carries this tag. Click → add to all.

The picker pre-resolves per-tag membership using a single new
`count_tag_membership_inner(tag_ids: Vec<String>, block_ids: Vec<String>)` query that
returns `Vec<(tag_id, applied_count)>` via one `json_each` join. The frontend interprets
`applied_count == 0 / selection.size / other` as the three states.

**No "replace" semantics in v1.** Replace = "set the tag set to exactly these" is
destructive and easy to misclick; explicit "remove all tags" is a deferred action.

### Saved views

A saved view is the user-stamped snapshot of the **Pages view's view-state tuple**:

```ts
interface SavedPagesView {
  id: string                  // ULID, generated frontend-side
  name: string                // user-supplied, non-empty, no length cap in v1
  createdAt: string           // ISO-8601
  updatedAt: string           // ISO-8601
  sort: SortOption            // from usePageBrowserSort
  density: DensityMode        // from PEND-56's density store
  filters: PagesFilterSet     // from PEND-58's compound-filter primitive
  // No selection state. Selection is ephemeral by design.
}
```

**Storage.** localStorage key `agaric:pages:savedViews:v1`, JSON-serialised
`{ schemaVersion: 1, views: SavedPagesView[] }`. The reader tolerates an unknown future
`schemaVersion`: if `>1`, it discards the contents and starts empty, surfacing a toast
with a link to recover the raw JSON (so users with multiple Agaric versions installed on
the same machine don't silently lose views on downgrade). The cross-tab broadcast pattern
mirrors `useStarredPages` — a custom `'pages-saved-views-changed'` window event broadcasts
on every mutation; every mounted hook re-reads and short-circuits on set equality.

**UI surface.** A new `<SavedViewsDropdown>` sits in `PageBrowserHeader` to the right of
the sort dropdown. Two modes:

- **Empty state** — single `"Save current view…"` button. Click opens a
  `<SaveViewDialog>` with a single text input.
- **Populated** — split button. Primary face shows the active view's name (or
  `"Custom"` when the live view-state tuple doesn't match any saved view). Dropdown lists
  saved views (most-recently-used at top); each row has a delete affordance. Footer item
  `"Save current view…"` + (if a view is active) `"Update '${name}'"`.

**No backend persistence in v1.** A backend `saved_views` table is its own future plan —
out of scope here. The localStorage v1 ships with `schemaVersion: 1` so the graduation
path is clean: backend bulk-import endpoint reads v1, migrates, then later versions stop
writing to localStorage.

**Active-view detection.** A view is "active" when its `{sort, density, filters}` tuple
is deeply-equal to the live state. The dropdown surfaces this so the user knows whether
they're "in" a saved view or off it.

### IPC surface

Five new `*_inner` functions, all in the existing files, all under the established
`CommandTx::begin_immediate` / `MAX_BATCH_BLOCK_IDS` pattern. Sketches only —
load-bearing shapes:

```rust
// src-tauri/src/commands/blocks/crud.rs (alongside restore_blocks_by_ids_inner)
pub async fn delete_blocks_by_ids_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<String>,
) -> Result<BulkTrashResponse, AppError> { /* one IMMEDIATE tx, json_each resolve, one OpRef per root */ }

pub async fn move_blocks_to_space_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<String>,
    target_space_id: String,
) -> Result<BulkMoveResponse, AppError> { /* validates target space exists; rejects no-op (already in space) silently per existing tolerance policy */ }
```

```rust
// src-tauri/src/commands/tags.rs
pub async fn add_tags_to_blocks_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<String>,
    tag_ids: Vec<String>,
) -> Result<BulkTagResponse, AppError> { /* M × N pairs in one tx; silently skips already-applied (block_id, tag_id) pairs */ }

pub async fn remove_tags_from_blocks_inner( /* mirror */ ) -> Result<BulkTagResponse, AppError>;
```

```rust
// src-tauri/src/commands/properties.rs (generalised from set_todo_state_batch_inner)
pub async fn set_property_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<String>,
    name: String,           // allowlist: "todo_state", "priority", "due_date", "scheduled_date"
    value: Option<String>,  // None = clear
) -> Result<i64, AppError> { /* delegates to the existing _batch core; the new entrypoint is the (name) dispatch */ }
```

**Cancellation safety.** The same shape `restore_blocks_by_ids_inner` already obeys —
once `CommandTx::begin_immediate` returns, the body up to `tx.commit().await?` is one
cancellation-safe unit. The Tauri command wrapper does not race with cancellation because
the IPC future drops the tx, which rolls back. **Each bulk op is atomic: all rows succeed
or the tx rolls back.** No partial-write state observable to other readers.

**Single-tx-per-bulk-op contract.** Every new command opens *one* `BEGIN IMMEDIATE`,
performs *one* `json_each` resolve, emits its op-log rows in one contiguous seq range (so
the materializer sees the bulk via `BatchApplyOps`), and commits once. The op-log seq
range is exposed via the `LAST_APPEND` task-local; the dispatch layer in
`src-tauri/src/mcp/activity.rs` already drains that into `additionalOpRefs`. **Activity
feed sees exactly one entry per bulk op with N `additionalOpRefs`.** Undo against that
entry is "rewind to the seq before the range" — which the existing reverse-op machinery
already supports for `RestoreBlock` / `DeleteBlock` / `AddTag` / `RemoveTag` /
`SetProperty`. `MoveBlocksToSpace` may need a `Reverse` impl this plan adds.

**Why one tx per op (not chunked).** `MAX_BATCH_BLOCK_IDS = 1000` is the existing cap.
SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is 32766; we're nowhere near it. The constant
exists to bound writer-lock hold time, not to chunk for correctness. Chunking would split
one logical "user pressed Trash" into N activity-feed entries with N reverse-op replays
— fragile. Keep it atomic. The frontend enforces the same cap before invoking.

### Edge cases (locked in)

- **Selection across pagination.** `useListMultiSelect` already resets selection when
  `items.length` changes (`useListMultiSelect.ts:39-47`). For PageBrowser, `loadMore`
  *grows* the items array — same length-change reset path. **This is wrong for Pages**:
  users will reasonably expect their selection to survive when they scroll-to-load-more.
  **Fix:** swap the length-change reset for a *predicate-based reset* — drop only ids
  no longer present in the items list. This is a one-line edit inside
  `useListMultiSelect`, generalises cleanly to TrashView/HistoryView (both today reset
  overly-eagerly on `loadMore`), and is gated behind a hook option
  `preserveOnGrowth: true` so existing callers see no behaviour change.
- **Selection across sort change.** Sort is a re-order, not a membership change.
  Selection survives by construction once the length-change reset is replaced with a
  predicate.
- **Selection across filter change.** Filter shrinks the items list. The predicate drops
  ids no longer visible. A confirmation toast (`"M of N selections dropped from filter"`)
  is shown if the drop is non-zero.
- **Selected page deleted mid-flight by another agent / sync replay.** Backend
  `*_by_ids_inner` commands already follow the "silently skip ids that don't resolve"
  tolerance policy documented in `set_todo_state_batch_inner` (`properties.rs:407-415`).
  The return value reports the count *actually mutated*; the frontend reconciles by
  reloading the page list and dropping vanished ids from selection.
- **Activity feed entry per bulk op.** Guaranteed by the single-tx-per-bulk-op contract
  above; one feed row, N `additionalOpRefs`.
- **Partial-failure handling.** A bulk op cannot partially fail in v1 — the tx commits
  all or rolls back all. Validation errors (empty list, oversize list, invalid
  `target_space_id`) abort the tx before any write. Backend errors surface as a single
  `AppError`; the frontend shows one toast and clears the toolbar's pending state. No
  "3 of 50 succeeded" state to display.
- **Bulk op against a single page.** Backend accepts a one-element `block_ids` list. The
  frontend does NOT route through the existing single-row delete path when one row is
  selected via the toolbar — the path-by-toolbar consistency is more important than
  micro-optimising one-element bulk ops.

## Phase split

### Phase 0 — Backend bulk IPC (M, ~5-6 h)

- Implement five new `*_inner` functions in their existing-file homes (no new files):
  - `delete_blocks_by_ids_inner` (`blocks/crud.rs`)
  - `move_blocks_to_space_inner` (`blocks/crud.rs`)
  - `add_tags_to_blocks_inner` + `remove_tags_from_blocks_inner` (`tags.rs`)
  - `set_property_batch_inner` (`properties.rs`)
- Add Tauri command wrappers in the same files (mirror `restore_blocks_by_ids` at
  `blocks/crud.rs:2782`).
- Add `Reverse` impls for any payload that lacks one (most-likely `MoveBlocksToSpace`);
  existing `Reverse` impls cover `DeleteBlock` / `AddTag` / `RemoveTag` / `SetProperty`.
- Regenerate specta bindings (`cd src-tauri && cargo test -- specta_tests --ignored`).
- Backend tests under `src-tauri/src/commands/tests/`.

### Phase 1 — Frontend multi-select wiring (S-M, ~3 h)

- Add `useListMultiSelect` to `PageBrowser.tsx` keyed on `filteredPages` with
  `getItemId: (p) => p.id`. **No fork** — the existing hook works verbatim against
  `BlockRow`.
- Generalise the length-change reset in `useListMultiSelect` to predicate-based reset
  (gated behind `preserveOnGrowth: true`); add the option to the TrashView / HistoryView
  callers without enabling it (no behaviour change). Add a unit test for both paths.
- Add a `usePageBrowserShortcuts` hook modelled on `useTrashListShortcuts` for Space /
  Cmd-A / Esc.
- Wire `handleRowClick` into the existing `PageRow` click handler so Cmd-click and
  Shift-click suppress navigation.
- Render a thin selection indicator in the `PageBrowserRowRenderer` (a checkbox-shaped
  affordance on hover, filled when selected). The visual reuses existing styles; no new
  tokens.

### Phase 2 — Frontend bulk-action toolbar (M, ~4-5 h)

- New `src/components/PageBrowser/PageBrowserBatchToolbar.tsx` — wraps
  `BatchActionToolbar`, exposes five action buttons.
- New `src/components/PageBrowser/BulkTagPicker.tsx` — three-state chip picker; consumes
  a new `useTagMembership(blockIds)` hook that calls `count_tag_membership_inner`.
- New `src/components/PageBrowser/BulkMoveToSpaceDialog.tsx` — select target space;
  calls `move_blocks_to_space`.
- New `src/components/PageBrowser/BulkSetPropertyMenu.tsx` — for `todo_state` /
  `priority` / due / scheduled.
- New `src/lib/tauri.ts` wrappers for the five new commands (1 per).
- All bulk actions pre-validate against `MAX_BATCH_BLOCK_IDS = 1000` on the client and
  surface a toast if exceeded (defence in depth; the backend authoritatively rejects).

### Phase 3 — Saved views (M, ~3-4 h)

- New `src/lib/saved-pages-views.ts` — pure storage adapter, mirrors
  `src/lib/starred-pages.ts` shape (reader, writer, custom-event broadcast,
  schemaVersion guard).
- New `src/hooks/useSavedPagesViews.ts` — pattern-match `useStarredPages` (set-equality
  short-circuit, custom event subscription).
- New `src/components/PageBrowser/SavedViewsDropdown.tsx` + `SaveViewDialog.tsx`,
  slotted into `PageBrowserHeader`.
- Active-view detection: a `useMemo` over `(sort, density, filters, savedViews)` that
  returns the matching view id or `null`. Deep-equal helper lives in
  `src/lib/saved-pages-views.ts`.

### Phase 4 — Tests (M, ~4 h)

See *Tests* section.

### Phase 5 — Docs (S, ~1.5 h)

- New `docs/PAGES_VIEW.md` — user-facing overview of multi-select + bulk ops + saved
  views. Each section is self-contained so PEND-56 / PEND-58 can append theirs without
  merge conflict.
- Extend `AGENTS.md` "Backend Patterns" with: *Pages bulk ops share
  `MAX_BATCH_BLOCK_IDS = 1000` and a single `CommandTx::begin_immediate` per op; never
  chunk a logical bulk op into multiple txs — the activity feed and undo machinery treat
  one tx as one user action.*
- README.md: one-line *Pages bulk operations* entry → `docs/PAGES_VIEW.md`.

## Robustness

- **Race: bulk op + concurrent single-row edit.** Both paths take `BEGIN IMMEDIATE`.
  SQLite serialises writers; the later writer waits for the earlier to commit. No torn
  read — the materializer sees the rows in commit order. The bulk op's `OpRef` chain is
  contiguous in op_log.seq regardless of intervening single-row ops on *other* rows (each
  tx is a contiguous seq range; the materializer's `BatchApplyOps` consumes ranges, not
  individual seqs).
- **Race: bulk op + sync replay.** Same answer — both serialise on the writer lock.
  Sync replay applies ops in seq order; a bulk op's range arrives as a unit.
- **Undo semantics.** Each bulk op contributes one activity-feed entry. Undo against
  that entry replays the reverse ops in reverse seq order inside one `BEGIN IMMEDIATE`
  tx — i.e. exactly the existing single-op undo machinery, with N reverse-ops per call.
  No new code path required so long as every payload type has a `Reverse` impl.
- **Selection-state persistence across navigation.** Selection is in-memory only (the
  `useState` inside `useListMultiSelect`). Navigating away unmounts `PageBrowser` and
  clears it. **By design** — the scroll-restoration affordance in `PageBrowser.tsx:307+`
  does not include selection, and forwarding selection across navigation would
  re-introduce the "stale references to deleted pages" problem the predicate-based reset
  solves on `loadMore`.
- **Bulk-op cancellation.** A user pressing Esc during a pending bulk op cannot cancel
  the tx mid-write — `CommandTx` is not cancellation-aware mid-`commit`. Esc *does*
  dismiss the toolbar; the in-flight op completes and surfaces its toast. The toolbar's
  "pending" state is the only UI indicator. This is acceptable because bulk ops at the
  1000-row cap take far less than a second to commit on the established SQLite write path
  (measured in the existing `restore_blocks_by_ids` benchmarks — target to re-measure
  for Pages-specific row shapes).
- **Partial failure recovery.** No partial failure surface exists — atomic by
  `CommandTx`. The frontend never has to reconcile "3 of 50 succeeded".

## Performance

- **Tx size limit:** `MAX_BATCH_BLOCK_IDS = 1000` (existing constant). Same cap applies
  across every new `*_by_ids_inner`. The frontend pre-validates with a toast at the cap
  boundary.
- **UI responsiveness during big bulk ops:** The bulk-op IPC call is `await`-ed inside
  an `async` handler. The toolbar enters a `pending` state (button disabled, spinner)
  until the promise resolves. No progress UI in v1 — the operation is atomic and short.
  **Target to measure** the p95 latency of a 1000-row bulk-tag on a mid-tier dev machine;
  if > 500 ms, revisit the spinner-vs-progress decision.
- **Chunking:** rejected. Chunking breaks one-op-per-bulk-action atomicity (see *IPC
  surface* above). The 1000-cap is the right ceiling, not a chunk boundary.
- **Saved-view storage size:** Worst-case projection — 50 saved views × an
  arbitrary-size filter blob. **Target to measure** the actual size after PEND-58 settles
  its filter primitive; if a single view exceeds 4 KB at p95, revisit by trimming filter
  normalisation. localStorage cap is browser-dependent (~5 MB typical); we're nowhere
  near it at any plausible view count.
- **`count_tag_membership_inner` cost:** one query,
  `json_each(?1) JOIN json_each(?2) JOIN block_tags`. Bounded by
  `selection.size × distinct_tag_count_in_selection`. Acceptable at the 1000-cap.

## Maintainability

- **Saved-views schema versioning.** localStorage key `agaric:pages:savedViews:v1`. The
  reader rejects unknown future `schemaVersion` and surfaces a recovery toast (see *Saved
  views* above). When backend graduation lands, the migration path is: backend
  bulk-import endpoint reads v1 → migrates → subsequent writes stop touching localStorage.
  No data loss; the v1 reader never deletes the v1 blob (only ignores it post-migration).
- **Shared `useBulkOperations<T>` hook.** **Defer.** TrashView and HistoryView each
  compose their own bulk-action handlers today against the same `useListMultiSelect`
  primitive; extracting `useBulkOperations` is tempting but premature — the three call
  sites have non-overlapping action shapes (trash: restore/purge; history: undo; pages:
  tag/move/star/trash/property). Re-evaluate after this plan ships, when there are three
  real callers to triangulate against.
- **Bulk-op command convention.** Every new `*_by_ids_inner` follows the verbatim shape
  of `restore_blocks_by_ids_inner` — empty-list guard, oversize-list guard, uppercase
  normalisation, `json_each` resolve, `CommandTx::begin_immediate`, single op-log seq
  range, return *affected* count. Documented in AGENTS.md so the next bulk op (whichever
  plan adds it) starts from a copy-paste-modify baseline.
- **Activity-feed integration is zero-cost.** The existing `LAST_APPEND` task-local
  pattern (`mcp/activity.rs:121-145, 413-420`) already does the work; new commands
  inherit the behaviour by emitting their ops inside the dispatched task scope.

## Tests

### Backend unit (`src-tauri/src/commands/tests/`)

- `delete_blocks_by_ids_clears_deleted_at_for_n_blocks` (mirror existing
  `restore_blocks_by_ids` shape).
- `delete_blocks_by_ids_empty_input_returns_validation_error`.
- `delete_blocks_by_ids_rejects_oversize_list`.
- `delete_blocks_by_ids_atomic_rollback_on_validation_error`.
- `delete_blocks_by_ids_writes_one_op_log_seq_range`.
- Same five shapes for `move_blocks_to_space`, `add_tags_to_blocks`,
  `remove_tags_from_blocks`, `set_property_batch`.
- `add_tags_to_blocks_skips_already_applied_pairs` (M×N cross product; idempotent).
- `move_blocks_to_space_rejects_unknown_target_space`.
- `set_property_batch_rejects_disallowed_name` (allowlist enforcement).

### Frontend unit (`src/__tests__/` + `src/hooks/__tests__/`)

- `useListMultiSelect.test.ts` — new test cases for `preserveOnGrowth: true`:
  selection survives length growth; selection drops ids that disappeared on length shrink.
- `useSavedPagesViews.test.tsx` — add / update / delete / schemaVersion-guard / cross-tab
  event propagation (mirror `useStarredPages.test.tsx`).
- `usePageBrowserShortcuts.test.ts` — Space toggles focused row; Cmd-A selects all
  visible; Esc clears.
- Handler tests for each of the five bulk actions: success toast, error toast (mocked
  IPC rejection), oversize-pre-check toast.

### Frontend integration (`src/components/__tests__/PageBrowser.bulk.test.tsx` — new file)

- Selection survives `loadMore` when `preserveOnGrowth: true` is wired in.
- Selection survives a sort change.
- Selection partially drops on a filter change; the drop count appears in a toast.
- Bulk-tag picker shows the three states correctly across a mixed selection.
- Activity-feed assertion: one entry per bulk op with the right `OpRef` chain length.

### E2E (`e2e/pages-bulk-ops.spec.ts` — new file)

- Select 3 pages via Shift-click; bulk-tag with `#review`; reload; assert each of the 3
  carries the tag.
- Save current view as "Triage"; change sort; load "Triage"; assert sort reverted;
  assert active-view indicator on.
- Bulk-trash 2 pages; assert activity feed has one entry titled accordingly; click Undo
  on that entry; assert both rows back in Pages.

### a11y

- `vitest-axe` on `<PageBrowserBatchToolbar>` mounted with `selectedCount=3`.
- `vitest-axe` on `<SavedViewsDropdown>` open + closed.
- Keyboard-only e2e: open Pages, Cmd-A, Tab to first toolbar action, Enter → assert
  bulk action ran.

## Open questions

1. **Saved views in localStorage forever, or graduate to backend?** Defer the decision
   until the v1 ships and the usage pattern surfaces (single-machine vs. multi-machine,
   sync-vs-local). The schemaVersion v1 guard means graduation costs nothing if we
   choose to do it.
2. **Hard cap on bulk-op size — keep at 1000, lower, or raise?** Inherited from
   `MAX_BATCH_BLOCK_IDS`. The cap is currently writer-lock-hold-time-driven, not
   correctness-driven. **Target to measure** the p95 commit latency of a 1000-row
   bulk-tag and a 1000-row bulk-move-to-space; revisit if either exceeds a perceptible
   threshold.
3. **Progress UI vs. spinner.** v1 ships a spinner. If p95 latency at 1000 rows is too
   long to feel snappy, the next plan replaces the spinner with a determinate progress
   bar. The op stays atomic either way — the progress bar would be cosmetic over
   `BatchApplyOps`-time, not actual chunking.
4. **Are bulk ops cancellable mid-flight?** No in v1. SQLite `BEGIN IMMEDIATE` is not
   cancellation-aware. Adding cancellation requires a chunked design (rejected above) or
   a Rust-side abort token threaded through `CommandTx` (deferred).
5. **Should the bulk-tag picker remember per-selection-context tag suggestions?**
   Probably yes for usability, but the surface (a "recent tags in selection" sub-list)
   is its own design question. Defer to a usage-data-informed follow-up.

## Acceptance criteria

- User can select 50 pages via Shift-click and bulk-tag them with one click. Backend
  emits one `add_tags_to_blocks` IPC call with one tx; activity feed shows one entry;
  `additionalOpRefs.length == 49` on that entry.
- User can select 50 pages and bulk-trash them; the Trash view shows all 50 with
  original-location breadcrumbs; one Undo from the activity feed restores all 50 in one tx.
- Selection survives a `loadMore` (count chip and toolbar persist after the next page
  arrives); selection drops only ids that vanished after a filter change, with a toast
  counting the drop.
- Selection clears on sort change only if a *visible* row goes missing — sort is
  order-only, so in practice selection always survives sort.
- A bulk op that exceeds `MAX_BATCH_BLOCK_IDS = 1000` surfaces a frontend toast
  **before** the IPC fires; backend rejects with `AppError::Validation` if the frontend
  guard is bypassed.
- A saved view round-trips: save current view, navigate away, return, re-load the saved
  view, assert sort + density + filters reverted to the saved tuple.
- localStorage schemaVersion: writing a `v: 2` blob into the key surfaces the recovery
  toast on next mount, and the saved-views dropdown shows empty.
- Every new `*_by_ids_inner` command has unit-test coverage for the five canonical
  shapes (happy path, empty-list rejection, oversize rejection, atomic-rollback-on-error,
  op-log seq-range contiguity).
- `vitest-axe` passes on `<PageBrowserBatchToolbar>` and `<SavedViewsDropdown>`.
- Keyboard-only: a user can complete the full "select all + bulk-tag" gesture without
  touching the mouse.

## Related

- PEND-56 (density rows + sort foundation the selection UI overlays / saved-views
  snapshot) — **shipped**; plan file deleted on completion (see `git log` / `SESSION-LOG.md`).
- PEND-58 (compound filters; filter primitives saved views snapshot) — **shipped**;
  plan file deleted on completion.
- `src/hooks/useListMultiSelect.ts` — **reused verbatim** (with one additive
  `preserveOnGrowth` option).
- `src/components/BatchActionToolbar.tsx` — **reused verbatim** as the wrapper for the
  new `PageBrowserBatchToolbar`.
- `src/hooks/useTrashListShortcuts.ts` — precedent for the new `usePageBrowserShortcuts`.
- `src/components/TrashView.tsx` — reference implementation of the `useListMultiSelect`
  - `BatchActionToolbar` composition.
- `src/components/PageBrowser.tsx` — orchestrator the selection layer mounts inside.
- `src/components/PageBrowser/PageBrowserHeader.tsx` — host for the new
  `<SavedViewsDropdown>`.
- `src/components/PageBrowser/PageBrowserRowRenderer.tsx` — host for the row-level
  selection affordance.
- `src/lib/starred-pages.ts` + `src/hooks/useStarredPages.ts` — localStorage-with-cross-
  tab-event pattern the saved-views storage mirrors.
- `src-tauri/src/commands/blocks/crud.rs:1751-1949` — `MAX_BATCH_BLOCK_IDS` cap
  definition + `restore_blocks_by_ids_inner` / `purge_blocks_by_ids_inner` template.
- `src-tauri/src/commands/properties.rs:394` — `MAX_BATCH_BLOCK_IDS = 1000` constant;
  reused across every new `*_by_ids_inner`.
- `src-tauri/src/commands/properties.rs:428` — `set_todo_state_batch_inner` template
  the generalised `set_property_batch_inner` extends.
- `src-tauri/src/commands/tags.rs:35` — `add_tag_inner` template for the bulk variant.
- `src-tauri/src/mcp/activity.rs:121-145, 413-420` — `LAST_APPEND` + `additionalOpRefs`
  contract every bulk op inherits.
- `AGENTS.md` — extension target for the "Pages bulk ops share one tx" invariant.
