# Session 2435 — Ctrl+Shift+T opens Turn into on a block with text

#5733's spec for the Turn into chord found it. On a block with text,
Ctrl+Shift+T typed `/turn` into the block and opened nothing. The picker
opens only for a `/` at a textblock start or after whitespace, and the
chord inserted it at the caret.

**Fixed:**
- **`openSlashPicker(editor, query)`** in `slash-command.ts` now opens the
  picker the way typing would.
  - It inserts `/turn ` at the start of the caret's textblock, with the
    caret before the space.
  - When the picker closes it deletes what it inserted and puts the caret
    back. After a pick, only the space is left to delete.
  - The cleanup tracks its own inserted range through every transaction,
    not the picker's. A caret moved into the block's first word used to
    stretch the picker's range over it, and closing then deleted user text.
- **`useFocusedBlockActions`** imports the module on use. A static import put
  the editor stack on BlockTree's startup graph, and the #2939 guard test
  caught it.

**Specs:** `e2e/turn-into-chord.spec.ts` covers three cases:
- picking Quote turns a block with text into a quote, and it survives a
  reopen;
- Escape leaves the text unchanged;
- moving the caret into the first word closes the picker and keeps the word.

`useFocusedBlockActions.test.ts` pins the same cases at unit level. The
spec and the first-word unit case were each red against the code they
cover.

**Known, not fixed (also on main):** if the picker stays open past the
content-commit debounce, the block is saved with the trigger text in it.
Page-level undo after a pick then shows that text once before the original.
A typed `/quote` does the same. Fixing it means the debounced commit
reading the slash plugin's state, which the lazy-editor rule (#2939) keeps
out of that hook.

**Ran:**
- vitest on `src/editor` and `useFocusedBlockActions`, and the
  lazy-editor import-graph test;
- the turn-into and slash-command specs, after rebasing on main;
- `npm run typecheck`.
