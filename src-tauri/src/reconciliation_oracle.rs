//! Reconciliation oracle (#3345, programme #3351 theme T3).
//!
//! Derived state in this codebase is **hand-maintained per op arm**. The
//! apply kernel (`agaric_engine::apply::kernel::apply_op_tx_with_mode`)
//! captures a bespoke `PreOpState` variant per op type and feeds it to
//! `maintain_pages_cache_counts_after_op`, so every new op type is a fresh
//! chance to forget an arm. The content-addressed attachment blob store
//! (`attachment_blobs`, migration 0094) has the same shape one level down:
//! three independent sites INSERT a blob row (`persist_attachment` on local
//! ingest, `sync_files::register_received_blob` after a verified receive,
//! `recovery::backfill_attachment_blobs`), none of them INCREMENTS or
//! DECREMENTS anything — the only reconciliation is a background GC sweep.
//!
//! Only local ingest is driven by this slice's tests; the sync-receive arm is
//! covered by the oracle (any state it produces is diffed) but is not yet
//! *exercised* by a driver. That is a follow-up, not a claim made here.
//!
//! Nothing in the tree rebuilt those artefacts from base tables and diffed
//! the result against the incrementally-maintained state. This module is
//! that missing oracle.
//!
//! # Contract
//!
//! * Every `rebuild_*_from_base` function recomputes a derived artefact
//!   from **base tables only**, in Rust, from first principles. They are
//!   deliberately slow and naive — an oracle, not a fast path.
//! * They share **no code** with the incremental maintenance path. They do
//!   not call `recompute_pages_cache_counts_for_pages`, `rebuild_pages_cache`,
//!   `recompute_all_pages_cache_counts`, `rebuild_page_ids`,
//!   `cleanup_orphaned_attachments`, or any SQL those functions use. A
//!   rebuild that calls the same projection helper it is auditing proves
//!   nothing, so every aggregate, every set difference and every ancestor
//!   walk here is folded in Rust over a raw row dump.
//! * [`assert_reconciled`] diffs every artefact and reports the **first**
//!   divergence in a stable order, naming the artefact, the key, expected
//!   vs. actual, and the maintenance site that owns the arm — enough to
//!   identify which op caused it when the caller asserts per-op.
//!
//! # Where this runs
//!
//! Oracles are slow by construction, so they belong in nextest and the
//! scheduled lanes, **not** the commit path. The only prek hook that runs
//! Rust tests (`cargo-test` → `scripts/test-related-rust.sh`) is
//! `stages = ["pre-push"]`; nothing here is reachable from `pre-commit`.
//!
//! # What is covered
//!
//! | Artefact | Base tables | Maintained by |
//! |---|---|---|
//! | `attachment_blobs` (blob refcount) | `attachments` | `persist_attachment` (insert arm) / `cleanup_orphaned_attachments` (prune arm) |
//! | `pages_cache` ROW MEMBERSHIP | `blocks` | `rebuild_pages_cache` (the `RebuildPagesCache` task) |
//! | `blocks.page_id` (page OWNERSHIP) | `blocks` | `set_block_page_id_from_parent` (create arm) / `rederive_page_and_space_ids` (move arm) / `rebuild_page_ids` (vault-wide arm) |
//! | `pages_cache.{inbound_link_count,child_block_count}` | `blocks`, `block_links` | `maintain_pages_cache_counts_after_op` (sync arms) / `rebuild_pages_cache_counts` (deferred cohort arm) |
//! | `page_link_cache` (the page-level `block_links` roll-up) | `blocks`, `block_links` | `reindex_page_link_cache_for_block` (the `ReindexBlockLinks` task — the SOLE per-block writer) / `rebuild_page_link_cache` (the `RebuildPageLinkCache` task) |
//!
//! Deliberately **not** covered here — see the follow-up issues: the agenda
//! cache, the projected-agenda cache, `block_tag_refs`,
//! `tags_cache.usage_count`, `blocks.space_id` re-derivation, and the FTS
//! index.
//!
//! # `page_link_cache` has NO synchronous arm at all (#3296)
//!
//! Unlike the `pages_cache` counts, this roll-up is maintained **only** by
//! background tasks the DISPATCHER decides to enqueue: nothing in
//! `apply_op_tx` writes it. That makes the dispatch table itself — not a
//! projection helper — the thing that can be wrong, and it is a table with one
//! arm per op type, hand-maintained (`materializer::dispatch::
//! invalidations_for_op`). So the settle for this artefact
//! ([`settle_page_link_cache_for_op`]) does not run a fixed list of
//! maintainers: it asks PRODUCTION's fan-out table which link maintainers this
//! op needs and runs exactly those. An arm that forgets to enqueue
//! `ReindexBlockLinks` therefore runs nothing, the roll-up never gains the
//! edge, and the diff below reports it — which is precisely how the #3296
//! `CreateBlock` gap surfaces structurally rather than by someone noticing an
//! empty graph.
//!
//! # The counts' page-ownership assumption is no longer unfalsifiable (#3654)
//!
//! Both `pages_cache` count rules read the denormalised `blocks.page_id`, and
//! so does the incremental UPDATE they audit — so on its own the count
//! artefact cannot see page-ownership drift: both sides read the same drifted
//! column and agree. [`rebuild_page_ownership_from_base`] closes that by
//! auditing the column ITSELF against a structural `parent_id` walk, and
//! [`reconcile`] diffs ownership BEFORE the counts. A drift in `page_id` is
//! therefore reported at its root (`blocks.page_id`) rather than silently
//! agreed on, which is what makes the count comparison meaningful rather than
//! self-confirming.
//!
//! # Eventual consistency is part of the contract, not an excuse
//!
//! Two of the maintenance arms are deliberately DEFERRED in production:
//!
//! * `maintain_pages_cache_counts_after_op` returns early for
//!   `PreOpState::{Cohort, RestoreCohortAndAncestors, Purge}` (#2042) and
//!   `materializer::dispatch` enqueues `MaterializeTask::RebuildPagesCacheCounts`
//!   instead;
//! * `delete_attachment_inner` / the purge paths never unlink bytes or prune
//!   `attachment_blobs` (#1993/#3259); `cleanup_orphaned_attachments` does.
//!
//! So the oracle is a statement about the **settled** state. A caller that
//! drives an op which production defers MUST also drive production's
//! deferred pass before asserting — that is what
//! [`settle_deferred_pages_cache_counts`] and the GC call in the attachment
//! tests do. Both deferred passes are production code, so breaking either of
//! them still turns the oracle red; nothing is repaired by test-local code.

#![cfg(test)]

use std::collections::{BTreeMap, BTreeSet};

use agaric_core::error::AppError;
use sqlx::SqlitePool;

// ---------------------------------------------------------------------------
// Divergence report
// ---------------------------------------------------------------------------

/// One way in which incrementally-maintained derived state disagrees with a
/// from-base rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Divergence {
    /// Derived artefact + column, e.g. `pages_cache.child_block_count`.
    pub artefact: &'static str,
    /// The row key the divergence is about (page id, content hash, …).
    pub key: String,
    /// What a from-base rebuild says the value must be.
    pub expected: String,
    /// What the incrementally-maintained state actually holds.
    pub actual: String,
    /// The maintenance site that owns this arm — where to look first.
    pub owner: &'static str,
}

impl std::fmt::Display for Divergence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} [{}]\n      rebuilt-from-base: {}\n      incremental state: {}\n      maintained by:     {}",
            self.artefact, self.key, self.expected, self.actual, self.owner
        )
    }
}

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

    // Both page-shaped counters come from the SAME Rust folds the artefacts
    // use, so "the fixture covers this" and "the oracle audited this" can
    // never drift apart.
    let blocks = dump_blocks(pool).await?;
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
    })
}

// ---------------------------------------------------------------------------
// Base-table snapshots
//
// Every rebuild below folds one of these dumps in Rust. No aggregate, no
// JOIN, no correlated subquery is pushed into SQLite — that is the whole
// point: the maintenance path expresses its aggregates as SQL, so an oracle
// written in the same SQL would be a copy of the thing it audits.
// ---------------------------------------------------------------------------

/// One `blocks` row, reduced to the columns the derived artefacts depend on.
#[derive(Debug, Clone)]
struct BaseBlock {
    id: String,
    /// The structural parent. The ONLY input to page ownership — everything
    /// else about a page is a cache of this edge.
    parent_id: Option<String>,
    /// The denormalised ownership cache. Read as an ACTUAL value to diff
    /// against, never as an input to a rebuild that audits ownership.
    page_id: Option<String>,
    /// `'page'` / `'content'` / `'tag'` (CHECK `block_type_valid`, 0085).
    block_type: String,
    /// A page with no content has no title and therefore no cache row.
    content: Option<String>,
    /// `None` = live. `blocks.deleted_at` is epoch-ms INTEGER (migration 0080).
    deleted_at: Option<i64>,
}

/// One `attachments` row, reduced to the columns the blob store depends on.
#[derive(Debug, Clone)]
struct BaseAttachment {
    id: String,
    fs_path: String,
    content_hash: Option<String>,
    /// `None` = live. `attachments.deleted_at` is still TEXT (out of #109 scope).
    deleted_at: Option<String>,
}

type BaseBlockRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<i64>,
);

async fn dump_blocks(pool: &SqlitePool) -> Result<Vec<BaseBlock>, AppError> {
    // Kept off the offline `.sqlx` cache and deliberately aggregate-free — the
    // fold happens in Rust so this shares nothing with the maintenance path.
    // In particular there is no recursive CTE here: the ancestor walk that
    // derives page ownership is the one thing `rebuild_page_ids` expresses as
    // a `WITH RECURSIVE`, so expressing it the same way would make the oracle
    // a copy of the code it audits.
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, BaseBlockRow>(
        "SELECT id, parent_id, page_id, block_type, content, deleted_at FROM blocks",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, parent_id, page_id, block_type, content, deleted_at)| BaseBlock {
                id,
                parent_id,
                page_id,
                block_type,
                content,
                deleted_at,
            },
        )
        .collect())
}

async fn dump_block_links(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    const SQL: &str = "SELECT source_id, target_id FROM block_links";
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

async fn dump_attachments(pool: &SqlitePool) -> Result<Vec<BaseAttachment>, AppError> {
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        "SELECT id, fs_path, content_hash, deleted_at FROM attachments",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, fs_path, content_hash, deleted_at)| BaseAttachment {
            id,
            fs_path,
            content_hash,
            deleted_at,
        })
        .collect())
}

/// `blocks.block_type` for a page. A block is a page iff this matches
/// (CHECK `block_type_valid`, migration 0085, admits only
/// `content` / `tag` / `page`).
const PAGE_BLOCK_TYPE: &str = "page";

// ---------------------------------------------------------------------------
// Artefact 3 — `pages_cache` ROW MEMBERSHIP (#3654 part 1)
// ---------------------------------------------------------------------------

/// The set of block ids that MUST have a `pages_cache` row.
///
/// Transcribed from the column semantics, not from the maintenance SQL: a
/// `pages_cache` row is the materialised *title* of a page, so it exists for
/// exactly the blocks that are a live page carrying a title.
///
/// A plain `filter` over the raw `blocks` dump — no `NOT IN`, no anti-join,
/// no `SELECT … FROM blocks` predicate pushed into SQLite. `rebuild_pages_cache`
/// expresses the same set twice (as the source of an UPSERT and as the
/// `NOT IN (…)` of a delete-orphans sweep); a rebuild that asked SQLite the
/// same question would agree with both copies of a bug in it.
fn fold_live_page_blocks(blocks: &[BaseBlock]) -> BTreeSet<String> {
    blocks
        .iter()
        .filter(|b| {
            b.block_type == PAGE_BLOCK_TYPE && b.deleted_at.is_none() && b.content.is_some()
        })
        .map(|b| b.id.clone())
        .collect()
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

/// Read the key set of `pages_cache` as it stands.
async fn read_pages_cache_page_ids(pool: &SqlitePool) -> Result<BTreeSet<String>, AppError> {
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let rows: Vec<String> = sqlx::query_scalar("SELECT page_id FROM pages_cache")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
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

// ---------------------------------------------------------------------------
// Artefact 4 — `blocks.page_id`, i.e. page OWNERSHIP (#3654 part 2)
// ---------------------------------------------------------------------------

/// Derive every block's owning page STRUCTURALLY, from `parent_id` alone.
///
/// The specification (`cache::page_id::DESIRED_PAGE_ID_SQL` + its R27
/// fixpoint extension, transcribed — not called, and not re-expressed as a
/// recursive CTE):
///
/// * a page owns itself (also a DB CHECK, `page_id_self_for_pages`);
/// * any other block is owned by its NEAREST page ancestor, walking `parent_id`
///   upwards;
/// * a block with no page ancestor — an orphan, a bare `tag`, or a member of a
///   `parent_id` cycle — is owned by nothing (`NULL`).
///
/// `deleted_at` is deliberately NOT consulted: production derives `page_id`
/// for tombstones too, and a rebuild that skipped them would report a
/// divergence on every soft-deleted block.
///
/// The walk is bounded by the number of blocks and carries its own `visited`
/// set, so a corrupted `parent_id` cycle resolves to `None` instead of
/// hanging — the same outcome production's `depth < 100` cap plus fixpoint
/// extension produces, reached without borrowing its shape.
fn fold_page_ownership(blocks: &[BaseBlock]) -> BTreeMap<String, Option<String>> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut out = BTreeMap::new();
    for start in blocks {
        let mut visited: BTreeSet<&str> = BTreeSet::new();
        let mut cursor: Option<&BaseBlock> = Some(start);
        let mut owner: Option<String> = None;
        while let Some(block) = cursor {
            if !visited.insert(block.id.as_str()) {
                // `parent_id` cycle — unresolvable, exactly as the capped CTE
                // plus its fixpoint extension leave it.
                break;
            }
            if block.block_type == PAGE_BLOCK_TYPE {
                owner = Some(block.id.clone());
                break;
            }
            cursor = block
                .parent_id
                .as_deref()
                .and_then(|p| by_id.get(p).copied());
        }
        out.insert(start.id.clone(), owner);
    }
    out
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
/// `commands::block_cleanup::rederive_page_and_space_ids`. A driver that
/// re-derived after every op would therefore repair exactly the arm most
/// likely to be wrong, so callers run this only where production does.
pub async fn settle_derived_page_ids(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_page_ids(pool).await
}

// ---------------------------------------------------------------------------
// Artefact 1 — `pages_cache.{inbound_link_count, child_block_count}`
// ---------------------------------------------------------------------------

/// The two materialised aggregate columns of one `pages_cache` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCounts {
    pub inbound_link_count: i64,
    pub child_block_count: i64,
}

/// Recompute both `pages_cache` count columns for every page id that has a
/// cache row, from `blocks` + `block_links` alone.
///
/// The rules are transcribed from the column semantics (migrations 0069 /
/// 0070), NOT from the maintenance SQL:
///
/// * `child_block_count[P]` — live blocks whose `page_id` is `P`, excluding
///   the page block itself.
/// * `inbound_link_count[P]` — distinct link SOURCES that point at any live
///   block owned by `P`, excluding sources that are themselves deleted,
///   orphaned (`page_id IS NULL`), or on page `P` (same-page/self links).
///
/// Folded in Rust over three flat row dumps: no `COUNT`, no `DISTINCT`, no
/// `JOIN` is delegated to SQLite, so this cannot accidentally inherit a bug
/// from the correlated-subquery UPDATE it audits.
///
/// # The input this rebuild shares with the thing it audits — and why that is
/// no longer an unfalsifiable assumption (#3654)
///
/// Both count rules above read the denormalised `blocks.page_id` column, and
/// so does the maintenance UPDATE. On its own that would put page ownership
/// outside what this artefact can falsify: if `page_id` drifts from the
/// `parent_id` tree (the E4 shape — a cross-page move whose re-derivation is
/// missed), the UPDATE and this rebuild read the same drifted column and
/// agree.
///
/// [`rebuild_page_ownership_from_base`] now audits that column against the
/// tree it is a cache of, and [`reconcile`] diffs it BEFORE these counts, so a
/// drift is reported once, at its root, naming `blocks.page_id` and the
/// re-derivation arm — rather than as an unexplained count difference, or not
/// at all. The counts are deliberately left keyed on `page_id` rather than
/// recomputed from the derived ownership: a count divergence then means "the
/// affected-page resolution missed a row", a distinct failure from "ownership
/// itself is wrong", and the two report separately instead of one masking the
/// other.
///
/// `materializer::tests::pages_cache_parity::canonical_counts` remains the
/// other structural view (it derives `child_block_count` by descending the
/// live `parent_id` tree and stopping at nested page boundaries). It differs
/// from the pair here on one edge — a live block under a soft-deleted parent
/// is excluded there but owned here, because production's `page_id`
/// derivation ignores `deleted_at`. Neither is wrong; they answer different
/// questions, and this module claims only the one it computes.
pub async fn rebuild_pages_cache_counts_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, PageCounts>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let links = dump_block_links(pool).await?;
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let page_ids: Vec<String> = sqlx::query_scalar("SELECT page_id FROM pages_cache")
        .fetch_all(pool)
        .await?;

    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut out = BTreeMap::new();
    for page in page_ids {
        let mut child_block_count: i64 = 0;
        for b in &blocks {
            if b.deleted_at.is_none() && b.page_id.as_deref() == Some(page.as_str()) && b.id != page
            {
                child_block_count += 1;
            }
        }

        let mut sources: BTreeSet<&str> = BTreeSet::new();
        for (source_id, target_id) in &links {
            // Target must be a LIVE block owned by this page.
            let Some(target) = by_id.get(target_id.as_str()) else {
                continue;
            };
            if target.deleted_at.is_some() || target.page_id.as_deref() != Some(page.as_str()) {
                continue;
            }
            // Source must be live, page-owned, and on a DIFFERENT page.
            let Some(source) = by_id.get(source_id.as_str()) else {
                continue;
            };
            if source.deleted_at.is_some() {
                continue;
            }
            let Some(source_page) = source.page_id.as_deref() else {
                continue;
            };
            if source_page == page {
                continue;
            }
            sources.insert(source_id.as_str());
        }

        out.insert(
            page,
            PageCounts {
                inbound_link_count: i64::try_from(sources.len()).unwrap_or(i64::MAX),
                child_block_count,
            },
        );
    }
    Ok(out)
}

/// Read the incrementally-maintained `pages_cache` counts as they stand.
async fn read_pages_cache_counts(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, PageCounts>, AppError> {
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let rows = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT page_id, inbound_link_count, child_block_count FROM pages_cache",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(page_id, inbound_link_count, child_block_count)| {
            (
                page_id,
                PageCounts {
                    inbound_link_count,
                    child_block_count,
                },
            )
        })
        .collect())
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

// ---------------------------------------------------------------------------
// Artefact 2 — `attachment_blobs` (the attachment blob refcount)
// ---------------------------------------------------------------------------

/// What a from-base rebuild says one content hash's blob entry must look like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobExpectation {
    /// Number of `attachments` rows carrying this hash. Never 0 — a hash with
    /// no referencing row does not appear in the rebuild at all.
    pub refcount: usize,
    /// The `fs_path`s those rows point at. Under #1993 dedup this is normally
    /// a single canonical path shared by all of them.
    pub referenced_paths: BTreeSet<String>,
    /// The ids of the referencing rows, so a divergence report names the rows
    /// whose bytes are at stake rather than just a hash.
    pub referrer_ids: BTreeSet<String>,
    /// Which of [`Self::referrer_ids`] are tombstones (`deleted_at` set). A
    /// hash held up ONLY by tombstones is the interesting case — see
    /// [`rebuild_attachment_blobs_from_base`] — so a report says so instead of
    /// leaving the reader to wonder why a "deleted" attachment still matters.
    pub soft_deleted_referrer_ids: BTreeSet<String>,
}

/// Recompute the blob store from `attachments` alone.
///
/// `attachment_blobs` (migration 0094) has **no refcount column**: the link
/// is by-hash on demand, and no op arm increments or decrements anything. The
/// derived truth is therefore purely a fold over `attachments`:
///
/// > a blob row must exist for exactly those content hashes carried by at
/// > least one `attachments` row, and its `on_disk_path` must be a path one of
/// > those rows actually references.
///
/// The second half is the load-bearing one. `cleanup_orphaned_attachments`
/// decides what to unlink by testing `on_disk_path` membership in
/// `SELECT fs_path FROM attachments` — it never consults `content_hash`. A
/// blob whose `on_disk_path` no referrer uses is therefore a blob whose bytes
/// the GC will unlink while rows still resolve that hash to them.
///
/// # Soft-deleted rows ARE references (#3654 part 3)
///
/// The two production writers of `attachment_blobs` used to disagree here.
/// `cleanup_orphaned_attachments` loads `SELECT fs_path FROM attachments` with
/// NO predicate, so a tombstone keeps both the file and the blob row alive;
/// `backfill_attachment_blobs` scoped its candidate set with
/// `WHERE deleted_at IS NULL` while its comment claimed to match "the refcount
/// semantics used by the GC", which was the opposite of what the GC does.
/// Benign only because `attachments.deleted_at` still has no production writer
/// — which is exactly why it had to be settled before one appears rather than
/// discovered afterwards.
///
/// It is settled in the GC's direction, and the backfill was moved to match:
/// **a tombstone is still a reference.** A tombstone is restorable
/// (`history.rs`' `add_attachment` reversal re-inserts the row with its
/// original `fs_path`), and nothing re-fetches its bytes — `sync_files`'
/// missing-file scan is live-rows-only. So dropping a tombstone's bytes turns
/// a restore into a permanently broken reference, while keeping them costs
/// disk until the row is hard-deleted. That is the same asymmetry #3371 and
/// #3660 already settled for the mapping itself: a reference that outlives its
/// bytes is unrecoverable, a redundant copy self-heals.
pub async fn rebuild_attachment_blobs_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, BlobExpectation>, AppError> {
    let attachments = dump_attachments(pool).await?;
    let mut out: BTreeMap<String, BlobExpectation> = BTreeMap::new();
    for a in &attachments {
        let Some(hash) = a.content_hash.as_deref() else {
            // Rows written by the op-apply arm (`apply_add_attachment_tx`)
            // carry no hash at all and therefore impose no blob obligation.
            continue;
        };
        let entry = out
            .entry(hash.to_owned())
            .or_insert_with(|| BlobExpectation {
                refcount: 0,
                referenced_paths: BTreeSet::new(),
                referrer_ids: BTreeSet::new(),
                soft_deleted_referrer_ids: BTreeSet::new(),
            });
        entry.refcount += 1;
        entry.referenced_paths.insert(a.fs_path.clone());
        entry.referrer_ids.insert(a.id.clone());
        if a.deleted_at.is_some() {
            entry.soft_deleted_referrer_ids.insert(a.id.clone());
        }
    }
    Ok(out)
}

/// Read the blob store as it stands.
async fn read_attachment_blobs(pool: &SqlitePool) -> Result<BTreeMap<String, String>, AppError> {
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT content_hash, on_disk_path FROM attachment_blobs",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

// ---------------------------------------------------------------------------
// Artefact 5 — `page_link_cache` (the page-level `block_links` roll-up, #3296)
// ---------------------------------------------------------------------------

/// The payload of one `page_link_cache` row; its `(source_page, target)` PK is
/// the map key.
///
/// All four columns are diffed, not just `edge_count`. The three flags
/// (migration 0096) exist so the hot unscoped read in `list_page_links_inner`
/// can filter with a partial index and ZERO `blocks` joins — which means a
/// stale flag is not cosmetic: it is a link the Graph view silently drops
/// (`src_deleted`/`tgt_deleted` stuck at 1) or a link to a non-page block it
/// silently shows (`tgt_is_page` stuck at 1). Auditing `edge_count` alone
/// would leave the entire reason the denormalisation exists unchecked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageLinkEdge {
    /// Live `block_links` rows whose source block rolls up to this page.
    pub edge_count: i64,
    /// Is the SOURCE PAGE (the group key) soft-deleted — or gone entirely?
    pub src_deleted: bool,
    /// Is the target block soft-deleted?
    pub tgt_deleted: bool,
    /// Is the target block a `page`?
    pub tgt_is_page: bool,
}

/// Recompute the whole `page_link_cache` from `blocks` + `block_links` alone.
///
/// The rules are transcribed from the column semantics (migrations 0065 /
/// 0096) rather than from either maintenance query — with ONE honest
/// exception, called out below: the `COALESCE(page_id, parent_id, id)`
/// attribution chain IS the writers' rule, restated. So this oracle catches
/// IMPLEMENTATION bugs (a wrong join, a lost aggregate, a missing `WHERE`, the
/// chunked `INSERT OR IGNORE`, the zero-edge `DELETE` sweep) but CANNOT catch a
/// SPECIFICATION bug in the attribution rule itself — if that chain is the
/// wrong idea, the fold is wrong in the same way and the two agree. Inherent to
/// re-deriving a rule rather than deriving it from an independent source; noted
/// so nobody reads this as stronger than it is.
///
/// The rules:
///
/// * an edge is one `block_links` row whose SOURCE BLOCK exists and is live —
///   a tombstoned source contributes nothing, which is why deleting a block
///   must drop the rows it was holding up;
/// * an edge whose TARGET block no longer exists contributes nothing either
///   (both production queries inner-join `blocks` on the target);
/// * edges are grouped by `(source_page, target)`, where `source_page` is the
///   source block's owning page: its `page_id`, else its `parent_id`, else the
///   source block's own id. This chain is load-bearing and identical in the
///   incremental writer, the full rebuild and here — a block whose `page_id`
///   was never stamped rolls up under its immediate parent instead;
/// * `edge_count` is how many such rows land in the group;
/// * `src_deleted` is the state of the SOURCE PAGE — the group key — and is
///   `true` when that page is soft-deleted OR does not exist at all (a purged
///   or never-created page id, which the read must mask exactly as it masks a
///   tombstone);
/// * `tgt_deleted` / `tgt_is_page` come from the single target block.
///
/// Folded in Rust over two flat row dumps: no `GROUP BY`, no `COUNT`, no
/// `COALESCE`, no `LEFT JOIN` is delegated to SQLite. Both production writers
/// express this as one SQL shape — the incremental UPSERT restricted to one
/// source page, the full rebuild unrestricted — so an oracle written in that
/// shape would agree with a bug living in it. In particular the ancestor
/// question ("which page does this block's links belong to?") is answered here
/// by reading the two columns directly rather than by re-expressing the
/// `COALESCE` in SQL.
///
/// # Tombstones: verified against the writers, not assumed
///
/// A soft-deleted SOURCE BLOCK is excluded (both writers carry
/// `WHERE sb.deleted_at IS NULL`), but a soft-deleted TARGET is NOT — its row
/// survives carrying `tgt_deleted = 1`, and the read path filters on the flag.
/// A soft-deleted SOURCE PAGE likewise keeps its rows, flagged. Only a HARD
/// delete removes rows, and it does so through the schema rather than through
/// app code: `page_link_cache`'s two columns are
/// `REFERENCES blocks(id) ON DELETE CASCADE` (migration 0065), so a purge that
/// removes the block removes its cache rows — matching this fold, which drops
/// any edge whose source or target block is absent from `blocks`.
pub async fn rebuild_page_link_cache_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<(String, String), PageLinkEdge>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let links = dump_block_links(pool).await?;
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut out: BTreeMap<(String, String), PageLinkEdge> = BTreeMap::new();
    for (source_id, target_id) in &links {
        // The source block must exist and be LIVE.
        let Some(source) = by_id.get(source_id.as_str()) else {
            continue;
        };
        if source.deleted_at.is_some() {
            continue;
        }
        // The target block must exist (its flags are read off it).
        let Some(target) = by_id.get(target_id.as_str()) else {
            continue;
        };

        let source_page = source
            .page_id
            .clone()
            .or_else(|| source.parent_id.clone())
            .unwrap_or_else(|| source_id.clone());
        // A source page that is absent from `blocks` is masked as deleted —
        // the same outcome the writers' `COALESCE(…, 1)` / `CASE WHEN sp.id IS
        // NULL THEN 1` produce, reached without borrowing their shape.
        let src_deleted = by_id
            .get(source_page.as_str())
            .is_none_or(|p| p.deleted_at.is_some());

        let entry = out
            .entry((source_page, target_id.clone()))
            .or_insert(PageLinkEdge {
                edge_count: 0,
                src_deleted,
                tgt_deleted: target.deleted_at.is_some(),
                tgt_is_page: target.block_type == PAGE_BLOCK_TYPE,
            });
        entry.edge_count += 1;
    }
    Ok(out)
}

/// Read the incrementally-maintained `page_link_cache` as it stands.
async fn read_page_link_cache(
    pool: &SqlitePool,
) -> Result<BTreeMap<(String, String), PageLinkEdge>, AppError> {
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let rows = sqlx::query_as::<_, (String, String, i64, i64, i64, i64)>(
        "SELECT source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, \
         tgt_is_page FROM page_link_cache",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(source, target, edge_count, src_deleted, tgt_deleted, tgt_is_page)| {
                (
                    (source, target),
                    PageLinkEdge {
                        edge_count,
                        src_deleted: src_deleted != 0,
                        tgt_deleted: tgt_deleted != 0,
                        tgt_is_page: tgt_is_page != 0,
                    },
                )
            },
        )
        .collect())
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
/// path would carry: `None`/`None` models remote replay, inbound sync and boot
/// (which never carry hints), which is also what the apply-path proptest
/// drivers model. Note `move_same_page: None` means the #2700 same-page-move
/// optimisation is not exercised here.
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

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

/// Diff every covered derived artefact against its from-base rebuild.
///
/// Divergences come back in a stable order, each artefact sorted by key, so
/// `first` is deterministic and a shrunk proptest counter-example reports the
/// same line every run. The order is ROOT-CAUSE FIRST within the `pages_cache`
/// family: ownership (`blocks.page_id`) precedes row membership, which
/// precedes the counts, because the counts are keyed on both of the others. A
/// single missed `page_id` re-derivation therefore reports as one ownership
/// divergence rather than as an unexplained count difference on two pages.
pub async fn reconcile(pool: &SqlitePool) -> Result<Vec<Divergence>, AppError> {
    let mut out = Vec::new();

    // --- Artefact 2: attachment blob refcount --------------------------------
    let expected_blobs = rebuild_attachment_blobs_from_base(pool).await?;
    let actual_blobs = read_attachment_blobs(pool).await?;

    for (hash, on_disk_path) in &actual_blobs {
        match expected_blobs.get(hash) {
            None => out.push(Divergence {
                artefact: "attachment_blobs.refcount",
                key: hash.clone(),
                expected: "no blob row (refcount 0 — no attachments row, live or \
                           soft-deleted, carries this hash)"
                    .to_owned(),
                actual: format!("blob row present, on_disk_path={on_disk_path}"),
                owner: "cleanup_orphaned_attachments (the only INCREMENTAL prune arm; \
                        keys on fs_path, never on content_hash — snapshot restore \
                        wipes the table wholesale) — a delete/purge arm dropped the \
                        last referencing row without the blob store ever noticing",
            }),
            Some(expectation) => {
                if !expectation.referenced_paths.contains(on_disk_path) {
                    out.push(Divergence {
                        artefact: "attachment_blobs.on_disk_path",
                        key: hash.clone(),
                        expected: format!(
                            "one of the {} referrers' fs_paths {:?} (rows {:?}, of which \
                             soft-deleted: {:?})",
                            expectation.refcount,
                            expectation.referenced_paths,
                            expectation.referrer_ids,
                            expectation.soft_deleted_referrer_ids
                        ),
                        actual: format!("{on_disk_path} (referenced by no attachments row)"),
                        owner: "persist_attachment (dedup INSERT arm) / \
                                cleanup_orphaned_attachments (prune arm) — the GC unlinks \
                                bytes whose path no `attachments.fs_path` matches, so these \
                                bytes are about to be destroyed while live rows still \
                                resolve this hash to them",
                    });
                }
            }
        }
    }
    for (hash, expectation) in &expected_blobs {
        if !actual_blobs.contains_key(hash) {
            out.push(Divergence {
                artefact: "attachment_blobs.refcount",
                key: hash.clone(),
                expected: format!(
                    "blob row present (refcount {}, referenced_paths {:?}, referrers {:?}, \
                     of which soft-deleted: {:?})",
                    expectation.refcount,
                    expectation.referenced_paths,
                    expectation.referrer_ids,
                    expectation.soft_deleted_referrer_ids
                ),
                actual: "no blob row".to_owned(),
                owner: "the insert arms — persist_attachment (local ingest), \
                        sync_files::register_received_blob (repointing upsert after a \
                        verified receive), recovery::backfill_attachment_blobs — an \
                        attachments row carries a content_hash with no blob entry, so \
                        the next ingest of those bytes writes a second copy and the \
                        dedup target is lost",
            });
        }
    }

    // --- Artefact 4: blocks.page_id (page OWNERSHIP) -------------------------
    //
    // FIRST of the pages_cache family: the two artefacts below are keyed on
    // this column, so reporting it first names the root cause once instead of
    // reporting its consequences on every affected page.
    let blocks = dump_blocks(pool).await?;
    let expected_ownership = fold_page_ownership(&blocks);
    let stored_ownership: BTreeMap<&str, Option<&str>> = blocks
        .iter()
        .map(|b| (b.id.as_str(), b.page_id.as_deref()))
        .collect();
    for (block_id, expected_owner) in &expected_ownership {
        let Some(actual_owner) = stored_ownership.get(block_id.as_str()) else {
            continue;
        };
        if expected_owner.as_deref() != *actual_owner {
            out.push(Divergence {
                artefact: "blocks.page_id",
                key: block_id.clone(),
                expected: expected_owner
                    .clone()
                    .unwrap_or_else(|| "NULL (no page ancestor via parent_id)".to_owned()),
                actual: actual_owner.map_or_else(|| "NULL".to_owned(), str::to_owned),
                owner: "set_block_page_id_from_parent (the scoped leaf-create arm) / \
                        commands::block_cleanup::rederive_page_and_space_ids (the in-tx \
                        move arm — a MOVE deliberately does NOT enqueue the vault-wide \
                        rebuild, #2200) / cache::rebuild_page_ids (the vault-wide arm \
                        dispatch enqueues for create/delete/restore/purge and inbound \
                        sync) — the denormalised owner disagrees with the parent_id \
                        tree it caches, so every page_id-keyed count, filter and \
                        backlink below it is computed for the wrong page",
            });
        }
    }

    // --- Artefact 3: pages_cache ROW MEMBERSHIP ------------------------------
    let expected_rows = fold_live_page_blocks(&blocks);
    let actual_rows = read_pages_cache_page_ids(pool).await?;
    for page_id in expected_rows.difference(&actual_rows) {
        out.push(Divergence {
            artefact: "pages_cache.row",
            key: page_id.clone(),
            expected: "a cache row (live page block carrying a title)".to_owned(),
            actual: "no row in pages_cache".to_owned(),
            owner: "rebuild_pages_cache (the RebuildPagesCache task — row membership has \
                    NO synchronous per-op arm) — the page is missing from the Pages \
                    list, its title never materialises, and the count arms have no row \
                    to maintain",
        });
    }
    for page_id in actual_rows.difference(&expected_rows) {
        out.push(Divergence {
            artefact: "pages_cache.row",
            key: page_id.clone(),
            expected: "no cache row (the block is not a live page block with a title)".to_owned(),
            actual: "a row in pages_cache".to_owned(),
            owner: "rebuild_pages_cache (its delete-orphans sweep) — a deleted, purged, \
                    demoted or title-cleared page still occupies the Pages list and \
                    still carries counts",
        });
    }

    // --- Artefact 1: pages_cache counts --------------------------------------
    let expected_counts = rebuild_pages_cache_counts_from_base(pool).await?;
    let actual_counts = read_pages_cache_counts(pool).await?;
    for (page_id, expected) in &expected_counts {
        let Some(actual) = actual_counts.get(page_id) else {
            continue;
        };
        if expected.child_block_count != actual.child_block_count {
            out.push(Divergence {
                artefact: "pages_cache.child_block_count",
                key: page_id.clone(),
                expected: expected.child_block_count.to_string(),
                actual: actual.child_block_count.to_string(),
                owner: "maintain_pages_cache_counts_after_op (PreOpState arms for \
                        Create/Edit/Move) + rebuild_pages_cache_counts (the deferred \
                        cohort pass dispatch enqueues for Delete/Restore/Purge)",
            });
        }
        if expected.inbound_link_count != actual.inbound_link_count {
            out.push(Divergence {
                artefact: "pages_cache.inbound_link_count",
                key: page_id.clone(),
                expected: expected.inbound_link_count.to_string(),
                actual: actual.inbound_link_count.to_string(),
                owner: "maintain_pages_cache_counts_after_op (PreOpState arms for \
                        Create/Edit/Move) + rebuild_pages_cache_counts (the deferred \
                        cohort pass dispatch enqueues for Delete/Restore/Purge)",
            });
        }
    }

    // --- Artefact 5: page_link_cache (#3296) ---------------------------------
    //
    // LAST, and after page ownership deliberately: this roll-up is keyed on the
    // same `page_id` the ownership artefact audits, so a drift there would
    // otherwise report twice — once at its root and once as an unexplained
    // link-attribution difference. Reporting it here keeps `first` naming the
    // root cause.
    const PAGE_LINK_OWNER: &str = "reindex_page_link_cache_for_block (the ReindexBlockLinks task — the SOLE \
         per-block writer; NOTHING maintains this roll-up inside apply_op_tx) / \
         rebuild_page_link_cache (the RebuildPageLinkCache task, in the lifecycle + \
         inbound-sync rebuild sets) — and, one level up, the arm of \
         materializer::dispatch::invalidations_for_op that decides whether either \
         task is enqueued at all (#3296): the Graph view and the page-links panel \
         read page_link_cache EXCLUSIVELY, and the read path's lazy rebuild only \
         fires when the table is ENTIRELY empty";
    let expected_links = rebuild_page_link_cache_from_base(pool).await?;
    let actual_links = read_page_link_cache(pool).await?;
    for (key, expected) in &expected_links {
        let label = format!("{} -> {}", key.0, key.1);
        match actual_links.get(key) {
            None => out.push(Divergence {
                artefact: "page_link_cache.row",
                key: label,
                expected: format!("a cache row {expected:?}"),
                actual: "no row in page_link_cache".to_owned(),
                owner: PAGE_LINK_OWNER,
            }),
            Some(actual) if actual != expected => out.push(Divergence {
                artefact: "page_link_cache.edge",
                key: label,
                expected: format!("{expected:?}"),
                actual: format!("{actual:?}"),
                owner: PAGE_LINK_OWNER,
            }),
            Some(_) => {}
        }
    }
    for (key, actual) in &actual_links {
        if !expected_links.contains_key(key) {
            out.push(Divergence {
                artefact: "page_link_cache.row",
                key: format!("{} -> {}", key.0, key.1),
                expected: "no cache row (no live source block on this page links to this \
                           target, or an endpoint block is gone)"
                    .to_owned(),
                actual: format!("a row in page_link_cache {actual:?}"),
                owner: PAGE_LINK_OWNER,
            });
        }
    }

    Ok(out)
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

#[cfg(test)]
mod tests;
