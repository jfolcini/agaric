# Session 3518 — clippy and the sqlx cache check share one compile

Set out to shorten the PR CI critical path outside nextest. Re-measured on green `main` runs: on a Rust-touching run `validate / lint` took about 800 s, and its cargo steps were clippy (161 s), the four `sqlx prepare --check` steps (140 + 24 + 37 + 41 s), cargo doc (61 s) and the fuzz check (56 s). Playwright shard 3 was the longest shard on some runs, not all, so rebalancing it would have been chasing noise.

Every sqlx step recompiled the workspace members clippy had just compiled. Its job log shows why: rust-cache keeps only dependencies, and each `prepare --check` lane builds `agaric-core`/`agaric-store`/… under its own feature set, so all four compile from scratch. `scripts/clippy-sqlx-check.sh` now runs clippy once with the query macros online. `scripts/sqlx-rustc-wrapper.sh`, a `RUSTC_WRAPPER`, sets a separate `SQLX_OFFLINE_DIR` for each crate's lib and test builds. The script then diffs each committed cache using sqlx-cli's rules: a missing or different entry fails, and unused entries only warn. The root cache is checked against every crate's queries, the way `just gen-sqlx` builds it. A member cache is checked against its own lib and test queries plus the lib queries of the workspace crates it depends on, which is what its own `prepare` lane wrote.

Traps:

- A member's committed cache holds its dependencies' lib queries but not their `#[cfg(test)]` ones. A per-crate union without the lib/test split reported hundreds of false "missing" entries.
- The wrapper does not dirty dependency fingerprints. Only the seven workspace crates recompile.
- Clippy now runs online. The offline-cache resolution it used to prove is implied by the exact cache match, and cargo doc and the fuzz check still compile offline.

Ran: the script on a clean tree (passes, zero unused warnings), and a falsification that deleted one `agaric-store` entry and edited one `agaric-sync` entry (it failed with exactly those two errors). Also ran the `classify-changes` vitest file (shown red without the new paths), `prek` on the changed files, and the manual stage over all files. Locally the merged step ran in 1 m 34 s, against 1 m 18 s for offline clippy alone.
