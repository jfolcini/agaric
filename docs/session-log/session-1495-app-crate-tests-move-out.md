# Session 1495 — the app crate's tests move out of the lib

#4499 phase 0d. `agaric`'s test suites lived inside the lib: `src/lib.rs` carried five `#[cfg(test)] mod *_app_tests`, `src/command_integration_tests/` held fifteen more, and `src/commands/tests/` twenty-five. Every one of them compiled as part of `agaric_lib`, so the lib's test build was the whole backlog and a one-line change to a command re-typechecked 84,000 lines of test code with it. They are now three integration-test binaries under `src-tauri/tests/`: `app_tests/`, `commands/`, `command_integration/`.

Three binaries rather than forty-five. Each integration-test root is its own crate that links `agaric_lib` afresh, so a root per file would multiply link time by forty-five to buy the isolation the module tree already gives. The grouping is the one the directories already had.

Each is a directory with a `main.rs`, not a `tests/<name>.rs` beside a `tests/<name>/`. That shape is not cosmetic: for a crate root, `mod foo;` resolves against the root's own directory, so a `tests/commands.rs` root looks for `tests/foo.rs` and not `tests/commands/foo.rs` — E0583 on every submodule. Cargo auto-discovers `tests/<name>/main.rs` and names the binary after the directory, so the layout needs no `[[test]]` entry. `src-tauri/tests/AGENTS.md` now says so; the error message points at the wrong fix ("create `tests/foo.rs`"), which is how the first attempt got there.

What the move exposes is the point of the exercise: a test outside the lib can only reach what an external crate can reach. `crate::` became `agaric_lib::`, and twenty-three items had to become visible — seventeen constants, functions and one struct (`MAX_ATTACHMENT_SIZE`, `MAX_ATTACHMENT_FILE_COUNT`, `sanitize_internal_error`, `materializer::retry_queue::record_failure`, the import chunk sizes, the `*_FALLBACK_DEFAULTS`, `InlineQuerySpec` with its codec, …) and six `commands` submodules, all previously `pub(crate)` or private in modules that are already `pub`. The fixture is the interesting one. `commands::tests::common` is consumed both by the moved suites (as `agaric_lib::commands::tests::common`) and by `crate::integration_tests` and `crate::mcp::tools_ro::tests`, which are still in-lib `#[cfg(test)]` modules; moving it out would fork it in two, so it stays and its gate widens from `#[cfg(test)]` to `#[cfg(any(test, feature = "test-util"))]` — the feature the app crate already carries for exactly this, and which no release build turns on. Its `test_pool` returns a `TempDir`, so `tempfile` becomes an optional normal dependency pulled in by `test-util`: the lib rlib the test binaries link is built without this package's dev-dependencies. Same shape as `agaric-store`'s `test-util = ["dep:tempfile"]`.

`snapshot_tests`' insta snapshots move with it and are renamed: the module path in a snapshot's filename is crate-relative, so `agaric_lib__commands__tests__snapshot_tests__*` becomes `commands__snapshot_tests__*`, and they live at `tests/commands/snapshots/` where insta looks for them.

Nothing else changed. Every moved file is a `git mv` plus its `crate::` → `agaric_lib::` rewrite; the per-file count of `#[test]` / `#[tokio::test]` markers is identical to the pre-move tree, file by file, so no suite was dropped or duplicated in the shuffle.

Phase 1 (`reverse/` down into `agaric-engine`, `link_metadata/` into `agaric-store`) and #4502 phase 2 (the materializer into `agaric-engine` behind a spawner port) stay open on #4499 and #4502.

## Review rounds

The rust coverage ratchet moved 90.6 → 89.7 on the same diff the reviewer
verified drops no test and changes no production line: the lib's own test
binary no longer executes the moved suites, and llvm-cov measures per binary.
Same class as the two extraction re-baselines the baseline's comment already
lists; the baseline records this one too.

`commands_bench.rs` carried inline copies of `TEST_SPACE_ID` and
`assign_all_to_test_space` because `commands::tests` was `cfg(test)`. Benches
resolve dev-dependencies, so `test-util` is on for them and the shared
fixture is reachable; the copies are gone. The `metric-provable` hook's
`files` trigger gains `src-tauri/tests`, matching the scan root this session
gave the guard.
