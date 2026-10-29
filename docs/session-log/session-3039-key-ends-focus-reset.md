# Session 3039 — A key pressed just after focus is not undone by ProseMirror's focus heuristic

`bubble-keyboard.spec.ts`'s page-mode test failed in CI on an unrelated PR. After the selection bubble's Bold, the test's second keyboard selection (`Ctrl+Home`, then five `Shift+→`) came back empty.

**The cause is in prosemirror-view, and it is real for users.** `DOMObserver.flush` restores the editor's own selection when all of these hold:
- the DOM caret moves to the document's start with no mutation;
- it happens within 200 ms of a focus event (the private `view.input.lastFocus`);
- there was no click or touch first.

It is meant to undo Chrome resetting the selection on focus. Bold hands focus back to the editor, so a quick `Ctrl+Home` landed inside that window and was put back. The `Shift+→` that followed then shrank the old selection.
- The check runs in every browser, and prosemirror-view 1.42.8, the latest, still has it.
- No public API controls it.

**Changed:**
- `KeyEndsFocusReset`, in the roving editor's block extensions, so both block mode and page mode get it: a keydown in the editor ends the window.
- The spec's `selectWord` waits until the caret is at the document's edge before extending. That makes the spec fail every time without the fix, not one run in eight.
- A vitest pins the private field: a keydown clears it, a keyup does not. It also catches a prosemirror-view upgrade that renames the field.

**Why it is safe:** a typed character mutates the DOM, so the heuristic never applies to it, with or without the fix. The reviewer typed a character at once after six kinds of focus (Shift+Tab back from Bold, a click, a DOM `focus()` with no selection, Tab back in), in both the journal and page mode. The character landed in the same place with and without the fix, in every run.

**Numbers:**
- Under load: 4 of 30 runs failed before the fix; 30 of 30 passed after; the reviewer saw 40 of 40 pass.
- The editor keyboard specs: 92 passed.
