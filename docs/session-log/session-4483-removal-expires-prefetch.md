# Session 4483 — a page removal expires the subtrees prefetched before it

`trashed-page-recents.spec.ts` failed once on the bridge lane in #7105's run, on a diff that could not have caused it. The failure showed a trashed page opened from the recents strip, with "Welcome to Agaric!…" in its block tree and no toast. That is the #5243 bug the spec was written for.

**Cause.** Hovering a Pages row arms a 120 ms dwell, then holds the page's `load_page_subtree` result for 8 s (`prefetch-page-subtree.ts`). Only `recordGraphStructureChange()` expires it. #6545 S2b (5ad751397) dropped the hand calls that followed a local command and left the refresh to the change feed's structure arm. The feed lands only after the cache rebuild. S2b kept an immediate call for restores and page-store writes, for exactly this cache, but page removals lost theirs. A recents click in the gap before the feed opened the deleted page from its pre-delete snapshot.

**Fix.** `notifyPagesRemoved` calls `recordGraphStructureChange()` first, before its early returns. Every page removal reaches it: single delete, batch trash, the block tree's multi-select delete and page move. The doc comments in `graph-structure-events.ts`, `prefetch-page-subtree.ts` and `name-change-bus.ts` name it beside restores and page writes.

**Ran.**
- Bridge reproduction, on the unchanged spec with 6 busy-loop CPU hogs, `--repeat-each=40 --workers=4`: 1 failed of 40, with CI's snapshot.
- A throwaway copy of the spec widened the window: `slowMaterializerMs: 1500`, and a row hover with a 400 ms dwell before the Delete click. It failed 12/12 before the fix and passed 12/12 and 40/40 after. The unchanged spec under the same load passed 80/80 after.
- Two vitest cases, each shown red:
  - `usePageDeleteAction`: a subtree prefetched before the delete is gone after it. Without the call it fails on `expected Promise{…} to be null`.
  - `name-change-bus`: a removal with no active space, or above the fan-out budget, still bumps. With the call moved below the early returns it fails on `expected +0 to be 1`.
- The vitest files around the change, `npm run typecheck`, oxlint and oxfmt.
- An independent review traced every page-removal path to `notifyPagesRemoved`, and checked why S2b removed the call: as redundant, with no measured cost.

`graph-view.spec.ts` "Fit to view returns there" also failed 2 of 72 times in the bridge runs. It is a separate, older flake with its own fix.
