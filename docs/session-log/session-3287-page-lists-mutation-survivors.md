# Session 3287 — page-lists mutation survivors

The weekly sweep refiled 15 survivors and one no-coverage mutant in
`src/editor/page-mode/page-lists.ts` (#5977). The module's survivors had all
been recorded equivalent on 2026-10-19, but #6197's Document-dialect rewrite
changed those lines, so the entries matched nothing.

One was killable. `<` to `<=` in the history-depth check made a redo after an
undo that changed nothing count as an undo. A remote patch can delete a block
a history event typed into, so undoing that event changes no text and the
stored depth falls one behind. A new test drives that sequence: under `<=`,
the next Ctrl+Z does not give the list style back. The header note that
claimed the depth always moves was false and is gone.

The rest are equivalent, with reasons in the test file's header notes:
- the `findDiffStart` / `findDiffEnd` nulls come together;
- the redraw-only early return: every input a redraw reads already redraws, and `PageModeEditor` calls `tasksChanged` from its store subscription;
- the `id === null` checks, whose results are undefined or `'none'` for a null id anyway;
- `was` entries for blocks that are not due;
- the storage's starting depth, which is never below 0.

The no-coverage `''` in `itemOf` is not reached by a split or paste. TipTap
runs every `appendTransaction` before the view sees the state. TipTap's empty
document reaches it, with one block and no id, so a test now lays out an id-less
block between two numbered ones. The fallback is then covered, and its string
mutant is equivalent.

`mutation-accepted.tsv`:
- 9 entries whose line text is gone are deleted;
- 3 entries whose mutants are now killed are deleted;
- 6 survivors on `sameItems`' rewritten lines are recorded, beside the 16 findings.

Ran: Stryker on the finding lines and on the previously accepted lines, at a
60 s timeout (the default timeout turned survivors into timeouts on this
loaded box), and vitest on the three page-lists files.
