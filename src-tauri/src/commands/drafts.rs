//! Draft autosave command handlers (F-17).

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::draft;
use crate::error::AppError;

use super::*;

/// Flush a draft: look up the stored draft content, validate it, compute
/// `prev_edit`, write an `edit_block` op, and delete the draft row — all
/// inside a single `BEGIN IMMEDIATE` transaction.
///
/// Behavior:
/// - **No draft for `block_id`** — no-op, returns `Ok(())`.
/// - **H-12b: oversized content** (`stored.content.len() > MAX_CONTENT_LENGTH`)
///   — returns [`AppError::Validation`]; the draft row is **kept** (the tx
///   rolls back on early-return) so the user can edit it down. Never silently
///   truncated.
/// - **H-12a: target block missing or soft-deleted** — drops the orphan
///   draft (same tx), logs a `warn`, returns `Ok(())`. Avoids leaking
///   orphan `edit_block` ops into the append-only log.
/// - **Happy path** — appends one `edit_block` op and deletes the draft row
///   atomically.
#[instrument(skip(pool, device_id), err)]
pub async fn flush_draft_inner(
    pool: &SqlitePool,
    device_id: &str,
    block_id: String,
) -> Result<(), AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "flush_draft").await?;

    // 1. Look up the stored draft content inside the tx. No row → no-op.
    let stored_content = sqlx::query_scalar!(
        "SELECT content FROM block_drafts WHERE block_id = ?",
        block_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(content) = stored_content else {
        // Nothing to flush. Nothing was written, but commit cleanly so the
        // BEGIN IMMEDIATE write-lock is released promptly rather than
        // dropped/rolled back.
        tx.commit().await?;
        return Ok(());
    };

    // 2. H-12b: enforce MAX_CONTENT_LENGTH. Returning Err here drops `tx`
    //    without commit, so the row stays — the user can edit it down.
    if content.len() > super::MAX_CONTENT_LENGTH {
        return Err(AppError::Validation(format!(
            "draft content {} exceeds maximum {}",
            content.len(),
            super::MAX_CONTENT_LENGTH,
        )));
    }

    // 3. H-12a: verify the target block exists and is not soft-deleted.
    //    If absent, drop the orphan draft inside the same tx and bail.
    let target_alive = sqlx::query!(
        "SELECT id FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if !target_alive {
        sqlx::query("DELETE FROM block_drafts WHERE block_id = ?")
            .bind(&block_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::warn!(
            block_id = %block_id,
            "flush_draft: target block missing or soft-deleted; dropped orphan draft"
        );
        return Ok(());
    }

    // 4. prev_edit lookup (same logic as edit_block_inner) inside the tx.
    //    MAINT-147 (b): delegates to the shared helper in
    //    `commands::blocks::crud` so both call sites stay in lockstep.
    let prev_edit = super::blocks::find_prev_edit_in_tx(&mut tx, &block_id).await?;

    // 5. Append the edit_block op + delete the draft row, on the outer tx.
    draft::flush_draft_in_tx(&mut tx, device_id, &block_id, &content, prev_edit).await?;

    tx.commit().await?;
    Ok(())
}

/// Tauri command: save a draft for a block. Delegates to [`draft::save_draft`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn save_draft(
    pool: State<'_, WritePool>,
    block_id: String,
    content: String,
) -> Result<(), AppError> {
    draft::save_draft(&pool.0, &block_id, &content)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: flush a draft (write edit_block op + delete draft row).
/// Delegates to [`flush_draft_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn flush_draft(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    block_id: String,
) -> Result<(), AppError> {
    flush_draft_inner(&pool.0, device_id.as_str(), block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete a draft for a block. Delegates to [`draft::delete_draft`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_draft(pool: State<'_, WritePool>, block_id: String) -> Result<(), AppError> {
    draft::delete_draft(&pool.0, &block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list all drafts. Delegates to [`draft::get_all_drafts`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_drafts(pool: State<'_, ReadPool>) -> Result<Vec<draft::Draft>, AppError> {
    draft::get_all_drafts(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Inner implementation for `list_drafts`, usable from tests without Tauri state.
pub async fn list_drafts_inner(pool: &sqlx::SqlitePool) -> Result<Vec<draft::Draft>, AppError> {
    draft::get_all_drafts(pool).await
}

// ---------------------------------------------------------------------------
// Tests for H-12a (orphan-draft drop) and H-12b (oversized-content reject).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests_h12 {
    use super::*;
    use crate::db::init_pool;
    use crate::draft;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEVICE: &str = "test-device-h12";
    const LIVE_BLOCK: &str = "01HZ000000000000000H12LIVE";
    const DEAD_BLOCK: &str = "01HZ000000000000000H12DEAD";
    const MISSING_BLOCK: &str = "01HZ00000000000000H12MISS0";

    async fn test_pool() -> (sqlx::SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a (live) block row directly. Bypasses the command layer so we
    /// don't generate any `create_block` op_log entries that would interfere
    /// with the per-test op-count assertions.
    async fn insert_live_block(pool: &sqlx::SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'initial', NULL, 1)",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a soft-deleted block row directly.
    async fn insert_soft_deleted_block(pool: &sqlx::SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'initial', NULL, 1, '2025-01-01T00:00:00Z')",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn count_edit_block_ops(pool: &sqlx::SqlitePool, block_id: &str) -> i64 {
        sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log \
             WHERE op_type = 'edit_block' \
             AND json_extract(payload, '$.block_id') = ?",
            block_id,
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn draft_exists(pool: &sqlx::SqlitePool, block_id: &str) -> bool {
        draft::get_draft(pool, block_id).await.unwrap().is_some()
    }

    // -- H-12a: target block missing entirely ------------------------------
    //
    // The "target block has no row in `blocks` at all" case is now
    // unreachable: migration 0038 (M-93) added a FOREIGN KEY from
    // `block_drafts.block_id` to `blocks(id)` ON DELETE CASCADE, so any
    // attempt to seed an orphan draft fails with `SQLITE_CONSTRAINT_FOREIGNKEY`
    // up front. The `flush_draft_inner` H-12a guard ("target block missing
    // or soft-deleted; dropped orphan draft") is therefore now load-bearing
    // only for the soft-deleted-target branch (covered by
    // `flush_draft_drops_draft_when_target_soft_deleted` below). The
    // schema-level invariant itself is asserted by
    // `cannot_save_draft_for_nonexistent_block_m93` further down.

    // -- H-12a: target block soft-deleted -----------------------------------

    #[tokio::test]
    async fn flush_draft_drops_draft_when_target_soft_deleted() {
        let (pool, _dir) = test_pool().await;
        insert_soft_deleted_block(&pool, DEAD_BLOCK).await;

        draft::save_draft(&pool, DEAD_BLOCK, "stale content")
            .await
            .unwrap();
        assert!(draft_exists(&pool, DEAD_BLOCK).await);

        flush_draft_inner(&pool, DEVICE, DEAD_BLOCK.to_owned())
            .await
            .expect("flush against a soft-deleted block must succeed silently");

        assert_eq!(
            count_edit_block_ops(&pool, DEAD_BLOCK).await,
            0,
            "no edit_block op must target a soft-deleted block",
        );
        assert!(
            !draft_exists(&pool, DEAD_BLOCK).await,
            "draft pointing at a soft-deleted block must be dropped",
        );
    }

    // -- H-12b: oversized content rejected ---------------------------------

    #[tokio::test]
    async fn flush_draft_rejects_oversized_content() {
        let (pool, _dir) = test_pool().await;
        insert_live_block(&pool, LIVE_BLOCK).await;

        // Bypass save_draft's normal path with a direct insert so we can
        // store content beyond the cap without going through any future
        // size-cap on save_draft.
        let oversized = "x".repeat(super::super::MAX_CONTENT_LENGTH + 1);
        sqlx::query(
            "INSERT OR REPLACE INTO block_drafts (block_id, content, updated_at) \
             VALUES (?, ?, '2025-01-01T00:00:00Z')",
        )
        .bind(LIVE_BLOCK)
        .bind(&oversized)
        .execute(&pool)
        .await
        .unwrap();

        let err = flush_draft_inner(&pool, DEVICE, LIVE_BLOCK.to_owned())
            .await
            .expect_err("oversized draft must be rejected");

        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("draft content") && msg.contains("exceeds maximum"),
                    "validation message must call out draft size: got {msg:?}",
                );
            }
            other => panic!("expected AppError::Validation, got {other:?}"),
        }

        // Draft row MUST still exist (so the user can edit it down).
        assert!(
            draft_exists(&pool, LIVE_BLOCK).await,
            "draft must survive oversized rejection — never silently dropped",
        );
        // No op_log entry was appended.
        assert_eq!(
            count_edit_block_ops(&pool, LIVE_BLOCK).await,
            0,
            "no edit_block op must be appended on oversized rejection",
        );
    }

    // -- M-93: schema invariant — block_drafts FK to blocks(id) ------------
    //
    // These two tests lock down the migration 0038 invariant: a draft can
    // only exist for an existing `blocks(id)`, and hard-deleting the block
    // cascades the draft away atomically. They bypass the public command
    // API on purpose — we are testing the schema, not the Rust layer.

    /// Hard-deleting a block must cascade-delete its draft via the FK
    /// (`ON DELETE CASCADE`). Before migration 0038 the draft would have
    /// outlived the block and surfaced as orphan noise during recovery.
    #[tokio::test]
    async fn hard_delete_block_cascades_to_block_drafts_m93() {
        let (pool, _dir) = test_pool().await;
        insert_live_block(&pool, LIVE_BLOCK).await;
        draft::save_draft(&pool, LIVE_BLOCK, "draft body")
            .await
            .unwrap();
        assert!(draft_exists(&pool, LIVE_BLOCK).await, "draft seeded");

        // Hard-delete the parent block. There is no public command that
        // bypasses the soft-delete tombstone for a single block id (purge
        // operates on the whole soft-deleted set), so we issue the DELETE
        // directly — what matters is that the FK fires, regardless of the
        // call site.
        sqlx::query("DELETE FROM blocks WHERE id = ?")
            .bind(LIVE_BLOCK)
            .execute(&pool)
            .await
            .unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_drafts WHERE block_id = ?")
            .bind(LIVE_BLOCK)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count, 0,
            "M-93: hard-deleting a block must cascade to block_drafts (FK ON DELETE CASCADE)",
        );
    }

    /// Inserting a draft for a `block_id` that has no row in `blocks`
    /// must fail with a FOREIGN KEY constraint violation. This is the
    /// schema-level guarantee that orphan drafts can no longer be
    /// created — only existing-block drafts are valid.
    #[tokio::test]
    async fn cannot_save_draft_for_nonexistent_block_m93() {
        let (pool, _dir) = test_pool().await;

        // No row in `blocks` for MISSING_BLOCK. Direct INSERT — bypasses
        // any application-layer check; we are exercising the FK itself.
        let err = sqlx::query(
            "INSERT INTO block_drafts (block_id, content, updated_at) \
             VALUES (?, 'orphan content', '2025-01-01T00:00:00Z')",
        )
        .bind(MISSING_BLOCK)
        .execute(&pool)
        .await
        .expect_err("insert without parent block must violate FK");

        let msg = format!("{err}");
        assert!(
            msg.to_lowercase().contains("foreign key"),
            "expected FOREIGN KEY violation, got: {msg}",
        );
    }

    // -- Happy path ---------------------------------------------------------

    #[tokio::test]
    async fn flush_draft_happy_path() {
        let (pool, _dir) = test_pool().await;
        insert_live_block(&pool, LIVE_BLOCK).await;

        draft::save_draft(&pool, LIVE_BLOCK, "final content")
            .await
            .unwrap();

        flush_draft_inner(&pool, DEVICE, LIVE_BLOCK.to_owned())
            .await
            .expect("happy-path flush must succeed");

        assert_eq!(
            count_edit_block_ops(&pool, LIVE_BLOCK).await,
            1,
            "exactly one edit_block op must be appended on happy-path flush",
        );
        assert!(
            !draft_exists(&pool, LIVE_BLOCK).await,
            "draft row must be deleted after a successful flush",
        );
    }
}
