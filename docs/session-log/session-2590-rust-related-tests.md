# Session 2590 — Rust related tests select by crate, and no staticlib

**Gap:** the "Local inner loop" half of #5847. `scripts/test-related-rust.sh` mapped app
files to `test(~mod::path)` and other crates to `package(<crate>)`, looked only at `*.rs`,
and so ran nothing relevant for command integration tests, `src-tauri/tests/**`, the crates
depending on a changed crate, and non-Rust inputs.

**What changed:**
- The selector maps every changed file to its crate and runs
  `cargo nextest run --workspace --no-tests=pass -E 'rdeps(=a) + rdeps(=b)'`. The module
  tier and the six foundational-path fallbacks are gone: `rdeps(=agaric-core)` already
  selects every test, and an app-crate file cannot break another crate's tests. Full suite
  on migrations, a `Cargo.toml` or `Cargo.lock`, nextest config and its setup scripts, and
  `rust-toolchain.toml`. Checked against nextest 0.9.148 with `cargo nextest list`:
  `rdeps(=X)` includes `X` itself, its integration-test binaries and its bins.
- Two deliberate departures from the issue text. `conformance/**` maps to `agaric`, not
  the full suite: no other crate reads it (`git grep conformance/` over the member crates).
  A `.sqlx/` cache maps to the crate it sits in, not the full suite: test builds compile
  `query!` against the dev DB, and Phase E's four `sqlx prepare --check` lanes check the
  caches, so a full run on every SQL change would add minutes and catch nothing.
- Three tests read a sibling crate's source as data with no Cargo edge behind it
  (`agaric-store`'s `cohort_cascade_drift_guard` and `space_filter_canonical` scan
  `../src` and `agaric-engine`; `agaric`'s `commands::observability` and `bug_report`
  scan `diagnostics/src`). `source_readers` in the script adds them for those crates.
- `--worktree` diffs staged, unstaged and untracked files against `HEAD`; `just
  test-be-related` runs it. `HEAD`, not the merge-base: the loop is about uncommitted
  work, needs no remote, and `--range origin/main...HEAD` covers a branch. A bad
  `--range` now exits 2; it used to read as "no files" and exit 0.
- `crate-type` drops `staticlib`. Android loads `libagaric_lib.so` (the cdylib: cargo-mobile2
  copies `lib<name>.so` into `jniLibs`, and `build.rs`, `android_jni.rs` and
  `check-android-so-alignment.mjs` all name the `.so`); nothing references the `.a`, and
  `src-tauri/gen/` holds only `android`. No Android build was run.

**Measured** (16-core box shared with other agents, load 10-37):
- `--dry` over the last 50 Rust commits: 13 selected nothing before, 2 after (a fuzz
  lockfile bump and a docs-only commit, both correct). Full-suite selections went from 9 to
  11 (Cargo bumps that used to run nothing), and four that ran the full suite on a
  `lib.rs`/`db/` touch now run `rdeps(=agaric)`.
- 844eccf ran 75 tests before, 0 of them `page_cmd_tests`; now 3144, with all 295
  `page_cmd_tests`, `command_integration` (343) and `conformance_fixtures_match_backend`.
  96fa582 and 8232a68 select the same set; 9edcc6e goes from `package(agaric-store)` (1476)
  to 6825 tests across every crate depending on the store.
- `rdeps(=agaric)` ran 3144 tests in 151 s; the full suite ran 7092 in 466 s, under heavier
  load. Both green.
- staticlib: `libagaric_lib.a` was 1,427,687,774 bytes and was rewritten on every lib
  build, and is no longer produced. A touch of `src/lifecycle.rs` then
  `cargo nextest run --workspace --no-run --timings`, interleaved, seven runs each: wall
  median 67.6 s with it, 57.1 s without; the lib unit 18.1 s against 18.3 s. Inside the
  noise on this box, so the win shown is the archive write and its disk, not a time.
- `debug = "line-tables-only"` for first-party crates (env override, three interleaved
  pairs): 41.6/44.9/47.0 s against 36.0/52.3/46.8 s. No win; nothing changed.
- Merging the integration binaries: not done. In `--timings` the three app binaries
  (7.6, 14.6, 9.0 s) build in parallel off the critical path, which is the lib (16.5 s)
  followed by the lib's unit-test binary (28.5 s). That lib unit-test binary waits for the
  lib because of the `agaric` self dev-dependency (#4499).
- mold: not measured here. `scripts/setup.sh` already wires it when it is installed, and
  BUILD.md already describes it.

**Suites run:** `cargo nextest run --workspace` (7092 passed) and the `rdeps(=agaric)`
selection (3144 passed) on the staticlib-free build; `shellcheck`; `prek run --files` over
the changed files; `verify-ci-equivalent.sh --self-test`.
