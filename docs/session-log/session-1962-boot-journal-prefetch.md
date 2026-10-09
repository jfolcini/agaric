# Session 1962 — today's journal loads alongside the space list at boot (#5438)

The first journal block waited on a serial chain with a render between each
step: `list_spaces`, then the month's page map, then today's subtree. A new
day's first boot was seven calls deep.

What shipped:

- `src/stores/boot.ts`: before reconciling spaces, `prefetchBootJournal()`
  starts the month page-map fetch for the persisted space when the
  persisted view is the journal, then prefetches today's subtree. The real
  current space still comes from reconciliation (#5415); a stale persisted
  space costs one caught IPC.
- The page-map cache moved to `src/lib/calendar-page-dates-cache.ts` so the
  boot store can prefetch into it without a store importing a hook.
- `useCalendarPageDates` seeds its page map synchronously from a settled
  cache entry, and reports whether this mount fetched it.
- `useJournalAutoCreate` trusts a page map this mount fetched and skips the
  `get_journal_page_by_date` re-probe.
- `useJournalBlockCreation` creates the page and looks up the template in
  parallel; with no template it parks an empty subtree
  (`parkEmptyPageSubtree`) so BlockTree's first load skips a call that
  would return nothing.

Measured on the mock (`probe2.mjs`, timeline relative to `list_spaces`):
the page map now starts with `list_spaces` instead of 283 ms after it, and
today's subtree as it resolves instead of 685 ms after; a new day's chain
went from seven sequential calls to page creation and the template lookup
side by side, with the re-probe and the empty load gone. React commits
before the first block: 12 → 9 (29 → 18 on a new day). Latency medians
were taken on a loaded box and are not usable; re-measure idle.

Verified: falsified on copies (the fresh-map arm off, creating despite
today in the map, the serial template lookup, never parking, parking with
a template), all red, restored and `cmp`-checked. Full vitest 20,810 passed;
Playwright journal and spaces specs 17/17; typecheck, oxlint and oxfmt
clean. #5395 moves the template into the backend; it gates the park on the
backend having created no template blocks.

Review fix (same PR): the "this mount fetched the map" flag was not tied to
the space and range it was fetched for. `JournalPage` stays mounted across a
space switch, so in the render where the space (or the month, via Today)
changed, the old map read as fresh and could create a duplicate day page in a
space that already had one. The flag now compares the fetched key with the
current one. The template lookup no longer gates `notifyPageAdded`, and the
`prefetchCalendarPageDates` alias is gone (`fetchPageMap` is exported).
Verified: the untied flag reddens four hook tests and the new two-space e2e;
full vitest green in two shards; Playwright journal and spaces 18/18.
