# Session 1216 — Gate + prune pre-migration DB backups

**Issue:** #3062

## Problem

`backup_db_before_migration` (src-tauri/src/db/pool.rs) copied `notes.db` →
`notes.db.pre-migration-<unix_ts>` on **every** boot and never pruned the copies. On a large
vault this meant unbounded disk growth and a boot-latency cost (a full file copy) paid even when
no migration was pending — i.e. on the overwhelming majority of boots.

## Fix

Two changes, both confined to `pool.rs`:

1. **Gate the backup on an actually-pending migration.** New `has_pending_migration(db_path)`
   opens a short-lived **read-only** probe connection (`SQLITE_OPEN_READONLY`, `create_if_missing(false)`)
   and compares the embedded `sqlx::migrate!("./migrations")` up-migration versions against the
   applied set in `_sqlx_migrations`. It **fail-safes to backing up** on any uncertain path (probe
   open fails, table absent, query error) so the safety net is never silently dropped; it skips the
   backup **only** on positive confirmation that every embedded version is already applied. The
   read-only probe cannot write, create, or checkpoint the vault, and is closed before the write
   pool opens — the copied `.db` is exactly the clean pre-boot vault (byte-identical test proves it).

2. **Prune to the newest N.** New `prune_old_backups(db_path, keep)` + `MAX_KEPT_BACKUPS = 3`.
   Scans the DB directory for `<db_filename>.pre-migration-*` siblings, sorts ascending by the
   trailing unix timestamp (mtime fallback), and deletes all but the newest 3 (the just-created
   backup is always kept). The prefix anchor means it never matches the live `notes.db`, `-wal`,
   `-shm`, or unrelated files; delete failures `warn` and continue — boot never aborts.

## Baseline

Surgical bump of `src-tauri/dynamic-sql-baseline.txt` `3 → 4 src-tauri/src/db/pool.rs` for the one
new static query against sqlx's internal `_sqlx_migrations` table (not part of the app schema, so
not macro-checkable against the offline `.sqlx` cache) — consistent with the file's existing
grandfathered PRAGMA sites. (`--update-baseline` deliberately not used.)

## Verification

- `cargo nextest run -E 'test(backup) or test(prune) or test(pre_migration) or test(migration) or test(init_pool) or test(pool)' -p agaric` → 75 passed, 0 failed.
- The 5 new/updated tests: `backup_skipped_when_no_migration_pending`,
  `backup_created_and_byte_identical_when_migration_pending`,
  `backup_created_when_pending_state_undeterminable`, `prune_old_backups_keeps_newest_three`,
  `backup_db_before_migration_skips_missing_and_in_memory` — all green and revert-sensitive
  (gate inversion flips the skip/backup tests).
- `cargo clippy -p agaric --lib` clean; `cargo fmt -p agaric --check` clean.
- Adversarial review confirmed the fail-safe has no false-`false` path and the probe leaves the
  vault untouched.
