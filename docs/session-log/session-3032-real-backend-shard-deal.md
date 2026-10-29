# Session 3032 — The real-backend specs are dealt round-robin over their shards

The maintainer asked for every slow test to be fixed. The discovery report put the PR critical path in the real-backend lane: build, then three spec shards, and shard 3 ran 1–3 minutes past the others.

**Changed:** `wdio.conf.ts` sorts the spec files and deals them round-robin over the `--shard` total, read from the command line. WebdriverIO cuts `--shard i/n` as contiguous slices in file-name order, so the slow `sync-*` and `reminder-*` specs shared one slice. Dealt, each slice is every n-th file.
- **Coverage does not depend on the order.** The slices still partition the list. The reviewer fed WebdriverIO's own `shard()` every list size from 1 to 8 and 95 to 100, over 2, 3, 4, 5 and 7 shards, and every file came out exactly once.
- **The real config lists the same 95 files as before** (32 / 32 / 31). The spec-only leg (`--shard 1/1 --spec …`) still runs exactly the specs it is given.
- **Predicted effect:** about 33 s off the longest shard, modelled from one run's per-spec durations. The same model reproduces that run's actual shard times to within about 13 s. CI on the next runs is the check.

**Built and then dropped:** Playwright shard weights. Playwright 1.64 reads an undocumented `PWTEST_SHARD_WEIGHTS`, and weights fitted to one run predicted shard 3 losing 80 s. The reviewer back-tested them on six green `main` runs:
- the mean longest shard fell by 28 s (6%);
- two of the six runs got slower;
- one shard swings by up to 56 s between runs.
That lane is not the critical path while the real-backend lane runs. A measured ratio that drifts as tests are added does not earn its line.

**Suites:** the workflow, lint, `tsc` and docs hooks on the changed files; the `--list` and `getSpecs()` coverage checks above.
