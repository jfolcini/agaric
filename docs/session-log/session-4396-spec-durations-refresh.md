# Session 4396 — the mock shards' timings, measured again

After #6996, `playwright (2)` took 10.7 min against 5.5 for the other two mock shards (#7005's last run). The dealer, `scripts/playwright-shard.mjs`, splits spec files by `e2e/spec-durations.json`. That file timed only 165 of the 205 files the mock lane now runs, and counted each of the other 40 at the median, among them `views-axe` (54 s), `table-handles` and `sticky-toolbar`. Some of its known times had also drifted: `mobile-overflow` went from 234 s to 143 s.

**Change:** `e2e/spec-durations.json` is regenerated with `node scripts/playwright-shard.mjs --update` from one JSON-reporter run of the whole mock lane, on main a531ce9: 1081 passed, 15 failed. The 15 failures are this container's: tests that launch the missing `chrome-headless-shell`, and `diagram-legibility`, which fails the same way on main here. A failed test's time is left out, so its file counts at the median.

**Ran:** the dealer gives 894 / 894 / 892 test-seconds by the new times. The times are local, so CI's shard lengths are the real check.
