<!-- markdownlint-disable MD060 -->
# Editor & Content

Companion to `docs/UI-MAP.md § Editor surfaces` (what the user sees) and `docs/UX.md § Editor architecture` (rules at point of edit). This file documents the **content format**, the **serializer contract**, the **roving-editor lifecycle**, the **FE/BE authority boundary**, and the **undo model**.

## Storage format

Block content is stored as Markdown-flavoured plain text. The full grammar is parsed by the FE serializer (round-tripped to ProseMirror, then back). Key rules:

- One block = one top-level Markdown construct (paragraph, heading, list item, code block, etc.). Multi-block markdown pasted into one block triggers an auto-split on blur.
- Inline marks are a **locked set**: bold, italic, code, strike, highlight, external-link, inline-block-link (`[[ULID]]`), tag-ref (`#[ULID]`), block-ref (`((ULID))`). New marks are deliberate additions to the serializer + grammar.
- Code blocks carry a `language` attribute (one of a curated set; matching common usage).
- Callouts use a `> [!type]` fenced shape (tip / note / info / warning / error).

## Custom serializer

The Markdown ↔ ProseMirror serializer lives **on the frontend** (`src/editor/markdown-parse.ts` + `src/editor/markdown-serialize.ts`, surfaced via a `markdown-serializer.ts` barrel). It is FE-only because the editor needs lossless round-trips on every keystroke; pushing through IPC for every transaction would destroy typing fluency.

The serializer is property-tested with `fast-check`: round-trip identity (`parse(serialize(parse(md))) == parse(md)`) and serialise idempotence. Off-the-shelf parsers were rejected because none of them handled the locked-mark set + our inline-ULID nodes losslessly.

The backend reads/writes `blocks.content` as opaque markdown text. The **only** backend interaction with the content format is the FTS strip pass (`src-tauri/src/fts/strip.rs::strip_for_fts`), which removes Markdown markup and resolves `[[ULID]]` / `#[ULID]` to their target titles for full-text search. The strip path has a sync variant (`strip_for_fts_with_maps`) for materialization paths that have already prefetched tag-name + page-title hash maps.

## Roving-editor invariant

Exactly one block hosts a `<EditorContent>` (TipTap) at any moment. Every other block renders as `StaticBlock` → `RichContentRenderer` (read-only). Focus changes unmount the editor from the previous block (persisting markdown via `persistUnmount`) and remount it in the new one.

This keeps:

- **Memory bounded** — one editor instance, not one per block.
- **Undo isolated** — each edit session has its own ProseMirror history.
- **DOM lean** — static blocks are pure presentational divs, not editor instances.

The `RovingEditorHandle` indirection (`src/editor/use-roving-editor.ts`) decouples the editor's lifecycle from React's render cycle.

## Picker plugins (inline references)

Five inline pickers share one mechanism (`src/editor/extensions/picker-plugin.ts` + `SuggestionList`): `BlockLinkPicker` (`[[`), `TagPicker` (`@`), `BlockRefPicker` (`((`), `SlashMenu` (`/`), `PropertyPicker` (`::`). Each is a TipTap extension that:

1. Registers an InputRule on the trigger character.
2. Mounts `SuggestionList` (a Floating-UI–positioned popup) via `ReactRenderer`.
3. On select, inserts a node at the captured `insertPos`.

**Capture before await.** Every picker captures `insertPos = editor.state.selection.from` BEFORE its async IPC call. After the await, if `insertPos > editor.state.doc.content.size` (the doc shrank), it falls back to inserting at the current cursor. This is the documented contract; missing the guard is a classic stale-position bug.

**Never `instanceof TextSelection` / `NodeSelection` in app code.** `@tiptap/pm/state` can resolve to a *different module copy* than the one a given selection object was constructed from (multiple entry points re-export ProseMirror), so `selection instanceof TextSelection` is silently **always false** even for a genuine text selection. This broke the bubble menu once already. Duck-type on structural properties instead: `'node' in selection` distinguishes a `NodeSelection`; gate text-selection logic on `selection.empty` / `selection.from` / `selection.to`. The same hazard applies to any `instanceof` against a ProseMirror class (`Node`, `Mark`, `Fragment`). Always run the editor e2e (`npx playwright test e2e/*.spec.ts --workers=1`) locally before pushing a bubble-menu / selection change — unit tests mock the editor and miss this.

**Chip deletion.** Pressing `Backspace` immediately after a picker-inserted chip deletes the whole chip atom in one keystroke. The `tag-ref` / `block-link` / `block-ref` node types implement this on `Backspace`. (It does not re-expand to source text: the `@` / `[[` / `((` suggestion plugins only reopen on a user-typed trigger char, so re-inserting text would leave an inert string behind — the user retypes the trigger to open the picker again.)

## Auto-split on blur

When a block's content (after editing) contains newlines outside code fences, blur splits it into multiple blocks. `shouldSplitOnBlur(markdown)` returns true when the post-parse doc has more than one top-level node; the store action `splitBlock(blockId, markdown)` performs the split.

Code blocks and headings are exceptions: a heading-marker (`#`) or fence (` ``` `) at the start of an empty block converts that block in place rather than splitting.

## FE / BE authority boundary

The single load-bearing rule of editor architecture:

- **FE is authoritative for in-progress local edits.** Until you blur, your changes live in TipTap state + (debounced) `block_drafts`. They are not yet a committed op.
- **BE is authoritative for post-flush state.** On blur, the editor unmounts, the FE serialises to markdown, and the store dispatches the right op (`edit_block` / `splitBlock` / `merge` / etc.). The op is the authoritative record.
- **Handover is unmount.** The transition point is exactly the editor unmount; there is no per-keystroke IPC, no live-merge with concurrent remote edits during typing.

Edge cases the contract acknowledges:

- **Until you blur, your edits are not durable.** A hard kill mid-edit recovers from `block_drafts` on next boot (Recovery step 3). A power failure mid-keystroke can lose at most the typing since the last debounce.
- **Typing during sync.** No pause-sync-while-typing lock; the FE editor and the sync daemon run independently. Remote ops applied during your edit are written to the underlying block; on blur, your FE markdown becomes the new committed content. **This is effectively block-level last-write-wins at blur (#2459):** a remote edit that landed on the block you were typing in is superseded by your blur op for that block's content — the two are not character-merged, because your in-progress keystrokes were never individual ops (the handover-is-unmount rule above). The CRDT's character-level merge governs *committed* concurrent edits (two devices that both blurred without overlap-in-progress); the same-block-while-typing overlap resolves at block granularity by design, and the superseded version persists in `op_log` for undo / history view. This is the deliberate trade for a keystroke-latency-free editor with no per-keystroke IPC.

`useEditorBlur` enforces a five-step guard chain before unmount: (1) no active block → no-op; (2) blur from a stale element → no-op; (3) early-persist (debounced save); (4) portal + visible-element scan via the single `[data-editor-portal]` attribute selector (replaces the legacy 8-class array); (5) unmount + save-or-split.

## Keyboard

Two hooks with similar names; the split matters:

- `src/editor/use-block-keyboard.ts` — attaches a capture-phase DOM listener on `editor.view.dom.parentElement`. It pre-empts ProseMirror for keys that must fire before the editor (Enter to split, Backspace at start to merge, indent/dedent).
- `src/hooks/useBlockKeyboardHandlers.ts` — the high-level action handlers (`handleEnterSave`, `handleDeleteBlock`, …). Re-entrancy refs (`enterSaveInProgress`, `deleteInProgress`) guard against double-fire from rapid keystrokes.

Suggestion-popup passthrough: when a picker is visible, `Enter / Tab / Escape / Backspace` go to the picker, not the block handler. The block handler checks `isSuggestionPopupVisible()` before processing.

`Tab` / `Shift+Tab` are intentionally NOT bound to indent / dedent — they remain browser focus navigation so the app stays keyboard-accessible. Indent / dedent use `Ctrl+Shift+→` / `Ctrl+Shift+←`.

`flushSync` on blur: when `handleBlur` calls `edit()` or `splitBlock()`, wrap in `flushSync()` so the store update renders before the editor unmounts. Otherwise the editor disappears before the save completes.

## Multi-selection

`useBlockStore.selectedBlockIds: string[]` carries the selection set. `Shift+Click` extends, `Ctrl+Click` toggles, `Ctrl+A` selects all visible. Editing a block clears selection — modes are mutually exclusive on purpose (you're either editing one block or selecting many).

## Undo / redo

Two-tier:

- **In-editor undo**: ProseMirror history. Scoped to one edit session. Survives only until the editor unmounts.
- **Page-level undo**: `UndoStore` over the op log. Reversed via `src-tauri/src/reverse/` (one reverse-op per source op type; see table below). Coalesces consecutive ops within `UNDO_GROUP_WINDOW_MS`; redo stack capped at `MAX_REDO_STACK`. Both constants live in `src/stores/undo.ts`.

### Addressing model (#2468)

Page-level undo is **op-ref addressed**: each mutating command returns the `OpRef`s it produced (`WithOps<T> = T & { op_refs: OpRef[] }`, captured backend-side via the `LAST_APPEND` task-local, so the refs are exactly this invocation's appends — never "latest"). `UndoStore` entries carry those refs; Ctrl+Z submits them to `undo_op` (single) or `undo_ops` (coalesced group, one atomic transaction, `NonReversible` aborts the whole set). This kills the positional-offset race class (#2446): an op appended between the user's intent and the IPC cannot shift the target. The backend verifies each ref in-transaction — local (`is_replicated = 0`, the #2481 implicit-undo scoping: replicated foreign ops are only revertible through the explicit History-view `revert_ops` path), forward (`is_undo = 0`), and not already reversed (via `op_log.reverses_device_id/reverses_seq` provenance, migration 0101; a target is "currently reversed" while an unreversed reverse of it exists, so undo→redo→undo cycles stay legal).

The **positional** path (`undo_page_op` / `undo_page_group`, `LIMIT 1 OFFSET undoDepth` — the documented invariant-#3 carve-out) survives as the fallback for flows whose commands don't yet surface refs (`move_blocks_batch`, `create_blocks_batch`) and for history predating ref tracking; `undoDepth` is display/fallback state only. Redo is unchanged: the redo stack already held refs, and a redone group's `new_op_ref`s are pushed back as one ref entry.

Reverse-op table (canonical):

| Source op | Reverse op |
| --- | --- |
| `create_block` | `delete_block` (soft delete) |
| `edit_block` | `edit_block` with the captured previous content |
| `delete_block` | `restore_block` |
| `restore_block` | `delete_block` |
| `purge_block` | **non-reversible** |
| `move_block` | `move_block` to the previous parent + position |
| `set_property` | `set_property` with previous value (or `delete_property` if absent) |
| `delete_property` | `set_property` with captured previous value |
| `add_tag` | `remove_tag` |
| `remove_tag` | `add_tag` |
| `add_attachment` | `delete_attachment` |
| `delete_attachment` | conditional: `add_attachment` with captured metadata if available; otherwise non-reversible |

Prior-state lookups for `edit_block` / `set_property` / `delete_property` reverses use the **op log** (walk backwards from the target seq to find the predecessor value), not the materialised `blocks` row. The materialised state is the current value; the op log holds history.

## Recurrence

Repeating tasks rely on a shared per-block projection function (`src-tauri/src/recurrence/projection.rs::project_block_dates`) that both the cache rebuild (`projected_agenda_cache`) and the on-the-fly fallback (`list_projected_agenda_on_the_fly`) call. The function owns: rule parsing (`+` / `.+` / `++` mode dispatch), `plus_plus` catch-up + pre-emit, `until_date` / `remaining` end conditions, the 10 000-iter safety bound, and `[range_start, range_end]` clipping. The two callsites disagreed once on `.+1w` projection — the parity test `projected_agenda_cached_equals_on_the_fly` pins agreement.

Marking a repeating task DONE rolls it forward: a synthetic new occurrence is generated, `repeat-seq` increments, the previous occurrence stays as a completed entry in History.

## Viewport rendering

The block tree uses an `IntersectionObserver` placeholder pattern (`SortableBlockWrapper`): offscreen blocks become zero-height placeholders to preserve scroll position, while keeping the React tree mounted. The focused block is never virtualised — its editor state must survive scroll. DnD overlays the placeholder pattern with `WhileDragging` measurement so drag-and-drop sees real depths.

Note the phrase "keeping the React tree mounted": the IntersectionObserver pattern above is a *paint* optimization, not a *mount* one. An offscreen block stops painting, but its `SortableBlockWrapper` fiber, hooks, and listeners stay live. On a large flat page (or one the user hasn't collapsed) that means one mounted fiber per block regardless of viewport — see § Mount envelope below for the FE-side bound on that.

## Mount envelope (#2467)

The backend has a precise, bench-validated envelope (`docs/architecture/operations.md` § Memory footprint & scaling envelope; `interactive_slo.rs` gates CI at 100K blocks/space) and a hard per-page load cap (`PAGE_SUBTREE_MAX_BLOCKS = 10_000` in `commands/pages/listing.rs`, surfaced to the user via `blockTree.truncatedNotice`). Until #2467, the frontend had no counterpart: every block `load_page_subtree` returned was mounted as a React component, so a page anywhere near the backend's 10K cap meant 10K mounted fibers — the "full-tree mounting" cliff the frontend architecture review flagged.

**What exists today (this slice):** `useBlockMountLimit` (`src/hooks/useBlockMountLimit.ts`) caps how many of the collapse-filtered rows actually mount, applied in `BlockTree.tsx` immediately after `useBlockCollapse` and before zoom/DnD/keyboard-nav — everything downstream of that point only ever sees the capped set, so the mount cap composes with collapse instead of conflicting with it.

- **`INITIAL_MOUNT_LIMIT = 500`** rows mount on first render of a page.
- **`MOUNT_LIMIT_STEP = 500`** more rows mount per click on the boundary row (`BlockListRenderer`'s `block-tree-mount-boundary`), which reports how many rows remain hidden (`blockTree.mountBoundary`, i18n-pluralised).
- Rows beyond the limit are **not mounted at all** — not placeholders, absent from the DOM — until revealed. The limit resets when the page changes (`rootParentId`), mirroring the per-page collapse-state reset (#752); BlockTree is not remounted on page switch (journal week/month views swap pages in place), so without the reset an expanded limit on one large page would leak into the next.

**These numbers are a conservative safety rail, not a measured cliff.** #2467's "Measure" phase — an e2e/bench fixture at 1K / 5K / 10K blocks/page recording mount time, keystroke latency, and splice cost — has not been run. There is no browser-measured per-block mount cost or keystroke-latency-vs-block-count curve backing `500`; it was chosen only as "comfortably below the ~10K fiber cliff, comfortably above typical page sizes" so it stays invisible for the vast majority of pages. Treat it as provisional until real numbers exist, the same epistemic stance `operations.md` takes on the (also unmeasured) per-device peak-RAM-at-N-blocks figure.

**What this does NOT cover** (left for later phases, per #2467's suggested scope):

- **No true virtualization.** Rows within the cap still cost a full mounted fiber each; this only bounds the ceiling, it doesn't reduce steady-state cost below it. Real windowed rendering (DOM recycling) for non-focused static rows remains open.
- **No fold-aware lazy loading via `load_page_subtree` depth limits.** The backend command is unchanged — it still returns (and the store still holds) every block up to `PAGE_SUBTREE_MAX_BLOCKS` in one shot; the mount cap only bounds what renders from that already-loaded set. Adding a `limit`/depth parameter to `load_page_subtree` so the backend itself streams a page incrementally is a natural next phase and was deliberately left alone here (Rust command surface, out of scope for this slice).
- **No store-level chunking.** `usePageBlockStore`'s `blocks` array still holds the full loaded set; only the render path is capped.
- **Batch metadata IPCs are not scoped to the mounted set.** `useViewportWindow`'s `windowedBlocks` (properties/attachments/link-resolve batching, #1268) conservatively treats any never-measured block as "in window" — including mount-cap-excluded blocks, which are never measured because they're never mounted. This is a pre-existing characteristic shared with manually-collapsed subtrees (same gap, smaller blast radius before this change); scoping it to the mounted set is a cheap, low-risk follow-up.
- **DnD across the mount boundary is not specially handled.** Dropping "after the last mounted row" is a valid position (it lands immediately before the first hidden block), so no special-casing was needed for the common case, but dragging a mounted block whose subtree extends past the boundary won't visually carry its unmounted descendants during the drag (the backend move itself is still correct — children move via `parent_id`, independent of what the FE had mounted).

## Zoom-in

Block zoom is a per-block focus mode. The breadcrumb in the page header shows `Page › Section › Block`; clicking a breadcrumb segment zooms out. Zoom state is ephemeral (not persisted, not synced) — closing the page or navigating away resets to the page root.
