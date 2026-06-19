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
- **Typing during sync.** No pause-sync-while-typing lock; the FE editor and the sync daemon run independently. Remote ops applied during your edit are written to the underlying block; on blur, your FE markdown becomes the new committed content. The previous version persists in `op_log` for undo / history view.

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

## Zoom-in

Block zoom is a per-block focus mode. The breadcrumb in the page header shows `Page › Section › Block`; clicking a breadcrumb segment zooms out. Zoom state is ephemeral (not persisted, not synced) — closing the page or navigating away resets to the page root.
