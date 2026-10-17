# Session 2437 — An emoji picked from the emoji picker lands in the block

#5734's picker specs found this. An emoji picked from the browse-grid picker,
opened by `/emoji` or the toolbar's Emoji button, never reached the block.
Nothing was logged.

**Cause:**
- The picker's Dialog took focus.
- `useEditorBlur` read that as leaving the editor, so it saved the block and
  unmounted the roving editor.
- The editor stayed registered as the active editor, so the insert went into
  its detached document and reported success.

**Fixed:**
- **The picker is an editor portal.** Its Dialog and its mobile Sheet carry
  `data-editor-portal`, as the block date picker does. The editor stays
  mounted, and the emoji lands at the caret.
- **No more empty-block exemption.** `openEmojiPicker` no longer registers
  the block in `preserveEmptyBlockIds`. With no blur there is nothing to
  exempt, and an unused registration would spare the next genuinely leaked
  blank block. A `BlockTree` test pins that the blank block is now cleaned
  up.

**Specs:** `e2e/emoji-picker.spec.ts`.
- `/emoji` and the toolbar button each insert 🚀 between two words.
- The editor keeps focus, and the text survives a reopen.
- Both tests were red against the unfixed code: no editor was left after
  the pick.

**Unit tests:**
- `EmojiPickerDialog.test.tsx` checks that both shells read as editor
  portals.
- `BlockTree.test.tsx` has the cleanup case above.

**Left alone:** Escape without a pick leaves the block mounted but without
a caret, the same as `/date` does today. Nothing is lost: a click elsewhere
saves the block.

**Ran:**
- the emoji, slash, page-kebab, emoji-in-titles, settings and page-mode
  specs;
- vitest on `src/components/EmojiPicker` and `src/components/editor`;
- `npm run typecheck`.
