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

Three readers of link-derived data now refresh on the structure counter.
The first two are TanStack queries and use it to *invalidate*, not to
re-key: the counter moves at every typing pause (the 700 ms content commit
plus its 150 ms debounce), and a new key means a cache entry with no data,
which emptied the panel into a skeleton, dropped the Load-more pages and
snapped the expanded groups shut on every pause. Invalidating the query's
prefix refetches the loaded pages in place with the rows still on screen.
Linked References keeps the property counter in its key as before; Unlinked
References had no refresh signal at all (its own comment said so), and a
mention becoming a link is a content edit, so the structure counter is its
axis. The journal week and month badge counts (`useBatchCounts`) are a plain
effect and re-run on it. "Link it" in Unlinked References calls the command
directly, bypassing the store that bumps the counter, so it bumps it itself;
without that the Linked References panel above it kept the pre-link list.

Each has a test that bumps the counter after the first fetch and asserts the
second answer arrives; the two panels also have a test that parks the refetch
and asserts the rows and the header count stay on screen meanwhile, which is
the assertion that separates invalidating from re-keying. Removing any one
invalidate call, the badge-count dependency or the Link-it bump reddens
exactly its test.

## Verified

- vitest on the backlinks components, `useUnlinkedReferences`,
  `useBacklinkGroups` and `useBatchCounts`: 10 files, 181 passed.
- `npm run typecheck` exit 0.
- Falsified on copies, restored `cmp`-clean: each invalidate call removed,
  the batch-counts dependency dropped, and the Link-it bump removed; each
  reddens its own new tests.
- Reproduced beforehand against the mock with a throwaway Playwright spec
  (not committed): a second incoming link from another page shows after a
  remount, which is what the maintainer can do by hand; the mounted case is
  what this change fixes and is pinned by the component test.
- Not run locally: the full suites (CI carries them; the laptop is in use).
