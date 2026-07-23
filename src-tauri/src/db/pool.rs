use sqlx::SqlitePool;
use sqlx::sqlite::SqlitePoolOptions;
use std::path::Path;

use super::recovery::{
    engine_reproject_pending, ensure_blocks_table_exists, recover_derived_state_from_op_log,
    reproject_blocks_from_engine,
};
// The pure pool primitives (`DbPools`, `base_connect_options`, the acquire/begin
// helpers, the pragma consts, `now_ms` / `next_delete_ms`) moved into
// `agaric-store` (wave S3b-i, #2621) and are re-exported by `crate::db`. The
// app-only wiring below (`WriteCtx`, `init_pools`, `init_pool`,
// `clear_leaked_bypass_sentinel`) couples to `recovery` / `device` /
// `materializer`, so it stays here and reaches the primitives via `crate::db::`.
use crate::db::{DbPools, base_connect_options};

/// #1056 — bundled write-path context for the IPC arg ceiling.
///
/// Write commands previously threaded the same three Tauri `State` args —
/// `pool: State<'_, WritePool>` + `device_id: State<'_, DeviceId>` +
/// `materializer: State<'_, Materializer>` — which permanently burned 3 of
/// tauri-specta's hard 10-argument IPC ceiling (see
/// `commands/AGENTS.md` §`tauri-specta` 10-argument ceiling). Bundling the
/// triple into one managed `WriteCtx` collapses those 3 slots to 1, raising
/// the usable user-arg budget from 7 to ~9 and letting the
/// `#[allow(clippy::too_many_arguments)]` attributed to the base params be
/// removed.
///
/// Every field is cheaply cloneable (the pool and [`Materializer`] are
/// `Arc`-backed; [`DeviceId`] wraps a small `String`), so `WriteCtx` is
/// constructed once at boot from the same values that back the standalone
/// `WritePool` / `DeviceId` / `Materializer` managed states (which are kept
/// for the read-only / partial-triple consumers — e.g. `get_device_id`,
/// `sync_cmds`, `link_metadata`).
///
/// The accessors return exactly the borrow shapes the `*_inner` cores expect
/// (`&SqlitePool`, `&str`, `&Materializer`), so wrappers forward
/// `ctx.pool()` / `ctx.device_id()` / `ctx.materializer()` with no behaviour
/// change.
pub struct WriteCtx {
    write: SqlitePool,
    device_id: crate::device::DeviceId,
    materializer: crate::materializer::Materializer,
}

impl WriteCtx {
    /// Construct from the same values backing the standalone managed states.
    pub fn new(
        write: SqlitePool,
        device_id: crate::device::DeviceId,
        materializer: crate::materializer::Materializer,
    ) -> Self {
        Self {
            write,
            device_id,
            materializer,
        }
    }

    /// The write-capable pool (matches the `&SqlitePool` an `*_inner` takes).
    pub fn pool(&self) -> &SqlitePool {
        &self.write
    }

    /// The device UUID string (matches the `&str` an `*_inner` takes).
    pub fn device_id(&self) -> &str {
        self.device_id.as_str()
    }

    /// The materializer handle (matches the `&Materializer` an `*_inner` takes).
    pub fn materializer(&self) -> &crate::materializer::Materializer {
        &self.materializer
    }
}

/// #1575 — clear any leaked op-log bypass sentinel at write-pool boot.
///
/// `_op_log_mutation_allowed` is a shared (non-temp) table and the op_log
/// immutability triggers (migration 0036) gate on a global
/// `WHEN NOT EXISTS (SELECT 1 FROM _op_log_mutation_allowed)` predicate.
/// Isolation relies entirely on the transactional discipline in
/// `op_log::bypass` always removing the sentinel before the bypass
/// transaction commits. If any caller ever commits with the sentinel still
/// present (e.g. a crash mid-bypass, or a future bug), append-only
/// enforcement is silently and permanently OFF for the whole database.
///
/// As a defense-in-depth backstop, delete any sentinel rows at boot after
/// migrations run and before the pool serves traffic. Finding a row here
/// means a latent bug leaked the sentinel, so surface it with a `warn`.
async fn clear_leaked_bypass_sentinel(
    write_pool: &SqlitePool,
) -> Result<(), crate::error::AppError> {
    let cleared = sqlx::query!("DELETE FROM _op_log_mutation_allowed")
        .execute(write_pool)
        .await?
        .rows_affected();
    if cleared > 0 {
        tracing::warn!(
            rows = cleared,
            "cleared leaked op-log bypass sentinel at boot: a prior bypass \
             transaction committed (or crashed) without removing the sentinel \
             row, which had silently disabled op_log append-only enforcement \
             DB-wide until now"
        );
    }
    Ok(())
}

/// #2919 / #3062 — number of timestamped pre-migration backups to retain.
///
/// Pruning keeps the newest [`MAX_KEPT_BACKUPS`] siblings and deletes older
/// ones, bounding on-disk accumulation. The just-created backup counts as one
/// of the kept set.
const MAX_KEPT_BACKUPS: usize = 3;

/// #2919 / #3062 — take a best-effort backup of the vault database immediately
/// before migrations run, but ONLY when a migration is actually pending, and
/// prune stale backups so they don't accumulate unbounded.
///
/// A downgrade (an older binary opening a vault a newer version migrated) or a
/// failed/partial migration can corrupt or partially-migrate the ONLY copy of
/// the user's data. Before `sqlx::migrate!` touches the file, snapshot it to a
/// timestamped sibling so the user can recover.
///
/// #3062 — the backup used to fire on EVERY boot, even the common case where the
/// DB is already fully migrated and no migration will run. That grew a fresh
/// timestamped copy per launch forever. This gate skips the copy when the
/// embedded migration set has nothing new to apply, and prunes old backups down
/// to [`MAX_KEPT_BACKUPS`].
///
/// Called at the very start of [`init_pools`], BEFORE the pool connects:
/// `create_if_missing` would otherwise materialise a zero-byte shell for a
/// fresh vault and connecting writes the WAL header, either of which would
/// defeat the "only back up an existing vault" guards below. Running first means
/// the file on disk is exactly the user's pre-boot vault. The pending-migration
/// probe opens only a short-lived READ-ONLY (`SQLITE_OPEN_READONLY`) connection,
/// which cannot write or checkpoint, so the on-disk `.db` snapshot semantics are
/// preserved — a read-only connection makes no committed data change, so copying
/// the main `.db` file (not `-wal`/`-shm`) remains valid.
///
/// Guards — each a silent skip, never an error:
/// - `:memory:` / in-memory DBs (tests/benches) — no file to copy.
/// - the file does not exist yet — a fresh vault has no data to protect.
/// - a zero-byte file — nothing to protect.
/// - no migration pending — the DB is already up to date; nothing to protect.
///
/// Fail-safe: if the pending state cannot be determined for ANY reason (the
/// `_sqlx_migrations` table is absent, a query error, an unexpected vault
/// state), we treat it as PENDING and back up. We never skip a backup when a
/// migration might run.
///
/// Best-effort by design: a copy failure (permissions, disk full, …) logs a
/// `warn` and returns — we NEVER abort boot because the safety copy could not be
/// written. The migration is what must proceed; the backup is a bonus.
///
/// Only the main DB file is copied (not `-wal`/`-shm`).
async fn backup_db_before_migration(db_path: &Path) {
    // In-memory pools (tests/benches) never touch disk.
    if db_path.as_os_str() == ":memory:" {
        return;
    }
    let Ok(meta) = std::fs::metadata(db_path) else {
        // Fresh vault: nothing on disk yet. Not an error.
        return;
    };
    // A zero-byte file (e.g. a freshly created shell) has no data to protect.
    if !meta.is_file() || meta.len() == 0 {
        return;
    }

    // #3062 — the whole point: skip the copy when the DB is already fully
    // migrated. Prune anyway so historical accumulation still shrinks. Fail-safe
    // returns `true` on any uncertainty, so we never skip when unsure.
    if !has_pending_migration(db_path).await {
        prune_old_backups(db_path, MAX_KEPT_BACKUPS);
        return;
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    // `notes.db` -> `notes.db.pre-migration-<unix_ts>` (sibling in the same dir).
    let mut backup = db_path.as_os_str().to_owned();
    backup.push(format!(".pre-migration-{ts}"));
    let backup = std::path::PathBuf::from(backup);
    match std::fs::copy(db_path, &backup) {
        Ok(bytes) => tracing::info!(
            backup = %backup.display(),
            bytes,
            "pre-migration DB backup created"
        ),
        // Best-effort: log and PROCEED with the migration; a failed backup must
        // never block boot.
        Err(e) => tracing::warn!(
            error = %e,
            db = %db_path.display(),
            "pre-migration DB backup failed; proceeding with migration anyway"
        ),
    }

    // Bound accumulation regardless of whether the copy above succeeded.
    prune_old_backups(db_path, MAX_KEPT_BACKUPS);
}

/// #3062 — is any embedded migration not yet recorded in the vault's
/// `_sqlx_migrations` table?
///
/// The embedded migrator (`sqlx::migrate!("./migrations")`) is the source of
/// truth for "what should be applied" — the SAME migrator [`init_pools`] runs
/// below. We compare its up-migration versions against the versions already
/// recorded in `_sqlx_migrations`; pending means any embedded version is
/// missing from the applied set.
///
/// FAIL-SAFE: any uncertainty returns `true` (treat as pending → back up). That
/// covers an absent `_sqlx_migrations` table, a query failure, or a file that
/// cannot be opened read-only. We must never report "not pending" unless we have
/// positively confirmed every embedded version is already applied.
///
/// The probe opens a single READ-ONLY (`SQLITE_OPEN_READONLY`) connection and
/// closes it immediately. A read-only connection cannot write or checkpoint, so
/// it does not mutate the vault — the pre-migration `.db` snapshot stays clean.
async fn has_pending_migration(db_path: &Path) -> bool {
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::{ConnectOptions, Connection};

    let embedded: std::collections::HashSet<i64> = sqlx::migrate!("./migrations")
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .map(|m| m.version)
        .collect();
    // No embedded migrations at all (shouldn't happen) — nothing can be pending.
    if embedded.is_empty() {
        return false;
    }

    // Read-only open: cannot create, write, or checkpoint the vault.
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true)
        .create_if_missing(false);
    // Can't even open it read-only → can't confirm state → fail safe.
    let Ok(mut conn) = opts.connect().await else {
        return true;
    };

    let queried = sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations")
        .fetch_all(&mut conn)
        .await;
    // Close the short-lived read-only connection regardless of the query result.
    let _ = conn.close().await;

    // Missing table / query error → can't confirm state → fail safe.
    let Ok(versions) = queried else {
        return true;
    };
    let applied: std::collections::HashSet<i64> = versions.into_iter().collect();

    // Pending if any embedded version is not yet applied.
    embedded.iter().any(|v| !applied.contains(v))
}

/// #3062 — delete all but the newest `keep` pre-migration backups next to
/// `db_path`.
///
/// Scans the DB file's directory for siblings named
/// `<db_filename>.pre-migration-*`, orders them by the trailing unix timestamp
/// (falling back to filesystem mtime, then to keeping them, when the suffix
/// isn't a plain integer), and removes everything past the newest `keep`.
///
/// Best-effort: a delete failure logs a `warn` and continues — pruning must
/// NEVER abort boot.
fn prune_old_backups(db_path: &Path, keep: usize) {
    let Some(dir) = db_path.parent() else {
        return;
    };
    let Some(file_name) = db_path.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let prefix = format!("{file_name}.pre-migration-");

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    // (sort_key, path): sort_key is the trailing unix ts, or mtime as a
    // fallback, so newest sorts last.
    let mut backups: Vec<(u64, std::path::PathBuf)> = entries
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let suffix = name.strip_prefix(&prefix)?;
            let key = suffix.parse::<u64>().unwrap_or_else(|_| {
                entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs())
            });
            Some((key, entry.path()))
        })
        .collect();

    if backups.len() <= keep {
        return;
    }
    // Ascending by key: oldest first, newest last.
    backups.sort_by_key(|(key, _)| *key);
    let remove_count = backups.len() - keep;
    for (_, path) in backups.into_iter().take(remove_count) {
        if let Err(e) = std::fs::remove_file(&path) {
            tracing::warn!(
                error = %e,
                backup = %path.display(),
                "failed to prune old pre-migration DB backup; continuing"
            );
        }
    }
}

/// Initialize separated read/write SQLite pools with WAL mode.
///
/// The write pool runs migrations on creation.  The read pool sets
/// `PRAGMA query_only = ON` so any accidental write through a read
/// connection is rejected by SQLite.
///
/// Enables `PRAGMA foreign_keys = ON` on every connection in both pools —
/// SQLite does NOT enforce FK constraints by default, so this is mandatory.
pub async fn init_pools(db_path: &Path) -> Result<DbPools, crate::error::AppError> {
    // #2919 — snapshot the existing on-disk vault before migrations run. No-op
    // for a fresh or in-memory DB. Must precede the pool connect below so a
    // fresh vault's `create_if_missing` shell isn't mistaken for real data.
    // #3062 — gated on an actually-pending migration; prunes old backups.
    backup_db_before_migration(db_path).await;

    // --- Write pool: 2 connections — SQLite serialises at engine level ---
    let write_opts = base_connect_options(db_path);
    let write_pool = SqlitePoolOptions::new()
        .max_connections(2)
        // #434 — cap pool-acquire wait at 10s. sqlx defaults acquire_timeout
        // to 30s, but busy_timeout is 5s; a saturated pool would otherwise
        // freeze the UI for 30s before surfacing an error. 10s gives the
        // pool enough time to recover from a momentary write-heavy burst
        // while still returning an error well within the UI response budget.
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(write_opts)
        .await?;

    // Recovery: if a prior crash left blocks missing, recreate it
    // from op_log so migrations have a target table to rebuild.
    let blocks_recovered = ensure_blocks_table_exists(&write_pool).await?;

    // Run migrations on the write pool (needs write access)
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&write_pool).await?;
    tracing::info!("database migrations complete");

    // Recovery part 2: restore properties and tags that migration 73's
    // DROP TABLE would have CASCADE-deleted. #616: gated on the positive
    // corruption signal from `ensure_blocks_table_exists` (this boot's flag
    // or the persisted pending marker), never on empty-table inference.
    recover_derived_state_from_op_log(&write_pool, blocks_recovered).await?;

    // #2504: engine-first rebuild. The two op-log passes above reconstruct only
    // device-local content (the op_log is strictly device-local post-#490-M1),
    // so on a synced device every remote-authored block/property/tag is missing.
    // Reproject the SQL primary state authoritatively from the per-space Loro
    // engine snapshots (`loro_doc_state` — the complete convergent state), on top
    // of the op-log passes (which also restored engine-independent `attachments`).
    // Gated on the same this-boot block-recovery signal.
    // #2920: also re-attempt when a PRIOR boot's engine reprojection skipped
    // some spaces/blocks and armed the retry marker. The `blocks_recovered` gate
    // is this-boot-only (the `blocks` table is present again on the next boot),
    // so without the marker check a partial engine recovery would be silently,
    // permanently lost — remote-authored content invisible in SQL forever.
    if blocks_recovered || engine_reproject_pending(&write_pool).await? {
        reproject_blocks_from_engine(&write_pool).await?;
    }

    // T-5: Update query planner statistics after migrations.
    // PRAGMA optimize analyzes tables whose stats may be stale and runs
    // ANALYZE only where beneficial. Safe, idempotent, runs in <100ms
    // for typical personal databases.
    sqlx::query("PRAGMA optimize").execute(&write_pool).await?;

    // #1575: defense-in-depth — clear any leaked op-log bypass sentinel that
    // a prior bypass transaction may have committed without removing. Must
    // run after migrations (the table exists) and before serving traffic.
    clear_leaked_bypass_sentinel(&write_pool).await?;

    // --- Read pool: 4 concurrent readers, query_only enforced ---
    let read_opts = base_connect_options(db_path).pragma("query_only", "ON");
    let read_pool = SqlitePoolOptions::new()
        .max_connections(4)
        // #434 — see write pool: align acquire_timeout with the UX freeze budget
        // instead of sqlx's 30s default.
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(read_opts)
        .await?;

    // R2 (#347): assert the read pool actually came up `query_only`. The
    // `.pragma("query_only", "ON")` above is the structural guard against
    // an accidental write through a read connection (C1's bug class), but a
    // mis-wired connect-options builder or a future sqlx change could
    // silently drop the pragma. Acquire one read connection and confirm
    // `PRAGMA query_only == 1` at boot rather than discovering it on the
    // first errant write at runtime.
    let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
        .fetch_one(&read_pool)
        .await?;
    if query_only != 1 {
        // #655: this is a read-pool *configuration* failure, not a snapshot
        // failure — surface it in the database domain so logs and the IPC
        // `kind` attribute the failure correctly. Route through
        // `sqlx::Error::Configuration` → `From<sqlx::Error>` so we honour the
        // "never construct `AppError::Database` directly" invariant on the
        // enum and the failure lands as `kind: "database"`.
        return Err(crate::error::AppError::from(sqlx::Error::Configuration(
            format!(
                "read pool failed query_only assertion at boot: PRAGMA query_only = {query_only} \
                 (expected 1); the read pool is not write-protected"
            )
            .into(),
        )));
    }

    Ok(DbPools {
        write: write_pool,
        read: read_pool,
    })
}

/// Initialize a single combined pool — **test/bench-only fixture**.
///
/// ## When to use which
///
/// | Use case | API |
/// |----------|-----|
/// | Production app startup (`lib.rs::setup`) | [`init_pools`] |
/// | Anything that needs the production split-pool semantics — `query_only = ON` reader, dedicated writer | [`init_pools`] |
/// | Unit tests / benches that just need a working migrated DB and don't care about reader/writer separation | `init_pool` (this fn) |
///
/// This creates one pool with `max_connections(5)` — the legacy
/// pre-pool-split behaviour, retained because the vast majority of
/// tests and benches don't need a `query_only` reader pool to
/// exercise their unit under test.  Tests that *do* need to verify
/// behaviour under split-pool wiring (e.g. M-82-style pool-mismatch
/// regressions, MCP read-only tooling) must call [`init_pools`]
/// instead — see the `tools_ro::tests_m82` module for a worked
/// example.
///
/// **Do not use `init_pool` from production code paths.**  All
/// non-test/bench callers should use [`init_pools`] so the
/// `query_only` pragma rejects accidental writes through the read
/// pool at the SQLite engine level.
pub async fn init_pool(db_path: &Path) -> Result<SqlitePool, crate::error::AppError> {
    let connect_options = base_connect_options(db_path);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(connect_options)
        .await?;

    // Recovery
    let blocks_recovered = ensure_blocks_table_exists(&pool).await?;

    // Run migrations
    tracing::info!("running database migrations");
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("database migrations complete");

    // Recovery part 2 (#616: see `init_pools` for the gate rationale)
    recover_derived_state_from_op_log(&pool, blocks_recovered).await?;

    // #2504: engine-first rebuild from the Loro snapshots — see `init_pools`.
    // #2920: see `init_pools` — re-attempt when a prior boot armed the retry
    // marker, not only when this boot rebuilt the `blocks` table.
    if blocks_recovered || engine_reproject_pending(&pool).await? {
        reproject_blocks_from_engine(&pool).await?;
    }

    // Match `init_pools` — refresh planner stats after migrations.
    sqlx::query("PRAGMA optimize").execute(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        (pool, dir)
    }

    /// #1575 — the boot cleanup helper deletes a leaked bypass sentinel so
    /// op_log append-only enforcement is restored. Revert-sensitive: if the
    /// `DELETE FROM _op_log_mutation_allowed` is removed, the row survives and
    /// this assertion fails.
    #[tokio::test]
    async fn clear_leaked_bypass_sentinel_deletes_leaked_row() {
        let (pool, _dir) = test_pool().await;

        // Simulate a leaked sentinel: a prior bypass transaction committed
        // (or crashed) without removing its row, disabling enforcement DB-wide.
        sqlx::query("INSERT INTO _op_log_mutation_allowed (token) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _op_log_mutation_allowed")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(before, 1, "sentinel row should be present before cleanup");

        clear_leaked_bypass_sentinel(&pool).await.unwrap();

        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _op_log_mutation_allowed")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after, 0, "boot cleanup must clear the leaked sentinel");
    }

    /// No-op when there is nothing to clear — the common (healthy) case must
    /// not error and must leave the table empty.
    #[tokio::test]
    async fn clear_leaked_bypass_sentinel_is_noop_when_absent() {
        let (pool, _dir) = test_pool().await;

        clear_leaked_bypass_sentinel(&pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _op_log_mutation_allowed")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    /// Count `<db_name>.pre-migration-*` siblings in `dir`.
    fn count_pre_migration_backups(dir: &Path, db_name: &str) -> usize {
        let prefix = format!("{db_name}.pre-migration-");
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .count()
    }

    /// Migrate `db_path`, then remove the newest `_sqlx_migrations` record so
    /// the embedded migrator has exactly one version that is no longer applied —
    /// i.e. a genuinely pending migration. The deletion is checkpointed into the
    /// main `.db` (TRUNCATE) so the file is self-contained.
    async fn make_migration_pending(db_path: &Path) {
        let pool = init_pool(db_path).await.unwrap();
        let deleted = sqlx::query(
            "DELETE FROM _sqlx_migrations \
             WHERE version = (SELECT MAX(version) FROM _sqlx_migrations)",
        )
        .execute(&pool)
        .await
        .unwrap()
        .rows_affected();
        assert_eq!(deleted, 1, "expected to un-apply exactly one migration");
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .unwrap();
        drop(pool);
    }

    /// #3062 — when a migration is genuinely pending, a byte-identical
    /// timestamped backup of the pre-migration on-disk vault is created.
    /// Revert-sensitive: removing the `backup_db_before_migration` copy fails.
    #[tokio::test]
    async fn backup_created_and_byte_identical_when_migration_pending() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        make_migration_pending(&db_path).await;
        let original = std::fs::read(&db_path).unwrap();
        assert!(!original.is_empty(), "migrated DB must be non-empty");

        backup_db_before_migration(&db_path).await;

        // Exactly one timestamped backup sibling, byte-identical to the DB.
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("notes.db.pre-migration-"))
            })
            .collect();
        assert_eq!(
            backups.len(),
            1,
            "exactly one pre-migration backup expected"
        );
        let backup_bytes = std::fs::read(&backups[0]).unwrap();
        assert_eq!(backup_bytes, original, "backup must match the original DB");
    }

    /// #3062 — the core fix: a fully-migrated DB has nothing pending, so NO
    /// backup is created (this is what stopped the per-boot accumulation).
    #[tokio::test]
    async fn backup_skipped_when_no_migration_pending() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        // Fully migrated: every embedded version is recorded in `_sqlx_migrations`.
        let pool = init_pool(&db_path).await.unwrap();
        drop(pool);

        backup_db_before_migration(&db_path).await;

        assert_eq!(
            count_pre_migration_backups(dir.path(), "notes.db"),
            0,
            "a fully-migrated DB must NOT produce a pre-migration backup"
        );
    }

    /// #3062 — fail-safe: if the pending state can't be determined (a non-empty
    /// file whose `_sqlx_migrations` table can't be read), the backup MUST still
    /// happen. Never skip when a migration might run.
    #[tokio::test]
    async fn backup_created_when_pending_state_undeterminable() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        // Non-empty, but not a readable sqlx-migrated SQLite DB.
        std::fs::write(&db_path, b"this is not a valid sqlite database file").unwrap();

        backup_db_before_migration(&db_path).await;

        assert_eq!(
            count_pre_migration_backups(dir.path(), "notes.db"),
            1,
            "fail-safe: an undeterminable vault must still be backed up"
        );
    }

    /// #3062 — pruning keeps exactly the newest `MAX_KEPT_BACKUPS` (3) backups by
    /// trailing timestamp and removes all older ones.
    #[tokio::test]
    async fn prune_old_backups_keeps_newest_three() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        // Six backups, oldest -> newest by trailing unix timestamp.
        for ts in [100u64, 200, 300, 400, 500, 600] {
            let p = dir.path().join(format!("notes.db.pre-migration-{ts}"));
            std::fs::write(&p, format!("backup-{ts}")).unwrap();
        }

        prune_old_backups(&db_path, 3);

        let mut remaining: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("notes.db.pre-migration-"))
            .collect();
        remaining.sort();
        assert_eq!(
            remaining,
            vec![
                "notes.db.pre-migration-400".to_string(),
                "notes.db.pre-migration-500".to_string(),
                "notes.db.pre-migration-600".to_string(),
            ],
            "pruning must keep exactly the newest 3 backups by timestamp"
        );
    }

    /// #2919 — the backup is a safe no-op for the cases that must NOT produce a
    /// copy and must NOT error: a missing file (fresh vault), the `:memory:`
    /// sentinel, and a zero-byte shell. These return before the pending probe.
    #[tokio::test]
    async fn backup_db_before_migration_skips_missing_and_in_memory() {
        let dir = TempDir::new().unwrap();

        // Missing file (fresh vault): no backup, no panic.
        let missing = dir.path().join("does-not-exist.db");
        backup_db_before_migration(&missing).await;
        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "a missing file must not produce any backup"
        );

        // In-memory sentinel path: no backup, no panic.
        backup_db_before_migration(Path::new(":memory:")).await;

        // Zero-byte shell: no backup.
        let empty = dir.path().join("empty.db");
        std::fs::File::create(&empty).unwrap();
        backup_db_before_migration(&empty).await;
        let has_backup = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains("pre-migration"));
        assert!(!has_backup, "a zero-byte file must not be backed up");
    }
}
