# Session 1688 — a mounted references panel learns about a new link

The maintainer saw two blocks linking a page and a Linked References panel
that said one. The database held both rows, the shipped SQL returned both,
and a Playwright run against the mock showed the panel correct on remount.
The panel was stale while mounted: it refreshed only on mount and on the
`block:properties-changed` counter, which the backend fires for property
commands and never for a `[[link]]` typed, pasted or synced. The repo
already had the right signal: the graph-structure counter (#1530), bumped by
the page-block store on every local op and by `sync:complete` for remote
ones. `GraphView` subscribed to it; the panels did not.

Three readers of link-derived data now fold the structure counter into their
refresh axis, the way `GraphView` does. Linked References adds it to the
property counter it already used. Unlinked References had no refresh signal
at all (its own comment said so); a mention becoming a link is a content
edit, so the structure counter is its axis and the property counter stays
out. The journal week and month badge counts (`useBatchCounts`) re-run
their fetch on it too; they were keyed only on the visible date range.

Each has a test that bumps the counter after the first fetch and asserts the
second answer reaches the screen (or the hook's state); removing the counter
from any one of the three keys reddens exactly its test. The Unlinked
References key-shape assertions gained the new slot, read from the live
counter rather than a literal.

## Verified

- vitest on `LinkedReferences`, `UnlinkedReferences` (both files),
  `useUnlinkedReferences` and `useBatchCounts`: 5 files, 139 passed.
- `npm run typecheck` exit 0.
- Falsified on copies, restored `cmp`-clean: the structure key dropped from
  the Linked References key, from the Unlinked References prefix, and from
  the batch-counts dependencies; each reddens its own new test.
- Reproduced beforehand against the mock with a throwaway Playwright spec
  (not committed): a second incoming link from another page shows after a
  remount, which is what the maintainer can do by hand; the mounted case is
  what this change fixes and is pinned by the component test.
- Not run locally: the full suites (CI carries them; the laptop is in use).
