//! #1453 Phase 1 — backfill blake3 `content_hash` for pre-existing attachments.
//!
//! Migration `0093` adds a NULLABLE `content_hash` column. Rows attached before
//! the column existed (and rows materialized purely from a remote `AddAttachment`
//! op, whose payload carries no hash) have `content_hash IS NULL`. This one-shot
//! boot-time pass fills them in by hashing the bytes on disk.
//!
//! ## Design
//!
//! * **Reuses the sync hashing.** Hashing goes through
//!   [`crate::sync_files::read_attachment_file`], which finalises
//!   `blake3::hash(&data).to_hex()` — the exact scheme the file-sync layer uses
//!   — so a backfilled hash matches a sync offer's `blake3_hash` byte-for-byte.
//! * **Idempotent.** It only selects rows `WHERE content_hash IS NULL`, so a
//!   second run after a fully-successful pass is a no-op (selects nothing).
//! * **Tolerates a missing file.** If the file is absent on disk (or the stored
//!   `fs_path` is malformed), the row is logged and left `NULL` — never an error
//!   that aborts boot. Sync GC reconciles missing attachments separately.
//! * **Best-effort.** Called from `recover_at_boot` and wrapped so any failure
//!   is logged and boot continues.

use sqlx::SqlitePool;
use std::path::Path;

use crate::error::AppError;

/// Outcome of a single backfill pass. Returned for logging/telemetry and so
/// tests can assert how many rows were updated vs. skipped.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BackfillReport {
    /// Rows whose `content_hash` was successfully computed and persisted.
    pub hashed: u64,
    /// Rows skipped because the file was missing on disk or its `fs_path` was
    /// malformed — left `NULL`.
    pub skipped_missing: u64,
}

/// One `(id, fs_path)` candidate for hashing.
struct Candidate {
    id: String,
    fs_path: String,
}

/// Backfill `content_hash` for every attachment row that has none yet and whose
/// file is present on disk.
///
/// Idempotent: only `content_hash IS NULL` rows are considered, so running twice
/// is a no-op on the second pass. A missing-on-disk file leaves the row `NULL`
/// and is counted in [`BackfillReport::skipped_missing`].
///
/// # Errors
///
/// - [`AppError::Database`] — the initial candidate SELECT failed. Per-row
///   update failures and per-file read failures are logged and skipped, not
///   propagated, so one bad row cannot abort the pass.
pub async fn backfill_attachment_content_hashes(
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<BackfillReport, AppError> {
    // Candidate set: rows still lacking a hash. This `WHERE content_hash IS
    // NULL` filter is what makes the pass idempotent across boots.
    let candidates = sqlx::query_as!(
        Candidate,
        "SELECT id, fs_path FROM attachments WHERE content_hash IS NULL"
    )
    .fetch_all(pool)
    .await?;

    let mut report = BackfillReport::default();

    for c in candidates {
        let dir = app_data_dir.to_path_buf();
        let path = c.fs_path.clone();
        // Reuse the sync hashing helper. It validates the fs_path shape and
        // reads the bytes (synchronous std::fs on the blocking pool, like the
        // read/attach paths).
        let hash_result = tokio::task::spawn_blocking(move || {
            crate::sync_files::read_attachment_file(&dir, &path)
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())));

        let hash = match hash_result {
            // Join succeeded and the file hashed cleanly.
            Ok(Ok((_bytes, hash))) => hash,
            // The file is missing / unreadable / fs_path malformed — tolerate
            // it: leave the row NULL and move on (sync GC reconciles missing
            // files; the next attach or a future backfill can fill it later).
            Ok(Err(e)) => {
                tracing::warn!(
                    attachment_id = %c.id,
                    fs_path = %c.fs_path,
                    error = %e,
                    "attachment content_hash backfill: file unreadable — leaving NULL"
                );
                report.skipped_missing += 1;
                continue;
            }
            // spawn_blocking join error (panic / cancellation) — also skip.
            Err(e) => {
                tracing::warn!(
                    attachment_id = %c.id,
                    fs_path = %c.fs_path,
                    error = %e,
                    "attachment content_hash backfill: hashing task failed — leaving NULL"
                );
                report.skipped_missing += 1;
                continue;
            }
        };

        // Persist. Guard the UPDATE with `content_hash IS NULL` too so a
        // concurrent/duplicate run can never clobber an already-set value.
        let updated = sqlx::query!(
            "UPDATE attachments SET content_hash = ? WHERE id = ? AND content_hash IS NULL",
            hash,
            c.id,
        )
        .execute(pool)
        .await;

        match updated {
            Ok(r) if r.rows_affected() > 0 => report.hashed += 1,
            Ok(_) => {
                // Row vanished or was hashed by someone else between SELECT and
                // UPDATE — not an error, just nothing to do.
            }
            Err(e) => {
                tracing::warn!(
                    attachment_id = %c.id,
                    error = %e,
                    "attachment content_hash backfill: UPDATE failed — leaving NULL"
                );
                report.skipped_missing += 1;
            }
        }
    }

    if report.hashed > 0 || report.skipped_missing > 0 {
        tracing::info!(
            hashed = report.hashed,
            skipped_missing = report.skipped_missing,
            "attachment content_hash backfill complete (#1453)"
        );
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn insert_block(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'content', 'x', 0)",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a hashless attachment row (mirrors a pre-0093 / remote-op row).
    async fn insert_hashless_attachment(
        pool: &SqlitePool,
        id: &str,
        block_id: &str,
        fs_path: &str,
        size: i64,
    ) {
        sqlx::query(
            "INSERT INTO attachments \
             (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, 'application/zip', 'f.bin', ?, ?, 1735689600000)",
        )
        .bind(id)
        .bind(block_id)
        .bind(size)
        .bind(fs_path)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn fetch_hash(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>("SELECT content_hash FROM attachments WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Backfill populates a pre-existing hashless row, the hash matches the sync
    /// hasher, and a second run is a no-op (idempotent).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backfill_populates_and_is_idempotent() {
        let (pool, dir) = test_pool().await;
        let app_data_dir = dir.path();

        insert_block(&pool, "BLK-1").await;
        std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
        let bytes: Vec<u8> = (0u8..=250).cycle().take(3000).collect();
        let fs_path = "attachments/present.bin";
        std::fs::write(app_data_dir.join(fs_path), &bytes).unwrap();
        let size = i64::try_from(bytes.len()).unwrap();
        insert_hashless_attachment(&pool, "ATT-1", "BLK-1", fs_path, size).await;

        assert_eq!(fetch_hash(&pool, "ATT-1").await, None, "starts hashless");

        let r1 = backfill_attachment_content_hashes(&pool, app_data_dir)
            .await
            .unwrap();
        assert_eq!(r1.hashed, 1, "one row hashed");
        assert_eq!(r1.skipped_missing, 0);

        let stored = fetch_hash(&pool, "ATT-1").await.expect("now hashed");
        let (_b, sync_hash) =
            crate::sync_files::read_attachment_file(app_data_dir, fs_path).unwrap();
        assert_eq!(stored, sync_hash, "backfilled hash matches sync hasher");
        assert_eq!(stored, blake3::hash(&bytes).to_hex().to_string());

        // Idempotent: a second run sees no NULL rows → no-op, hash unchanged.
        let r2 = backfill_attachment_content_hashes(&pool, app_data_dir)
            .await
            .unwrap();
        assert_eq!(r2.hashed, 0, "second run is a no-op");
        assert_eq!(r2.skipped_missing, 0);
        assert_eq!(
            fetch_hash(&pool, "ATT-1").await.as_deref(),
            Some(stored.as_str()),
            "hash unchanged by idempotent re-run"
        );
    }

    /// Backfill tolerates a row whose file is missing on disk: leaves it NULL,
    /// counts it as skipped, and does not error.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backfill_tolerates_missing_file() {
        let (pool, dir) = test_pool().await;
        let app_data_dir = dir.path();

        insert_block(&pool, "BLK-2").await;
        // No file written at this fs_path — it is missing on disk.
        insert_hashless_attachment(&pool, "ATT-MISSING", "BLK-2", "attachments/gone.bin", 10).await;

        let r = backfill_attachment_content_hashes(&pool, app_data_dir)
            .await
            .unwrap();
        assert_eq!(r.hashed, 0, "nothing hashed");
        assert_eq!(r.skipped_missing, 1, "missing file counted as skipped");
        assert_eq!(
            fetch_hash(&pool, "ATT-MISSING").await,
            None,
            "missing-file row left NULL"
        );
    }
}
