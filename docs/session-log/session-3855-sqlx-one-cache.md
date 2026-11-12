# Session 3855 — one sqlx offline cache instead of four

#6560's experiment checkbox: drop the three member `.sqlx/` caches (`agaric-store`, `agaric-engine`, `agaric-sync`) and keep only `src-tauri/.sqlx`.

## Evidence

- Every one of the 878 member files (221 + 329 + 328, 469 distinct names) is byte-identical to a file in the root cache (766 files); no member-only file. Checked with `cmp` per file.
- `sqlx-macros-core` 0.9.0 `src/query/mod.rs` looks in `SQLX_OFFLINE_DIR`, then the crate's own `.sqlx`, then `workspace_root().join(".sqlx")`, where `workspace_root` runs `cargo metadata` in the crate's directory. A member compiled from the separate `src-tauri/fuzz` workspace therefore still resolves to `src-tauri/.sqlx`.
- With the member caches deleted, all green: `SQLX_OFFLINE=true cargo check --workspace --all-targets`, the CI fuzz step (`SQLX_OFFLINE=true CARGO_TARGET_DIR=src-tauri/target cargo check --manifest-path src-tauri/fuzz/Cargo.toml --locked`), and `cd agaric-store && SQLX_OFFLINE=true cargo check --tests`. Falsified by deleting one root entry: `agaric-store` failed with "`SQLX_OFFLINE=true` but there is no cached data for this query".
- `scripts/clippy-sqlx-check.sh` passes, and the queries the macros generated are exactly the 766 committed files. `cargo sqlx prepare --workspace --check -- --workspace --tests` passes with no unused-entry warning.

## What changed

- `just gen-sqlx` is one pass. Phase E of `verify-ci-equivalent.sh` and the weekly `full-suite-prek` lane are one `prepare --workspace --check -- --workspace --tests` lane. The `--workspace` on both sides matters: without it the root lane never compiles member test queries or `diagnostics`, which the member lanes used to cover.
- `clippy-sqlx-check.sh` sets `SQLX_OFFLINE_DIR` itself, so `sqlx-rustc-wrapper.sh` (which split the generated queries per crate) is deleted. The generated dir has to exist before the macros run, or every query fails with "sqlx offline path does not exist".
- `check-sqlx-cache-drift.sh`, its hook and its pre-push backstop are deleted. The guard flagged an entry deleted from one cache while a sibling cache still had it, and with one cache there is no sibling, so it could never fire. A wrong-scope prune still fails Phase E and CI `lint`.
- The member `migrations -> ../migrations` symlinks and the member `dev.db` ignores are deleted, since only the member prepare lanes used them. `sqlx::migrate!("../migrations")` resolves from `CARGO_MANIFEST_DIR`, not through the symlink.
- Docs, the PR template, CONTRIBUTING, member crate comments, and the approved `AGENTS.md` lines (including the Pre-push bullet's "four `sqlx prepare --check` lanes", the same fact) now say one cache.
- `classify-changes.sh` and its test no longer list the two deleted scripts.
- Review re-ran the reds: a whitespace change to a non-test `agaric-store` query and to a `#[cfg(test)]` `agaric-sync` query each fail `clippy-sqlx-check.sh` with "`.sqlx` is missing query-…"; the second also fails the Phase E command. A planted extra entry warns "1 potentially unused", as it did on `main`.

## Left open

- The issue's "gate Phase E on SQL changes" step was not done. A query edit inside a multi-line `query!` does not put the macro token on a changed line, so that gate needs its own design and a self-test.
