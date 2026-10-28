# Session 2945 — page-save mutation survivors

#5962 listed twenty survivors and one no-coverage mutant in `src/editor/page-mode/page-save.ts`, most of them in `losesText` and in `planDeletes`' `carried`. Stryker on the module at `origin/main`, on a loaded box, gave 381 killed, 32 timeout, 33 survived and 1 no-coverage, and the filer reported exactly the issue's 21 ids.

**Killed by nine tests in `page-save-edges.test.ts`.** Each edits a page and asserts what the fake backend was asked to write and what it holds after:
- A refused new block holds back every block under it, however deep.
- `losesText` holds back an edit whose new half failed to create in each of these cases: a block split between two of the same letter (`fo|o`); a first half that has grown longer than the whole was; a block that joins its own lines, because a line break is text.
- `losesText` writes the edit when the text only took a mark, and when the block was brought back by an undo and has no saved text to compare with. The second case is the one no test had run before.
- A delete waits for the edit of a block that carried in a block holding only a chip, the `￼` that `textOf` reads.
- An empty block's delete does not wait.
- A block whose peer-written child the document never showed is still deleted, with the child going along.

**Deleted, behaviour unchanged:**
- `planMoves` built its wanted children with `?? []`, and its stand-in child was always skipped as absent. It now uses the file's own `childrenOf` on a `PageTree`.
- `carried` returns early when the saved block has no node, so the `''` it compared against is gone.
- `runAll`'s `stopOnFailure` is optional. The edits and deletes, which never stop, pass nothing. Both `{ stopOnFailure: false }` literals were equivalent to `{}`, and the stale accepted entry for one of them (`const edited = await runAll(planEdits…`) and the live one for the other go too.

**Accepted:** `start <= shorter` in `losesText`. It steps past `shorter` only when both texts end there equal, and `losesText` is false either way. The reason line notes that the `>=` variant shares the key and is killed.

**Not changed:** `losesText(null, …)` is false, so a restored block's edit is written even when a block split off it was refused. The test pins that behaviour. Making it true would hold the restored block's edit back for as long as the refusal lasts, a trade-off outside a mutation pass.

**Suites:**
- the page-save, page-save-edges and remote-patch tests (104 of 104);
- typecheck and oxlint;
- Playwright `page-mode`, `journal-page-mode` and `page-mode-input` (48 of 48);
- each new test shown red against its mutant, with the source restored on exit;
- Stryker on the module after the change: 398 killed, 28 timeout, 14 survived (all accepted), 0 no-coverage. The remaining timeouts are mutants that loop forever, such as the start loop and `savePage`'s `for (;;)`;
- a filer dry run over that report: nothing new.
