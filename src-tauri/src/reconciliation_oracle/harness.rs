//! The test-only half of the reconciliation oracle: production SETTLES (the
//! deferred and background maintainers a driver must run before asserting),
//! the non-vacuity COVERAGE counters, the thin `rebuild_*` wrappers the drivers
//! diff against, and the format-or-panic wrappers proptest feeds to
//! `prop_assert!`.
//!
//! Everything here either WRITES through a production rebuild or exists to make
//! a test fail loudly, so none of it belongs in the release module — the
//! oracle a user runs (`commands::reconciliation`) must read and compare, never
//! repair. `reconciliation_oracle.rs` re-exports this module under `cfg(test)`,
//! so `crate::reconciliation_oracle::settle_*` keeps resolving for the drivers.

#![cfg(test)]

use super::*;

/// How much of the oracle's subject matter actually EXISTS in a given
/// database. Callers assert on this so a green oracle can never be a green
/// vacuum: an artefact with zero rows is not evidence of anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OracleCoverage {
    /// Rows in `pages_cache` (the pages whose counts are being audited).
    pub pages_cache_rows: i64,
    /// Blocks a from-base rebuild says MUST have a `pages_cache` row — live
    /// page blocks with a title. The row-membership artefact compares a set
    /// of this size against `pages_cache`'s key set, so a zero here means the
    /// membership diff was `{} == {}`.
    pub live_page_blocks: i64,
    /// Blocks whose structurally-derived owning page is some OTHER block.
    ///
    /// The ownership artefact's trivial default: every page owns itself
    /// (a DB-level CHECK, `page_id_self_for_pages`, already guarantees that
    /// half), so a fixture in which no block is owned by a page other than
    /// itself makes the `parent_id` walk a no-op and the comparison vacuous.
    /// This counts the blocks for which the walk actually had to climb.
    pub blocks_owned_by_another_page: i64,
    /// `attachments` rows carrying a non-NULL `content_hash` — the rows that
    /// can produce a blob obligation at all. NOT scoped to live rows: a
    /// soft-deleted row still keeps its bytes and its blob mapping alive
    /// (see [`rebuild_attachment_blobs_from_base`]).
    pub hashed_attachment_rows: i64,
    /// `attachments` rows with `deleted_at` set. The tombstone arm of the
    /// blob rebuild is only exercised when this is non-zero, so tests that
    /// claim to cover it assert on it.
    pub soft_deleted_attachment_rows: i64,
    /// Rows in `attachment_blobs`.
    pub attachment_blob_rows: i64,
    /// Rows in `page_link_cache` — what incremental maintenance produced.
    pub page_link_cache_rows: i64,
    /// `(source_page, target)` pairs a from-base rebuild says MUST have a
    /// `page_link_cache` row.
    ///
    /// The page-link artefact compares a map of this size against the table's
    /// key set, so a zero here means the diff was `{} == {}`. It is the
    /// non-vacuity counter that matters most for this artefact: a chain that
    /// never writes a `[[ULID]]` token leaves `block_links` empty, and an
    /// oracle over an always-empty roll-up is worthless.
    pub page_link_edges: i64,
    /// Rows in `fts_blocks` — what incremental maintenance produced. Counts
    /// ROWS, not distinct blocks, so a duplicate (#345 / C6) shows up here as
    /// well as in the divergence list.
    pub fts_blocks_rows: i64,
    /// Blocks a from-base rebuild says MUST be indexed — live, with non-NULL
    /// content.
    ///
    /// The FTS artefact compares a map of this size against the index's key
    /// set, so a zero means the membership diff was `{} == {}`.
    pub fts_indexable_blocks: i64,
    /// Tombstoned blocks that still carry content — each one an obligation to
    /// hold NO row (#4733). This is the non-vacuity counter for the REMOVAL
    /// half: a fixture where it is zero exercised only the "index a live
    /// block" direction, whatever the divergence list says.
    pub fts_tombstoned_blocks: i64,
    /// #4679: live blocks carrying a non-NULL `due_date` or `scheduled_date`
    /// column — the `agenda_cache` column arms' source rows. Before #4679 the
    /// generator's date op projected a column CLEAR, so this was always 0.
    pub date_column_rows: i64,
    /// #4679: rows in `block_tags` — the `agenda_cache` tag arm's and
    /// `tags_cache.usage_count`'s source. B6 dropped every tag op before
    /// #4679, so this was always 0 there.
    pub block_tag_edges: i64,
    /// Blocks the from-base space fold assigns a non-NULL DERIVED space —
    /// non-page blocks with a page ancestor whose own `space_id` is set.
    ///
    /// The space artefact compares a map of this size against the column, so
    /// a zero means the diff compared `{}` against `{}`. Folded, not counted
    /// in SQL, for the same reason as `page_link_edges`.
    pub derived_space_rows: i64,
    /// #4679 / #3345: distinct non-NULL spaces the from-base fold assigns to
    /// DERIVED rows — the SAME fold `derived_space_rows` comes from, so this
    /// counts spaces the oracle actually audited a block in, not spaces some
    /// authoritative row (a page, a top-level tag) happens to name.
    ///
    /// One page group migrates as a whole, so a chain with a single rooting
    /// page reads at most 1 here at any ONE op; B6 unions the fold's values
    /// across the chain instead, which is what "the derived rows were seen in
    /// two spaces" means there.
    pub distinct_block_spaces: i64,
}

/// Count the artefact rows the oracle is auditing.
pub async fn oracle_coverage(pool: &SqlitePool) -> Result<OracleCoverage, AppError> {
    // Kept off the offline `.sqlx` cache so the oracle needs no regeneration.
    // dynamic-sql: static SQL, test-only oracle read-back.
    let pages_cache_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache")
        .fetch_one(pool)
        .await?;
    // dynamic-sql: static SQL, test-only oracle read-back.
    let hashed_attachment_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE content_hash IS NOT NULL")
            .fetch_one(pool)
            .await?;
    // dynamic-sql: static SQL, test-only oracle read-back.
    let soft_deleted_attachment_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE deleted_at IS NOT NULL")
            .fetch_one(pool)
            .await?;
    // dynamic-sql: static SQL, test-only oracle read-back.
    let attachment_blob_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
        .fetch_one(pool)
        .await?;
    // dynamic-sql: static SQL, test-only oracle read-back.
    let page_link_cache_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM page_link_cache")
        .fetch_one(pool)
        .await?;
    // Folded, not counted in SQL — same rule as the page-shaped counters
    // below: "the fixture covers this" and "the oracle audited this" must come
    // from one computation so they cannot drift apart.
    let page_link_edges =
        i64::try_from(rebuild_page_link_cache_from_base(pool).await?.len()).unwrap_or(i64::MAX);
    // dynamic-sql: static SQL, test-only oracle read-back.
    let fts_blocks_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks")
        .fetch_one(pool)
        .await?;
    // Folded, not counted in SQL — same reason as `page_link_edges`.
    let fts_indexable_blocks =
        i64::try_from(rebuild_fts_index_from_base(pool).await?.len()).unwrap_or(i64::MAX);
    // dynamic-sql: static SQL, test-only oracle read-back.
    let date_column_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks \
         WHERE deleted_at IS NULL AND (due_date IS NOT NULL OR scheduled_date IS NOT NULL)",
    )
    .fetch_one(pool)
    .await?;
    // dynamic-sql: static SQL, test-only oracle read-back.
    let block_tag_edges: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_tags")
        .fetch_one(pool)
        .await?;

    // The page-shaped and space-shaped counters come from the SAME Rust folds
    // the artefacts use, so "the fixture covers this" and "the oracle audited
    // this" can never drift apart.
    let blocks = dump_blocks(pool).await?;
    // The removal half's obligations, folded from the same dump — the
    // complement of `fts_indexable_blocks` within the blocks that have content.
    let fts_tombstoned_blocks = i64::try_from(
        blocks
            .iter()
            .filter(|b| b.deleted_at.is_some() && b.content.is_some())
            .count(),
    )
    .unwrap_or(i64::MAX);
    let derived_spaces = fold_block_space_ids(&blocks);
    let derived_space_rows = i64::try_from(
        derived_spaces
            .values()
            .filter(|d| d.space_id.is_some())
            .count(),
    )
    .unwrap_or(i64::MAX);
    let distinct_block_spaces = i64::try_from(
        derived_spaces
            .values()
            .filter_map(|d| d.space_id.as_deref())
            .collect::<BTreeSet<_>>()
            .len(),
    )
    .unwrap_or(i64::MAX);
    let live_page_blocks = i64::try_from(fold_live_page_blocks(&blocks).len()).unwrap_or(i64::MAX);
    let ownership = fold_page_ownership(&blocks);
    let blocks_owned_by_another_page = i64::try_from(
        ownership
            .iter()
            .filter(|(id, owner)| owner.as_deref().is_some_and(|p| p != id.as_str()))
            .count(),
    )
    .unwrap_or(i64::MAX);

    Ok(OracleCoverage {
        pages_cache_rows,
        live_page_blocks,
        blocks_owned_by_another_page,
        hashed_attachment_rows,
        soft_deleted_attachment_rows,
        attachment_blob_rows,
        page_link_cache_rows,
        page_link_edges,
        fts_blocks_rows,
        fts_indexable_blocks,
        fts_tombstoned_blocks,
        date_column_rows,
        block_tag_edges,
        derived_space_rows,
        distinct_block_spaces,
    })
}

/// Recompute which pages must have a `pages_cache` row, from `blocks` alone.
///
/// # Why this is a SEPARATE artefact from the counts
///
/// [`reconcile`]'s count diff keys **both** sides off the rows that already
/// exist in `pages_cache`, so it compares two count columns for pages the
/// cache already knows about. A **missing** row for a live page (its title
/// never lands, and every count arm below has nothing to maintain) or an
/// **extra** row for a block that is no longer a live titled page (a stale
/// title in the Pages list, and a page that keeps being counted after it is
/// gone) are both invisible to it. The counts are the values; this is the
/// key set.
pub async fn rebuild_pages_cache_rows_from_base(
    pool: &SqlitePool,
) -> Result<BTreeSet<String>, AppError> {
    Ok(fold_live_page_blocks(&dump_blocks(pool).await?))
}

/// Run production's `pages_cache` ROW pass — the `RebuildPagesCache` task
/// `materializer::dispatch` enqueues for every op that mutates a page block
/// (create / edit-title / delete / restore / purge; `#2037 pt2` drops it for
/// ops whose block-type hint is exactly `content`).
///
/// Row membership has **no** synchronous per-op arm at all: this rebuild is
/// its only maintainer, so a caller that mutates a page and asserts without it
/// is asserting against an un-settled state. It is production code
/// (`agaric_store::cache::rebuild_pages_cache`), so breaking it turns the
/// oracle red. Note it does NOT touch either count column (#417 moved that to
/// [`settle_deferred_pages_cache_counts`]), so calling it can never repair a
/// count bug and mask it.
pub async fn settle_pages_cache_rows(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_pages_cache(pool).await
}

/// Recompute `blocks.page_id` for every block from the `parent_id` tree.
///
/// This is the artefact the `pages_cache` count rebuild used to have to
/// ASSUME. Both count rules read `blocks.page_id` as page ownership and so
/// does the incremental UPDATE they audit, so ownership drift — the E4 shape,
/// a cross-page move whose re-derivation is missed — used to be invisible:
/// both sides read the same drifted column and agreed. Auditing the column
/// against the tree it is a cache of is what turns that shared input from an
/// assumption into a checked fact.
pub async fn rebuild_page_ownership_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, Option<String>>, AppError> {
    Ok(fold_page_ownership(&dump_blocks(pool).await?))
}

/// Run production's vault-wide `page_id` re-derivation — the `RebuildPageIds`
/// task, a member of the create / delete / restore / purge and inbound-sync
/// rebuild sets in `materializer::dispatch`.
///
/// A MOVE deliberately does NOT enqueue it (#2200): the local move command
/// re-derives the moved subtree synchronously in-transaction via
/// `agaric_store::block_descendants::rederive_page_and_space_ids`. A driver that
/// re-derived after every op would therefore repair exactly the arm most
/// likely to be wrong, so callers run this only where production does.
pub async fn settle_derived_page_ids(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_page_ids(pool).await
}

/// Recompute the derived `blocks.space_id` values from base rows. Only the
/// rows [`fold_block_space_ids`] scopes in are present; a caller diffing
/// against the column must not read an absent key as "expected NULL".
pub async fn rebuild_block_space_ids_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, DerivedSpace>, AppError> {
    Ok(fold_block_space_ids(&dump_blocks(pool).await?))
}

/// Run production's vault-wide `space_id` propagation — the second half of the
/// `RebuildPageIds` task handler (`task_handlers.rs`), and what the 0086
/// backfill did. It re-derives every non-page block that has a `page_id` and
/// leaves pages, tags and orphans alone, which is exactly the scope the fold
/// audits. Production code, so breaking it turns the oracle red.
pub async fn settle_block_space_ids_rebuild(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_space_ids(pool).await
}

/// Run production's DEFERRED `pages_cache` count pass — the one
/// `materializer::dispatch` enqueues as `MaterializeTask::RebuildPagesCacheCounts`
/// for every cohort op (`DeleteBlock` / `RestoreBlock` / `PurgeBlock`),
/// because `maintain_pages_cache_counts_after_op` returns early for those
/// (#2042).
///
/// A driver that applies a cohort op and then asserts reconciliation without
/// this is asserting against an un-settled state. This is production code
/// (`agaric_store::cache::rebuild_pages_cache_counts`), not a test-local
/// repair: breaking it turns the oracle red exactly as breaking a synchronous
/// arm does. That is what makes the DECREMENT half of the count pair covered
/// rather than left open.
pub async fn settle_deferred_pages_cache_counts(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_pages_cache_counts(pool).await
}

/// Run production's whole-table `page_link_cache` recompute — the
/// `RebuildPageLinkCache` task, a member of every lifecycle rebuild set
/// (delete / restore / purge), of the cross-page `MoveBlock` arm, and of the
/// inbound-sync / snapshot-restore sets.
///
/// For a driver that writes `block_links` WITHOUT an op (a fixture, or the
/// in-tx arm of a path whose op is not modelled), this is the only maintainer
/// that can know about those edges: the per-block reindex keys on one source
/// page. It is production code (`agaric_store::cache::rebuild_page_link_cache`),
/// so breaking it turns the oracle red.
pub async fn settle_page_link_cache_rebuild(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_page_link_cache(pool).await
}

/// Run the `page_link_cache` maintainers PRODUCTION's dispatch table says this
/// op needs — and only those.
///
/// Nothing writes this roll-up inside `apply_op_tx`; its only maintainers are
/// two background tasks (`ReindexBlockLinks`, `RebuildPageLinkCache`) that the
/// per-op-type fan-out table in `materializer::dispatch::invalidations_for_op`
/// decides to enqueue. So a driver that ran a FIXED list of maintainers after
/// every op would be auditing the projection helpers while silently repairing
/// the one thing that is actually hand-maintained per op — the table. This
/// function asks the real table instead, which is what makes a forgotten
/// enqueue (#3296's `CreateBlock` arm) show up as a divergence rather than as
/// an assumption nobody wrote down. Returns how many maintainers production
/// asked for, so a caller can see "zero" for itself.
///
/// # Why only the roll-up half of the `ReindexBlockLinks` handler runs
///
/// The production handler does three things: re-diff `block_links` for the
/// block, roll up into `page_link_cache`, then refresh
/// `pages_cache.inbound_link_count` for the affected pages. The first and
/// third are deliberately NOT run here. `block_links` is a BASE table for this
/// module — [`rebuild_pages_cache_counts_from_base`] and
/// [`rebuild_page_link_cache_from_base`] both fold it as ground truth — so
/// re-deriving it from content would let the backstop overwrite whatever the
/// in-tx arm produced; and re-running the inbound-count refresh would REPAIR
/// the `pages_cache.inbound_link_count` artefact this same oracle audits,
/// turning that count diff from a check into a self-confirming one. Running
/// only `reindex_page_link_cache_for_block` keeps every other artefact's
/// evidence exactly as the arm under audit left it.
///
/// # What this does NOT cover (be precise about it)
///
/// `reindex_page_link_cache_for_block` is production code — the SOLE per-block
/// writer of the roll-up — so breaking THAT FUNCTION turns the oracle red. But
/// this calls it directly rather than through `handle_background_task`, so the
/// `ReindexBlockLinks` task → function WIRING is bypassed: deleting the call in
/// `materializer/handlers/task_handlers.rs` would leave this oracle green. That
/// wiring is pinned elsewhere (`materializer/tests/page_link_cache.rs`,
/// `local_edit_page_link_cache_converges_local_matches_remote_2397`), so it is
/// covered — just not here. Do not read a green B6 as evidence the handler is
/// wired up.
///
/// Likewise, this runs `invalidations_for_op`'s RAW output, whereas production
/// runs it through `enqueue_background_tasks`, which FILTERS: a local
/// delete/restore/purge diverts `is_global_lifecycle_rebuild` tasks (including
/// `RebuildPageLinkCache`) into a trailing debounce. So the harness settles
/// more EAGERLY than production does. That is the safe direction for an
/// eventual-consistency oracle — it cannot manufacture a divergence production
/// would not eventually reach — but "asks production's own table" is one level
/// shallower than the function that actually runs.
///
/// `block_type_hint` / `move_same_page` are the same hints the caller's op
/// path would carry. `block_type_hint: None` models remote replay, inbound sync
/// and boot (which never carry it), which is also what the apply-path proptest
/// drivers model.
///
/// #3886: `move_same_page` is no longer always `None` at B6's call site. Doing
/// so meant the #2700 same-page skip — the branch that actually DROPS
/// `RebuildPageLinkCache` — was never exercised by the oracle, so a wrong skip
/// could not become a divergence. B6 now computes it by calling production's
/// own `materializer::move_same_page_hint` on the moved root's `page_id` before
/// and after the apply, i.e. the same two reads `commands/blocks/move_ops.rs`
/// performs, so the rule cannot drift out of sync with a mirror kept in test
/// code.
///
/// Be precise about what that buys, because it is LESS than "any weakening of
/// the hint reddens B6". `prepare_chain` reparents every root create/move onto
/// `PAGE_ID`, so EVERY chain block carries a real, unchanged `page_id` and the
/// hint is `Some(true)` for every generated move. That is exactly what makes
/// the skip branch reachable here (see the non-vacuity `prop_assert` at the
/// end of B6), but it also means B6 generates NO page-less move — reverting
/// `move_same_page_hint` to its pre-#3886 `old == new` form leaves this
/// property GREEN. The page-less shape #3886 fixes is pinned by the dedicated
/// tests instead (`move_same_page_hint_rejects_a_pageless_move_3886`,
/// `invalidations_for_op_move_block_pageless_subtree_keeps_page_link_rebuild_3886`,
/// and the end-to-end
/// `pageless_subtree_reparent_moves_the_page_link_rollup_key_3886`). What B6
/// does audit is that the skip, WHEN TAKEN on a real-page move, does not
/// diverge from a from-base rebuild.
pub async fn settle_page_link_cache_for_op(
    pool: &SqlitePool,
    record: &agaric_store::op_log::OpRecord,
    block_type_hint: Option<&str>,
    move_same_page: Option<bool>,
) -> Result<usize, AppError> {
    use crate::materializer::MaterializeTask;

    let tasks = crate::materializer::invalidations_for_op(record, block_type_hint, move_same_page)?;
    let mut ran = 0usize;
    for task in &tasks {
        match task {
            MaterializeTask::ReindexBlockLinks { block_id } => {
                agaric_store::cache::reindex_page_link_cache_for_block(pool, block_id).await?;
                ran += 1;
            }
            MaterializeTask::RebuildPageLinkCache => {
                agaric_store::cache::rebuild_page_link_cache(pool).await?;
                ran += 1;
            }
            _ => {}
        }
    }
    Ok(ran)
}

/// [`fold_block_links_from_content`] over a fresh `blocks` dump.
pub async fn rebuild_block_links_from_content(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, AppError> {
    Ok(fold_block_links_from_content(&dump_blocks(pool).await?))
}

/// How much of the `block_links` artefact's subject matter EXISTS in a given
/// database — the same "a green oracle must not be a green vacuum" discipline
/// [`OracleCoverage`] enforces for the roll-up artefacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockLinksCoverage {
    /// Rows in `block_links` — what the incremental writers produced.
    pub block_links_rows: i64,
    /// `(live source, token)` pairs parsed out of `blocks.content`, BEFORE any
    /// existence or space filtering. Zero means the vault contains no link
    /// syntax at all and the whole artefact compared `{} == {}`.
    pub content_link_tokens: i64,
    /// Edges the from-content rebuild says MUST exist — the expected side.
    pub derivable_edges: i64,
    /// Live source blocks carrying link tokens whose resolved space is
    /// non-NULL, i.e. the sources for which the cross-space filter is ARMED at
    /// all. With zero of these every target passes (`?3 IS NULL`) and the
    /// filter — the thing #3903 was about — is not under test.
    pub space_filtered_sources: i64,
    /// Token targets whose OWN `space_id` is NULL but whose owning page
    /// carries one, i.e. targets that can only resolve through the
    /// owning-page fallback.
    ///
    /// This is the #3903 non-vacuity counter and the sharpest one here: a
    /// fixture with zero of these leaves the pre-#3894 subquery and the
    /// post-#3894 one indistinguishable, so the artefact could not tell them
    /// apart however many other edges it audited.
    pub page_fallback_space_targets: i64,
}

/// Count what the `block_links` artefact is actually auditing.
pub async fn block_links_coverage(pool: &SqlitePool) -> Result<BlockLinksCoverage, AppError> {
    let blocks = dump_blocks(pool).await?;
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut content_link_tokens: i64 = 0;
    let mut space_filtered_sources: i64 = 0;
    let mut fallback_targets: BTreeSet<String> = BTreeSet::new();
    for source in &blocks {
        if source.deleted_at.is_some() {
            continue;
        }
        let targets = fold_content_link_targets(source.content.as_deref());
        if targets.is_empty() {
            continue;
        }
        content_link_tokens += i64::try_from(targets.len()).unwrap_or(i64::MAX);
        if fold_block_space(&by_id, &source.id).is_some() {
            space_filtered_sources += 1;
        }
        for target_id in targets {
            let Some(target) = by_id.get(target_id.as_str()) else {
                continue;
            };
            if target.space_id.is_none() && fold_block_space(&by_id, &target_id).is_some() {
                fallback_targets.insert(target_id);
            }
        }
    }

    // Folded from the SAME functions the artefact uses, never counted in SQL:
    // "the fixture covers this" and "the oracle audited this" must come from
    // one computation so they cannot drift apart.
    let derivable_edges =
        i64::try_from(fold_block_links_from_content(&blocks).len()).unwrap_or(i64::MAX);
    let block_links_rows = i64::try_from(dump_block_links(pool).await?.len()).unwrap_or(i64::MAX);

    Ok(BlockLinksCoverage {
        block_links_rows,
        content_link_tokens,
        derivable_edges,
        space_filtered_sources,
        page_fallback_space_targets: i64::try_from(fallback_targets.len()).unwrap_or(i64::MAX),
    })
}

/// The formatted first `block_links` divergence, or `None` when the table
/// agrees with a from-content rebuild.
///
/// Mirrors [`reconciliation_failure`] but reports under its own banner, so a
/// failure is never mistaken for one of the roll-up artefacts: this one names
/// a BASE table, and its owner list is a pair of writers with no vault-wide
/// repair behind them.
pub async fn block_links_reconciliation_failure(
    pool: &SqlitePool,
    context: &str,
) -> Option<String> {
    let divergences = match reconcile_block_links(pool).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "block_links oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "BLOCK_LINKS RECONCILIATION FAILED at [{context}]\n  \
         block_links disagrees with a from-CONTENT rebuild in {} place(s); first:\n    {first}",
        divergences.len(),
    ))
}

/// Panic with the first `block_links` divergence unless the table equals its
/// from-content rebuild.
pub async fn assert_block_links_reconciled(pool: &SqlitePool, context: &str) {
    if let Some(report) = block_links_reconciliation_failure(pool, context).await {
        panic!("{report}");
    }
}

/// [`fold_block_tag_refs_from_content`] over a fresh `blocks` dump.
pub async fn rebuild_block_tag_refs_from_content(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, AppError> {
    Ok(fold_block_tag_refs_from_content(&dump_blocks(pool).await?))
}

/// The formatted first `block_tag_refs` divergence, or `None` when the table
/// agrees with a from-content rebuild.
pub async fn block_tag_refs_reconciliation_failure(
    pool: &SqlitePool,
    context: &str,
) -> Option<String> {
    let divergences = match reconcile_block_tag_refs(pool).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "block_tag_refs oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "BLOCK_TAG_REFS RECONCILIATION FAILED at [{context}]\n  \
         block_tag_refs disagrees with a from-CONTENT rebuild in {} place(s); first:\n    {first}",
        divergences.len(),
    ))
}

/// Panic with the first `block_tag_refs` divergence unless the table equals its
/// from-content rebuild.
pub async fn assert_block_tag_refs_reconciled(pool: &SqlitePool, context: &str) {
    if let Some(report) = block_tag_refs_reconciliation_failure(pool, context).await {
        panic!("{report}");
    }
}

/// The formatted first `tags_cache` divergence, or `None` when it reconciles.
pub async fn tags_cache_reconciliation_failure(pool: &SqlitePool, context: &str) -> Option<String> {
    let divergences = match reconcile_tags_cache(pool).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "tags_cache oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "TAGS_CACHE RECONCILIATION FAILED at [{context}]\n  \
         tags_cache disagrees with a from-base rebuild in {} place(s); first:\n    {first}",
        divergences.len(),
    ))
}

/// Panic with the first `tags_cache` divergence unless it equals its rebuild.
pub async fn assert_tags_cache_reconciled(pool: &SqlitePool, context: &str) {
    if let Some(report) = tags_cache_reconciliation_failure(pool, context).await {
        panic!("{report}");
    }
}

/// The formatted first `agenda_cache` divergence, or `None` when it reconciles.
pub async fn agenda_cache_reconciliation_failure(
    pool: &SqlitePool,
    context: &str,
) -> Option<String> {
    let divergences = match reconcile_agenda_cache(pool).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "agenda_cache oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "AGENDA_CACHE RECONCILIATION FAILED at [{context}]\n  \
         agenda_cache disagrees with a from-base rebuild in {} place(s); first:\n    {first}",
        divergences.len(),
    ))
}

/// Panic with the first `agenda_cache` divergence unless it equals its rebuild.
pub async fn assert_agenda_cache_reconciled(pool: &SqlitePool, context: &str) {
    if let Some(report) = agenda_cache_reconciliation_failure(pool, context).await {
        panic!("{report}");
    }
}

/// The formatted first `projected_agenda_cache` divergence, or `None`.
pub async fn projected_agenda_reconciliation_failure(
    pool: &SqlitePool,
    today: chrono::NaiveDate,
    context: &str,
) -> Option<String> {
    let divergences = match reconcile_projected_agenda(pool, today).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "projected_agenda_cache oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "PROJECTED_AGENDA_CACHE RECONCILIATION FAILED at [{context}]\n  \
         projected_agenda_cache disagrees with a from-base rebuild in {} place(s); first:\n    \
         {first}",
        divergences.len(),
    ))
}

/// Panic with the first `projected_agenda_cache` divergence unless it reconciles.
pub async fn assert_projected_agenda_reconciled(
    pool: &SqlitePool,
    today: chrono::NaiveDate,
    context: &str,
) {
    if let Some(report) = projected_agenda_reconciliation_failure(pool, today, context).await {
        panic!("{report}");
    }
}

/// [`fold_block_links_unresolved`] over fresh `blocks` and `block_links` dumps.
pub async fn rebuild_block_links_unresolved_from_content(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let links: BTreeSet<(String, String)> = dump_block_links(pool).await?.into_iter().collect();
    Ok(fold_block_links_unresolved(&blocks, &links))
}

/// How much of the obligation artefact's subject matter EXISTS in a given
/// database — the "a green oracle must not be a green vacuum" discipline
/// [`OracleCoverage`] and [`BlockLinksCoverage`] enforce, applied to this one.
///
/// Kept as its OWN struct rather than as extra fields on [`BlockLinksCoverage`]
/// because the two artefacts are non-vacuous for different reasons: an edge
/// fixture is interesting when the cross-space filter is armed, an obligation
/// fixture is interesting when something is actually owed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockLinksUnresolvedCoverage {
    /// Rows in `block_links_unresolved` — what the writers produced.
    pub unresolved_rows: i64,
    /// Obligations the fold says MUST exist — the expected side. Zero means
    /// every token in the vault is already an edge and the whole artefact
    /// compared `{} == {}`.
    pub owed_by_content: i64,
    /// Obligations whose target EXISTS in `blocks` and is live.
    ///
    /// The sharp counter. An obligation to an ABSENT target is the easy shape
    /// (#4118 case 1) and any fold that parsed tokens at all would produce it.
    /// One whose target is present and live is owed for a subtler reason — the
    /// cross-space/space-stamp window (#4118 case 2), or an edge some writer
    /// dropped — and it is the shape a fold that quietly required "target not
    /// in `blocks`" would MISS. A fixture with zero of these cannot tell those
    /// two folds apart.
    pub owed_with_a_live_target: i64,
}

/// Count what the obligation artefact is actually auditing.
///
/// # Errors
/// Returns [`AppError`] if either dump fails.
pub async fn block_links_unresolved_coverage(
    pool: &SqlitePool,
) -> Result<BlockLinksUnresolvedCoverage, AppError> {
    let blocks = dump_blocks(pool).await?;
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let links: BTreeSet<(String, String)> = dump_block_links(pool).await?.into_iter().collect();

    // Folded from the SAME function the artefact uses, never counted in SQL:
    // "the fixture covers this" and "the oracle audited this" must come from
    // one computation so they cannot drift apart.
    let owed = fold_block_links_unresolved(&blocks, &links);
    let owed_with_a_live_target = owed
        .iter()
        .filter(|(_, target_id)| {
            by_id
                .get(target_id.as_str())
                .is_some_and(|t| t.deleted_at.is_none())
        })
        .count();

    Ok(BlockLinksUnresolvedCoverage {
        unresolved_rows: i64::try_from(dump_block_links_unresolved(pool).await?.len())
            .unwrap_or(i64::MAX),
        owed_by_content: i64::try_from(owed.len()).unwrap_or(i64::MAX),
        owed_with_a_live_target: i64::try_from(owed_with_a_live_target).unwrap_or(i64::MAX),
    })
}

/// The formatted first `block_links_unresolved` divergence, or `None` when the
/// table agrees with a re-derivation from content.
///
/// Reports under its OWN banner (see [`reconcile_block_links_unresolved`] for
/// why it is not merged into the sibling's): this one names an OBLIGATION
/// index, and its divergences are repairs that will or will not happen rather
/// than edges that are or are not there.
pub async fn block_links_unresolved_reconciliation_failure(
    pool: &SqlitePool,
    context: &str,
) -> Option<String> {
    let divergences = match reconcile_block_links_unresolved(pool).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "block_links_unresolved oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "BLOCK_LINKS_UNRESOLVED RECONCILIATION FAILED at [{context}]\n  \
         block_links_unresolved disagrees with a re-derivation from block content in {} \
         place(s); first:\n    {first}",
        divergences.len(),
    ))
}

/// Panic with the first `block_links_unresolved` divergence unless the table
/// equals its re-derivation.
pub async fn assert_block_links_unresolved_reconciled(pool: &SqlitePool, context: &str) {
    if let Some(report) = block_links_unresolved_reconciliation_failure(pool, context).await {
        panic!("{report}");
    }
}

/// Bring `block_links_unresolved` in line with the vault-wide arm,
/// `rebuild_block_links_unresolved` (#4218; its production caller, the
/// snapshot RESET, went in #4699).
///
/// The settle for a fixture that wrote `blocks.content` (and possibly
/// `block_links`) directly, with no op behind it, so no `ReindexBlockLinks`
/// was ever enqueued. Mirrors [`settle_page_link_cache_rebuild`], and is the
/// ONE place the artefact and the production rebuild touch: the fold above is
/// an independent transcription, so a test that settles with this and then
/// asserts with [`assert_block_links_unresolved_reconciled`] is pinning the two
/// derivations against each other rather than asking one of them twice.
///
/// # Errors
/// Returns [`AppError`] if the rebuild fails.
pub async fn settle_block_links_unresolved(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_block_links_unresolved(pool).await
}

/// Run the FTS maintainers PRODUCTION's dispatch table says this op needs —
/// and only those.
///
/// Same contract as [`settle_page_link_cache_for_op`], for the same reason:
/// no arm of `apply_op_tx` writes `fts_blocks`, so the only thing that can be
/// wrong is the per-op-type fan-out table. A driver running a FIXED list of
/// FTS maintainers after every op would repair exactly the hand-maintained
/// thing it is supposed to audit. This asks
/// `materializer::dispatch::invalidations_for_op` instead and runs the tasks
/// it names, through the same production functions
/// `materializer::handlers::task_handlers` dispatches to. Returns how many it
/// ran, so a caller can see "zero" for itself.
///
/// Two task variants are deliberately absent. `FtsOptimize` is an FTS5
/// index-compaction command with no effect on which rows exist or what they
/// hold, enqueued on a metric threshold rather than by an op arm. And
/// `RebuildFtsIndex` is not reachable from here at all: no arm of
/// `invalidations_for_op` pushes it — it comes only from `inbound_sync_fts_tasks`
/// and boot — so an arm for it would be a repair path for a case this function
/// cannot be handed.
///
/// # What this does NOT cover
///
/// The task → function WIRING is bypassed, exactly as in
/// [`settle_page_link_cache_for_op`]: this calls
/// `agaric_store::fts::{update_fts_for_block_with_maps, remove_fts_for_block,
/// reindex_fts_references}` directly rather than through
/// `handle_background_task`, so deleting a call there leaves this green. Nor
/// does it model the split read/write pool the handler prefers when one is
/// available. Both are pinned elsewhere (`materializer/tests/agenda_fts_misc.rs`,
/// `fts/tests.rs`); do not read a green B6 as evidence the handler is wired up.
///
/// Nor are the #4733 cohort fan-outs here: they are not tasks but post-commit
/// calls beside the engine fan-outs, and the B6 driver mirrors them the way it
/// mirrors those (`apply_reproject_proptest::Driver::drive`).
///
/// `block_type_hint: None` models remote replay, inbound sync and boot — the
/// same hint the apply-path proptest drivers carry.
pub async fn settle_fts_for_op(
    pool: &SqlitePool,
    record: &agaric_store::op_log::OpRecord,
    block_type_hint: Option<&str>,
) -> Result<usize, AppError> {
    use crate::materializer::MaterializeTask;

    let tasks = crate::materializer::invalidations_for_op(record, block_type_hint, None)?;
    let mut ran = 0usize;
    for task in &tasks {
        match task {
            MaterializeTask::UpdateFtsBlock { block_id } => {
                // The handler's own read: maps scoped to this block's refs
                // (#418), fed to the `_with_maps` upsert.
                let (tag_names, page_titles) =
                    agaric_store::fts::load_ref_maps_for_block(pool, block_id).await?;
                agaric_store::fts::update_fts_for_block_with_maps(
                    pool,
                    block_id,
                    &tag_names,
                    &page_titles,
                )
                .await?;
                ran += 1;
            }
            MaterializeTask::RemoveFtsBlock { block_id } => {
                agaric_store::fts::remove_fts_for_block(pool, block_id).await?;
                ran += 1;
            }
            MaterializeTask::ReindexFtsReferences { block_id } => {
                agaric_store::fts::reindex_fts_references(pool, block_id).await?;
                ran += 1;
            }
            _ => {}
        }
    }
    Ok(ran)
}

/// #4679: run the `blocks.space_id` maintainer PRODUCTION's dispatch table
/// says this op needs — and only that.
///
/// Same contract as [`settle_page_link_cache_for_op`]. Until #4679 the
/// apply-path drivers stamped the column themselves after every create, so an
/// oracle over it would have diffed the test's own write against a rebuild
/// rooted in the same constant. This asks `invalidations_for_op` instead and
/// runs the production function for each `SetBlockPageId` it names
/// (`set_block_space_id_from_parent`, the second half of that task's handler
/// in `task_handlers.rs`).
///
/// # The post-commit stamp is a RE-stamp on the engine path — measured, #3345
///
/// A created block's column is NOT NULL between the apply and this settle:
/// the apply kernel's `maintain_pages_cache_counts_after_op` stamps `page_id`
/// AND `space_id` from the owning page inside the create's own transaction
/// (`PreOpState::Create` in `apply/pages_cache.rs`, so the in-tx count
/// recompute keys on a correct `page_id`), and B6 instrumented to read the
/// column right after `drive` found it already set on every create. So on
/// this path `set_block_space_id_from_parent` writes the value the row
/// already holds, and skipping it leaves B6 GREEN — production's own
/// redundancy, not a gap in the oracle: skipping the in-tx stamp alone leaves
/// B6 green too, because this settle repairs it exactly as production's task
/// would, and only skipping BOTH reddens B6 at the first create. The
/// post-commit arm on its own is pinned by
/// `block_space_ids_reconcile_and_report_a_missed_stamp_3345`, whose fixture
/// holds the column NULL the way a row written by a path without the kernel
/// arm (a SQL-only fallback, a sync import before its space registers) is.
///
/// Only the SPACE half of the handler runs here. The drivers still stamp
/// `page_id` themselves (the engine-path guard needs the NEXT op's
/// `resolve_block_space` to succeed in-line, which it does through the owning
/// page), so the handler's `set_block_page_id_from_parent_in_tx` would match
/// zero rows; running it would be a no-op dressed as coverage.
///
/// A `SetProperty(space)` needs nothing from here: its page-group
/// `blocks.space_id` write is in-tx (`project_set_property_to_sql`), and the
/// dispatch table enqueues no space task for it.
///
/// `block_type_hint: None` models remote replay, inbound sync and boot — the
/// same hint the apply-path proptest drivers carry.
pub async fn settle_block_space_ids_for_op(
    pool: &SqlitePool,
    record: &agaric_store::op_log::OpRecord,
    block_type_hint: Option<&str>,
) -> Result<usize, AppError> {
    use crate::materializer::MaterializeTask;

    let tasks = crate::materializer::invalidations_for_op(record, block_type_hint, None)?;
    let mut ran = 0usize;
    for task in &tasks {
        if let MaterializeTask::SetBlockPageId { block_id } = task {
            agaric_store::cache::set_block_space_id_from_parent(pool, block_id).await?;
            ran += 1;
        }
    }
    Ok(ran)
}

/// The formatted first divergence, or `None` when derived state reconciles.
///
/// Returns a `String` rather than panicking so proptest callers can feed it
/// to `prop_assert!` and let the shrinker minimise the counter-example.
pub async fn reconciliation_failure(pool: &SqlitePool, context: &str) -> Option<String> {
    let divergences = match reconcile(pool).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "reconciliation oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "RECONCILIATION FAILED at [{context}]\n  \
         derived state disagrees with a from-base rebuild in {} place(s); first:\n    {first}",
        divergences.len(),
    ))
}

/// Panic with the first divergence unless every covered derived artefact
/// equals its from-base rebuild. `context` should identify the op that just
/// applied (index + type) so the failure names the arm that broke.
pub async fn assert_reconciled(pool: &SqlitePool, context: &str) {
    if let Some(report) = reconciliation_failure(pool, context).await {
        panic!("{report}");
    }
}
