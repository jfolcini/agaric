# Session 4404 — stale pins: cargo-binstall, nvm, Rust 1.100.0

The weekly `stale-pins` lane (run 44478509486) reported three pins behind upstream past the 7-day cooldown. This PR moves all three and fixes what Rust 1.100.0 broke.

## What shipped

- **cargo-binstall 1.20.1 → 1.27.0, nvm 0.39.7 → 0.41.0** through `scripts/pins.mjs bump`. A second download of each binstall archive gave the same sha256s, and each holds one `cargo-binstall` binary; the new `nvm.sh` hash matches the file in a `v0.41.0` checkout. Nothing else in `pins.txt` moved.
- **Rust 1.99.1 → 1.100.0** in `rust-toolchain.toml`, every `toolchain:` input in `.github/actions/toolchain` and the workflows, and `rust-version` in every crate manifest.
- **Clippy 1.100**: `map_unwrap_or` now covers `.map(f).unwrap_or_default()`; those chains are `.map_or_default(f)` (mechanical, applied by `cargo clippy --fix`). `needless_bool` caught the `if … { return true } false` tail of `is_blocked_ip`'s Teredo check.
- **Cargo 1.100's build-dir layout**: intermediate artifacts moved from `target/<profile>/deps/` to `target/<profile>/build/<crate>/<hash>/out/`. Two things read the old path:
  - the bench smoke step in `scheduled-deep-checks.yml` globbed `target/release/deps/<name>-*`, and would have found no binary. The compile step now maps bench names to executables from `cargo bench --no-run --message-format=json-render-diagnostics`;
  - `docs/BUILD.md`'s debug-info sweep. It now matches `*.rcgu.o` / `*.rcgu.dwo` only, because the same `out/` directories hold build scripts' C objects (sqlite, blake3).

## Decisions and traps

- **`pins.mjs stale` cannot run in a cloud session.** api.github.com answers 401 with the session's `GITHUB_TOKEN` and 403 without it, so every `github:` upstream shows as an error. The run's own table was the source; it was a few hours old.
- **The `panic` setting ignored for the `bench` profile** warning predates 1.100 (1.99.1 prints it too), so it stays out of this PR.
- **The fuzz crate needs `SQLX_OFFLINE=true`** to `cargo check` from `src-tauri/fuzz`; without it, sqlx tries `dev.db` relative to that directory.
- **Release notes** also list never-type fallback to `!` on every edition and `Infallible` as an alias of `!`, the rustdoc `invalid_markdown_table` lint, Cargo's `[lints.cargo]` table, and Unicode 18 in `escape_debug`. None of these surfaced in clippy, rustdoc or the tests.

## What ran

- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check` on 1.100.0.
- `cargo nextest run --workspace` in two partitions. Partition 1 ran before rebasing onto #7009 and failed only `conformance_fuzz::mock_matches_backend_on_fixed_seed_op_chains_6567`, main's known red; after the rebase that test passes. Partition 2 passed in full.
- `cargo test --workspace --doc`; the `cargo-doc-links` rustdoc command; `SQLX_OFFLINE=true cargo check` in `src-tauri/fuzz` (lockfile unchanged).
- The new bench mapping, run locally on `core_bench`.
