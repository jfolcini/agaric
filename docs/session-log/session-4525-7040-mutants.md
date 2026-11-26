# Session 4525 — the surviving mutants from the last day's PRs

The maintainer asked for every mutant the PRs of the last day reported, killed. The diff-scoped mutation lane's comments on the 70 PRs updated in that window named four modules with survivors.

**Already dead**

- `meeting-dialog` (#7101): #7118 added the test for its one survivor.
- `snapshot.rs` (#7110): that PR's two engine tests killed its three.

**Killed here**

- **`page-collapse`, `withSections`:** a heading the caret's selection shows folds nothing, so Tab on a selection from the heading into its section moves only the selected blocks. Survived since #7145; the new test was red with the `revealed` filter removed.
- **`page-collapse`, `unfoldLanded`:** its empty-list guard did nothing. Every transaction it is given changes the blocks, and that re-lays the page anyway. The guard is deleted.
- **`page-tasks` (#7147):** a block's `dir="auto"` and its controls' `dir="ltr"`. A vitest now pins both; each was red with its value blanked.

**Accepted as equivalent** (`mutation-accepted.tsv`, each with its reason)

- `EXPAND`'s text, which only the constant itself reads.
- `firstChild?.`: a page block's content is `block+`.
- The `expanded !== undefined` arm. Each transaction that carries the meta also re-lays the page another way: a move or drop changes the blocks, and a split's `keepHidden` takes the caret out of the reveal.

**Tests**

- Stryker on `page-collapse` against this branch: 252 killed. Its 8 survivors are all accepted entries, 0 left once the accepted list is applied.
- Stryker on `page-tasks` against this branch: 556 killed, two more than on #7147. Its survivors are all accepted entries.
- vitest on `src/editor/page-mode`, and `npm run typecheck`.
