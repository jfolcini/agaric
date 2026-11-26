# Session 4470 — a bridge worker re-seeds its template when the date changes

#7091's bridge shard went red at three tests that count pages. Each found one page more than it expected: `pages-view` › "default journal chip" (7 pages, not 6), `pages-view` › "Orphan narrows" (5 matching, not 4), and `pages-browser-happy-paths` › "a saved view…" (7 titles, not 6). Its tests ran between 00:01 and 00:03 UTC.

**Cause.** A Playwright worker seeds its bridge's template vault once (`e2e/bridge.ts`), and every test gets a copy. The seed writes today's journal page and dates counted from today, using the date it runs on. This worker seeded before midnight. After midnight, the app and the specs (`localDateStr(new Date())`) read the new day, so the seeded journal page became an ordinary past page beside today's.

**Fix.** `Bridge.reset()` replaces `request('reset')`. When the local date differs from the day the template was seeded, it stops that bridge and starts a fresh, re-seeded one first. Only `e2e/helpers.ts`'s `realBackend` fixture resets.

**Ran.**
- A seed run under a clock shifted one day back makes the date check restart the bridge, and the journal-chip and Orphan tests pass. With the check removed, the same run fails both tests with CI's counts (7 vs 6, 5 vs 4).
- `npm run typecheck:e2e`, oxlint and oxfmt.
