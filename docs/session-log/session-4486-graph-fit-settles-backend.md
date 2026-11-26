# Session 4486 — the graph fit test settles the backend before it opens the view

`graph-view.spec.ts`'s "…Fit to view returns there (reduced motion: reduce)" failed 3 times in 14 attempts on the bridge, while a cargo build loaded the box. Each time, the transform after Fit to view differed slightly from the first settle's fit. CI has not reported it.

**Cause.** `seedLinkedPages` writes 88 pages through the real commands and the test opens the Graph view straight away. Each write's `blocks:changed` lands only after its cache rebuilds, so the graph refetches after it has drawn. The refetch lays the nodes out again. Under reduced motion the first layout and its fit are synchronous, and the re-layout comes after that one fit, which never repeats. Fit to view then fits the moved nodes. The animated layout takes about 5 s to settle, so the refetch lands inside it and the first fit already sees the final layout. `e2e/AGENTS.md` names this trap and its remedy, `settleBackend(page)` after a seed, which `seedBulkPages` and `seedFacetPage` already call.

**Fix.** `seedLinkedPages` ends with `settleBackend(page)`. That covers its two callers: this test and "hovering a node labels it and every neighbour".

**Ran.** All on the bridge, built from this branch's base.
- A probe recorded the canvas size, the node count and one node's position after the first fit and again 2 s later.
  - Without the fix, the reduced-motion node moved (x 367→337) with the size and count unchanged, and the test failed 2/2 with that dwell.
  - With the fix, nothing moved in 8 runs, 4 per variant, and all passed.
- `slowMaterializerMs: 1500` did not widen the race: the refetch then lands after the test has finished.
- The whole spec with the fix, `--workers=4 --repeat-each=3`: 72/72.
- oxlint and oxfmt.
