# Session 3670 — cargo deny: rmcp 3.9.0, accept the libsqlite3-sys advisory

The weekly deep-check `full-suite-prek` leg (#3394, run 42619807897) went red on `cargo deny`: two advisories published after the last lock change.

- **RUSTSEC-2026-0462 (rmcp).** Fixed in 3.9.0. `rmcp` moves 3.8.0 → 3.9.0 in `src-tauri/Cargo.lock` and 3.7.0 → 3.9.0 in `src-tauri/fuzz/Cargo.lock`. A local `cargo update -p rmcp --precise 3.9.0` also re-points unrelated `windows-sys` and `syn` edges, so only the `rmcp` and `rmcp-macros` package entries were taken; `cargo metadata --locked` accepts both locks.
- **RUSTSEC-2026-0459 (libsqlite3-sys, bundled SQLite).** The fix is libsqlite3-sys 0.39, and sqlx 0.9.0 caps it below 0.38, so no lock change reaches it. It is accept-listed in `deny.toml`: the flaw needs a database and `-wal` written by a less trusted party, and Agaric opens only its own `notes.db` and its own backups. `audit.toml` and both `osv-scanner.toml` files were regenerated with `node scripts/sync-audit-from-deny.mjs`.

Ran: `cargo deny check` red on `origin/main` with both advisories, green after; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo nextest run --workspace -E 'test(/mcp/)'`.
