# Session 3961 — the query cache evicts after five minutes

`Refs #6539` (the cache item; generated event types and binary uploads stay open).

The client default in `src/lib/query-client.ts` was `gcTime: Infinity`, and several keys carry
typed text (advanced query, inline queries, block history, pages filters), so an unobserved entry
per keystroke stayed for the session. The default is now five minutes, TanStack's own client
default written out. The property key and value caches stay for the session through
`queryClient.setQueryDefaults([root], …)` in their modules, which covers every reader with one
line each.

Decisions and traps:

- Seven hooks already set a five-minute `gcTime`, now equal to the default. They stay:
  `useUnlinkedReferences.test.ts` (#3316) requires the hook to override.
- Pages-list scroll restore past the first batch now holds only within five minutes of leaving
  the list, and so does "returning to an unchanged list sends no IPC" (#5446). Raised with the
  maintainer.
- `just e2e-related --range` ignores the working tree: the recipe's `--worktree` is overridden by
  `--range`. Before a commit, call `scripts/e2e-related.sh --worktree`.
- Test pattern: load with real timers, switch to fake timers before the key change, so the
  collection timer lands on the fake clock.

Ran: full vitest, typecheck, lint, and the Playwright specs on the affected surfaces. No spec can
show the eviction itself, since each Playwright test gets a fresh page.
