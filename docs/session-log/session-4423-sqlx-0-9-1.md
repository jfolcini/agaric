# Session 4423 — sqlx 0.9.1, bundled SQLite 3.54

Moved sqlx and its sub-crates from 0.9.0 to 0.9.1, held out of the Dependabot batch (#7042) because the bump couples the `.sqlx` cache and the `sqlx-cli` pin. Every crate cleared the 7-day release-age gate (sqlx 2026-11-18, libsqlite3-sys 0.39.1 2026-10-25).

- sqlx 0.9.1 widens `sqlx-sqlite`'s `libsqlite3-sys` range to take 0.39, which bundles SQLite 3.54.1 and fixes RUSTSEC-2026-0459. Took `libsqlite3-sys` 0.39.1 with a targeted `cargo update -p … --precise` in both the workspace and the fuzz lock, dropped the advisory's waiver from `deny.toml`, and regenerated `audit.toml` and both `osv-scanner.toml` files with `scripts/sync-audit-from-deny.mjs`.
- The workspace lock diff also re-points some `windows-sys` and `syn` dependency edges; cargo chose them within existing ranges, and no package was added, removed or changed version beyond sqlx-* and libsqlite3-sys.
- `pins.txt` moves `sqlx-cli` to 0.9.1 to match the lock.
- `just gen-sqlx` rewrote the inferred nullability of two cached queries (the snapshot-diff `before` lookup and the retry-queue kind listing). Both columns carry explicit `!`/`?` overrides, so the generated Rust types do not change.
- Changelog items checked against the code: #4367 (malformed migration filenames now error; ours all match `NNNN_name.sql`), #4306 (read-only statements report zero changes; no `rows_affected` reads one). Pool sizing and `PRAGMA foreign_keys = ON` are untouched.

Ran: workspace clippy with `-D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `scripts/clippy-sqlx-check.sh`, `cargo deny check`, whole-workspace nextest in two partitions, and the workspace doc-tests.
