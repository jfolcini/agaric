# Session 1236 — PR sweep, fuzz-lane repair, CI/DX batch

`/loop /batch-issues` run, 2026-07-29.

## Merge sweep

17 PRs brought green and merged (Dependabot bumps plus the phase-7 `tauri.ts→bindings.ts`
migration, #3141, whose phase-6/phase-7 conflicts were resolved by union). `main` verified
green after the sweep.

Every merge needed `--admin`. The blocker was not failing checks but the ruleset's strict
up-to-date requirement, which makes routine Dependabot merges require a bypass. Filed as
**#3172** rather than left as an undocumented habit.

## Fuzz lane

The fuzz lane had **zero effective coverage**. Two targets (`snapshot_decode`, `import_parse`)
were broken by `2a021d0f2`; two more (`fts_strip`, `html_parse`) had never been wired into the
CI loop since #2945. Repaired (#3163) and validated live via `workflow_dispatch`: all five
targets ran (285932 / 2164793 / 880254 / 510347 / 848379 runs), crash-free.

Also fixed the loop's design: `set -euo pipefail` made the first failing target abort the
rest, so one broken target masked the others. Now every target runs and the job fails at the
end with a per-target classification (#3174). Findings now file a deduplicated tracking issue
(#3169), same pattern as mutants.

## loro 1.13.7 (#3149 / #3161 / #3162)

`recovery::sync_inbox::replay_streams_all_rows_across_multiple_chunks_1574` goes 28.83s →
137.15s (4.75×) on loro 1.13.7, blowing nextest's terminate window. Investigation found the
regression is real upstream but **the amplifier is ours**: `snapshot.rs` reprojects the entire
root sibling group on every inbound create/move, which is O(n²), and that test seeds 205 root
siblings. Fix in flight on `perf/root-sibling-reprojection` (#3162); #3164 (batch replay via
`import_batch`) and #3165 (the artificial 205-peer test shape) split out as follow-ups.

**Correction on the record:** the mechanism was initially attributed to
`get_change_by_lamport_lte`; that function cannot fire on this path. The actual cost is in
`find_common_ancestor` (`loro-internal/src/dag.rs`). Retracted on #3161.

## CI / DX batch

- **#3168** — `e2e-tauri-weekly` and `scheduled-deep-checks` shared the identical cron
  `'17 4 * * 1'`, so the two heaviest lanes contended for the same runner pool. Staggered the
  shorter lane to `'43 2 * * 1'`, with cross-references in both files.
- **#3170** — a failed test shard produced no lcov artifact, so the ratchet measured half the
  suite and reported it as a coverage regression: one root cause surfacing as three red checks.
  A missing shard is now a distinct, explicit failure.

  The first draft of this claimed the old zero-artifact `exit 0` was a latent *false green*.
  Adversarial review refuted it: `validate-all` requires `cargo-tests` itself to succeed
  (`_validate.yml:1740`), so a total Rust-suite failure already reds the gate no matter what
  the coverage job reports. The bug is a confusing red, exactly as the issue stated — no more.
  The stale comments filed as #3178 are what made the job *look* non-gating and invited the
  over-claim.
- **#3171** — `scripts/seed-worktree.sh`: idempotent worktree seeding (node_modules symlink
  before any build, `src-tauri/.env`, a *migrated* dev.db rather than a stale copy, upstream
  fix, opt-in `--mcp`). The skill docs that still taught the hand-copy anti-pattern now point
  at the script.

### #3167 — deliberately not shipped

The 711s debug build. An evidence sweep returned a confident "rust-cache always misses" with
quoted log lines — but every run analysed predates #3159, the caching PR being evaluated,
which merged the same morning. **Zero runs have executed with the current config.** Tuning
cache keys on that would have been fitting to a cold start; the issue's own text predicted
exactly this trap.

One finding did survive: `prepare-external-bins.mjs` runs a *release* build of `agaric-mcp`
(~8m32s of the ~11m51s step) inside a lane that exists to do a `--debug --no-bundle` build.
A `--placeholder-only` flag already exists and nothing is bundled here — but whether the
WebdriverIO smoke exercises the sidecar at runtime is unverified, so it is recorded on the
issue rather than acted on. Re-measure after the first warm-cache run.

## Issues filed

#3160, #3161, #3162, #3163, #3164, #3165, #3167, #3168, #3169, #3170, #3171, #3172, #3178.

**#3166 withdrawn** — filed as broken `claude-review` infrastructure; the maintainer
identified it as subscription quota exhaustion. Verified (`claude-review` pass 1m54s) and
closed as not-a-bug.

## Notes

Two agents used `SKIP_CI_VERIFY` to get a push through (an upstream-name mismatch, and a
doc-test failure on byte-identical files during a concurrent cargo build race). Flagged as an
unrequested pattern — the friction that pushes agents toward the bypass is the same friction
`seed-worktree.sh` removes.
