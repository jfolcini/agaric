//! Soft-delete pure query helpers: `is_deleted`, `soft_delete_block`.
//!
//! Wave S4e (#2621): the two pure, side-effect-free soft-delete query
//! helpers. The materializer-coupled orchestration (`cascade_soft_delete`,
//! `restore_block`, and the `synthesize_*_op` fan-out builders) stays in the
//! app crate — it reaches these two helpers via `pub use` re-exports so every
//! `crate::soft_delete::…` call site resolves unchanged.

use sqlx::SqlitePool;

use agaric_core::error::AppError;

/// Check whether a block is currently soft-deleted.
pub async fn is_deleted(pool: &SqlitePool, block_id: &str) -> Result<Option<bool>, AppError> {
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id,)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.deleted_at.is_some()))
}

/// Soft-delete a single block (no cascade).
pub async fn soft_delete_block(pool: &SqlitePool, block_id: &str) -> Result<Option<i64>, AppError> {
    // #1549: monotonic-per-process delete clock so this primitive's
    // `deleted_at` stamp never collides with another same-ms delete's cohort.
    let now = crate::db::next_delete_ms();
    let result = sqlx::query!(
        "UPDATE blocks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        now,
        block_id
    )
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        Ok(None)
    } else {
        Ok(Some(now))
    }
}
