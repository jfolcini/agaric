//! PEND-56b `pages_cache.{inbound_link_count,child_block_count}`
//! maintenance: the canonical recompute SELECT and the per-op
//! affected-page resolution hooks.

use super::*;

// ---------------------------------------------------------------------------
// PEND-56b — `pages_cache.{inbound_link_count,child_block_count}` maintenance
// ---------------------------------------------------------------------------
//
// Migrations 0069/0070 added two materialised aggregate columns to
// `pages_cache` (`inbound_link_count`, `child_block_count`) and backfilled
// them. The materializer is the only thing that mutates caches (AGENTS.md
// invariant), so it must keep the two columns equal to what a live recompute
// over `blocks` + `block_links` would produce.
//
// Strategy: **recompute-on-touch**. For every per-op handler that can
// affect the counts we (a) compute the bounded set of pages whose counts
// may have changed, and (b) UPDATE each row to the value of the canonical
// recompute SELECT in `recompute_pages_cache_counts_for_pages` (below). The
// per-op cost is bounded by the few link targets / outbound edges of a
// single block; total correctness is asserted by the integration parity
// test (see the `pages_cache_count_parity` mod in `materializer/tests.rs`).
//
// The single source of truth for the count SELECT shape is
// `recompute_pages_cache_counts_for_pages`. The migration-0070 backfill and
// the parity test's `canonical_counts` use the same shape; the parity test
// fails the build if the materialised columns ever diverge from a
// from-first-principles recompute.

/// Recompute and persist both `inbound_link_count` and `child_block_count`
/// for every `pages_cache` row whose `page_id` appears in `page_ids`.
///
/// Idempotent: missing `pages_cache` rows (e.g., the target was a content
/// block, or the page was soft-deleted and its cache row already removed)
/// are silently skipped — the `WHERE page_id = ?` filter matches zero
/// rows. Duplicate ids in the slice are deduplicated upfront.
///
/// This recompute SELECT is the **single source of truth** for the two
/// count columns. The migration-0070 backfill
/// (`migrations/0070_pages_cache_inbound_link_count_exclude_same_page.sql`)
/// and the parity test's `canonical_counts` derive the same values; if you
/// change either subquery here, change them there too — the parity test
/// catches drift on every run.
///
/// `child_block_count` is page-wide: every non-deleted block whose
/// `page_id` is this page (excluding the page block itself). The backfill
/// in migration 0069 seeded this column with the same shape.
///
/// `inbound_link_count` is also page-wide (NOT the single-block-scoped
/// backlink count in `backlink/grouped.rs`, which evaluates one block's
/// inbound edges): it counts distinct source blocks that link into the
/// page or any of its descendants while EXCLUDING same-page/self links (a
/// source whose own `page_id` is the target page) and deleted/orphan
/// sources (`src.deleted_at IS NULL`, `src.page_id IS NOT NULL`). The
/// original 0069 backfill omitted those exclusions and over-counted;
/// migration 0070 re-backfills existing rows with this corrected shape,
/// which is what makes `Orphan` / `HasNoInboundLinks` / `MostLinked` /
/// the `↗N` badge agree with the live backlink panel.
pub(crate) async fn recompute_pages_cache_counts_for_pages(
    conn: &mut sqlx::SqliteConnection,
    page_ids: &[String],
) -> Result<(), AppError> {
    if page_ids.is_empty() {
        return Ok(());
    }
    // B-C2 (issue #108): dedupe the touched set and apply both counts
    // in one statement, replacing the per-page loop. The correlated
    // subqueries reference the outer UPDATE's `pages_cache.page_id`
    // (one row at a time), so a multi-row UPDATE is semantically
    // identical to N single-row UPDATEs but does it in one round-trip.
    use std::collections::HashSet;
    let unique: HashSet<&String> = page_ids.iter().collect();
    let unique: Vec<&String> = unique.into_iter().collect();
    let json = serde_json::to_string(&unique)?;
    sqlx::query!(
        "UPDATE pages_cache SET \
             inbound_link_count = ( \
                 SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                     JOIN blocks descendant ON bl.target_id = descendant.id \
                     JOIN blocks src ON src.id = bl.source_id \
                     WHERE descendant.page_id = pages_cache.page_id \
                       AND descendant.deleted_at IS NULL \
                       AND src.deleted_at IS NULL \
                       AND src.page_id IS NOT NULL \
                       AND src.page_id != pages_cache.page_id \
             ), \
             child_block_count = ( \
                 SELECT COUNT(*) FROM blocks descendant \
                     WHERE descendant.page_id = pages_cache.page_id \
                       AND descendant.deleted_at IS NULL \
                       AND descendant.id != pages_cache.page_id \
             ) \
         WHERE page_id IN (SELECT value FROM json_each(?))",
        json,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Read every `page_id` set on the given block ids (NULLs filtered out)
/// and return the unique values. Used to map a set of affected blocks to
/// the set of pages whose counts must be refreshed.
pub(super) async fn distinct_pages_for_blocks(
    conn: &mut sqlx::SqliteConnection,
    block_ids: &[String],
) -> Result<Vec<String>, AppError> {
    if block_ids.is_empty() {
        return Ok(Vec::new());
    }
    let json = serde_json::to_string(block_ids)?;
    let rows = sqlx::query!(
        "SELECT DISTINCT page_id AS \"page_id!\" FROM blocks \
         WHERE id IN (SELECT value FROM json_each(?)) \
           AND page_id IS NOT NULL",
        json,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// Parse all `[[ULID]]` / `((ULID))` link tokens from a block's content
/// and return the unique target ids. Mirrors the regex used by
/// `cache::reindex_block_links` so the materialised counts and the
/// `block_links` table see the same edge set.
pub(super) fn parse_link_targets_from_content(content: &str) -> Vec<String> {
    use std::collections::HashSet;
    let mut out: HashSet<String> = HashSet::new();
    for cap in crate::cache::ULID_LINK_RE.captures_iter(content) {
        out.insert(cap[1].to_string());
    }
    out.into_iter().collect()
}

/// Return the set of pages whose `inbound_link_count` could be affected
/// by `block_id`'s outbound edges currently recorded in `block_links`.
/// Resolved as the distinct `page_id` of every `bl.target_id` where
/// `bl.source_id = block_id`. NULL page ids (e.g., orphan targets) are
/// filtered out.
pub(super) async fn outbound_target_pages_for_block(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        "SELECT DISTINCT b.page_id AS \"page_id!\" FROM block_links bl \
             JOIN blocks b ON b.id = bl.target_id \
         WHERE bl.source_id = ? AND b.page_id IS NOT NULL",
        block_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// Batch variant of [`outbound_target_pages_for_block`]: resolve the set of
/// pages reachable via outbound edges from any block in `block_ids` in a
/// single SQL round-trip, using `json_each(?)` to avoid an N+1 pattern.
///
/// Returns the distinct `page_id` values (NULLs excluded) across all
/// `bl.target_id` rows where `bl.source_id IN block_ids`.  Empty input
/// short-circuits without touching the DB.
///
/// Uses the runtime (non-macro) query form so the `.sqlx` offline-query
/// cache does not need a regeneration when the function is first added.
pub(super) async fn outbound_target_pages_for_blocks(
    conn: &mut sqlx::SqliteConnection,
    block_ids: &[String],
) -> Result<Vec<String>, AppError> {
    if block_ids.is_empty() {
        return Ok(Vec::new());
    }
    let json = serde_json::to_string(block_ids)?;
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT b.page_id FROM block_links bl \
         JOIN blocks b ON b.id = bl.target_id \
         WHERE bl.source_id IN (SELECT value FROM json_each(?)) \
           AND b.page_id IS NOT NULL",
    )
    .bind(&json)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows)
}

/// Resolve the set of pages each candidate target block would contribute
/// to as an `inbound_link_count` source if it were linked from a content
/// block. For each `target_id` we read `blocks.page_id`; if the target is
/// itself a page the value equals its own id; if the target is a content
/// block, the value is its owning page; if the row is missing (dangling
/// token) the target is dropped.
pub(super) async fn target_pages_for_block_ids(
    conn: &mut sqlx::SqliteConnection,
    target_ids: &[String],
) -> Result<Vec<String>, AppError> {
    if target_ids.is_empty() {
        return Ok(Vec::new());
    }
    let json = serde_json::to_string(target_ids)?;
    let rows = sqlx::query!(
        "SELECT DISTINCT page_id AS \"page_id!\" FROM blocks \
         WHERE id IN (SELECT value FROM json_each(?)) \
           AND page_id IS NOT NULL",
        json,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// PEND-56b: maintenance hook called from `apply_op_tx` after each per-op
/// projection commits. Computes the bounded set of pages whose counts may
/// have changed and refreshes them via the canonical SELECT.
///
/// Per-op affected-page set:
///
/// - `CreateBlock`: the new block's owning page (`+= 1` child for non-page
///   creates; `pages_cache` row insert for page creates) + every page
///   targeted by `[[ULID]]`/`((ULID))` tokens in the new content.
/// - `EditBlock`: the edited block's owning page + every page targeted by
///   the OLD `block_links` rows (will lose an edge if the token is gone) +
///   every page parsed out of the NEW content (will gain an edge once
///   `ReindexBlockLinks` runs in the background).
/// - `DeleteBlock` (cohort-aware): every page the cohort blocks lived on
///   (lose a child) + every page each cohort block's outbound edges
///   pointed to (lose an inbound) + every page that was inbound-linked
///   FROM the cohort (their outbound counts unchanged but inbound was
///   the descendants which are now deleted).
/// - `RestoreBlock`: symmetric to delete — same affected set.
/// - `PurgeBlock`: same as delete, plus the cohort's source-pages of
///   inbound edges that get cleared by FK CASCADE on `block_links`.
///
/// NOTE on `EditBlock` / `CreateBlock` with link tokens (#1548): the new
/// block's outbound `block_links` rows are brought in sync IN THIS TX via
/// `cache::reindex_block_links_conn` BEFORE the count recompute, so the
/// in-tx `inbound_link_count` SELECT (which joins `block_links`) reflects
/// added and removed edges immediately — the count is synchronously correct
/// per-op rather than eventually-consistent on the background
/// `ReindexBlockLinks` task. That background task remains as the idempotent
/// backstop: it re-diffs the same content, finds the edges already applied,
/// and is a no-op, so the synchronous update and the rebuild converge on the
/// same value with no double-count.
pub(super) async fn maintain_pages_cache_counts_after_op(
    conn: &mut sqlx::SqliteConnection,
    pre_state: &PreOpState,
) -> Result<(), AppError> {
    use std::collections::HashSet;

    let mut affected: HashSet<String> = HashSet::new();

    match pre_state {
        PreOpState::Create {
            block_id,
            parent_id,
            block_type,
            content,
        } => {
            // The new block exists in `blocks` post-projection. Resolve
            // its owning page from the parent chain.
            //
            // For page creates the projection writes (id, block_type=page,
            // content, parent_id=None). The block's `page_id` is set by
            // the background `RebuildPageIds` task to its own id. To make
            // the count visible immediately, we INSERT a `pages_cache`
            // row here so the recompute UPDATE below has a target row.
            // Determine the owning page.
            let owning_page = resolve_owning_page(conn, block_id, parent_id.as_deref()).await?;
            if block_type == "page" {
                // INSERT the pages_cache row if missing so the
                // `UPDATE` below sees a target. Title = content
                // (matches `rebuild_pages_cache`'s desired-state SQL).
                let title = content.as_str();
                let now = crate::db::now_ms();
                sqlx::query!(
                    "INSERT OR IGNORE INTO pages_cache \
                         (page_id, title, updated_at, inbound_link_count, child_block_count) \
                     VALUES (?, ?, ?, 0, 0)",
                    block_id,
                    title,
                    now,
                )
                .execute(&mut *conn)
                .await?;
                affected.insert(block_id.clone());
            }
            if let Some(p) = owning_page {
                affected.insert(p);
            }
            // Parse [[ULID]]/((ULID)) tokens from the new content
            // and add the inferred target pages.
            let tokens = parse_link_targets_from_content(content);
            if !tokens.is_empty() {
                // #1548: write this block's outbound `block_links` edges IN
                // THIS TX (idempotent diff, same engine the background
                // `ReindexBlockLinks` task uses) BEFORE the recompute below,
                // so the in-tx `inbound_link_count` SELECT — which joins
                // `block_links` — observes the new edges immediately. Without
                // this the count stayed stale until the async reindex caught
                // up. The later background reindex re-diffs the same content,
                // finds the edges already present, and is a no-op: the sync
                // update and the backstop rebuild converge with no
                // double-count.
                crate::cache::reindex_block_links_conn(conn, block_id).await?;
                for p in target_pages_for_block_ids(conn, &tokens).await? {
                    affected.insert(p);
                }
            }
        }
        PreOpState::Edit { block_id, to_text } => {
            // Owning page of the edited block.
            let row = sqlx::query!("SELECT page_id FROM blocks WHERE id = ?", block_id)
                .fetch_optional(&mut *conn)
                .await?;
            if let Some(Some(p)) = row.map(|r| r.page_id) {
                affected.insert(p);
            }
            // Pages reachable via OLD outbound edges (still in
            // `block_links` until we re-diff below). Collected BEFORE the
            // in-tx reindex so a page that just LOST its only inbound edge
            // (token removed) is still in the affected set and gets its
            // decremented count recomputed.
            for p in outbound_target_pages_for_block(conn, block_id).await? {
                affected.insert(p);
            }
            // Pages parsed from the NEW content — caught via target's
            // page_id. We add them so the affected set covers pages that
            // just GAINED an inbound edge as well.
            let tokens = parse_link_targets_from_content(to_text);
            if !tokens.is_empty() {
                for p in target_pages_for_block_ids(conn, &tokens).await? {
                    affected.insert(p);
                }
            }
            // #1548: bring this block's outbound `block_links` rows in sync
            // with the new content IN THIS TX (idempotent diff — the same
            // engine the background `ReindexBlockLinks` task runs), so the
            // `inbound_link_count` recompute below — which joins
            // `block_links` — reflects added AND removed edges immediately
            // instead of staying stale until the async reindex catches up.
            // The later background reindex re-diffs the same content, finds
            // no changes, and is a no-op: the synchronous update and the
            // backstop rebuild converge with no double-count.
            crate::cache::reindex_block_links_conn(conn, block_id).await?;
        }
        PreOpState::Cohort(cohort) => {
            // The cohort is captured upstream in `apply_op_tx` (see
            // `collect_delete_cohort` / `collect_restore_cohort`). We
            // mirror the same set here via the `Cohort` variant.
            for p in distinct_pages_for_blocks(conn, cohort).await? {
                affected.insert(p);
            }
            // Pages targeted by outbound edges from any cohort block.
            // For DeleteBlock those edges still exist in `block_links`
            // (CASCADE FK fires on row DELETE, not on `deleted_at` stamp);
            // for RestoreBlock the edges remain throughout, so the union
            // of `outbound_target_pages_for_block` over the cohort is
            // identical pre- and post-projection.
            // #463: single batch query instead of one round-trip per cohort block.
            for p in outbound_target_pages_for_blocks(conn, cohort).await? {
                affected.insert(p);
            }
            // Inbound: blocks whose links pointed INTO the cohort. Their
            // page_id's `inbound_link_count` doesn't change because the
            // inbound count is keyed on the TARGET page (the cohort's
            // page), not the source. So nothing to add here beyond what
            // we already collected via `distinct_pages_for_blocks`.
            //
            // Edge case: the cohort may include a page block. That page
            // contributed to its own descendants' inbound count via
            // `descendant.page_id = page_id`. After soft-delete, the
            // page's own `pages_cache` row is still present (it's
            // removed by the later `RebuildPagesCache` rebuild); the
            // recompute UPDATE will set its inbound_link_count to 0
            // (all descendants are now deleted_at IS NOT NULL).
        }
        PreOpState::Purge { affected_pages } => {
            // PurgeBlock removes the cohort's `blocks` rows entirely; FK
            // CASCADE on `block_links` (mig 0061) clears outbound and
            // inbound edges. We captured the affected pages BEFORE the
            // cascade ran (see `pre_state`).
            for p in affected_pages {
                affected.insert(p.clone());
            }
        }
        PreOpState::Move { block_id, src_page } => {
            // E4: a MoveBlock CAN alter `page_id`. `commands/blocks/move_ops.rs`
            // recomputes `page_id` for the moved block + its descendants on a
            // cross-page reparent, so the source page loses children and the
            // destination page gains them. The earlier "MoveBlock never alters
            // page_id" assumption was false and left both pages'
            // `child_block_count` stale until an unrelated op touched each one.
            //
            // The materializer's own MoveBlock projection
            // (`apply_move_block_via_loro` → `project_move_block_to_sql`) only
            // writes `parent_id`/`position`; it defers the `page_id` recompute
            // to the background `RebuildPageIds` task. The page-wide count
            // recompute below keys on `blocks.page_id`, so we mirror
            // `move_ops.rs` and update the moved subtree's `page_id` HERE
            // (bounded, depth-capped) before recomputing — that keeps the
            // in-tx recompute correct without waiting for `RebuildPageIds`,
            // and is idempotent with it.
            let dest_page = reparent_moved_subtree_page_id(conn, block_id).await?;
            if let Some(src) = src_page {
                affected.insert(src.clone());
            }
            if let Some(dest) = dest_page {
                affected.insert(dest);
            }
        }
        // No-ops for count maintenance: tag / property / attachment ops
        // never affect either count (they don't change the
        // `blocks.page_id`/`deleted_at` membership of any page).
        PreOpState::None => {}
    }

    if affected.is_empty() {
        return Ok(());
    }
    let v: Vec<String> = affected.into_iter().collect();
    recompute_pages_cache_counts_for_pages(conn, &v).await?;
    Ok(())
}

/// E4: recompute `blocks.page_id` for a just-moved block and its
/// descendants, mirroring `commands/blocks/move_ops.rs`, and return the
/// block's new owning page id (the destination page) for count-refresh.
///
/// The materializer's MoveBlock projection only writes
/// `parent_id`/`position`; the canonical full `page_id` rebuild is the
/// background `RebuildPageIds` task. But the page-wide count recompute in
/// `maintain_pages_cache_counts_after_op` keys on `blocks.page_id`, so we
/// reproduce the bounded subtree update here (depth-capped per invariant
/// #9) so the in-tx recompute reflects the new page membership without
/// waiting for `RebuildPageIds`. Running both is idempotent — they
/// converge on the same `page_id` for the subtree.
///
/// Returns the moved block's destination page (its own id when the moved
/// block is itself a page; the parent's owning page otherwise; `None`
/// when the block was moved to the top level / has no page ancestor).
pub(super) async fn reparent_moved_subtree_page_id(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Option<String>, AppError> {
    // The block's current parent_id reflects the post-projection move.
    let row = sqlx::query!(
        "SELECT block_type, parent_id FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut *conn)
    .await?;
    let Some((block_type, parent_id)) = row.map(|r| (r.block_type, r.parent_id)) else {
        // Block vanished (e.g. concurrent purge); nothing to recompute.
        return Ok(None);
    };

    // Destination page derived from the NEW parent: a page parent owns
    // itself; any other parent contributes its own `page_id`. No parent
    // → top-level → no owning page (page_id NULL). Mirrors `move_ops.rs`.
    let new_page_id: Option<String> = if let Some(pid) = &parent_id {
        sqlx::query_scalar!(
            "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END \
             AS \"v?\" FROM blocks WHERE id = ?",
            pid,
        )
        .fetch_optional(&mut *conn)
        .await?
        .flatten()
    } else {
        None
    };

    let is_page = block_type == "page";
    // Pages always own themselves regardless of parent; content/other
    // blocks inherit the destination page id.
    let effective_page_id = if is_page {
        Some(block_id.to_owned())
    } else {
        new_page_id.clone()
    };

    // Update the moved block itself (pages keep page_id = self).
    if !is_page {
        let new_page_id_ref = new_page_id.as_deref();
        sqlx::query!(
            "UPDATE blocks SET page_id = ? WHERE id = ?",
            new_page_id_ref,
            block_id,
        )
        .execute(&mut *conn)
        .await?;
    }

    // Update all non-page descendants to inherit the moved block's page
    // id. Recursive CTE bounds `depth < 100` (invariant #9) and filters
    // `deleted_at IS NULL` in both members so soft-deleted conflict
    // copies don't leak into the walk. Mirrors `move_ops.rs`.
    let effective_page_id_ref = effective_page_id.as_deref();
    sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ) \
         UPDATE blocks SET page_id = ?2 \
         WHERE id IN (SELECT id FROM descendants) AND block_type != 'page'",
        block_id,
        effective_page_id_ref,
    )
    .execute(&mut *conn)
    .await?;

    Ok(effective_page_id)
}

/// Walk `blocks.parent_id` from `block_id` and return the page-typed
/// ancestor's id, or `None` if no ancestor of `block_type = 'page'`
/// exists. For the seed block itself the function returns `block_id`
/// when its `block_type = 'page'`. Matches the shape of the recursive
/// CTE in `cache::page_id::rebuild_page_ids_impl` (single-block scope,
/// depth-bounded).
pub(super) async fn resolve_owning_page(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    parent_hint: Option<&str>,
) -> Result<Option<String>, AppError> {
    // B-I1 (issue #108): collapse the per-row ancestor walk into the
    // canonical `ancestors_cte_standard!()` CTE — one round-trip
    // (or two, with the `parent_hint` fallback) instead of one per
    // depth-step. Depth-cap 100 (invariant #9) is preserved by the
    // macro's recursive guard. The `JOIN blocks` + `ORDER BY depth ASC
    // LIMIT 1` selects the nearest page-typed ancestor; for a seed that
    // is itself a page the depth-0 row wins.
    if let Some(page_id) = nearest_page_ancestor(conn, block_id).await? {
        return Ok(Some(page_id));
    }
    // Seed row may not exist yet (the createBlock path can call this
    // before projection has inserted the row in some legacy call sites);
    // fall back to `parent_hint` if provided.
    if let Some(hint) = parent_hint {
        return nearest_page_ancestor(conn, hint).await;
    }
    Ok(None)
}

/// Issue #108 (B-I1) helper: walk ancestors of `seed` via the canonical
/// recursive CTE and return the id of the nearest `block_type = 'page'`
/// ancestor (or the seed itself if it is a page). `None` when the seed
/// row doesn't exist or no page-typed ancestor is reachable within the
/// invariant-#9 depth-100 bound.
pub(super) async fn nearest_page_ancestor(
    conn: &mut sqlx::SqliteConnection,
    seed: &str,
) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as(concat!(
        crate::ancestors_cte_standard!(),
        "SELECT a.id FROM ancestors a \
         JOIN blocks b ON b.id = a.id \
         WHERE b.block_type = 'page' \
         ORDER BY a.depth ASC \
         LIMIT 1",
    ))
    .bind(seed)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// Capture the set of pages this block was linking to BEFORE the
/// pending `reindex_block_links` diff runs. Returned to the caller so
/// it can union the pre- and post-diff target page sets when refreshing
/// `pages_cache.inbound_link_count` — covers both edges that just
/// disappeared (no longer in `block_links` post-diff, only in pre-set)
/// and edges that stayed (in both).
pub(super) async fn pre_diff_target_pages(
    pool: &sqlx::SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        "SELECT DISTINCT b.page_id AS \"page_id!\" FROM block_links bl \
             JOIN blocks b ON b.id = bl.target_id \
         WHERE bl.source_id = ? AND b.page_id IS NOT NULL",
        block_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.page_id).collect())
}

/// Refresh `pages_cache.inbound_link_count` for every page reachable
/// via this block's outbound edges (pre-diff PLUS post-diff) and every
/// target page currently in `page_link_cache` from this block's source
/// page.
///
/// Called from the `MaterializeTask::ReindexBlockLinks` arm AFTER
/// `cache::reindex_block_links` + `cache::reindex_page_link_cache_for_block`
/// have written the canonical post-diff state. The set of affected
/// target pages is the union of:
///
/// 1. `pre` — page ids captured BEFORE the diff ran (catches edges
///    that just disappeared; the post-diff `block_links` no longer
///    references them, so we'd miss the decrement otherwise).
/// 2. Distinct `page_id` of each block currently in `block_links`
///    under `source_id = block_id` (catches edges that just appeared
///    or stayed put — new inbound counts to refresh).
/// 3. Distinct `target_page_id` in `page_link_cache` where
///    `source_page_id = blocks.parent_id` (or `block_id` if the block
///    itself is a page) — covers the page-link-cache's view of the
///    block's outbound page edges.
///
/// Bounded by the block's outbound edge cardinality (a few targets
/// per block in practice). Each iteration runs a single UPDATE with
/// two SELECT subqueries; the SELECTs are index-served by
/// `idx_block_links_target_source` + `idx_blocks_page_id`.
pub(super) async fn refresh_inbound_counts_after_reindex(
    pool: &sqlx::SqlitePool,
    block_id: &str,
    pre: &[String],
) -> Result<(), AppError> {
    use std::collections::HashSet;
    // SQL-review M-1: write txs must use `begin_immediate_logged` so
    // sync-burst contention serialises upfront with a `warn!` log
    // instead of stalling mid-tx under SQLite's default DEFERRED
    // isolation. Mirrors the convention in `apply_op` / `apply_op` batch.
    let mut tx =
        crate::db::begin_immediate_logged(pool, "materializer_pages_cache_inbound_refresh").await?;
    let mut affected: HashSet<String> = HashSet::new();
    for p in pre {
        affected.insert(p.clone());
    }

    // (2) Current outbound targets' page ids.
    let rows = sqlx::query!(
        "SELECT DISTINCT b.page_id AS \"page_id!\" FROM block_links bl \
             JOIN blocks b ON b.id = bl.target_id \
         WHERE bl.source_id = ? AND b.page_id IS NOT NULL",
        block_id,
    )
    .fetch_all(&mut *tx)
    .await?;
    for r in rows {
        affected.insert(r.page_id);
    }

    // (3) Resolve the source page (the page this block rolls up to in
    // `page_link_cache`). #677 — this MUST mirror
    // `cache::reindex_page_link_cache_for_block`'s `COALESCE(page_id,
    // parent_id, id)` chain (page_links.rs, "MUST stay identical" since #345),
    // NOT the older `COALESCE(parent_id, block_id)`. For a content block nested
    // several levels under a page, `parent_id` is the intermediate block — not
    // the page — so keying off it resolves a different `source_page` than the
    // roll-up groups under, and the page_link_cache lookup below would miss the
    // block's cached outbound edges. `page_id` is the nearest page ancestor
    // (and == id for page blocks); `parent_id` then `id` are the same fallbacks
    // the roll-up uses for un-stamped fixtures / top-level / purged blocks.
    let src_row = sqlx::query!(
        "SELECT page_id, parent_id FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let source_page: String = match src_row {
        Some(r) => r
            .page_id
            .or(r.parent_id)
            .unwrap_or_else(|| block_id.to_owned()),
        None => block_id.to_owned(),
    };

    // Add every target_page_id currently in page_link_cache from this
    // source so we catch any remaining cached edges that point out.
    let cached = sqlx::query!(
        "SELECT target_page_id FROM page_link_cache WHERE source_page_id = ?",
        source_page,
    )
    .fetch_all(&mut *tx)
    .await?;
    for r in cached {
        affected.insert(r.target_page_id);
    }

    if affected.is_empty() {
        return Ok(());
    }
    let v: Vec<String> = affected.into_iter().collect();
    recompute_pages_cache_counts_for_pages(&mut tx, &v).await?;
    tx.commit().await?;
    Ok(())
}

/// Per-op state captured BEFORE projection mutates `blocks` so the
/// post-projection recompute knows exactly which page rows to refresh.
///
/// Each variant carries exactly the data its op type needs; the empty
/// `None` variant covers op types that don't touch the cache counts
/// (tag / property / attachment). `apply_op_tx` constructs one variant
/// per arm and `maintain_pages_cache_counts_after_op` matches on it, so
/// the op→fields coupling is exhaustive-match-checked rather than an
/// unchecked runtime convention.
pub(super) enum PreOpState {
    /// Op types that cannot affect either cache count.
    None,
    /// CreateBlock: payload fields needed to resolve the owning page,
    /// (optionally) seed a `pages_cache` row for page creates, and parse
    /// outbound link tokens from the new content.
    Create {
        block_id: String,
        parent_id: Option<String>,
        block_type: String,
        content: String,
    },
    /// EditBlock: the edited block + its new text (for link-token parsing).
    Edit { block_id: String, to_text: String },
    /// DeleteBlock / RestoreBlock cohort (mirrors `ApplyEffects`).
    /// The descendant cohort captured BEFORE the UPDATE; both ops refresh
    /// the same affected set.
    Cohort(Vec<String>),
    /// PurgeBlock affected-pages snapshot (captured pre-cascade because
    /// FK CASCADE on `block_links` clears outbound/inbound edges before
    /// the post-op recompute runs).
    Purge { affected_pages: Vec<String> },
    /// MoveBlock (E4). Captured BEFORE the projection reparents the block
    /// so the count hook can refresh BOTH the source page (the block's
    /// `page_id` at move time) and the destination page (derived post-move
    /// from the new parent chain). A cross-page reparent recomputes
    /// `page_id` for the moved subtree in `move_ops.rs`, so the two pages'
    /// `child_block_count` would otherwise drift.
    Move {
        block_id: String,
        src_page: Option<String>,
    },
}
