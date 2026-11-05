# Session 3549 — cargo-tests cache key names the dependency opt-level

Part of the slow-tests sweep. Main run 42001507788, the first with #6373's `--config 'profile.dev.package."*".opt-level=2'` on cargo-tests, passed. The llvm-cov test step took 92.1 s / 74.1 s (main run 41980707506 before it: 397.2 s / 418.6 s). The step's build part took 1119 s / 738 s (before: 272 s / 276 s): the restore was a full match on `v0-rust-rust-cov-Linux-x64-7f2e3d4c-1a595465`, a tree built at opt-level 0, so every dependency recompiled, and rust-cache's post step logged "Cache up-to-date." and saved nothing. That tree would have been rebuilt on every run until `Cargo.lock` changed.

The cargo-tests cache key is now `rust-cov-deps-o2`, so the next main run that runs cargo-tests misses, saves the opt-level 2 tree, and the runs after it restore it.

Correction to session 3540 (#6373), whose log merged with it: "the first main run after merge rebuilds the dependencies cold, and later runs are warm again" is wrong, for the reason above.

The old `rust-cov` family's last entry is no longer read; `cache-prune` keeps each family's newest main entry, so it leaves through the cache quota's LRU eviction. `prek run --files .github/workflows/_validate.yml` passed.
