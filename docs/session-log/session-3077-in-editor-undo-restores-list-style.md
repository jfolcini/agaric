# Session 3077 — Ctrl+Z inside the editor brings back the list style a kind change took off

This is #6156 part 2. Part 1 (#6176) made a kind change, and the list style it took off, one page-level undo step. The maintainer wants one step in both modes. So this part makes the in-editor Ctrl+Z (ProseMirror history) put the style back too, and a redo takes it off again.

**Why the editor decides:** the planned store-side fix could not work, for two reasons.
- `FlatBlock` carries no list style, and `delete_property` returns no prior value, so the store never knows which style it cleared.
- The store's `edit` cannot tell an undo from an explicit Turn into → paragraph or a Backspace on the `#`, because they reach it with the same content.

Only the editor sees history transactions and the marker it shows, so it decides in both modes.

**Changed:**
- **Page mode** (`page-lists.ts`):
  - When a block leaves its list, `PageLists` remembers `{style, depth}` for it, unless the change is itself an undo.
  - On an undo, a block whose depth is the current depth + 1, and which went from no marker to a marker, gets its style back through `setStyle`, so the write lands in the page-level undo.
- **Block mode:** a new `listStyleUndo` extension holds one slot. The undo of exactly that change sends `RESTORE_LIST_STYLE`.
  - The tree's handler flushes the draft, writes the style and records the undo, so the restore joins the saved text's entry.
  - It writes nothing if the stored content still shows a marker, meaning the change was never saved.
- **Undo recording:** `PageModeEditor` and `useListStyleSyntax` record through `notifyUndoNewAction`, which acts on #6176's review note.

**Red first:**
- **Page mode:** removing the restore loop reddens `page-lists` (`['none','none']` against `['none','ordered']`) and the page-mode e2e (`listStyle: null`).
- **Block mode:** removing the depth check makes a Backspace or a later change's undo ask for a restore.
- **The handler:**
  - removing the marker gate gives an extra write;
  - removing the flush splits the undo entry.
- **Each review fix,** removed alone, reddens its own test.

**Review fixed three page-mode defects:**
- **Spurious restore after a later change:** a leave caused by an undo was recorded. So after `/bullet-list` on a heading, the second Ctrl+Z gave a plain block a bullet it never had. This was reproduced in Chromium.
- **Delete then undo:** pruning entries when a block left the page lost the style on delete then undo. The pruning is gone; entries are bounded by the page's blocks.
- **After prosemirror-history's depth cut,** a stale entry could fire on an unrelated undo. The no-marker-to-marker check stops it.

**Known limits:**
- A typed `# ` takes two Ctrl+Z, because of TipTap's input-rule undo. This is documented.
- In block mode, undo, redo and undo again within the property refetch window restores nothing the second time.
- A task set after the leave is cleared by page mode's restore but kept by block mode's. Part 2B decides this, along with `clearTaskStates`' ref-less undo record and a real-backend spec.
- The redo of `/bullet-list` on a heading gives no bullet back. This predates this change.

**Suites:**
- vitest, the whole suite (23,775 tests);
- typecheck and lint;
- the manual-stage hooks;
- Playwright: `kind-change-undo` ×3, the undo, list and slash-command specs, and every `page-mode*` spec (184).
