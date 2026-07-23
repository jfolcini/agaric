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

/// #2919 — take a best-effort backup of the vault database immediately before
/// migrations run.
///
/// A downgrade (an older binary opening a vault a newer version migrated) or a
/// failed/partial migration can corrupt or partially-migrate the ONLY copy of
/// the user's data. Before `sqlx::migrate!` touches the file, snapshot it to a
/// timestamped sibling so the user can recover.
///
/// Called at the very start of [`init_pools`], BEFORE the pool connects:
/// `create_if_missing` would otherwise materialise a zero-byte shell for a
/// fresh vault and connecting writes the WAL header, either of which would
/// defeat the "only back up an existing vault" guards below. Running first means
/// the file on disk is exactly the user's pre-boot vault.
///
/// Guards — each a silent skip, never an error:
/// - `:memory:` / in-memory DBs (tests/benches) — no file to copy.
/// - the file does not exist yet — a fresh vault has no data to protect.
/// - a zero-byte file — nothing to protect.
///
/// Best-effort by design: a copy failure (permissions, disk full, …) logs a
/// `warn` and returns — we NEVER abort boot because the safety copy could not be
/// written. The migration is what must proceed; the backup is a bonus.
///
/// Only the main DB file is copied (not `-wal`/`-shm`). A single timestamped
/// copy per migration run keeps this simple and bounds accumulation to
/// one-per-boot rather than unbounded history.
fn backup_db_before_migration(db_path: &Path) {
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
    backup_db_before_migration(db_path);

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

    /// #2919 — a real, non-empty on-disk vault gets a byte-identical timestamped
    /// backup written before migration. Revert-sensitive: removing the
    /// `backup_db_before_migration` copy makes this fail.
    #[tokio::test]
    async fn backup_db_before_migration_copies_existing_file() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("notes.db");
        // A migrated pool is a real, non-empty SQLite file on disk.
        let pool = init_pool(&db_path).await.unwrap();
        drop(pool); // release the file handle before copying
        let original = std::fs::read(&db_path).unwrap();
        assert!(!original.is_empty(), "migrated DB must be non-empty");

        backup_db_before_migration(&db_path);

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

    /// #2919 — the backup is a safe no-op for the cases that must NOT produce a
    /// copy and must NOT error: a missing file (fresh vault), the `:memory:`
    /// sentinel, and a zero-byte shell.
    #[tokio::test]
    async fn backup_db_before_migration_skips_missing_and_in_memory() {
        let dir = TempDir::new().unwrap();

        // Missing file (fresh vault): no backup, no panic.
        let missing = dir.path().join("does-not-exist.db");
        backup_db_before_migration(&missing);
        assert!(
            std::fs::read_dir(dir.path()).unwrap().next().is_none(),
            "a missing file must not produce any backup"
        );

        // In-memory sentinel path: no backup, no panic.
        backup_db_before_migration(Path::new(":memory:"));

        // Zero-byte shell: no backup.
        let empty = dir.path().join("empty.db");
        std::fs::File::create(&empty).unwrap();
        backup_db_before_migration(&empty);
        let has_backup = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(std::result::Result::ok)
            .any(|e| e.file_name().to_string_lossy().contains("pre-migration"));
        assert!(!has_backup, "a zero-byte file must not be backed up");
    }
}
