//! #1993 Phase 1 — backfill the content-addressed `attachment_blobs` store
//! from the pre-existing per-row `attachments` files.
//!
//! Migration `0094` creates an EMPTY `attachment_blobs` table and drops the
//! `fs_path` UNIQUE index. This one-shot boot-time pass populates the blob
//! store from the rows that existed before dedup. It does NOT hash anything
//! itself — it consumes rows that ALREADY carry a `content_hash`. The
//! preceding boot pass ([`crate::recovery::backfill_attachment_content_hashes`],
//! run first at boot) is what hashes any live row still lacking a
//! `content_hash`; this pass simply skips rows whose `content_hash` is still
//! NULL (their file was gone, so the prior pass could not hash them).
//!
//! 1. Group live `attachments` rows by their existing `content_hash`. Rows
//!    whose `content_hash` is still NULL are skipped (the prior hash backfill
//!    pass populates everything it can; an unhashable row's file is gone).
//! 2. For each distinct hash, pick ONE canonical surviving file and insert a
//!    single `attachment_blobs` row pointing at it.
//! 3. Repoint every other row sharing that hash so its `fs_path` equals the
//!    canonical blob's `on_disk_path`. The now-redundant duplicate files are
//!    left on disk for the refcount-aware GC pass to reclaim (no row will
//!    reference them once repointed, and no LIVE row references their path, so
//!    `cleanup_orphaned_attachments` unlinks them safely).
//!
//! ## Design
//!
//! * **Idempotent.** A blob row is created with `INSERT OR IGNORE`, and a row
//!   is only repointed when its `fs_path` differs from the canonical path, so
//!   a second pass after a fully-successful run is a no-op.
//! * **Tolerates a missing file.** A row whose hash is still NULL (the prior
//!   hash backfill could not read its bytes, i.e. the file is gone) is skipped
//!   — no blob can be created for bytes we cannot find. Sync GC and the
//!   missing-attachment re-request path reconcile those separately.
//! * **Best-effort.** Called from `recover_at_boot` after the 0093 hash
//!   backfill; any failure is logged and boot continues. The blob store is an
//!   availability/dedup optimization, not a correctness invariant — the
//!   per-row `fs_path` still resolves bytes even with an empty blob table.

use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::Path;

use crate::db::now_ms;
use crate::error::AppError;

/// Outcome of a single blob-backfill pass, returned for logging/telemetry and
/// so tests can assert behaviour.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BlobBackfillReport {
    /// Distinct `attachment_blobs` rows newly created this pass.
    pub blobs_created: u64,
    /// Attachment rows whose `fs_path` was repointed at a canonical blob file.
    pub rows_repointed: u64,
    /// Distinct hashes skipped because no surviving file backed them.
    pub skipped_no_file: u64,
}

/// One live attachment row relevant to the backfill.
struct Row {
    id: String,
    fs_path: String,
    size_bytes: i64,
    content_hash: Option<String>,
}

/// Populate `attachment_blobs` from existing `attachments` rows and repoint
/// duplicate rows at the canonical blob file.
///
/// Must run AFTER [`crate::recovery::backfill_attachment_content_hashes`] so
/// rows that can be hashed already carry a `content_hash`.
///
/// # Errors
///
/// - [`AppError::Database`] — the initial candidate SELECT failed. Per-blob /
///   per-row failures are logged and skipped, never propagated, so one bad
///   group cannot abort the whole pass.
pub async fn backfill_attachment_blobs(
    pool: &SqlitePool,
    app_data_dir: &Path,
) -> Result<BlobBackfillReport, AppError> {
    // Live rows only (`deleted_at IS NULL`). The blob layer reflects the set
    // of LIVE references, matching the refcount semantics used by the GC.
    let rows = sqlx::query_as!(
        Row,
        r#"SELECT id as "id!", fs_path as "fs_path!", size_bytes as "size_bytes!", content_hash
           FROM attachments WHERE deleted_at IS NULL"#
    )
    .fetch_all(pool)
    .await?;

    // Group by content_hash. Rows still NULL (file missing / unhashable) are
    // not reconcilable into a blob and are skipped.
    let mut by_hash: HashMap<String, Vec<Row>> = HashMap::new();
    for r in rows {
        if let Some(h) = r.content_hash.clone() {
            by_hash.entry(h).or_default().push(r);
        }
    }

    let mut report = BlobBackfillReport::default();

    for (hash, group) in by_hash {
        // Choose a canonical file: the first row in the group whose file is
        // actually present on disk. If none survive, we cannot create a blob.
        let mut canonical: Option<&Row> = None;
        for r in &group {
            let full = app_data_dir.join(&r.fs_path);
            if tokio::fs::try_exists(&full).await.unwrap_or(false) {
                canonical = Some(r);
                break;
            }
        }
        let Some(canonical) = canonical else {
            tracing::warn!(
                content_hash = %hash,
                rows = group.len(),
                "blob backfill: no surviving file for hash group — skipping"
            );
            report.skipped_no_file += 1;
            continue;
        };

        // Create the blob row (idempotent). created_at uses now_ms(); the blob
        // table is a derived store, not the op log, so a fresh timestamp is
        // correct (the bytes' provenance lives in the op log via AddAttachment).
        let now = now_ms();
        let insert = sqlx::query!(
            "INSERT OR IGNORE INTO attachment_blobs \
             (content_hash, on_disk_path, size_bytes, created_at) \
             VALUES (?, ?, ?, ?)",
            hash,
            canonical.fs_path,
            canonical.size_bytes,
            now,
        )
        .execute(pool)
        .await;
        match insert {
            Ok(r) if r.rows_affected() > 0 => report.blobs_created += 1,
            Ok(_) => { /* blob already existed — idempotent re-run */ }
            Err(e) => {
                tracing::warn!(
                    content_hash = %hash,
                    error = %e,
                    "blob backfill: INSERT attachment_blobs failed — skipping group"
                );
                continue;
            }
        }

        // The canonical on_disk_path is whatever the blob row ended up with
        // (which may pre-date this run if it already existed). Read it back so
        // repointing is consistent with the stored blob, not just our pick.
        let on_disk_path = match sqlx::query_scalar!(
            "SELECT on_disk_path FROM attachment_blobs WHERE content_hash = ?",
            hash
        )
        .fetch_optional(pool)
        .await
        {
            Ok(Some(p)) => p,
            Ok(None) => canonical.fs_path.clone(),
            Err(e) => {
                tracing::warn!(content_hash = %hash, error = %e, "blob backfill: blob read-back failed");
                canonical.fs_path.clone()
            }
        };

        // Repoint every row in the group whose fs_path differs from the
        // canonical blob path.
        for r in &group {
            if r.fs_path == on_disk_path {
                continue;
            }
            let updated = sqlx::query!(
                "UPDATE attachments SET fs_path = ? WHERE id = ? AND fs_path <> ?",
                on_disk_path,
                r.id,
                on_disk_path,
            )
            .execute(pool)
            .await;
            match updated {
                Ok(u) if u.rows_affected() > 0 => report.rows_repointed += 1,
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(
                        attachment_id = %r.id,
                        error = %e,
                        "blob backfill: repoint UPDATE failed — leaving fs_path as-is"
                    );
                }
            }
        }
    }

    if report.blobs_created > 0 || report.rows_repointed > 0 || report.skipped_no_file > 0 {
        tracing::info!(
            blobs_created = report.blobs_created,
            rows_repointed = report.rows_repointed,
            skipped_no_file = report.skipped_no_file,
            "attachment blob backfill complete (#1993)"
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

    async fn insert_attachment(
        pool: &SqlitePool,
        id: &str,
        block_id: &str,
        fs_path: &str,
        size: i64,
        hash: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO attachments \
             (id, block_id, mime_type, filename, size_bytes, fs_path, created_at, content_hash) \
             VALUES (?, ?, 'application/zip', 'f.bin', ?, ?, 1735689600000, ?)",
        )
        .bind(id)
        .bind(block_id)
        .bind(size)
        .bind(fs_path)
        .bind(hash)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn fetch_fs_path(pool: &SqlitePool, id: &str) -> String {
        sqlx::query_scalar::<_, String>("SELECT fs_path FROM attachments WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Two rows with identical bytes/hash collapse to ONE blob row, the
    /// duplicate row is repointed at the canonical file, and a second pass is
    /// a no-op (idempotent).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backfill_dedups_identical_hash_and_is_idempotent() {
        let (pool, dir) = test_pool().await;
        let app = dir.path();
        std::fs::create_dir_all(app.join("attachments")).unwrap();

        let bytes = b"identical bytes for blob dedup".to_vec();
        let hash = blake3::hash(&bytes).to_hex().to_string();
        let size = i64::try_from(bytes.len()).unwrap();

        insert_block(&pool, "BLK-A").await;
        insert_block(&pool, "BLK-B").await;
        std::fs::write(app.join("attachments/a.bin"), &bytes).unwrap();
        std::fs::write(app.join("attachments/b.bin"), &bytes).unwrap();
        insert_attachment(
            &pool,
            "ATT-A",
            "BLK-A",
            "attachments/a.bin",
            size,
            Some(&hash),
        )
        .await;
        insert_attachment(
            &pool,
            "ATT-B",
            "BLK-B",
            "attachments/b.bin",
            size,
            Some(&hash),
        )
        .await;

        let r1 = backfill_attachment_blobs(&pool, app).await.unwrap();
        assert_eq!(r1.blobs_created, 1, "one distinct hash → one blob");
        assert_eq!(r1.rows_repointed, 1, "the second row is repointed");

        // Exactly one blob row for the hash.
        let blob_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs WHERE content_hash = ?")
                .bind(&hash)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(blob_count, 1);

        // Both rows now resolve to the canonical file.
        let pa = fetch_fs_path(&pool, "ATT-A").await;
        let pb = fetch_fs_path(&pool, "ATT-B").await;
        assert_eq!(pa, "attachments/a.bin", "canonical = first surviving file");
        assert_eq!(pb, pa, "duplicate row repointed at canonical blob");

        // Idempotent: second pass changes nothing.
        let r2 = backfill_attachment_blobs(&pool, app).await.unwrap();
        assert_eq!(r2.blobs_created, 0);
        assert_eq!(r2.rows_repointed, 0);
    }

    /// A hash group whose only files are all missing on disk creates no blob.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backfill_skips_hash_with_no_surviving_file() {
        let (pool, dir) = test_pool().await;
        let app = dir.path();

        insert_block(&pool, "BLK-C").await;
        // hash present but file absent
        insert_attachment(
            &pool,
            "ATT-C",
            "BLK-C",
            "attachments/gone.bin",
            5,
            Some("deadbeef"),
        )
        .await;

        let r = backfill_attachment_blobs(&pool, app).await.unwrap();
        assert_eq!(r.blobs_created, 0);
        assert_eq!(r.skipped_no_file, 1);
    }
}
