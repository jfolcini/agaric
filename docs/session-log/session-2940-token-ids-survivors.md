# Session 2940 — token-ids mutation survivors

#5966, reopened by the maintainer with two survivors in `src/editor/token-ids.ts`, both ConditionalExpression: `kept !== null` in `idsAfter` made true, and `id === null` in `withPageIds` made false. Stryker on the module at `origin/main`: 114 killed, 3 survived, the third being the `takenIds` guard that `mutation-accepted.tsv` already held.

**Deleted:** the `id === null ||` arm in `withPageIds`. A block with no id that is not in `pageIds` is rebuilt with `blockId: null`, an equal block, so the guard changed nothing. Deleting beat accepting here: the accept key has no replacement, so an entry at that column would also have hidden the whole condition made false, which a test kills today.

**Accepted:** `kept !== null` made true. An id-less block then takes the arm that pushes `kept`, which is null, as the else arm does, and the null it adds to `held` is read only by later id-less blocks, which push null either way. Deleting the guard instead would mean widening `held` and `taken` to hold null. Its reason line says the key also covers the whole condition made true or false at that column, which the Enter and undo-after-a-peer tests kill today.

**Moved:** the test file's "equivalent mutants, accepted" paragraph is gone. Its `takenIds` reason is now the `#` line above that entry in `mutation-accepted.tsv`, and its other two items are the deletion and the new entry.

**Suites:**
- the token-ids, source-buffer, page-block-ids, page-mode editor and property tests (382 of 382);
- typecheck and oxlint;
- Stryker on the module after the change: 110 killed, 2 survived (both accepted), 0 no-coverage;
- a filer dry run over that report with no known body: 2 findings, 2 suppressed as accepted, nothing new. The same dry run over the before-report reports the `withPageIds` guard as new.
