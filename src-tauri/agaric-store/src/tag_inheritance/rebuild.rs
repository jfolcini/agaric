//! Full-vault rebuild of the `block_tag_inherited` cache table (P-4).
//!
//! Used as the materializer's safety-net / initial-population path. The
//! split variant ([`rebuild_all_split`]) runs [`rebuild_all`] only when a
//! comparison on the read pool finds the table stale.
//!
//! See [`crate::tag_inheritance`] for the recursive-CTE policy and macro
//! family.

use sqlx::SqlitePool;

use agaric_core::error::AppError;

/// Full rebuild of the `block_tag_inherited` table.
///
/// Atomic DELETE + recompute in a single transaction. Called as a background
/// materializer task (safety net / initial population).
///
/// # The definition of `block_tag_inherited`
///
/// This function is the canonical statement of what the table contains, and
/// every incremental maintainer in `super::incremental` must converge on it
/// (#3876). A row `(block_id, tag_id, inherited_from)` exists iff:
///
/// * some STRICT ancestor of `block_id` holds `tag_id` directly in
///   `block_tags`, reached through a chain of live (`deleted_at IS NULL`)
///   blocks, and
/// * `inherited_from` is the NEAREST such ancestor (`tag_inh_rebuild_nearest!`
///   collapses the walk by minimum depth, `MIN(inherited_from)` as tiebreak).
///
/// Notably the relation does NOT depend on whether `block_id` ALSO holds
/// `tag_id` directly: a block that is tagged `#t` and sits under an ancestor
/// tagged `#t` appears in BOTH `block_tags` and `block_tag_inherited`
/// (#3876; migration 0021's backfill has always done this). Consumers wanting
/// "inherited but not direct" subtract — `useBlockTags` does exactly that, and
/// [`crate::tag_query::list_inherited_tags_for_block`] documents the overlap.
/// No consumer counts the two tables additively: every read is a `UNION` or an
/// `EXISTS`, so the overlap cannot double-count.
pub async fn rebuild_all(pool: &SqlitePool) -> Result<(), AppError> {
    // #117: BEGIN IMMEDIATE takes the writer lock up front, so concurrent
    // `apply_op_tag_inheritance` calls serialise behind the DELETE +
    // recompute: an incremental update lands wholly before or wholly after
    // it. `begin_immediate_logged` adds the slow-acquire log.
    let mut tx = crate::db::begin_immediate_logged(pool, "tag_inheritance_rebuild").await?;

    sqlx::query("DELETE FROM block_tag_inherited")
        .execute(&mut *tx)
        .await?;

    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendant_tags_full!(),
        ", ",
        crate::tag_inh_rebuild_nearest!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT block_id, tag_id, inherited_from FROM descendant_tags_nearest",
    ))
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// [`rebuild_all`] that first compares the table with what it should hold, on
/// `read_pool`, and returns without taking the writer lock when they agree.
///
/// Every op maintains `block_tag_inherited` in its own transaction, so on a
/// restore, which enqueues this as a safety net, the comparison normally
/// finds nothing. When it finds a difference the rebuild is [`rebuild_all`]
/// itself, under the lock: it derives every row again there, so nothing the
/// comparison read is written. A row that goes stale after the comparison is
/// the business of the write that staled it, as it is after any rebuild.
pub async fn rebuild_all_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    // The CTE is the one `rebuild_all` inserts from. It is named twice, so
    // SQLite materialises it once.
    let stale: bool = sqlx::query_scalar(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendant_tags_full!(),
        ", ",
        crate::tag_inh_rebuild_nearest!(),
        " SELECT EXISTS ( \
             SELECT block_id, tag_id, inherited_from FROM descendant_tags_nearest \
             EXCEPT \
             SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
         ) OR EXISTS ( \
             SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
             EXCEPT \
             SELECT block_id, tag_id, inherited_from FROM descendant_tags_nearest \
         )",
    ))
    .fetch_one(read_pool)
    .await?;
    if !stale {
        return Ok(());
    }
    rebuild_all(write_pool).await
}
