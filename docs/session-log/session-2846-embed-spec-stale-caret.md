# Session 2846 — the page-mode embed spec types into an empty block

Main's CI went red on `e2e/embed-typing.spec.ts`, page mode, right after #6044 merged. The spec clicked `first`, pressed End and then Enter, and polled the DOM selection between steps. ProseMirror reads a caret moved by End on the next `selectionchange`, so Enter could still split `first` at the click position. The DOM caret had moved, but the editor's had not; this is the race `selectEditorRange` in `e2e/helpers.ts` documents. The run's snapshot showed the caret at the start of `first`.

The spec now seeds `first`, an empty block and `last`, clicks the empty block, and waits until the selection sits in that block before typing `![[`. An empty block has one caret position, so no key has to move the caret. The expected contents stay `first`, the embed and `last`.

Shown red: the embed token written with `}` instead of `}}` (`pageEmbedContent` in `block-link-picker.ts`). The embed did not render, and `toContainText("Welcome to Agaric!")` failed.

Ran: `e2e/embed-typing.spec.ts` with `--repeat-each=6 --workers=2`, 18 of 18 passed.
