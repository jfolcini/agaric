# Session 1613 — the Rust mutation lane reaches `agaric-sync` (#4696 lever A)

#4696 measured the lane and found it spending 18 runner-hours a week re-proving
464 kills on a swept surface to surface single-digit findings. Its lever A is
the only large one: the scope is a fixed allowlist with no rotation, so the
budget will never reach the rest of the workspace without editing
`src-tauri/.cargo/mutants.toml`.

Levers B (`[profile.mutants]`, `debug = "none"`) and the cache-saver narrowing
already landed, in #4773 and #4774. This is lever A. Lever C (the two-phase
scan/confirm) is untouched.

## What was added, and what was deliberately left out

`agaric-sync` had never been mutated — 58,891 non-test LOC of version vectors,
wire batching and QUIC framing. It also did not meet the config's own selection
rule ("a small invariant core… heavily proptested with independent oracles")
until #4517, which landed property tests for the four pure decision points in
`sync_protocol/protocol_proptest.rs`. Two files hold them:

- `sync_protocol/operations.rs` — `check_reset_required` (one of the two
  version-vector comparisons) and `batch_ops_for_wire`. A wire partition that
  loses, duplicates or reorders a record is silent: the receiver just sees a
  different op log.
- `sync_protocol/types.rs` — `encode_persisted_loro_vvs` /
  `decode_persisted_loro_vvs`. The decoder returns `Vec`, not `Result`, so the
  type does not answer "what does it do with garbage" and only a property can.

**Not `sync_protocol/loro_sync.rs`**, which holds the other version-vector
comparison (`classify_from_vv_reachability`). It is 2802 LOC of session
orchestration around that one proptested function, so mutating the file would
bury 77 constrained mutants under mutants nothing is meant to kill — the
"bury the high-value survivors" failure the narrow scope exists to avoid. The
whole point of lever A is to spend the budget where it returns something.

## The shard count is derived

`cargo mutants --list --json -p agaric-sync` under the new globs: **82**
mutants (`operations.rs` 55, `types.rs` 27). Read from the JSON on purpose —
the text listing wraps long mutant descriptions onto a second line, so
`--list | wc -l` reports 77 and quietly loses five.

Sized at 3 shards, 28/shard, against an estimated capacity of 37:

| package | mutants | per shard | shards | capacity |
|---|---:|---:|---:|---:|
| agaric-store | 125 | 42 | 3 | 44 |
| agaric-engine | 566 | 32 | 18 | 44 (est.) |
| **agaric-sync** | **82** | **28** | **3** | **37 (est.)** |

The capacity estimate is the part worth showing. `MUTANTS_WALL_BUDGET` is
5400 s and the lane measured ~105 s per viable mutant. That number belongs to
the two existing packages, whose test phases are lighter than this one's —
measured on one dev box, `cargo nextest run -p <pkg>`:

| package | tests | test phase |
|---|---:|---:|
| agaric-store | 1433 | 27.9 s |
| agaric-engine | 1026 | 36.1 s |
| agaric-sync | 1008 | **65.0 s** |

1.8x the engine's, and a mutant that SURVIVES pays the whole phase (only a
caught one short-circuits on nextest's first failure). Adding ~30 s to the
lane's 105 s gives ~135 s, and `floor((5400 - ~360 baseline) / 135) = 37`. The
slice is set below that rather than at it, because the capacity is an estimate
and this is the package the borrowed number describes worst. As with
`agaric-engine`, the first crons' PARTIAL notices settle it.

## Falsified

`scripts/check-mutants-scope.mjs` is what couples the globs to the matrix, so
the matrix rows are only load-bearing if the guard actually fires without them.
Both mutations were run against a copy of the workflow and restored:

- **matrix rows removed, globs kept** → two `glob-outside-examined-packages`
  failures naming both new files, with the #2621 arch-wave explanation. This is
  the interesting one: without it the globs would resolve to real files,
  contribute zero mutants, and the lane would stay green.
- **shard index gap (0, 2 with `shards: 3`)** → `shard-matrix-incomplete`.

Guard green on the final tree: 6 globs, 25 mutable files, three examined
packages.

## Two things the glob broke, both caught in review

Adding a package to this lane is not the config-only change it looks like.

**The guard's own self-test pinned the glob count.** `check-mutants-scope.mjs`
asserted the drifted case reports exactly `4` moved-out globs; with six it
reports six, so `--self-test` exited non-zero and `check-mutants-scope.test.ts`
went red. The count is now read from `examine_globs` instead, and the test
matches `/all \d+ moved-out globs/` rather than the spelled-out "four".

The delivery mechanism is the interesting half: this PR touches no frontend
path, so `detect-changes` skips the `vitest` lane on it. The red would have
landed on the next PR touching `src/`, on a diff that had nothing to do with
it. Falsified by pinning the count back to `4` — the test reddens.

**The rust-cache saver no longer built every shard's tree.** `save-if` named
`agaric-engine` shard 0, "because its build is a superset of `agaric-store`'s".
That invariant is exactly what a new package can break: `cargo metadata` puts
`agaric-sync` ON TOP of `agaric-engine` -> `agaric-store` -> `agaric-core`,
pulling iroh/quinn/rustls, mdns-sd and blake3 that none of them compile, and
`cargo mutants -p <pkg>` builds only the named package's tree. The three new
shards would have restored a cache that had never seen that tree and rebuilt it
from source every cron — inside `--build-timeout 600`, and inside the wall
budget this session's sizing charges ~360 s of baseline to. The saver moves to
`agaric-sync` shard 0, which is now the superset.

Same shape as the #4696 finding that motivated the cache work in the first
place: the saver named a package the matrix no longer held, so nothing matched
and every shard cold-built weekly. A saver keyed on a package name is only ever
correct for the matrix it was written against.

Also folded in from the review: the `mutants-scope` hook's `files` pattern now
includes `agaric-sync/src/sync_protocol`, so renaming or deleting one of the
two new files runs the guard instead of waiting for the next cron.

## Not done

Lever C, the two-phase scan/confirm that #4696 measures at ~2.8x. It needs one
`cargo mutants` invocation per glob, because `additional_cargo_test_args` is
fixed for a whole run — the same constraint `stryker.config.mjs` documents for
the frontend lane. That is a workflow rewrite, not a config edit, and it is
sized as its own piece of work.
