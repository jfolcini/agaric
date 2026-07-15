//! ULID newtypes + the block-activeness gate.
//!
//! The newtypes (`BlockId`, `ActiveBlockId`, `PageId`, `UlidInline`, and the
//! `AttachmentId` / `SnapshotId` aliases) live in `agaric-core` (#2621) and are
//! re-exported here, so every `crate::ulid::BlockId` path resolves unchanged.
//! What stays in the app/store layer is the checked `BlockId → ActiveBlockId`
//! gate below: `verify_active` / `verify_active_in_tx` run a `sqlx::query!`
//! against the `blocks` table — schema owned by this crate, not a core concern
//! — so they cannot move down into the foundation crate.

use crate::error::AppError;
use sqlx::SqlitePool;

pub use agaric_core::ulid::*;

/// Verify that a [`BlockId`] refers to an active block — i.e., a row
/// exists in `blocks` with deleted_at IS NULL`.
///
/// This is the single checked gate from raw [`BlockId`] to
/// [`ActiveBlockId`]. Every `ActiveBlockId` value in the
/// codebase is either:
///
/// 1. produced directly by a SQL query that filters on
///    deleted_at IS NULL` (constructed via
///    [`ActiveBlockId::from_trusted_active`] at the helper boundary), or
/// 2. round-tripped through this function from a raw [`BlockId`].
///
/// Standalone (pool) form. Write commands that already open their own
/// transaction should call [`verify_active_in_tx`] instead so the
/// activeness check folds into the write transaction and the row is read
/// only once (#1627). This pool form remains the gate for read-only and
/// non-transactional callers (e.g. the MCP `set_property` boundary, which
/// has no surrounding tx of its own).
///
/// # Errors
///
/// - [`AppError::NotFound`] — no row exists with this id.
/// - [`AppError::Validation`] — the row exists but has been soft-deleted
///   (`deleted_at IS NOT NULL`).
pub async fn verify_active(pool: &SqlitePool, id: &BlockId) -> Result<ActiveBlockId, AppError> {
    let mut conn = pool.acquire().await?;
    verify_active_in_tx(&mut conn, id).await
}

/// In-transaction sibling of [`verify_active`].
///
/// Performs the IDENTICAL existence / soft-deleted discrimination as
/// [`verify_active`] — same SQL shape, same distinct error variants and
/// messages — but against a live transaction executor instead of the
/// pool. This lets a write command fold the activeness gate INTO the
/// same `BEGIN IMMEDIATE` transaction that performs the write, so the
/// row is read exactly once (TOCTOU-safe) and the previously redundant
/// pre-transaction round-trip on the pool is eliminated (#1627).
///
/// The returned [`ActiveBlockId`] carries the same type-state guarantee
/// as [`verify_active`]'s — it is minted only after the row is confirmed
/// to exist with `deleted_at IS NULL` inside the caller's transaction.
///
/// # Errors
///
/// - [`AppError::NotFound`] — no row exists with this id.
/// - [`AppError::Validation`] — the row exists but has been soft-deleted
///   (`deleted_at IS NOT NULL`).
pub async fn verify_active_in_tx(
    conn: &mut sqlx::SqliteConnection,
    id: &BlockId,
) -> Result<ActiveBlockId, AppError> {
    let id_str = id.as_str();
    let row = sqlx::query!(
        r#"SELECT deleted_at
           FROM blocks
           WHERE id = ?"#,
        id_str,
    )
    .fetch_optional(&mut *conn)
    .await?;

    let row = row.ok_or_else(|| AppError::NotFound(format!("block '{id_str}' does not exist")))?;

    if row.deleted_at.is_some() {
        return Err(AppError::validation(format!(
            "block '{id_str}' has been soft-deleted"
        )));
    }

    Ok(ActiveBlockId::from_trusted_active(id_str))
}

#[cfg(test)]
mod tests;
