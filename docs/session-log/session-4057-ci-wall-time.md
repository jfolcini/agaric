# Session 4057 — CI wall time: three Playwright workers, four real-backend shards

The maintainer asked for the slow tests in CI to be fixed while about ten PRs queued on `validate / validate-all` and `e2e-tauri-gate`. This session measured first and changed only what the numbers pointed at.

## What was measured

The last 40 non-cancelled PR runs of `ci.yml` and of `e2e-tauri-weekly.yml` (2026-11-12 and 13), job and step times from the jobs API, and the job logs of six green runs of each.

- `e2e-tauri-gate` goes green a median 19.5 min after the push and `validate-all` 13.5 min, so the real-backend lane decides when a PR can merge. Its build ends about 5.4 min in, then three shards ran 9 to 10 min each.
- No job is slow because of its setup, and no test is slow by itself. Playwright's test time is flat (median 2.4 s a test, the slowest 10 s), the real-backend specs' slowest file is 55 s of about 1540 s, and neither lane has a fixed sleep worth removing.
- Jobs wait for a runner: a `cargo-tests` shard a median 1.5 to 2.3 min and a real-backend shard 2.4 min, with waits up to 43 min. Runner minutes are what the queue is made of, so a change that only saves minutes also shortens the wait.

## What changed

- **Playwright runs three workers per shard on CI, not two.** On a four-core box the files of shard 2 took 614 s on two workers, 466 s on three and 434 s on four, the last at twice the load average, so three is where it stops paying. The whole suite passed on three workers except two `diagram-legibility.spec.ts` cases that fail the same way alone on one worker here: this container's Chromium is older than the pinned one and lays a label out at 10.99994 px.
- **The real-backend lane runs four shards**, and `e2e-tauri/spec-durations.json` is regenerated with `node scripts/e2e-tauri-durations.mjs` (13 of 133 specs had no time and were dealt as the median).

## Traps

- **The `cargo-tests` disk cleanup is not obsolete, although the runner has room.** The job's log shows 107 GB free after the cleanup, which reads as if the deletes were no longer needed. The nightly `full-suite` logs print the disk before their own cleanup: 86 GB free at job start, on 2026-11-02 as well, two days before the job died with no space left (#6274). So the coverage run fills about that much. A skip-when-there-is-room change was written and dropped on that evidence. The likely cause is `cargo llvm-cov nextest` writing one `.profraw` per test process (its `LLVM_PROFILE_FILE` carries `%p`, and `LLVM_PROFILE_FILE_NAME` overrides it); nothing here measured it.
- **Playwright's shard times cannot be rebalanced from a local run.** Dealt by the old `e2e/spec-durations.json` or by a fresh one, the four shards hold the same test seconds when measured locally (1400 to 1424 s), yet shard 2 is the slowest on CI in five of six runs. The regenerated file was dropped: no gain to show.
- **One `top` snapshot is not a mechanism.** The first commit message said two workers left a core idle; the snapshot showed the four cores about 90% busy on two workers. The message now states the timings only.

## What ran

Full vitest (1097 files, 26677 passed), `npm run typecheck`, `npm run lint`, `prek run --all-files` and the manual stage. Playwright locally as above. The real-backend lane did not run here: this PR's own CI run is its first run on four shards, and its job times are the "after" in the PR body.

What was measured and left alone is in a comment on #6553.
