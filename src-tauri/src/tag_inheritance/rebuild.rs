//! Full-vault rebuild of the `block_tag_inherited` cache table (P-4).
//!
//! Used as the materializer's safety-net / initial-population path. The
//! split variant ([`rebuild_all_split`]) exists for API parity with the
//! materializer's [`crate::materializer::handlers`] split/single dispatch
//! helper but now collapses onto the same single-statement recursive-CTE
//! `INSERT … SELECT` shape as [`rebuild_all`].
//!
//! See [`crate::tag_inheritance`] for the recursive-CTE policy and macro
//! family.

use sqlx::SqlitePool;

use crate::error::AppError;

/// Full rebuild of the `block_tag_inherited` table.
///
/// Atomic DELETE + recompute in a single transaction. Called as a background
/// materializer task (safety net / initial population).
pub async fn rebuild_all(pool: &SqlitePool) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM block_tag_inherited")
        .execute(&mut *tx)
        .await?;

    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendant_tags_full!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT block_id, tag_id, inherited_from FROM descendant_tags",
    ))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Read/write split variant of [`rebuild_all`].
///
/// Despite the name, the rebuild now runs entirely on `write_pool` inside
/// a single `BEGIN IMMEDIATE` transaction: DELETE followed by a single
/// recursive-CTE `INSERT … SELECT` (the same shape used by the unified
/// [`rebuild_all`]). The `read_pool` argument is retained for API
/// stability with the [`crate::materializer::handlers`] split/single
/// dispatch helper but is intentionally unused.
///
/// Closes L-93 (no per-row INSERT loop — the recursive CTE writes the
/// full tuple set in one statement) and L-94 (no read-vs-write race —
/// `BEGIN IMMEDIATE` serialises the rebuild with concurrent
/// [`super::apply_op_tag_inheritance`] writers, so any in-flight incremental
/// update either lands fully before the rebuild's DELETE or commits
/// after the rebuild commits, never sandwiched between).
pub(crate) async fn rebuild_all_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    // L-94: rebuild runs entirely on write_pool inside BEGIN IMMEDIATE;
    // read_pool is retained for API stability with `dispatch_split_or_single`.
    let _ = read_pool;

    // BEGIN IMMEDIATE eagerly acquires the writer lock so concurrent
    // `apply_op_tag_inheritance` calls serialise behind us. Combined with
    // the single-statement recursive-CTE INSERT below, this means the
    // DELETE + recompute is atomic with respect to incremental updates.
    let mut tx = write_pool.begin_with("BEGIN IMMEDIATE").await?;

    sqlx::query("DELETE FROM block_tag_inherited")
        .execute(&mut *tx)
        .await?;

    // L-93: same recursive-CTE INSERT … SELECT used by `rebuild_all` —
    // no Rust-side tuple materialisation, no per-row INSERT loop.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendant_tags_full!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT block_id, tag_id, inherited_from FROM descendant_tags",
    ))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}
