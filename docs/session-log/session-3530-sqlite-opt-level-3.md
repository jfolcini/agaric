# Session 3530 — test builds optimize bundled SQLite

Part of the slow-tests sweep, after the migrated-template change (#6363). With migrations out of the way, a DB test's time goes mostly to dependency code, SQLite first: it is bundled C, compiled at -O0 under the dev profile, which `test` and `mutants` inherit. `libsqlite3-sys` now builds at `opt-level = 3` in that profile. Everything else, the workspace crates included, is unchanged, and so are the release and bench profiles.

Measured with `cargo nextest run -p agaric-store` (1504 tests) on one 4-core box: opt-level 0 took 74.7 s / 78.9 s / 79.5 s; SQLite at opt-level 3 took 56.4 s / 56.3 s (after a 68.5 s warm-up run).

The PR first optimized every dependency (`[profile.dev.package."*"] opt-level = 2`). That was faster still: `agaric-store` 41.5 s / 41.4 s / 39.6 s; locally the full workspace went 265.7 s → 177.7 s, and in this PR's CI run 41984685737 the cargo-tests shards' llvm-cov test step went 397.2 s / 418.6 s (main run 41980707506) → 98.9 s / 81.2 s. But it more than doubled a cold dependency build (474 s → 1047 s locally from an empty target; the cold CI build step was 843 s / 963 s against 272 s / 276 s warm, and clippy 662 s against 162 s). The maintainer chose the SQLite-only line. `src-tauri/fuzz/Cargo.lock` does not move: a profile setting changes no dependency requirement.
