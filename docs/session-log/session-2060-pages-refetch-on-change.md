# Session 2060 — Pages: refetch on return only after a write

Item 2 of #5446, the maintainer's "option 5". Returning to Pages refetched
every loaded page (`refetchOnMount: 'always'`) even when nothing had changed.

Every generated command that can write a note now marks the Pages list stale
when it settles: `watchLocalWrites` wraps the `commands` table once at boot,
classifying by name and failing toward "write". The read classifier moved out
of `conformance-coverage.test.ts` into `src/lib/local-write-watch.ts` so the
test and the watcher share one list. Synced and MCP writes keep invalidating
through `useSyncEvents`. A mount refetches only an invalidated list; sort,
filter and space switches still refetch through `isStale`, checked against
the installed TanStack source.

Trap found in review: `flush_all_drafts` runs on every window hide, so any app
switch made the next return refetch everything. It is now a non-note write:
the typing a draft holds is already committed by the shorter
`useDebouncedContentCommit` debounce. Left as known: a crash-recovery flush at
boot no longer marks the list stale, and an immediate refetch after deleting
or restoring a page can read other pages' counts before the background cache
rebuild lands, as before.

Suites run: full vitest in shards, `npm run typecheck`, `npm run lint`, the
`pages-reopen`, `pages-view`, `perf` and `boot-ipc-counts` Playwright specs
against a fresh e2e build, each new test shown red against a mutated copy
(including the `main.tsx` wiring and the draft-flush exclusion).
