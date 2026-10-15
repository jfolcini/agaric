//! `page_link_cache` — derived-state cache for page-level link edges
//! (SQL-review §H-2).
//!
//! Each row holds a `(source_page_id, target_page_id, edge_count)`
//! tuple: the number of distinct `block_links` rows whose source rolls
//! up to `source_page_id` (via `blocks.page_id` — the denormalised
//! owning page, which is the source's own id when the source IS a page)
//! and whose target is `target_page_id`.
//!
//! SQL/C9 (#345): the roll-up prefers `blocks.page_id` over
//! `blocks.parent_id` — `COALESCE(page_id, parent_id, id)`. `parent_id`
//! is the *immediate* parent, so a link inside a block nested
//! two-or-more levels under a page was mis-attributed to the intermediate
//! block instead of the owning page. `page_id` (migration 0027/0066) is
//! the nearest page ancestor — self for page blocks. The `parent_id`
//! fallback preserves the prior single-step roll-up for rows where
//! `page_id` was never stamped (test fixtures / partial state); the final
//! `id` fallback covers top-level tags with neither.
//!
//! The read path (`list_page_links_inner`) selects from this table as a
//! single covering-index scan, replacing the previous 3-JOIN superlinear
//! `block_links × blocks × block_properties` shape that measured
//! ~1.3 s @ 100K in the interactive SLO bench. #2070 denormalised the
//! `deleted_at` / `block_type = 'page'` predicates into the
//! `src_deleted` / `tgt_deleted` / `tgt_is_page` flag columns (migration
//! 0096) so the unscoped read no longer needs even the two residual
//! `blocks` joins it carried after 0065.
//!
//! #5426 (migration 0122) does the same for the space-scoped read: `space_id`
//! is the space both pages share, NULL for an edge between spaces, an edge
//! with a space-less end, or an end that is not a page. It reads pages'
//! `blocks.space_id` alone, and every path that changes one (a `space` op,
//! inbound sync, purging the space) rebuilds this cache.
//!
//! Two public entry points:
//!
//! - [`reindex_page_link_cache_for_block`] — called from the
//!   `ReindexBlockLinks` materializer handler after the per-block
//!   `block_links` diff has been written. Recomputes only the
//!   `(source_page, target_page)` pairs touched by the changed block
//!   (the block's own page + every page it currently and previously
//!   linked to), so the cost is proportional to the diff width, not
//!   the table size.
//!
//! - [`rebuild_page_link_cache`] — full recompute that walks every
//!   `block_links` row, rolls up the source to a page via
//!   `COALESCE(blocks.page_id, parent_id, source_id)`, groups by
//!   `(source_page, target_page)`, and DELETE + INSERTs the whole
//!   table. Used by snapshot restore, the delete/restore/purge/cross-page-move
//!   `FULL_CACHE_REBUILD_TASKS` fan-out, a `space` op, and the read path's
//!   lazy heal in `commands::pages::links` (gated on the table being ENTIRELY
//!   empty).
//!
//! #3839 correction of record: this module previously documented a
//! "boot-time `table is empty` fallback (recovery)". **No such recovery
//! path exists** — `src/db/recovery/` never touches `page_link_cache`, and
//! `rebuild_all_caches` is `#[cfg(test)]`. An upgrading vault is populated
//! by migration `0110`, a one-shot backfill running the same roll-up as
//! [`rebuild_page_link_cache`]; the read-path lazy heal is a redundancy
//! behind it, not the mechanism (before 0110 it WAS the mechanism, and its
//! "table entirely empty" gate is permanently disarmed by the first row any
//! incremental maintenance writes).
//!
//! The static-literal queries here use the compile-checked `query!` /
//! `query_as!` macros (#235), validated against the `.sqlx` offline cache.
//! The dynamic chunked upserts (variable `json_each`/placeholder counts)
//! remain runtime-checked [`sqlx::query`] via `AssertSqlSafe`, since the
//! macros require a single string literal. The schema-existence check
//! happens via the migration smoke test in
//! `op_log::tests::page_link_cache_table_post_migration_0065`.

use sqlx::SqlitePool;

use crate::db::MAX_SQL_PARAMS;
use agaric_core::error::AppError;

/// One bind per `page_link_cache` column: the roll-up pair and count, the
/// three 0096 flags and the 0122 `space_id`. Mirrors the chunk-size
/// derivation in `cache/pages.rs` and `cache/agenda.rs`.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 7;

// ---------------------------------------------------------------------------
// Per-block incremental update
// ---------------------------------------------------------------------------

/// Recompute the `page_link_cache` rows whose `(source_page, target_page)`
/// pair could have been touched by a `ReindexBlockLinks(block_id)` task.
///
/// Called from `materializer::handlers::handle_background_task` AFTER
/// the `block_links` diff for `block_id` has been written so the
/// recompute sees the canonical `block_links` state.
///
/// Algorithm:
///   1. Resolve `source_page = COALESCE(page_id, parent_id, block_id)`
///      for `block_id`. If the block itself is a page, `page_id = id` so
///      `source_page = block_id`. If `block_id` is gone (purged),
///      `source_page` falls through to `block_id` and the recompute
///      naturally drops empty pairs.
///   2. Collect every distinct `target_page` that currently appears in
///      `block_links` under `source_id = block_id` OR rolls up to
///      `source_page` AND every `target_page` that previously appeared in
///      `page_link_cache` under `source_page_id = source_page` (so we pick
///      up edges that just dropped to zero).
///   3. For each `(source_page, target_page)` pair in the union, recompute
///      `edge_count = COUNT(*) FROM block_links bl JOIN blocks sb
///       ON sb.id = bl.source_id AND COALESCE(sb.page_id, sb.parent_id, sb.id) =
///       source_page WHERE bl.target_id = target_page`. UPSERT non-zero
///      counts; DELETE zero counts.
///   4. #3842: repeat (2)+(3) for every key this block may have been counted
///      under BEFORE `page_id` was stamped (`parent_id`, and its own `id`).
///      Without this, step (3) would ADD the correct page-keyed row while
///      LEAVING the earlier content-block-keyed row behind — the "spurious
///      row plus missing row" state #3842 describes. Because the recompute is
///      keyed on the roll-up key alone, running it for a stranded key drops
///      the rows nothing supports any more, and corrects the `edge_count` of
///      any row other blocks still support. #3891 gates each stale key on a
///      PK-prefix `page_link_cache` existence check first — a key with no
///      cached row has nothing stranded to sweep. See the comment at the loop
///      for the soundness argument.
///
/// Single transaction so the cache and `block_links` stay coherent under
/// concurrent reads — `list_page_links_inner` joining `blocks` and
/// `page_link_cache` either observes the pre-update snapshot or the
/// post-update one, never a mid-update split state.
///
/// Rows can cross spaces: `reindex_block_links` filters a pair only when the
/// source has a space at write time, and a page that later changes space
/// keeps its `block_links`. Such a row carries a NULL `space_id`, which is
/// what keeps it out of every space-scoped read (#5426).
pub async fn reindex_page_link_cache_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_page_links_reindex").await?;

    // Resolve the source page (the page the changed block lives on).
    // SQL/C9 (#345): prefer `page_id` (the denormalised owning page, set
    // by migration 0027/0066) over `parent_id` (the immediate parent).
    // For a content block nested several levels under a page, `parent_id`
    // is the intermediate block, not the page — keying edges by it
    // mis-attributes the link. `page_id` is the nearest page ancestor and
    // is `id` for page blocks. The `parent_id` fallback covers fixtures /
    // partial-state rows where `page_id` was not stamped (preserving the
    // pre-fix single-step roll-up), and the final `block_id` fallback
    // covers top-level tags (no parent, no page) and purged blocks.
    //
    // This `COALESCE(page_id, parent_id, id)` chain MUST stay identical to
    // the SQL roll-up below and in the full-rebuild query so the
    // Rust-resolved `source_page` matches what the SQL groups under.
    let row = sqlx::query!(
        "SELECT page_id, parent_id FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    let (page_id, parent_id) = match row {
        Some(r) => (r.page_id, r.parent_id),
        // Block missing (purged). Fall back to block_id so the
        // recompute can still drop stale rows keyed under that id.
        None => (None, None),
    };
    let source_page: String = page_id
        .clone()
        .or_else(|| parent_id.clone())
        .unwrap_or_else(|| block_id.to_owned());

    // #3842: the roll-up key is `COALESCE(page_id, parent_id, id)`, so a block
    // whose `page_id` was NULL when a previous `ReindexBlockLinks` ran had its
    // edges written under `parent_id` (or its own id). Once the deferred
    // `SetBlockPageId` stamps the real owning page the key MOVES, and the rows
    // written under the earlier key are stranded: `list_page_links_inner` then
    // shows an edge sourced at a non-page block while the real page's edge is
    // missing. Collect the earlier keys this block could have been counted
    // under and recompute them too. Only keys that differ from the current
    // `source_page` are candidates, and the recompute is support-checked, so a
    // key that is still the legitimate roll-up target of some OTHER live block
    // — a page-less subtree keyed on its top-level parent — keeps its rows
    // (with a corrected count).
    let stale_keys: Vec<String> = [parent_id, Some(block_id.to_owned())]
        .into_iter()
        .flatten()
        .filter(|k| *k != source_page)
        .collect();

    // Recompute the block's CURRENT key, then every key it may have been
    // counted under before `page_id` was stamped (#3842). Same recompute for
    // both: it is keyed on the roll-up key alone, so re-running it for a
    // stranded key both DROPS rows nothing supports any more and CORRECTS the
    // `edge_count` of rows other blocks still support.
    recompute_rows_for_rollup_key(&mut tx, &source_page).await?;

    // #3891: the stale-key sweep is gated on a PK-prefix existence check, an
    // index seek on `page_link_cache` (`sqlite_autoindex_page_link_cache_1
    // (source_page_id=?)`) in place of a recompute run inside this function's
    // `BEGIN IMMEDIATE`, i.e. on held write-lock time.
    //
    // Why skipping is sound. A stale key is a key this block has MOVED AWAY
    // from, and the sweep exists (#3842) to drop the rows stranded under it.
    // Stranding presupposes that a previous `ReindexBlockLinks` WROTE rows
    // under that key — i.e. that a `page_link_cache` row for it exists. When
    // none does, there is nothing stranded to drop and nothing to recount, so
    // no repair THIS block owes is skipped.
    //
    // Be precise about what that does NOT say, because the skip is not a
    // literal no-op. With no cached row under the key the zero-edge DELETE
    // matches nothing, but the UPSERT can still ADD rows — for targets that
    // roll up to the key from some OTHER live block. Skipping therefore
    // forgoes an OPPORTUNISTIC cross-block repair, and it is observable:
    // `reindex_page_link_cache_for_block_skips_an_unstranded_stale_key_3891`
    // pins exactly that state, and the ungated form converges on it where the
    // gated form does not.
    //
    // That repair is not this block's to make. Those rows belong to the other
    // block's own reindex (its CURRENT key, which is never gated) or to the
    // full `rebuild_page_link_cache`; reaching the state at all requires that
    // block's reindex to have never run or to have failed, in which case the
    // cache was ALREADY divergent before this call and the retry queue owes
    // the repair. So the gate costs a chance heal of a pre-existing
    // divergence, never a repair of a divergence this block caused. It is
    // also the direction the reconciliation oracle can see — a missing
    // `page_link_cache` row is a covered artefact (`reconciliation_oracle`
    // artefact 5), unlike a dropped `block_links` row, which is a BASE table
    // there and structurally invisible (#3903).
    //
    // The pre-#3842 code never touched a stale key at all, so the gate cannot
    // lose a repair the old code would have made either.
    //
    // The CURRENT key is deliberately NOT gated: it must be able to create the
    // block's first cached row.
    for stale_key in &stale_keys {
        let stranded: Option<i64> = sqlx::query_scalar!(
            "SELECT 1 AS \"one!\" FROM page_link_cache WHERE source_page_id = ?1 LIMIT 1",
            stale_key,
        )
        .fetch_optional(&mut *tx)
        .await?;
        if stranded.is_none() {
            continue;
        }
        recompute_rows_for_rollup_key(&mut tx, stale_key).await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Recompute every `page_link_cache` row keyed on ONE roll-up key
/// (`COALESCE(page_id, parent_id, id)` of some source block).
///
/// Split out of [`reindex_page_link_cache_for_block`] for #3842 so the same
/// recompute can run for the changed block's current key AND for the keys it
/// has moved away from. The result for a given key depends only on the key,
/// `block_links` and `blocks` — so running it for extra keys is idempotent and
/// converges on exactly the rows [`rebuild_page_link_cache`] would produce for
/// them.
async fn recompute_rows_for_rollup_key(
    conn: &mut sqlx::SqliteConnection,
    source_page: &str,
) -> Result<(), AppError> {
    let touched_targets = read_touched_targets_for_rollup_key(conn, source_page).await?;

    // B-C3 (issue #108): collapse the per-target COUNT + UPSERT/DELETE
    // loop into two statements regardless of K. The aggregate UPSERT
    // covers every touched target with a non-zero edge_count; targets
    // that no longer have any live edges don't appear in the GROUP BY
    // result and fall through to the zero-edge DELETE below. Net cost:
    // 2 round-trips instead of 2K, no Rust-side counting.
    if touched_targets.is_empty() {
        return Ok(());
    }
    let targets_json = serde_json::to_string(&touched_targets)?;

    // #2070: also compute and write the denormalised predicate flags so
    // an incremental upsert never resurrects a row with stale default
    // flags. `src_deleted` is the soft-delete state of the source PAGE
    // (`?1`), looked up once; `tgt_deleted` / `tgt_is_page` come from the
    // target block joined per row. The `DO UPDATE SET` refreshes all
    // three alongside `edge_count`. `MAX`/`MIN` just satisfy the GROUP BY
    // (the flags are constant per target group).
    //
    // #3894 FOREIGN KEY guard — the `EXISTS` term in the `desired` WHERE, the
    // same guard `rebuild_page_link_cache_impl`,
    // `rebuild_page_link_cache_split_impl` and migration 0110 carry (the third
    // COALESCE term is spelled `sb.id` here only because this statement's own
    // roll-up predicate is; `sb.id = bl.source_id` by the join). It belongs
    // here for the same reason: `source_page_id` is `NOT NULL REFERENCES
    // blocks(id)` (0065) with foreign keys ON for every connection, and the
    // value written is the derived roll-up key, not a joined column — a live
    // source block carrying a dangling `page_id` / `parent_id` (migrations
    // 0073 and 0085 NULL exactly that historical state out, so vaults in the
    // wild carry it) rolls up to an id that is not in `blocks` and the INSERT
    // raises. `ON CONFLICT` does not absorb it: per the SQLite docs the ON
    // CONFLICT algorithm does not apply to FOREIGN KEY constraints.
    //
    // #3842 is what makes this reachable for keys other than the block's own:
    // the stale-key sweep above runs this recompute for `parent_id` and for the
    // block's own id, so a dangling `parent_id` anywhere in the neighbourhood
    // now becomes a roll-up key here. Unguarded, the failure mode is worse than
    // the migration's, not better: 0110 skips the group silently, then this
    // path raises for the same key on every `ReindexBlockLinks`, and the error
    // is logged and RETRIED forever — a permanent background error loop rather
    // than one boot failure.
    //
    // The TARGET side needs nothing, exactly as in the rebuilds: `target` is
    // `bl.target_id` and `JOIN blocks tb ON tb.id = bl.target_id` is an INNER
    // join, so an edge whose target is purged produces no `desired` row at all.
    // Dropping a group cannot distort a surviving row either — the key is
    // constant across the whole statement (`?1`), so the predicate is all-or-
    // nothing and can never remove part of one target group's `COUNT(*)`.
    //
    // The zero-edge DELETE below is deliberately NOT guarded: it removes rows,
    // so it cannot violate an FK, and a row that somehow exists under a
    // dangling key should be swept, not preserved.
    //
    // #5426: `space_id` is the space both pages share (the rule the rebuilds
    // and migration 0122 spell as a `CASE`).
    sqlx::query!(
        "WITH desired AS ( \
             SELECT bl.target_id AS target, \
                    COUNT(*) AS edge_count, \
                    MAX(tb.deleted_at IS NOT NULL) AS tgt_deleted, \
                    MIN(tb.block_type = 'page') AS tgt_is_page, \
                    MAX(CASE WHEN tb.block_type = 'page' THEN tb.space_id END) \
                        AS tgt_page_space_id \
             FROM block_links bl \
             JOIN blocks sb ON sb.id = bl.source_id \
             JOIN blocks tb ON tb.id = bl.target_id \
             WHERE COALESCE(sb.page_id, sb.parent_id, sb.id) = ?1 \
               AND sb.deleted_at IS NULL \
               AND EXISTS ( \
                   SELECT 1 FROM blocks fk \
                   WHERE fk.id = COALESCE(sb.page_id, sb.parent_id, sb.id) \
               ) \
               AND bl.target_id IN (SELECT value FROM json_each(?2)) \
             GROUP BY 1 \
         ) \
         INSERT INTO page_link_cache \
             (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page, \
              space_id) \
         SELECT ?1, target, edge_count, \
                COALESCE((SELECT (b.deleted_at IS NOT NULL) FROM blocks b WHERE b.id = ?1), 1), \
                tgt_deleted, tgt_is_page, \
                (SELECT b.space_id FROM blocks b \
                 WHERE b.id = ?1 AND b.block_type = 'page' \
                   AND b.space_id = tgt_page_space_id) \
         FROM desired WHERE true \
         ON CONFLICT(source_page_id, target_page_id) \
         DO UPDATE SET edge_count = excluded.edge_count, \
                       src_deleted = excluded.src_deleted, \
                       tgt_deleted = excluded.tgt_deleted, \
                       tgt_is_page = excluded.tgt_is_page, \
                       space_id = excluded.space_id",
        source_page,
        targets_json,
    )
    .execute(&mut *conn)
    .await?;

    // Zero-edge sweep: remove any touched target whose live edge count
    // is now zero. Inlined `NOT EXISTS` against `block_links` mirrors
    // the `desired` CTE's filter shape — using the CTE directly is not
    // an option here because CTEs don't outlive their statement.
    sqlx::query!(
        "DELETE FROM page_link_cache \
         WHERE source_page_id = ?1 \
           AND target_page_id IN (SELECT value FROM json_each(?2)) \
           AND NOT EXISTS ( \
               SELECT 1 FROM block_links bl \
               JOIN blocks sb ON sb.id = bl.source_id \
               WHERE COALESCE(sb.page_id, sb.parent_id, sb.id) = ?1 \
                 AND sb.deleted_at IS NULL \
                 AND bl.target_id = page_link_cache.target_page_id \
           )",
        source_page,
        targets_json,
    )
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// The targets whose `page_link_cache` rows [`recompute_rows_for_rollup_key`]
/// has to revisit for `source_page`. Read-only.
async fn read_touched_targets_for_rollup_key(
    conn: &mut sqlx::SqliteConnection,
    source_page: &str,
) -> Result<Vec<String>, AppError> {
    // Pairs touched: every target that currently appears in block_links
    // under any block whose roll-up == source_page, UNION every target
    // already in page_link_cache under source_page. This catches both
    // additions (new target appears in block_links) and removals (target
    // previously cached, now zero edges left). Soft-deleted source
    // blocks contribute zero to the count — mirrors the legacy
    // `JOIN blocks sb ON ... AND sb.deleted_at IS NULL` filter.
    //
    // #5423: the roll-up `COALESCE(sb.page_id, sb.parent_id, sb.id) = ?1` is
    // spelled as its three cases, one branch each, because SQLite cannot use
    // an index for a COALESCE comparison: as one predicate it read the whole
    // vault (all of `block_links`, or every block once statistics exist) on
    // every reindex, under the write lock. Each branch is an
    // index seek (`page_id`, `parent_id`, the primary key) followed by the
    // source's own links. The scanning form is kept as the test oracle below.
    let touched_targets: Vec<String> = sqlx::query!(
        "SELECT target_id AS \"target_id!\" FROM (
             SELECT bl.target_id
             FROM blocks sb
             JOIN block_links bl ON bl.source_id = sb.id
             WHERE sb.page_id = ?1
               AND sb.deleted_at IS NULL
             UNION
             SELECT bl.target_id
             FROM blocks sb
             JOIN block_links bl ON bl.source_id = sb.id
             WHERE sb.page_id IS NULL
               AND sb.parent_id = ?1
               AND sb.deleted_at IS NULL
             UNION
             SELECT bl.target_id
             FROM blocks sb
             JOIN block_links bl ON bl.source_id = sb.id
             WHERE sb.id = ?1
               AND sb.page_id IS NULL
               AND sb.parent_id IS NULL
               AND sb.deleted_at IS NULL
             UNION
             SELECT target_page_id AS target_id
             FROM page_link_cache
             WHERE source_page_id = ?1
         )",
        source_page,
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(|row| row.target_id)
    .collect();

    Ok(touched_targets)
}

// ---------------------------------------------------------------------------
// Full recompute
// ---------------------------------------------------------------------------

/// Full recompute of `page_link_cache`.
///
/// Deletes all existing rows and re-populates by rolling up
/// `block_links` to the page level. Used by:
///
/// - the delete/restore/purge/cross-page-move `FULL_CACHE_REBUILD_TASKS`
///   fan-out,
/// - a `space` op, which moves `space_id` on edges in both directions (#5426),
/// - the read path's lazy heal in `commands::pages::links`, gated on the
///   table being ENTIRELY empty (#3839).
///
/// #3839: the previously-documented "boot-time `table is empty` fallback
/// (`recovery`)" does NOT exist. The upgrade-time population of an existing
/// vault is migration `0110`, whose SQL mirrors the roll-up below.
///
/// Per-content-edit invalidation goes through
/// [`reindex_page_link_cache_for_block`] from
/// `materializer::handlers::handle_background_task::ReindexBlockLinks`.
#[tracing::instrument(skip(pool), err)]
pub async fn rebuild_page_link_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("page_links", || rebuild_page_link_cache_impl(pool)).await
}

async fn rebuild_page_link_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_page_links_rebuild").await?;

    sqlx::query!("DELETE FROM page_link_cache")
        .execute(&mut *tx)
        .await?;

    // Materialise the rolled-up edge set into Rust memory then chunk
    // the INSERTs to respect `MAX_SQL_PARAMS`. The roll-up walks
    // `block_links` (~200K rows at 100K-block scale) joined with
    // `blocks` on the source side to read `parent_id`; output cardinality
    // is bounded by `min(distinct sources, distinct targets) ≤ #pages`,
    // typically a few thousand rows on a 100K-block vault.
    //
    // #2070 parity design: keep the legacy `WHERE sb.deleted_at IS NULL`
    // so `edge_count` counts only LIVE source blocks (a deleted source
    // block must not inflate the count — matches the legacy rebuild and
    // the incremental path). We denormalise the three READ-side
    // predicates as flags by also joining `blocks` for the target:
    //   - `src_deleted` is the source PAGE's delete state (the group
    //     key), NOT an aggregate over source blocks — mirroring the
    //     legacy read's `JOIN blocks src ON src.id = source_page_id AND
    //     src.deleted_at IS NULL`. It comes from the `LEFT JOIN blocks
    //     sp` on the rolled-up page id; a missing/purged source page
    //     (`sp.id IS NULL`) maps to deleted (`CASE WHEN sp.id IS NULL
    //     THEN 1 …`) so a dangling page reference is masked exactly like
    //     the legacy inner join and the incremental path drop it. So a
    //     page mid-cascade (deleted page, still-live block) is correctly
    //     masked even though its block survives the `deleted_at IS NULL`
    //     filter; a fully-deleted page produces no row at all (its blocks
    //     are filtered out), same as legacy. The page state is constant
    //     per `(source_page)` group, so the wrapping `MAX` is identity
    //     (just satisfies the GROUP BY aggregate requirement).
    //   - `tgt_deleted` / `tgt_is_page` come from the target block
    //     (`target_page_id = bl.target_id` is a single block, so the
    //     `MAX`/`MIN` are identity per group).
    //
    // #3894 FOREIGN KEY guard — the `EXISTS` term in the WHERE. Both cache
    // columns are `NOT NULL REFERENCES blocks(id)` (0065) and foreign keys
    // are ON for every connection (`db::base_connect_options`). The TARGET
    // side needs nothing: `target_page_id` is `bl.target_id` and the `tb`
    // INNER join already drops an edge whose target is gone. The SOURCE side
    // does, because `source_page_id` is not a joined column but the derived
    // key `COALESCE(sb.page_id, sb.parent_id, bl.source_id)` — `sb` joining
    // fine says nothing about whether the KEY names a live `blocks` row. A
    // source block carrying a dangling `page_id` / `parent_id` (migrations
    // 0073 and 0085 NULL exactly that historical state out, so vaults in the
    // wild carry it) rolls up to an id that is not in `blocks`, and the
    // INSERT below raises. `INSERT OR IGNORE` does NOT absorb that: per the
    // SQLite docs the ON CONFLICT algorithm does not apply to FOREIGN KEY
    // constraints. Skipping the group is the only outcome that leaves the
    // rebuild total. It cannot distort a surviving row: the key is the first
    // GROUP BY term, so the predicate is constant across a group and can only
    // drop whole groups, never part of one group's `COUNT(*)`. This is also
    // what makes migration 0110 (`0110_page_link_cache_backfill.sql`, a
    // transcription of this statement from before `space_id`) safe to run at
    // boot, where the same abort would be an unrecoverable startup failure
    // rather than a logged background error.
    //
    // #5426: `space_id` is the space both pages share; `sp` and `tb` are one
    // block each per group, so the `MAX` is identity.
    let rows = sqlx::query!(
        "SELECT
             COALESCE(sb.page_id, sb.parent_id, bl.source_id) AS \"source_page_id!: String\",
             bl.target_id AS \"target_page_id!: String\",
             COUNT(*) AS \"edge_count!: i64\",
             MAX(CASE WHEN sp.id IS NULL THEN 1 ELSE (sp.deleted_at IS NOT NULL) END) AS \"src_deleted!: i64\",
             MAX(tb.deleted_at IS NOT NULL) AS \"tgt_deleted!: i64\",
             MIN(tb.block_type = 'page') AS \"tgt_is_page!: i64\",
             MAX(CASE WHEN sp.block_type = 'page' AND tb.block_type = 'page'
                           AND sp.space_id = tb.space_id
                      THEN sp.space_id END) AS \"space_id?: String\"
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id
         JOIN blocks tb ON tb.id = bl.target_id
         LEFT JOIN blocks sp ON sp.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
         WHERE sb.deleted_at IS NULL
           AND EXISTS (
               SELECT 1 FROM blocks fk
               WHERE fk.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
           )
         GROUP BY 1, 2",
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut inserted: u64 = 0;
    for chunk in rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO page_link_cache \
             (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page, \
              space_id) \
             VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for r in chunk {
            q = q
                .bind(&r.source_page_id)
                .bind(&r.target_page_id)
                .bind(r.edge_count)
                .bind(r.src_deleted)
                .bind(r.tgt_deleted)
                .bind(r.tgt_is_page)
                .bind(&r.space_id);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}

/// Read/write split variant of [`rebuild_page_link_cache`].
///
/// Reads the rolled-up edge set from `read_pool` and applies the
/// DELETE + chunked INSERT on `write_pool`. Same stale-while-revalidate
/// semantics as the other `rebuild_*_split` variants.
pub async fn rebuild_page_link_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("page_links", || {
        rebuild_page_link_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_page_link_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // #2070 parity design (see `rebuild_page_link_cache_impl`): keep the
    // legacy `WHERE sb.deleted_at IS NULL` so `edge_count` counts only
    // live source blocks, and denormalise the read-side predicates as
    // flags. `src_deleted` is the source PAGE's delete state (group key,
    // via the `LEFT JOIN blocks sp` on the rolled-up page id), NOT a
    // source-block aggregate; `tgt_deleted` / `tgt_is_page` come from the
    // single target block.
    // The `MAX`/`MIN` aggregates are identity per group, present only to
    // satisfy the GROUP BY.
    //
    // Carries the same #3894 `EXISTS` foreign-key guard as the single-pool
    // variant — it writes the same `NOT NULL REFERENCES blocks(id)` columns,
    // so a rollup key that names no `blocks` row would raise here too. See
    // `rebuild_page_link_cache_impl` for why the source side needs it and the
    // target side does not, and why dropping the group cannot distort a
    // surviving row's `edge_count`. `space_id` follows the same rule there.
    let rows = sqlx::query!(
        "SELECT
             COALESCE(sb.page_id, sb.parent_id, bl.source_id) AS \"source_page_id!: String\",
             bl.target_id AS \"target_page_id!: String\",
             COUNT(*) AS \"edge_count!: i64\",
             MAX(CASE WHEN sp.id IS NULL THEN 1 ELSE (sp.deleted_at IS NOT NULL) END) AS \"src_deleted!: i64\",
             MAX(tb.deleted_at IS NOT NULL) AS \"tgt_deleted!: i64\",
             MIN(tb.block_type = 'page') AS \"tgt_is_page!: i64\",
             MAX(CASE WHEN sp.block_type = 'page' AND tb.block_type = 'page'
                           AND sp.space_id = tb.space_id
                      THEN sp.space_id END) AS \"space_id?: String\"
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id
         JOIN blocks tb ON tb.id = bl.target_id
         LEFT JOIN blocks sp ON sp.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
         WHERE sb.deleted_at IS NULL
           AND EXISTS (
               SELECT 1 FROM blocks fk
               WHERE fk.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
           )
         GROUP BY 1, 2",
    )
    .fetch_all(read_pool)
    .await?;

    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_page_links_rebuild_write").await?;

    sqlx::query!("DELETE FROM page_link_cache")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    for chunk in rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO page_link_cache \
             (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page, \
              space_id) \
             VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for r in chunk {
            q = q
                .bind(&r.source_page_id)
                .bind(&r.target_page_id)
                .bind(r.edge_count)
                .bind(r.src_deleted)
                .bind(r.tgt_deleted)
                .bind(r.tgt_is_page)
                .bind(&r.space_id);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}

#[cfg(test)]
mod touched_targets_tests {
    //! #5423 — the touched-targets read against the scanning form it replaced.

    use super::*;

    /// The pre-#5423 touched-targets read: the roll-up as one `COALESCE`
    /// comparison, which SQLite answers by scanning `block_links`. Kept as the
    /// oracle the indexed form must agree with.
    async fn read_touched_targets_by_scan(
        conn: &mut sqlx::SqliteConnection,
        source_page: &str,
    ) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT target_id FROM (
                 SELECT DISTINCT bl.target_id
                 FROM block_links bl
                 JOIN blocks sb ON sb.id = bl.source_id
                 WHERE COALESCE(sb.page_id, sb.parent_id, sb.id) = ?1
                   AND sb.deleted_at IS NULL
                 UNION
                 SELECT target_page_id AS target_id
                 FROM page_link_cache
                 WHERE source_page_id = ?1
             )",
        )
        .bind(source_page)
        .fetch_all(&mut *conn)
        .await
        .unwrap()
    }

    /// Every case of the roll-up `COALESCE(page_id, parent_id, id)`: a source
    /// keyed by its page (`A`), one keyed by its parent because it has no page
    /// (`C`), one keyed by itself because it has neither (`K`), one whose page
    /// wins over a parent naming another key (`M`), a soft-deleted source that
    /// must not count (`D`, and `D2` / `D3` on the parent and self branches), a
    /// paged source that must not match its own id (`Z`), and a target only
    /// `page_link_cache` still names (`P1 → T5`). For every key the indexed read must return the oracle's
    /// set; the literals pin that the sets are the intended ones rather than
    /// two agreeing empties.
    #[tokio::test]
    async fn touched_targets_match_the_scanning_oracle_for_every_rollup_case_5423() {
        let (pool, _dir) = crate::test_support::test_pool().await;
        // (id, block_type, parent_id, page_id, deleted_at), parents first.
        let blocks: [(&str, &str, Option<&str>, Option<&str>, Option<i64>); 15] = [
            ("P1", "page", None, Some("P1"), None),
            ("P2", "page", None, Some("P2"), None),
            ("T1", "page", None, Some("T1"), None),
            ("T2", "page", None, Some("T2"), None),
            ("T3", "page", None, Some("T3"), None),
            ("T4", "page", None, Some("T4"), None),
            ("T5", "page", None, Some("T5"), None),
            ("K", "content", None, None, None),
            ("C", "content", Some("K"), None, None),
            ("A", "content", Some("P1"), Some("P1"), None),
            ("D", "content", Some("P1"), Some("P1"), Some(1)),
            ("M", "content", Some("P1"), Some("P2"), None),
            ("D2", "content", Some("K"), None, Some(1)),
            ("D3", "content", None, None, Some(1)),
            ("Z", "content", None, Some("P2"), None),
        ];
        for (id, block_type, parent_id, page_id, deleted_at) in blocks {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, page_id, deleted_at) \
                 VALUES (?, ?, '', ?, ?, ?)",
            )
            .bind(id)
            .bind(block_type)
            .bind(parent_id)
            .bind(page_id)
            .bind(deleted_at)
            .execute(&pool)
            .await
            .unwrap();
        }
        for (source, target) in [
            ("A", "T1"),
            ("A", "T2"),
            ("D", "T3"),
            ("K", "T1"),
            ("C", "T2"),
            ("M", "T4"),
            ("D2", "T3"),
            ("D3", "T3"),
            ("Z", "T3"),
        ] {
            sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
                .bind(source)
                .bind(target)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES ('P1', 'T5', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let cases: [(&str, &[&str]); 7] = [
            ("P1", &["T1", "T2", "T5"]),
            ("P2", &["T3", "T4"]),
            ("K", &["T1", "T2"]),
            ("C", &[]),
            ("D3", &[]),
            ("Z", &[]),
            ("NOT_A_KEY", &[]),
        ];
        let mut conn = pool.acquire().await.unwrap();
        for (key, expected) in cases {
            let mut indexed = read_touched_targets_for_rollup_key(&mut conn, key)
                .await
                .unwrap();
            indexed.sort();
            let mut scanned = read_touched_targets_by_scan(&mut conn, key).await;
            scanned.sort();
            assert_eq!(
                indexed, scanned,
                "key {key}: the indexed read must return the scanning oracle's targets (#5423)"
            );
            assert_eq!(
                indexed, expected,
                "key {key}: the roll-up must touch exactly these targets (#5423)"
            );
        }
    }
}
