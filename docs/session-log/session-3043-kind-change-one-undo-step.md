# Session 3043 — A kind change and the list kind it took off are one page-level undo step (#6156)

The maintainer decided #6156 (comment 6481100003): a kind change undoes in one step, in both modes. Examples are a list block made a heading, a callout, a quote or code, or a task made a list block, or the reverse. Before this, the clear of the list style or task state was a separate write that no undo entry held. Ctrl+Z gave back the text, and the bullet or task stayed lost.

**Changed:**
- `setListStyle` and `clearListStyle` return their op refs.
- Every path that changes a block's kind records them into the same undo entry as the change:
  - `/h1`–`/h6`, `/callout`, `/code`, `/quote`;
  - Turn into from the slash menu, the toolbar and the block menu;
  - `/bullet-list` and `/numbered-list`;
  - a typed `- ` or `1. `;
  - the store's `edit`;
  - page mode's list-style action.
- A task state cleared by a list pick joins that entry too.
- The review found one more path: the toolbar's Turn into → Code block cleared the style before the block's text was committed, so the clear landed in no entry. It now commits first, as `/code` does.

**What this does not cover:**
- **In-editor undo.** Ctrl+Z inside the editor is ProseMirror's own history. After `/h2` in page mode it gives back the text but not the bullet, and in page mode that is the Ctrl+Z people use. Only a page-level undo, with no editor focused, restores both. `docs/features/editor.md` says so. Part 2 of #6156 closes it.
- **Task states have no op refs.** `clearTaskStates` writes them through `set_todo_state_batch`, which returns none. Its entry joins ref-less, which makes the entry positional (undone by op time).
  - It works for the common case.
  - It can undo an unrelated write made within the same 500 ms.
  - In one narrow case it drops older typing from undo: a task block typed in, then converted with the block menu's Turn into.
  - The review found that `delete_property(todo_state)` returns refs. Part 2 switches to it, once the mock's undo of that delete is fixed and a backend-authored fixture pins it.
- **The 500 ms window.** The style write must land within the undo store's grouping window, or one change becomes two undo steps. Every path has exactly one write between the two records.

**Tests:**
- 10 store and command tests, and 7 e2e cases (block and page mode: a heading, a task made a bullet, a bullet made a task, a bullet made code from the toolbar). Each shown red by removing the record it covers.
- One existing assertion changed: "`/numbered-list` does NOT call `onNewAction`". It pinned exactly the behaviour #6156 reverses, and it now asserts the exact refs recorded.
- The review also checked:
  - redo on both paths restores both halves;
  - 193 Playwright specs, whose only failures (`block-line-break` on iPhone, `diagram-legibility`) fail identically on `main`.
