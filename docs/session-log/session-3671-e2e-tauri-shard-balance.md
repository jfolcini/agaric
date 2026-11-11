# Session 3671 — deal the real-backend shards by measured spec time

Part of the slow-test sweep. The e2e-tauri lane, which `e2e-tauri-gate` (a required context) waits on, ran its three shards at very different lengths. Over the lane's last 10 green full runs, shard 3's specs took about 500 s against about 340 s and 390 s, because dealing by name round-robin happened to put the slowest files (`sync-large-vault`, `agenda-projected-repeat` and others) together.

wdio's `--shard i/n` runs the i-th contiguous slice, sized by count alone (`ConfigParser.shard` in @wdio/config: `round(N / n)` per slice, the rest to the last). `dealSpecs` in `wdio.conf.ts` keeps those slice sizes and fills them longest spec first, each into the slice with the least time so far. The times come from `e2e-tauri/spec-durations.json`, which `node scripts/e2e-tauri-durations.mjs` rewrites from the lane's recent green CI logs (the runner's RUNNING/PASSED line per spec). A spec missing from it counts as the median, so a new spec needs no step. On the committed data the shards come to 408/407/408 s instead of 391/340/492 s.

The unit test cuts slices the way wdio does rather than importing `@wdio/config`, which is not a direct dependency. If wdio ever slices differently, balance degrades but every spec still runs.

Ran: `npx vitest run e2e-tauri/` (52 passed); `npm run typecheck`; `npx knip`; oxlint and oxfmt on the touched files. The new tests went red once with round-robin dealing restored, and again with the median fallback replaced by 0.
