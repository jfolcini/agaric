# Session 4428 — the npm registry retry covers a fault that lasts minutes

**Ask.** Fix every flake. #7050's first `validate / lint` failed in `npm audit signatures`. The registry's attestations endpoint answered `OK` instead of JSON for `playwright@1.65.1`. Its only re-run went green.

**Cause.** `scripts/npm-audit-retry.sh` waited 5 s, then 15 s, so its three attempts covered about half a minute. The bad answer came on every attempt, from 07:39:19 to 07:39:52 UTC. #7043's lint passed the same step at 07:43:01, so the fault lasted minutes, not seconds.

**Fix.**
- The waits become 5, 15, 60 and 150 s: five attempts across about four minutes, which would have reached past 07:43.
- The trade: a genuine advisory or signature failure now takes those minutes longer to red its job, which is still well inside the lint job's timeout.

**Review note from #7043.** `holdPeer` and `pullFromPeer` in `e2e-tauri/sync-two-device.e2e.ts` each carried the same wait for the sidebar's Sync to be idle. It is now one `waitSyncIdle()`.

**Edited assertions.** `scripts/npm-audit-retry.test.mjs` pins the budget. "attempt 1 of 3" and "attempt 3 of 3" become "of 5", and the sleeps `['5', '15']` become `['5', '15', '60', '150']`. Restoring the old backoff reddens both tests.

**Ran:**
- `node --test scripts/npm-audit-retry.test.mjs`, green, and red with the old backoff restored.
- `npm run typecheck:e2e-tauri`.
- oxlint and oxfmt on the changed TS and JS.
