# Session 3954 — the table-cell link spec waits for the caret to reach the cell

`e2e/table-cell-link-backlink.spec.ts` failed once in CI (#6637, a PR that touches no editor code).
The page snapshot showed the header cell holding `[Meetings|the meetings]]`: the first `[` was lost,
so no link was made.

Cause: the spec pressed Enter on the table grid and typed at once. The caret reaches the first cell
of the new table a moment after the grid closes, and a key sent before that goes nowhere.
Reproduced by sending Enter and the text together: 3 of 3 runs fail with the CI assertion.

The spec now polls until the selection is inside the editor's header cell before typing, the wait
`table-view-render.spec.ts` already uses. Not a product defect: a person cannot type inside that
gap.

Checks run: the spec 20 times; `node --test scripts/e2e-related.test.mjs`.
