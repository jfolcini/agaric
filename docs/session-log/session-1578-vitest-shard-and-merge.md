# Session 1578 — re-sharding the vitest lane (#4818)

## What happened

`validate / vitest` was cancelled at its 20-minute cap on both open PRs (#4819
at 20m15s, #4820 at 20m07s). A cancelled lane is not a test result: it fails
`validate / validate-all` while saying nothing about the code under review, and
it blocked two PRs that have nothing to do with the frontend suite's runtime.

Measured on `main` the same day: 14m38s and 18m09s. The cap was sized in
PEND-41 R1 against a ~10-11 min observed-equivalent job, so the suite had grown
into all of its headroom and ordinary runner variance was deciding the outcome.

## Why sharding rather than a bigger number

Raising the cap treats the symptom. The suite is now the workflow's long pole,
which is the situation sharding exists for — and this lane *was* sharded, three
ways with a merge job, until PEND-86 (`5335bc647`) collapsed it into one job.
Both reasons that commit gave have since expired:

> Three ~3-min shards cost three runner slots plus a 4th (merge) job while the
> critical path was gated by cargo-tests anyway; one full run (~8-9 min with v8
> coverage) frees two slots…

The suite is not 8-9 minutes any more, and the ~16-min `cargo-tests` that
dominated the critical path was sharded away by that same commit. The merge job
it declined to keep is exactly the shape `cargo-coverage` adopted alongside it.

Two shards, not three: the old split cost a runner slot per shard plus the
merge, and two cells already bring the worst observed run comfortably under
budget.

## Shape

- `vitest` is a `shard: [1, 2]` matrix. Each cell runs
  `vitest run --shard=N/2 --reporter=blob --coverage` and uploads
  `.vitest-reports/` (vitest names the blob `blob-N-2.json`, so the two cannot
  collide) with one day's retention.
- `vitest-coverage` downloads both blobs and replays them with
  `--mergeReports`, which runs no tests and reports the union. The production
  build and bundle-size gate move here too: they are per-commit, not per-shard.
- It is in `validate-all`'s needs, because the #749 coverage thresholds moved
  into it. Leaving it out would have retired the coverage floor silently.
- A shard whose tests fail exits 1 but still writes its blob (measured), so the
  upload is `if: !cancelled()` and the merge job re-reports the real failure
  instead of failing on a half-suite coverage number.

No merge script and no new dependency: vitest 4's blob reporter and
`--mergeReports` are the supported path, and the one this repo previously hand-
rolled (`scripts/merge-vitest-coverage.mjs`, since deleted) is not needed.

## What was checked before writing the workflow

The thresholds question is the one that decides the design, so it was measured
rather than assumed. Running eight test files as one shard:

- shard alone: lines 1.25% (440/35028) — and the run FAILS, because
  `vitest.config.ts`'s thresholds are enforced per shard.
- both shards merged: lines 2.07% (728/35028) — strictly more than either, so
  `--mergeReports` genuinely unions coverage rather than picking a winner, and
  the thresholds gate on the merged figure.

Hence the thresholds are set to 0 on the shards and enforced once, downstream.
That reinstates a `=0` override #749 removed, so the reason is written at the
step: a shard failing on arithmetic is not a coverage regression.

## Provisional

Both caps are 25 minutes, and the comments say so. Half an 18-minute suite plus
`npm ci` should land far below that, but there are no per-shard samples yet —
`cargo-tests` carries the same "generous budget until we have instrumented
per-shard samples" note. Trim once the first runs land.

The suite's growth itself is untouched; #4818 tracks that.

## One thing I got wrong

The first version of this change described `cargo-coverage` as "deliberately
informational" and drew a contrast with the new job on that basis. It is not:
#648 made it gating, and `check_job cargo-coverage` sits eleven lines from the
comment that denied it. The claim came from PEND-86's commit message, which was
true when written; I quoted it instead of reading the file it describes. The
reviewer caught it in three places, including this log.

The lesson is the one already in `AGENTS.md` about prose: a commit message is a
dated observation, not a current fact, and citing one is not the same as
checking.
