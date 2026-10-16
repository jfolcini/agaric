# Session 2164 — cargo-tests drops its disk reclaim; vitest runs in 3 shards

Two more PR-gate speedups from the 2026-10-16 CI timing audit, plus the
review notes on #5620 and #5621.

`cargo-tests` started each shard with a background `rm -rf` of preinstalled
toolchains and a step that waited for it: 1.44 minutes median (p90 2.55, max
6.15) on both shards, on the critical path. All 15 sampled jobs started with
86 GB free of 145 GB; the out-of-space failure behind it (run 26569299876)
was in May 2026, on an older runner image. Both steps are gone. The two
weekly deep-check jobs that cited it as their rationale keep their reclaim
(different workload, off the PR path) and lose the dangling reference. The
Android build and release jobs keep theirs: their motivation is the Android
SDK/NDK on a 14 GB-free runner.

`vitest` goes from 2 shards to 3. Each shard reported about 690 s, roughly
half of it per-file setup. The coverage merge already collects every
`vitest-blob-*` artifact, so it takes the third blob unchanged.

Review notes: #5621's comments quoted measurements and run ids (12.3 of 17
minutes cold, run 38859986472; 4.2 of 5.4 warm, run 38815251099; doc tests
2.9–3.1 minutes, runs 38849989109 and 38860006295). Under AGENTS.md "no
figures that rot", those now live here, and the comments keep only the why.
