//! Per-op incremental updates to the `block_tag_inherited` cache table (P-4).
//!
//! These helpers are the building blocks dispatched by
//! [`super::apply_op_tag_inheritance`] and are also called directly from a
//! handful of command handlers (`commands/blocks/crud.rs`,
//! `commands/blocks/move_ops.rs`, `commands/tags.rs`) and the materializer
//! (`materializer/handlers.rs`). They are `pub(crate)` because the documented
//! single entry point is [`super::apply_op_tag_inheritance`]; in-crate
//! call-sites that pre-date the consolidation continue to invoke specific
//! helpers directly.
//!
//! See [`crate::tag_inheritance`] for the recursive-CTE policy and macro
//! family.

use sqlx::SqliteConnection;

use crate::error::AppError;

/// After adding a tag to a block, propagate it to all descendants.
///
/// Inserts `(descendant, tag_id, block_id)` for every non-deleted, non-conflict
/// descendant of `block_id`. Uses `INSERT OR IGNORE` to handle races and
/// re-application safely (a descendant might already inherit the same tag from
/// a closer ancestor — the PK constraint keeps the existing row).
pub(crate) async fn propagate_tag_to_descendants(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendants_active!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT id, ?2, ?1 FROM descendants",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// After removing a tag from a block, clean up inherited entries.
///
/// 1. Delete all rows where `inherited_from = block_id AND tag_id = tag_id`.
/// 2. Re-attribute descendants from a direct tagger that sits **inside** the
///    deleted subtree. A child `C` of `block_id` that holds `tag_id` directly
///    in `block_tags` must keep propagating the tag to its own descendants —
///    those rows were wiped in step 1 (they carried `inherited_from = block_id`
///    because of the `(block_id, tag_id)` PK / `INSERT OR IGNORE` ordering) and
///    must be re-seeded with `inherited_from = C`. The nearest such tagger wins.
/// 3. For each remaining affected descendant, walk up ancestors ABOVE
///    `block_id` to find the next block that directly has this tag. If found,
///    re-insert with that ancestor as the new `inherited_from`.
///
/// Step 3 handles the case where grandparent and parent both have the same tag:
/// removing it from the parent re-attributes inheritance to the grandparent.
/// Step 2 handles the symmetric case where a tagger lives strictly INSIDE the
/// removed subtree (#675): without it, that tagger's descendants would silently
/// lose the tag.
pub(crate) async fn remove_inherited_tag(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    // Step 1: Delete all entries inherited from this block for this tag
    sqlx::query("DELETE FROM block_tag_inherited WHERE inherited_from = ?1 AND tag_id = ?2")
        .bind(block_id)
        .bind(tag_id)
        .execute(&mut *conn)
        .await?;

    // Step 2 (#675): Re-seed inheritance from direct taggers INSIDE the subtree.
    //
    // For every active descendant D of block_id that no longer has an inherited
    // row and is not itself a direct tagger, find the NEAREST ancestor C that
    // (a) sits at or below the level of block_id's children (i.e. C is in the
    // descendants set), and (b) holds the tag directly in block_tags. Re-insert
    // (D, tag, C). The ancestor walk is seeded from D and ranked by depth so the
    // closest in-subtree tagger wins; ancestors at or above block_id are
    // excluded here (those are handled by step 3).
    //
    // `subtree_descendants` reuses the same children-and-below walk as the
    // descendants set; `taggers` are the descendants that hold the tag directly.
    // For each descendant we re-walk its own ancestor chain, intersect with the
    // in-subtree taggers, and take the closest.
    // dynamic-sql: #675 — static concat! CTE, all values bound (?1/?2), no interpolation.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        // descendants(id, depth): children-and-below of block_id (?1).
        "descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ), ",
        // taggers: descendants that hold the tag directly (active rows only).
        "taggers AS ( \
             SELECT d.id FROM descendants d \
             JOIN block_tags bt ON bt.block_id = d.id AND bt.tag_id = ?2 \
         ), ",
        // For each descendant, walk up its parent chain (bounded) collecting
        // (descendant, ancestor, depth) so we can find the nearest in-subtree
        // tagger ancestor. The walk stops climbing once it reaches block_id
        // (block_id's own ancestors are step 3's responsibility) — but we keep
        // walking the id up to and including the chain inside the subtree.
        "anc(start_id, id, depth) AS ( \
             SELECT d.id, b.parent_id, 1 FROM descendants d \
             JOIN blocks b ON b.id = d.id \
             WHERE b.parent_id IS NOT NULL \
             UNION ALL \
             SELECT a.start_id, b.parent_id, a.depth + 1 FROM anc a \
             JOIN blocks b ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND a.id <> ?1 AND a.depth < 100 \
         ), ",
        // nearest in-subtree tagger ancestor per descendant.
        "reseed AS ( \
             SELECT a.start_id AS block_id, t.id AS inherited_from \
             FROM anc a \
             JOIN taggers t ON t.id = a.id \
             WHERE a.depth = ( \
                 SELECT MIN(a2.depth) FROM anc a2 \
                 JOIN taggers t2 ON t2.id = a2.id \
                 WHERE a2.start_id = a.start_id \
             ) \
         ) ",
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT r.block_id, ?2, r.inherited_from \
         FROM reseed r \
         WHERE r.block_id NOT IN ( \
             SELECT block_id FROM block_tag_inherited WHERE tag_id = ?2 \
         ) \
         AND r.block_id NOT IN ( \
             SELECT block_id FROM block_tags WHERE tag_id = ?2 \
         )",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    // Step 3: For descendants of block_id, check if any OTHER ancestor still
    // has this tag. If so, re-insert with the closest such ancestor.
    // We find all descendants of block_id, then for each, walk UP ancestors
    // (starting from block_id's parent) to find the nearest ancestor with the tag.
    //
    // Use a single SQL statement: for each descendant of block_id that doesn't
    // already have an entry in block_tag_inherited for this tag, find the
    // nearest ancestor with the tag via a lateral ancestor walk.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendants_active!(),
        ", ",
        crate::tag_inh_ancestors_walk!(1),
        ", ",
        "nearest_ancestor AS ( \
             SELECT a.id FROM ancestors a \
             JOIN block_tags bt ON bt.block_id = a.id AND bt.tag_id = ?2 \
             JOIN blocks b ON b.id = a.id \
             WHERE b.deleted_at IS NULL \
             ORDER BY a.depth ASC \
             LIMIT 1 \
         ) ",
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT d.id, ?2, na.id \
         FROM descendants d, nearest_ancestor na \
         WHERE d.id NOT IN ( \
             SELECT block_id FROM block_tag_inherited WHERE tag_id = ?2 \
         ) \
         AND d.id NOT IN ( \
             SELECT block_id FROM block_tags WHERE tag_id = ?2 \
         )",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    // Also re-insert for block_id itself if it's a descendant of the ancestor
    // (block_id no longer has the tag directly, but might inherit from above)
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_ancestors_walk!(1),
        ", ",
        "nearest_ancestor AS ( \
             SELECT a.id FROM ancestors a \
             JOIN block_tags bt ON bt.block_id = a.id AND bt.tag_id = ?2 \
             JOIN blocks b ON b.id = a.id \
             WHERE b.deleted_at IS NULL \
             ORDER BY a.depth ASC \
             LIMIT 1 \
         ) ",
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, ?2, na.id \
         FROM nearest_ancestor na \
         WHERE ?1 NOT IN ( \
             SELECT block_id FROM block_tags WHERE tag_id = ?2 \
         )",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Recompute all inherited tags for a block and its entire subtree.
///
/// Used after `move_block` (ancestry changed), `delete_block` (subtree
/// soft-deleted), and `restore_block` (subtree un-deleted). This is the
/// "nuclear option" — deletes all inherited entries for the subtree, then
/// recomputes from scratch by walking up ancestors for each block.
pub(crate) async fn recompute_subtree_inheritance(
    conn: &mut SqliteConnection,
    root_id: &str,
) -> Result<(), AppError> {
    // Step 1: Delete all inherited entries where block_id is in the subtree
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_active!(),
        " DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Also delete entries where inherited_from is in the subtree
    // (other blocks outside the subtree shouldn't be affected, but entries
    // inherited FROM a subtree block that has been moved need cleanup)
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_active!(),
        " DELETE FROM block_tag_inherited \
         WHERE inherited_from IN (SELECT id FROM subtree) \
           AND block_id NOT IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Step 2: Recompute for the subtree. For each (block, tag) pair where
    // a block in the subtree has a direct tag, propagate to all its descendants
    // within the subtree.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_active!(),
        ", ",
        crate::tag_inh_tagged_descendants_in_subtree!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT block_id, tag_id, inherited_from FROM tagged_descendants",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Step 3: Handle tags inherited FROM OUTSIDE the subtree.
    // Walk up ancestors of root_id to find all tags that root_id and its
    // descendants should inherit from above.
    //
    // I-Search-4: same ancestor-walk invariant as in `remove_inherited_tag`
    // above — `tag_inh_ancestors_walk!(0)` walks the parent chain
    // unfiltered; downstream projection joins `blocks` for whatever
    // active-row filtering the caller needs.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_ancestors_walk!(0),
        ", ",
        "ancestor_tags AS ( \
             SELECT bt.block_id AS inherited_from, bt.tag_id \
             FROM ancestors anc \
             JOIN block_tags bt ON bt.block_id = anc.id \
             JOIN blocks b ON b.id = anc.id \
             WHERE b.deleted_at IS NULL \
         ), ",
        crate::tag_inh_subtree_active!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT st.id, at2.tag_id, at2.inherited_from \
         FROM subtree st \
         CROSS JOIN ancestor_tags at2 \
         WHERE st.id NOT IN ( \
             SELECT block_id FROM block_tags WHERE tag_id = at2.tag_id \
         )",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// After creating a new block, inherit all tags from its parent.
///
/// The new block has no children yet, so we only need to copy the parent's
/// effective tags (direct from `block_tags` + inherited from `block_tag_inherited`).
pub(crate) async fn inherit_parent_tags(
    conn: &mut SqliteConnection,
    block_id: &str,
    parent_id: Option<&str>,
) -> Result<(), AppError> {
    let Some(parent_id) = parent_id else {
        return Ok(()); // Top-level block, no parent to inherit from
    };

    // Insert all of parent's direct tags as inherited
    sqlx::query(
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, bt.tag_id, bt.block_id \
         FROM block_tags bt \
         JOIN blocks b ON b.id = bt.block_id \
         WHERE bt.block_id = ?2 AND b.deleted_at IS NULL",
    )
    .bind(block_id)
    .bind(parent_id)
    .execute(&mut *conn)
    .await?;

    // Insert all of parent's inherited tags (pass through inherited_from)
    sqlx::query(
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, bti.tag_id, bti.inherited_from \
         FROM block_tag_inherited bti \
         WHERE bti.block_id = ?2",
    )
    .bind(block_id)
    .bind(parent_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Remove all inherited tag entries for a subtree being soft-deleted.
///
/// Also removes entries where other blocks inherited tags FROM blocks in this
/// subtree (since those blocks are now deleted, their tags shouldn't propagate).
///
/// **CTE policy exception:** the two CTEs below deliberately do NOT
/// filter `deleted_at IS NULL` — this helper is called AFTER the
/// subtree has been soft-deleted (`remove_subtree_inherited` runs in the
/// same transaction as the cascade UPDATE). Filtering `deleted_at IS NULL`
/// here would miss every descendant we just marked deleted, leaving
/// orphaned inheritance rows.
///
/// The depth bound (`MAX_TAG_INHERITANCE_DEPTH`) still guards against
/// runaway recursion on corrupted parent_id chains.
pub(crate) async fn remove_subtree_inherited(
    conn: &mut SqliteConnection,
    root_id: &str,
) -> Result<(), AppError> {
    // Remove entries where block_id is in subtree
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_unfiltered!(),
        " DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Remove entries where inherited_from is in subtree (tags from deleted blocks)
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_unfiltered!(),
        " DELETE FROM block_tag_inherited \
         WHERE inherited_from IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}
