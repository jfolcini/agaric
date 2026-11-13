# Session 3961 — the query cache evicts after five minutes

`Refs #6539` (the cache item; generated event types and binary uploads stay open).

The client default in `src/lib/query-client.ts` was `gcTime: Infinity`, and several keys carry
typed text or a filter set (advanced query, inline queries, pages filters), so every distinct query
left an entry for the session. The default is now five minutes, TanStack's own client
default written out. The property key and value caches stay for the session through
`queryClient.setQueryDefaults([root], …)` in their modules, which covers every reader with one
line each.

Decisions and traps:

- Seven hooks set a five-minute `gcTime` and argued against the infinite default; review deleted
  the overrides and their comments, since the default now does the same. The #3316 test in
  `useUnlinkedReferences.test.ts` reads the entry's `gcTime`, so it still pins the bound.
- "Returning to an unchanged list sends no IPC" (#5446) now holds only within five minutes of
  leaving the Pages list; after that a return loads page 1. Raised with the maintainer.
- Pages scroll restore never takes effect on a return to a cached list, on `main` too (seen in
  Playwright: the saved offset is kept, the list comes back at the top). After five minutes away
  it now lands at the end of the first batch. Reported for an issue, not fixed here.
- `--range` replaces the working tree as `scripts/e2e-related.sh`'s diff source (the last source
  given wins), so before a commit run `just e2e-related` with no arguments.
- Test pattern: load with real timers, switch to fake timers before the key change, so the
  collection timer lands on the fake clock.

Ran: full vitest, typecheck, lint, and the Playwright specs on the affected surfaces. No spec can
show the eviction itself, since each Playwright test gets a fresh page.
