# Session 3530 — test builds optimize their dependencies

Part of the slow-tests sweep, after the migrated-template change (#6363). With migrations out of the way, a DB test's time is mostly dependency code: SQLite (bundled C, compiled at -O0 under the dev profile), sqlx and Loro. Every dependency now builds at `opt-level = 2` in the dev profile, which `test` and `mutants` inherit; the workspace crates stay at opt-level 0 and keep their debuginfo. The release and bench profiles are untouched.

Measured with `cargo nextest run -p agaric-store` (1504 tests) on one 4-core box, three runs each: opt-level 0 took 74.7 s / 78.9 s / 79.5 s; SQLite alone at opt-level 3 took 56.4 s / 56.3 s (after a 68.5 s warm-up run); every dependency at opt-level 2 took 41.5 s / 41.4 s / 39.6 s. The maintainer chose the all-dependencies line over the SQLite-only one.

The cost is a slower cold dependency build, locally after a `Cargo.lock` change and in CI on a rust-cache miss; warm builds do not change. This PR's own CI run is a cold build (the profile change misses rust-cache), measured against main's cargo-tests build step in the PR body, with a local cold-build and full-workspace comparison added there when it finishes. `src-tauri/fuzz/Cargo.lock` does not move: a profile setting changes no dependency requirement.
