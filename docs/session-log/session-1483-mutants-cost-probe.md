# Session 1483 — Mutants cost probe (#3393, step 1)

The weekly Rust mutants lane has never reached `agaric-store`: it tests a deterministic prefix of its 607 mutants inside a 90-minute wall budget, and the store sits at positions 510 to 607. #3393's narrowed scope of 2026-09-02 asks for three things in order: measure what one package-scoped mutant costs on the 4-vCPU runner in each package, derive the shard count from that, then shard the lane round-robin.

This session ships the measurement. `mutants-cost-probe.yml` is dispatch-only, never scheduled and never gating; the workflow watchdog only requires cron-triggered workflows to be watched, so it needs no entry there. It runs two arms, one per package the lane's globs live in, each a small round-robin shard so the sample spans the package's files, with cargo-mutants pinned to the 27.1.0 the lane resolved last week. The summary prints build and test seconds per mutant from cargo-mutants' own outcomes file, the mean over viable mutants, and how many such mutants the lane's 5400-second budget would test at that rate. `agaric-engine` is left out on purpose: its tests still live in the app crate, so a package-scoped run there measures nothing.

What the lane's last run already tells us, read from its uploaded outcomes: a viable `src/reverse` mutant costs about 600 seconds (a 125 to 135 second rebuild plus a 470 second run of the `agaric` suite), an unviable one about 60 to 80. The store's number is the one this probe exists to supply.

Verified: the workflow-lint and zizmor pre-commit hooks on the new file; the `-p`, `--shard`, `--sharding round-robin` flags and the union semantics of `-f` with `examine_globs` checked against cargo-mutants 27.1.0's `options.rs` and `main.rs`.
