# Session 2436 — Happy-path specs for the editor

These are #5733's mock-lane items, part of the #5726 sweep. Each spec was
shown red by a product mutation, and a reviewer re-ran every mutation.

**Shipped:**
- **`editor-keyboard-chords.spec.ts`**
  - Ctrl+Shift+S, Ctrl+Shift+H and Ctrl+U mark a word, and the marks
    survive a reopen.
  - Chromium underlines on Ctrl+U by itself, so the spec cannot tell the
    app's binding from the browser's.
  - Ctrl+Backspace deletes an empty block and focuses the one above.
  - Ctrl+Shift+V pastes two Markdown lines into the one block as typed.
- **`batch-toolbar-actions.spec.ts`**
  - Batch delete sends three blocks to Trash, and undo brings them back
    after a reopen.
  - Batch Cycle priority sets P1 on every selected block.
  - Bulk Indent nests every selected block.
- **`link-hover-preview.spec.ts`**
  - Hovering a link chip shows the fetched title.
  - With "Fetch link previews on hover" off, an uncached link's preview
    closes without a title. Turned back on, it shows the title.
- **`external-image-policy.spec.ts`**, new describe block:
  - Always load mounts the `<img>`, and Ask each time brings the domain
    placeholder back.
  - Never load shows the blocked note with no Load button.
  - The image URL is routed to a local PNG, so no test touches the network.
- **`drop-upload.spec.ts`**
  - A dropped file of 1 MB or more shows the Attaching toast, then
    Attached, and is still listed on the block after a reopen.
  - A disallowed type is refused with a toast that names the allowed
    types.
- **`inline-image-fold.spec.ts`**: a folded inline image stays a chip after a
  reopen and in the editor, and Expand restores it.

**Premises that were wrong:**
- The batch toolbar has no indent button. Bulk indent lives in the
  multi-select context menu's Move & arrange.
- Turning link previews off stops fetches only on a cache miss. A cached
  preview still shows, by design.
- The progress toast appears only from 1 MB up, and only the block being
  edited takes a dropped file.
- A folded image never shows as a chip in a search result row, by design:
  results render non-interactive.

**Fixed on the way:** Ctrl+Shift+T typed `/turn` instead of opening Turn
into. That fix and its spec ship in their own PR.

**Not here:**
- Edit as Markdown's draft and Reload items, held while page mode settles;
- the `e2e-tauri` items: audio attachments, `/voice` (blocked on #5730),
  draft restore at boot, the debounced commit, and the leaked-block sweep.

**Ran:**
- the six spec files together (14 passed), and with `--repeat-each=3`;
- `npm run typecheck` and oxlint.
