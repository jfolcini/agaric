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
//! | `blocks.page_id` (page OWNERSHIP) | `blocks` | `set_block_page_id_from_parent_in_tx` (create arm) / `rederive_page_and_space_ids` (move arm) / `rebuild_page_ids` (vault-wide arm) |
//! | `pages_cache.{inbound_link_count,child_block_count}` | `blocks`, `block_links` | `maintain_pages_cache_counts_after_op` (sync arms) / `rebuild_pages_cache_counts` (deferred cohort arm) |
//! | `page_link_cache` (the page-level `block_links` roll-up) | `blocks`, `block_links` | `reindex_page_link_cache_for_block` (the `ReindexBlockLinks` task — the SOLE per-block writer) / `rebuild_page_link_cache` (the `RebuildPageLinkCache` task) |
//! | `block_links` ITSELF (#3955) | `blocks` — **`blocks.content`**, not `block_links` | `reindex_block_links_conn` / `reindex_block_links_split` (the ONLY writers; there is no vault-wide rebuild) — audited by [`reconcile_block_links`], NOT by [`reconcile`] |
//! | `block_links_unresolved` (#4229) | `blocks.content` **and** `block_links` | `sync_unresolved_links` (inside both reindex writers) / `rebuild_block_links_unresolved` (the vault-wide arm, #4218; no production caller since #4699) — audited by [`reconcile_block_links_unresolved`], NOT by [`reconcile`] |
//! | `fts_blocks` (#3345) | `blocks` — `content`, `deleted_at`, and the tag/page names the refs resolve to | `update_fts_for_block` / `remove_fts_for_block` / `reindex_fts_references` / `rebuild_fts_index` (the four FTS tasks; NOTHING writes it inside `apply_op_tx`) |
//! | `blocks.space_id` on DERIVED rows (#3345) | `blocks` — `parent_id`, `block_type`, and the owning PAGE's own `space_id` | `maintain_pages_cache_counts_after_op`'s Create arm (in-tx, from the owning page) + `set_block_space_id_from_parent` (the post-commit re-stamp, the space half of the `SetBlockPageId` task) / `project_set_property_to_sql` + `project_delete_property_to_sql` (the in-tx page-group write of a `space` op) / `rederive_page_and_space_ids` (the in-tx move arm) / `rebuild_space_ids` (the vault-wide arm, second half of `RebuildPageIds`) — see [`rebuild_block_space_ids_from_base`] for what "derived" excludes |
//!
//! Deliberately **not** covered here — see the follow-up issues: the agenda
//! cache, the projected-agenda cache, `block_tag_refs` and
//! `tags_cache.usage_count`. All four became reachable in #4679 and are the
//! remaining #3345 artefacts, one PR each.
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
//! # `block_links` used to be a base table with no independent expected side (#3955)
//!
//! Two artefacts above fold `block_links` as GROUND TRUTH, and so does the
//! only vault-wide maintainer that exists (`rebuild_page_link_cache_impl`
//! reads `FROM block_links bl` — it rolls *up from* the table and never
//! re-parses content). A wrong row in `block_links` therefore produced a
//! CONSISTENT wrong answer on both sides of every diff above: the divergence
//! was not merely unlikely to be generated, it was arithmetically impossible
//! for [`reconcile`] to express. #3903 — the pushed-down cross-space filter
//! dropping same-space links whose target `space_id` was not yet stamped — is
//! exactly that shape, and every oracle run stayed green throughout.
//!
//! [`reconcile_block_links`] closes it the way #3654 closed the same class for
//! `blocks.page_id`: by auditing the table against an INDEPENDENT source —
//! here the link tokens in `blocks.content`, resolved by a Rust transcription
//! of `reindex_block_links`' rules — rather than against a derivation that
//! already trusts it.
//!
//! It is a SEPARATE entry point, deliberately **not** folded into
//! [`reconcile`]. See [`reconcile_block_links`] for the lane decision and for
//! the two eventual-consistency windows that make it a triaged deep check
//! rather than a per-op gate.
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
use std::sync::LazyLock;

use agaric_core::error::AppError;
use regex::Regex;
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
    ///
    /// #3955: it is also the INDEPENDENT source for `block_links` — the
    /// `[[ULID]]` / `((ULID))` tokens the reindexer parses out of it are the
    /// only thing in the schema that says what that table's rows must be.
    content: Option<String>,
    /// `None` = live. `blocks.deleted_at` is epoch-ms INTEGER (migration 0080).
    deleted_at: Option<i64>,
    /// The denormalised space membership (migration 0086, re-pointed at the
    /// `spaces` registry by 0089). NULL until `SetBlockPageId`'s
    /// `set_block_space_id_from_parent` stamps it post-commit — which is the
    /// whole reason `block_links`' cross-space filter needs the owning-page
    /// fallback (#3903), and therefore why this column is dumped at all.
    space_id: Option<String>,
    /// The promoted `due_date` property (migration 0012), a `YYYY-MM-DD` TEXT
    /// column. One of `agenda_cache`'s four upstreams.
    due_date: Option<String>,
    /// The promoted `scheduled_date` property (migration 0013). Same shape and
    /// role as `due_date`, at a lower agenda precedence.
    scheduled_date: Option<String>,
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
    Option<String>,
    Option<String>,
    Option<String>,
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
        "SELECT id, parent_id, page_id, block_type, content, deleted_at, space_id, due_date, \
         scheduled_date FROM blocks",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                parent_id,
                page_id,
                block_type,
                content,
                deleted_at,
                space_id,
                due_date,
                scheduled_date,
            )| BaseBlock {
                id,
                parent_id,
                page_id,
                block_type,
                content,
                deleted_at,
                space_id,
                due_date,
                scheduled_date,
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
/// `agaric_store::block_descendants::rederive_page_and_space_ids`. A driver that
/// re-derived after every op would therefore repair exactly the arm most
/// likely to be wrong, so callers run this only where production does.
pub async fn settle_derived_page_ids(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_page_ids(pool).await
}

// ---------------------------------------------------------------------------
// Artefact 9 — `blocks.space_id` on DERIVED rows (#3345, reachable since #4679)
// ---------------------------------------------------------------------------

/// What the from-base fold says one derived block's `space_id` must be, and
/// which page it derived it from — so a divergence can name the page whose
/// authoritative value the block was supposed to inherit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedSpace {
    /// The nearest page ancestor, by `parent_id` walk.
    pub owning_page: String,
    /// That page's own `space_id` column — `None` when the page carries none.
    pub space_id: Option<String>,
}

/// Recompute `blocks.space_id` for every block whose value is DERIVED, from
/// `parent_id`, `block_type` and the owning page's own column alone.
///
/// The rule is the one all four production writers share, transcribed from
/// the column's semantics (#533 Phase 2) rather than from any of their SQL: a
/// page's `space_id` is authoritative (only a `space` op writes it), and every
/// non-page block under that page carries a COPY of it. The owning page is the
/// nearest page ancestor by `parent_id` — [`fold_page_ownership`]'s walk, NOT
/// the stored `page_id` column, so a `page_id` drift cannot make both sides of
/// this diff agree on a wrong page; [`reconcile`] reports `blocks.page_id`
/// first so such a drift is named once, at its root.
///
/// # What is OUT of scope, and why it is not a gap in the fold
///
/// * **Pages** — authoritative, not derived: no base table says what a page's
///   space is except the column itself.
/// * **Top-level tags and orphans** (no page ancestor) — `rebuild_space_ids`'s
///   `page_id IS NOT NULL` guard leaves them untouched because a tag OWNS its
///   value (nulling it was the #533 data-loss hazard) and orphan content
///   "keeps its last value". The latter is history, not a function of base
///   tables, so no from-base rebuild can express it; the fold omits the row
///   rather than guess.
///
/// # Tombstones are IN scope
///
/// None of the writers filters on `deleted_at` — `rederive_page_and_space_ids`
/// dropped its filter in #3919 precisely because ownership is structural — and
/// the space-scoped trash list reads a soft-deleted row's `space_id` live. So a
/// tombstoned block is expected to carry its page's space exactly as a live one
/// is, and this fold walks tombstones like any other row.
///
/// # What the fold shares with production
///
/// The `parent_id` walk is [`fold_page_ownership`]'s, already the independent
/// side of Artefact 4. Nothing else: no `COALESCE`, no correlated subquery, no
/// `page_id` read. `set_block_space_id_from_parent` copies the PARENT's column
/// rather than the page's; the two agree whenever the parent is itself settled,
/// and the fold deliberately asks the page so a parent stamped wrong is
/// reported at the child too rather than inherited silently.
fn fold_block_space_ids(blocks: &[BaseBlock]) -> BTreeMap<String, DerivedSpace> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let mut out = BTreeMap::new();
    for (block_id, owner) in fold_page_ownership(blocks) {
        let Some(owning_page) = owner else {
            continue;
        };
        // Both lookups are total: `fold_page_ownership` keys on every block in
        // `blocks` and resolves each owner by walking `parent_id` THROUGH that
        // same slice, and `by_id` is built from it. An absent key would mean
        // the two disagreed about the dump, so say so rather than skipping the
        // row — a silent `continue` there would shrink what the artefact
        // audits without reporting anything.
        let block = by_id[block_id.as_str()];
        if block.block_type == PAGE_BLOCK_TYPE {
            continue;
        }
        let page = by_id[owning_page.as_str()];
        out.insert(
            block_id,
            DerivedSpace {
                owning_page,
                space_id: page.space_id.clone(),
            },
        );
    }
    out
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
///   `true` when that page is soft-deleted. A source page that does not exist
///   at all yields NO row (#3894): `source_page_id` is `NOT NULL REFERENCES
///   blocks(id)` with foreign keys ON, so such a row is unstorable and the
///   writers' `EXISTS` guard skips the group;
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
        // A source page that is ABSENT from `blocks` yields no row at all
        // (#3894). Not a rule borrowed from the writers — it is forced by the
        // schema: `page_link_cache.source_page_id` is `NOT NULL REFERENCES
        // blocks(id)` (0065) and foreign keys are ON, so a row keyed on an id
        // that is not in `blocks` is UNSTORABLE. The writers' `EXISTS` guard
        // skips exactly these groups for that reason (before it, they raised
        // instead — either way the row cannot exist), so folding one here
        // would report a permanent, unfixable divergence on any vault
        // carrying a dangling `page_id` / `parent_id` from a historical
        // `foreign_keys = OFF` window. A source page that EXISTS but is
        // soft-deleted still yields a row, flagged.
        let Some(source_page_block) = by_id.get(source_page.as_str()) else {
            continue;
        };
        let src_deleted = source_page_block.deleted_at.is_some();

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

// ---------------------------------------------------------------------------
// Artefact 6 — `block_links` ITSELF, re-derived from block CONTENT (#3955)
// ---------------------------------------------------------------------------

/// The `[[ULID]]` / `((ULID))` link-token grammar — **transcribed**, not
/// borrowed from `agaric_store::cache::ULID_LINK_RE`.
///
/// This is the one place the independence claim is weakest and it is stated
/// rather than hidden: the token grammar IS the specification of what a link
/// is, so a second copy of it cannot be "derived from first principles" the
/// way an aggregate can. What the transcription buys is that production cannot
/// change the grammar and take the oracle with it silently — a widened
/// production regex reddens this artefact until someone updates this literal
/// DELIBERATELY. `oracle_link_grammar_matches_production_3955` in `tests.rs`
/// pins the two against a corpus so that drift is a named test failure rather
/// than a wave of unexplained divergences.
///
/// Crockford base-32, exactly 26 uppercase alphanumerics; mixed delimiters
/// (`[[ULID))`) match, exactly as production's does.
static ORACLE_LINK_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\[\[|\(\()([0-9A-Z]{26})(?:\]\]|\)\))").expect("invalid oracle link regex")
});

/// The distinct link targets one block's content names.
///
/// # One deliberate departure from production's read
///
/// `reindex_block_links_conn` reads `SELECT content FROM blocks WHERE id = ?
/// AND deleted_at IS NULL` and treats a missing row as empty content, so its
/// rule for a TOMBSTONED source is "every outbound row must go". This fold
/// reads the raw `content` column instead, with no liveness scope.
///
/// That single difference is what keeps the EXTRA arm of
/// [`reconcile_block_links`] usable: no delete arm enqueues
/// `ReindexBlockLinks` (only `CreateBlock` and `EditBlock` do), so a
/// soft-deleted block's rows survive by design — `rebuild_page_link_cache`
/// excludes them at ROLL-UP time with its own `WHERE sb.deleted_at IS NULL`
/// rather than expecting them to be gone. Transcribing production's
/// live-scoped read here would therefore report every ordinary block deletion
/// as a pile of EXTRA rows, and an oracle that fires on every delete gets
/// muted. `block_links_oracle_leaves_the_unreindexed_windows_alone_3955` pins
/// this: restoring the live scope reddens it.
///
/// A NULL content column still means "no tokens" — hence `unwrap_or_default`
/// rather than an early return.
fn fold_content_link_targets(content: Option<&str>) -> BTreeSet<String> {
    ORACLE_LINK_TOKEN_RE
        .captures_iter(content.unwrap_or_default())
        .map(|cap| cap[1].to_owned())
        .collect()
}

/// Resolve one block's space, folded in Rust from the `blocks` dump.
///
/// Transcribed from `agaric_store::space::resolve_block_space` (#533 Phase 2):
///
/// ```sql
/// SELECT COALESCE(b.space_id, p.space_id)
///   FROM blocks b
///   LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
///  WHERE b.id = ?1 AND b.deleted_at IS NULL
/// ```
///
/// Every term is load-bearing and every one of them is the reason #3903
/// existed, so none of it is optional:
///
/// * the INPUT block must be live — a tombstone resolves to `None` (invariant
///   #9);
/// * its OWN `space_id` wins when present;
/// * otherwise the OWNING PAGE's `space_id` is the fallback, and that page
///   must itself be live (the `LEFT JOIN` predicate) — this is the term the
///   pre-#3894 target-side subquery omitted, so a target inside the
///   `SetBlockPageId` stamping window resolved `NULL`, `NULL = ?3` was falsy,
///   and a legitimate SAME-space link was dropped;
/// * a `page_id` pointing at a row that is not in `blocks` yields `None` (the
///   `LEFT JOIN` produces no match).
///
/// Post-#3894 both sides of production's filter use this shape — the source by
/// CALLING `resolve_block_space`, the target through a mirrored subquery. The
/// oracle uses one fold for both, which is what makes the asymmetry #3903 was
/// about expressible: production having two copies is exactly how they drifted.
fn fold_block_space(by_id: &BTreeMap<&str, &BaseBlock>, block_id: &str) -> Option<String> {
    let block = by_id.get(block_id)?;
    if block.deleted_at.is_some() {
        return None;
    }
    if let Some(own) = block.space_id.as_deref() {
        return Some(own.to_owned());
    }
    let page = by_id.get(block.page_id.as_deref()?)?;
    if page.deleted_at.is_some() {
        return None;
    }
    page.space_id.clone()
}

/// Recompute the whole `block_links` edge set from `blocks.content` alone.
///
/// The rules are `reindex_block_links_conn`'s INSERT rules, transcribed:
///
/// * the SOURCE block must be live — a tombstoned source reads as empty
///   content and contributes nothing;
/// * a candidate target is a distinct `[[ULID]]` / `((ULID))` token in that
///   content (self-links included: nothing excludes `source == target`);
/// * the TARGET must EXIST in `blocks` and be live (the `WHERE EXISTS
///   (SELECT 1 FROM blocks WHERE id = je.value AND deleted_at IS NULL)`
///   guard — the FK is not relied on, and invariant #9 keeps tombstones out);
/// * the cross-space filter: when the source's resolved space is `NULL` every
///   target passes (`?3 IS NULL`); otherwise the target's resolved space must
///   EQUAL it, with an unresolvable target space (`NULL = ?3` → falsy) dropped.
///
/// Folded in Rust over ONE flat `blocks` dump. Nothing is pushed into SQLite —
/// in particular the space resolution is [`fold_block_space`], not a
/// re-expression of production's correlated subquery, because that subquery is
/// precisely what was wrong in #3903.
///
/// # What this does NOT claim
///
/// It re-derives what the writers WOULD insert against the CURRENT state of
/// `blocks`. It is not a claim that production ever recomputes this set: there
/// is no vault-wide `rebuild_block_links` (the one wholesale wipe of it went
/// with the snapshot restore, #4699), and the per-block reindexer is a
/// DIFF driven by content change alone. The gap between the two is real and is
/// enumerated on [`reconcile_block_links`].
pub async fn rebuild_block_links_from_content(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, AppError> {
    Ok(fold_block_links_from_content(&dump_blocks(pool).await?))
}

fn fold_block_links_from_content(blocks: &[BaseBlock]) -> BTreeSet<(String, String)> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut out = BTreeSet::new();
    for source in blocks {
        if source.deleted_at.is_some() {
            continue;
        }
        let targets = fold_content_link_targets(source.content.as_deref());
        if targets.is_empty() {
            continue;
        }
        let source_space = fold_block_space(&by_id, &source.id);
        for target_id in targets {
            let Some(target) = by_id.get(target_id.as_str()) else {
                continue;
            };
            if target.deleted_at.is_some() {
                continue;
            }
            if let Some(space) = source_space.as_deref()
                && fold_block_space(&by_id, &target_id).as_deref() != Some(space)
            {
                continue;
            }
            out.insert((source.id.clone(), target_id));
        }
    }
    out
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

/// The maintenance site that owns every `block_links` divergence — there is
/// exactly one pair of writers and no vault-wide repair behind them.
const BLOCK_LINKS_OWNER: &str = "reindex_block_links_conn (the single-pool writer, called both by the \
     ReindexBlockLinks task and IN-TRANSACTION by agaric-engine's \
     maintain_pages_cache_counts_after_op) / reindex_block_links_split (the \
     read/write-split writer) — one level up, the arm of \
     materializer::dispatch::invalidations_for_op that enqueues \
     ReindexBlockLinks at all (only CreateBlock and EditBlock do) — plus \
     recovery::cache_refresh's draft-recovery path, which enqueues it \
     directly. There is still NO vault-wide rebuild_block_links: \
     the one wholesale wipe of it went with the snapshot restore (#4699), \
     and every other link artefact (pages_cache.inbound_link_count, \
     page_link_cache) folds this table as ground truth, so a loss here is \
     consistent on both sides of their diffs and invisible to reconcile(). \
     Since #4118 the SOURCE-triggered writer is no longer the only path back: \
     a token the INSERT declines is recorded in block_links_unresolved, keyed \
     by target, and the ReindexBlockLinks handler re-links those referrers when \
     the target itself is reindexed (create, edit, or the SetBlockPageId \
     page/space stamp). A row lost BEFORE that landed is still lost — the \
     unresolved index is populated by the reindexes that run after the \
     upgrade, not backfilled";

/// Diff `block_links` against a from-CONTENT rebuild — the artefact that makes
/// a base table auditable (#3955).
///
/// # Why this is separate from [`reconcile`], and which lane it runs in
///
/// **Lane: the scheduled deep-checks lane / directed drivers — NOT the per-op
/// `reconcile` path.** Three reasons, in increasing order of importance:
///
/// 1. **Cost.** Every other rebuild here folds columns; this one runs a regex
///    over every block's full content. [`reconcile`] is called after EVERY op
///    of EVERY generated chain in `apply_reproject_proptest`'s B6 property, so
///    the re-parse would be paid O(cases × ops × vault-bytes) times on the
///    per-PR gate for a check whose failures need triage anyway.
/// 2. **`reconcile`'s own fixtures write `block_links` rows directly**, with
///    no matching content token — that is the whole point of
///    `insert_block_link` in `tests.rs`, which models the in-tx arm writing an
///    edge that no background maintainer has rolled up yet. Folding this
///    artefact into `reconcile` would report every one of those as an EXTRA
///    row, i.e. it would break the roll-up artefact's fixtures for a reason
///    that is not a defect.
/// 3. **The two windows below are triage, not a gate.** They are real
///    permanent-loss shapes of the #3903 family, so they must NOT be
///    suppressed — but a per-PR gate that reddens on them would get muted, and
///    a muted oracle is worse than the blind spot it replaced.
///
/// # The two windows this artefact deliberately does not close
///
/// Production's writer is a DIFF driven by ONE trigger — a change to the
/// source block's content. Nothing re-runs it when the world around the source
/// changes. So the from-content rebuild and the stored table can legitimately
/// disagree in two directions, and each arm below is scoped to the rule the
/// writer actually implements:
///
/// * **MISSING** (expected edge, no row). Sound for the shape it exists to
///   catch — the insert-time filter dropping an edge it should have kept
///   (#3903). It CAN also fire when the target only became linkable after the
///   source's last reindex: the target was created later, or its `space_id`
///   was stamped later. #4118 closed that as an ONGOING loss — the declined
///   token is recorded in `block_links_unresolved` and the referrer is
///   re-linked when the target is next reindexed — but the arm can still fire
///   on a vault that carries such losses from BEFORE that landed (the
///   unresolved index is populated by subsequent reindexes, not backfilled),
///   and transiently in the window between the target becoming linkable and
///   the referrer's repair draining. Those are findings to triage, not a
///   regression signal, which is what keeps this artefact in a scheduled lane.
/// * **EXTRA** (row, no token). Scoped to production's DELETE rule: the writer
///   deletes `old_targets - parsed_tokens`, with NO existence and NO space
///   predicate. So a row is EXTRA only when its source's `content` column
///   names no such token. Rows whose target has since been soft-deleted, or
///   has since moved space, are NOT reported: production never re-evaluates
///   them, `rebuild_page_link_cache` is built to carry them (it flags
///   `tgt_deleted` rather than dropping the edge), and reporting them would
///   make this artefact fire on every ordinary block deletion. Rows under a
///   soft-deleted SOURCE fall out for the same reason, via the one deliberate
///   departure documented on [`fold_content_link_targets`]: the token read is
///   NOT liveness-scoped the way production's is.
///
/// A row whose token is present but whose target is now dead or cross-space
/// therefore satisfies neither arm — that gap is the window, and it is stated
/// here rather than papered over.
///
/// Divergences come back MISSING-first, each arm sorted by `(source, target)`,
/// so `first` is deterministic.
pub async fn reconcile_block_links(pool: &SqlitePool) -> Result<Vec<Divergence>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let expected = fold_block_links_from_content(&blocks);
    let stored: BTreeSet<(String, String)> = dump_block_links(pool).await?.into_iter().collect();

    let mut out = Vec::new();

    // --- MISSING: content says the edge exists, the table does not ----------
    for (source_id, target_id) in expected.difference(&stored) {
        let source_space = fold_block_space(&by_id, source_id);
        out.push(Divergence {
            artefact: "block_links.row",
            key: format!("{source_id} -> {target_id}"),
            expected: format!(
                "a block_links row: the live source's content carries the token, the \
                 target exists and is live, and both resolve to space {} (source) / {} \
                 (target)",
                source_space.as_deref().unwrap_or("NULL"),
                fold_block_space(&by_id, target_id)
                    .as_deref()
                    .unwrap_or("NULL"),
            ),
            actual: "no row in block_links".to_owned(),
            owner: BLOCK_LINKS_OWNER,
        });
    }

    // --- EXTRA: the table holds an edge the source's content never named ---
    for (source_id, target_id) in &stored {
        let Some(source) = by_id.get(source_id.as_str()) else {
            // Unstorable: `block_links.source_id` is `NOT NULL REFERENCES
            // blocks(id) ON DELETE CASCADE` (migration 0061) with foreign keys
            // ON, so a purge takes the row with it. Skipped for the same
            // reason `rebuild_page_link_cache_from_base` skips an absent
            // source page: folding a divergence here would report a
            // permanent, unfixable one on any vault carrying rows from a
            // historical `foreign_keys = OFF` window.
            continue;
        };
        // Deliberately UNSCOPED by liveness — see `fold_content_link_targets`.
        // A tombstoned source keeps its rows (no delete arm reindexes), so
        // reading the raw `content` column rather than production's
        // `WHERE deleted_at IS NULL` read is what stops this arm firing on
        // every ordinary block deletion. An explicit `deleted_at` skip here
        // would be dead code: a soft delete does not touch `content`, so the
        // tokens are still there and this `contains` already skips the row —
        // verified by deleting the skip and watching
        // `block_links_oracle_leaves_the_unreindexed_windows_alone_3955` stay
        // GREEN. What that test DOES falsify is the departure itself: scope
        // this read by liveness and it reddens.
        if fold_content_link_targets(source.content.as_deref()).contains(target_id) {
            continue;
        }
        out.push(Divergence {
            artefact: "block_links.row",
            key: format!("{source_id} -> {target_id}"),
            expected: "no block_links row (the source block's content column names no \
                       such [[ULID]] / ((ULID)) token, so the reindexer's DELETE arm — \
                       old_targets MINUS parsed tokens — must have removed it)"
                .to_owned(),
            actual: "a row in block_links".to_owned(),
            owner: BLOCK_LINKS_OWNER,
        });
    }

    Ok(out)
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

// ---------------------------------------------------------------------------
// Artefact 8 — `block_tag_refs`, the INLINE tag index (#3345)
// ---------------------------------------------------------------------------

/// Transcribed from `agaric_store::cache::TAG_REF_RE` DELIBERATELY, on the same
/// grounds as [`ORACLE_LINK_TOKEN_RE`]: an independent copy is what makes this
/// artefact a recomputation rather than a tautology.
/// `oracle_tag_grammar_matches_production_3345` pins the two against a corpus,
/// so drift is a named failure and not a wave of unexplained divergences.
///
/// Unlike the link grammar there are no mixed delimiters to tolerate —
/// production's regex is anchored on both sides.
static ORACLE_TAG_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[([0-9A-Z]{26})\]").expect("invalid oracle tag-ref regex"));

/// The distinct inline tag targets one block's content names.
///
/// # The same deliberate departure [`fold_content_link_targets`] makes
///
/// `reindex_block_tag_refs_in_tx` reads `SELECT content FROM blocks WHERE id = ?
/// AND deleted_at IS NULL` and treats a missing row as empty content, so its
/// rule for a TOMBSTONED source is "every row must go". This fold reads the raw
/// `content` column with no liveness scope, for the identical reason:
/// `ReindexBlockTagRefs` is enqueued by the `CreateBlock` and `EditBlock` arms
/// of `invalidations_for_op` and by NOTHING else, so a soft-deleted block's
/// rows survive by design. Transcribing production's live-scoped read would
/// report every ordinary deletion as a pile of EXTRA rows, and an oracle that
/// fires on every delete gets muted.
fn fold_content_tag_targets(content: Option<&str>) -> BTreeSet<String> {
    ORACLE_TAG_TOKEN_RE
        .captures_iter(content.unwrap_or_default())
        .map(|cap| cap[1].to_owned())
        .collect()
}

/// `block_tag_refs` folded from `blocks.content` — the only thing in the schema
/// that says what those rows must be.
pub async fn rebuild_block_tag_refs_from_content(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, AppError> {
    Ok(fold_block_tag_refs_from_content(&dump_blocks(pool).await?))
}

fn fold_block_tag_refs_from_content(blocks: &[BaseBlock]) -> BTreeSet<(String, String)> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut out = BTreeSet::new();
    for source in blocks {
        if source.deleted_at.is_some() {
            continue;
        }
        let targets = fold_content_tag_targets(source.content.as_deref());
        if targets.is_empty() {
            continue;
        }
        let source_space = fold_block_space(&by_id, &source.id);
        for tag_id in targets {
            let Some(tag) = by_id.get(tag_id.as_str()) else {
                continue;
            };
            // `WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ? AND
            // block_type = 'tag' AND deleted_at IS NULL)`: a `#[ULID]` naming a
            // page, a content block, or nothing at all is not an edge.
            if tag.block_type != "tag" || tag.deleted_at.is_some() {
                continue;
            }
            // ASYMMETRIC, and deliberately so. The INSERT resolves the SOURCE's
            // space through `resolve_block_space` (own column, else the owning
            // page's) and compares it against the TAG's RAW `blocks.space_id`,
            // with no owning-page fallback on that side. Folding the fallback
            // in symmetrically would make this oracle agree with a production
            // that does not behave that way.
            if let Some(space) = source_space.as_deref()
                && tag.space_id.as_deref() != Some(space)
            {
                continue;
            }
            out.insert((source.id.clone(), tag_id));
        }
    }
    out
}

async fn dump_block_tag_refs(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    const SQL: &str = "SELECT source_id, tag_id FROM block_tag_refs";
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

const BLOCK_TAG_REFS_OWNER: &str = "reindex_block_tag_refs(_in_tx/_split/_split_in_tx) and the \
     vault-wide rebuild_block_tag_refs_cache (the ReindexBlockTagRefs and \
     RebuildBlockTagRefsCache tasks) — and, one level up, the arms of \
     materializer::dispatch::invalidations_for_op that enqueue them, which are \
     CreateBlock and EditBlock and nothing else: the tags view and the tag_query \
     resolver UNION this table with block_tags, so a missing row is a tag whose \
     inline usages the user cannot see";

/// `block_tag_refs` against a from-CONTENT rebuild.
///
/// Same two arms, and the same window, as [`reconcile_block_links`]: the
/// MISSING arm folds LIVE sources only, while the EXTRA arm re-reads the raw
/// `content` column so a tombstoned source's surviving rows — which no delete
/// arm reindexes away — are not reported. See [`fold_content_tag_targets`].
///
/// Divergences come back MISSING-first, each arm sorted by `(source, tag)`, so
/// `first` is deterministic.
pub async fn reconcile_block_tag_refs(pool: &SqlitePool) -> Result<Vec<Divergence>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let expected = fold_block_tag_refs_from_content(&blocks);
    let stored: BTreeSet<(String, String)> = dump_block_tag_refs(pool).await?.into_iter().collect();

    let mut out = Vec::new();

    // --- MISSING: content names the tag, the table has no row ---------------
    for (source_id, tag_id) in expected.difference(&stored) {
        let source_space = fold_block_space(&by_id, source_id);
        out.push(Divergence {
            artefact: "block_tag_refs.row",
            key: format!("{source_id} -> {tag_id}"),
            expected: format!(
                "a block_tag_refs row (the source's content names `#[{tag_id}]`, that id is \
                 a live tag block, and the source's resolved space is {source_space:?})"
            ),
            actual: "no row in block_tag_refs".to_owned(),
            owner: BLOCK_TAG_REFS_OWNER,
        });
    }

    // --- EXTRA: the table holds a row the source's content never named ------
    for (source_id, tag_id) in &stored {
        let Some(source) = by_id.get(source_id.as_str()) else {
            // Unstorable: `block_tag_refs.source_id` is `NOT NULL REFERENCES
            // blocks(id) ON DELETE CASCADE` (migration 0034) with foreign keys
            // ON, so a purge takes the row with it. Skipped for the same reason
            // the block_links EXTRA arm skips an absent source.
            continue;
        };
        // Deliberately UNSCOPED by liveness — see `fold_content_tag_targets`.
        // A soft delete does not touch `content`, so a tombstoned source's
        // tokens are still here and this `contains` skips its rows.
        if fold_content_tag_targets(source.content.as_deref()).contains(tag_id) {
            continue;
        }
        out.push(Divergence {
            artefact: "block_tag_refs.row",
            key: format!("{source_id} -> {tag_id}"),
            expected: "no block_tag_refs row (the source block's content column names no \
                       such `#[ULID]` token, so the reindexer's DELETE arm — old_targets \
                       MINUS parsed tokens — must have removed it)"
                .to_owned(),
            actual: "a row in block_tag_refs".to_owned(),
            owner: BLOCK_TAG_REFS_OWNER,
        });
    }

    Ok(out)
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

// ---------------------------------------------------------------------------
// Artefact 9 — `tags_cache`, the tag roll-up (#3345)
// ---------------------------------------------------------------------------

/// One `tags_cache` row's derived content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedTagRow {
    /// The surviving tag's raw `blocks.content` — production selects the
    /// column, not the normalised key.
    pub name: String,
    /// Distinct LIVE source blocks referencing this tag, explicitly or inline.
    pub usage_count: i64,
}

async fn dump_block_tags(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    const SQL: &str = "SELECT block_id, tag_id FROM block_tags";
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

async fn dump_tags_cache(pool: &SqlitePool) -> Result<BTreeMap<String, DerivedTagRow>, AppError> {
    const SQL: &str = "SELECT tag_id, name, usage_count FROM tags_cache";
    // dynamic-sql: static SQL, test-only oracle read-back.
    let rows = sqlx::query_as::<_, (String, String, i64)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(tag_id, name, usage_count)| (tag_id, DerivedTagRow { name, usage_count }))
        .collect())
}

/// `tags_cache` folded from base rows.
///
/// Transcribed from `DESIRED_TAGS_SQL` (`agaric-store/src/cache/tags.rs`) plus
/// the Rust-side dedup that runs after it, folded here rather than re-expressed
/// as SQL so this is an independent recomputation:
///
///   * a row exists per LIVE `block_type = 'tag'` block with NON-NULL content —
///     a NULL-content tag gets no row at all;
///   * `usage_count` is `COUNT(*)` over the `UNION` (not `UNION ALL`, so
///     DISTINCT) of `block_tags` and `block_tag_refs`, each arm keeping only
///     pairs whose SOURCE block is live. A tag with no usages still gets a row,
///     via the `LEFT JOIN` + `COALESCE(…, 0)`;
///   * duplicate names collapse (#626): `tags_cache.name` is UNIQUE but
///     `blocks.content` is not, so among live tags sharing a name only the
///     SMALLEST `id` survives. Identity is
///     [`agaric_core::tag_norm::normalize_tag_name`] — NFC → full-Unicode
///     lowercase → NFC — and NOT `COLLATE NOCASE`, which folds ASCII only and
///     split non-ASCII case-variants the sync engine had already merged
///     (#1990).
///
/// `block_tag_refs` is read as STORED rather than re-derived from content.
/// It is audited by Artefact 8, so each artefact checks one derivation step and
/// a stale inline-ref row is reported against the table that owns it instead of
/// being misattributed to this roll-up.
pub async fn rebuild_tags_cache_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, DerivedTagRow>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let explicit = dump_block_tags(pool).await?;
    let inline = dump_block_tag_refs(pool).await?;
    Ok(fold_tags_cache_from_base(&blocks, &explicit, &inline))
}

fn fold_tags_cache_from_base(
    blocks: &[BaseBlock],
    explicit: &[(String, String)],
    inline: &[(String, String)],
) -> BTreeMap<String, DerivedTagRow> {
    let live: BTreeSet<&str> = blocks
        .iter()
        .filter(|b| b.deleted_at.is_none())
        .map(|b| b.id.as_str())
        .collect();

    // Distinct (tag, source) pairs from both arms, source-liveness enforced —
    // the `UNION`'s dedup and each arm's `JOIN blocks … WHERE deleted_at IS
    // NULL`.
    let mut usages: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for (source_id, tag_id) in explicit
        .iter()
        .map(|(block_id, tag_id)| (block_id.as_str(), tag_id.as_str()))
        .chain(
            inline
                .iter()
                .map(|(source_id, tag_id)| (source_id.as_str(), tag_id.as_str())),
        )
    {
        if !live.contains(source_id) {
            continue;
        }
        usages.entry(tag_id).or_default().insert(source_id);
    }

    // Survivors: smallest id per normalised name, among live named tags. The
    // content travels WITH the winner: recovering it afterwards would need a
    // fallback for the NULL the `else { continue }` above already excluded, and
    // that fallback would assert `name: ""` instead of failing.
    let mut winner_by_norm: BTreeMap<String, (&str, &str)> = BTreeMap::new();
    for tag in blocks
        .iter()
        .filter(|b| b.block_type == "tag" && b.deleted_at.is_none())
    {
        let Some(content) = tag.content.as_deref() else {
            continue;
        };
        let key = agaric_core::tag_norm::normalize_tag_name(content);
        winner_by_norm
            .entry(key)
            .and_modify(|held| {
                if tag.id.as_str() < held.0 {
                    *held = (tag.id.as_str(), content);
                }
            })
            .or_insert((tag.id.as_str(), content));
    }

    winner_by_norm
        .into_values()
        .map(|(id, content)| {
            let usage_count = usages.get(id).map_or(0, |sources| {
                i64::try_from(sources.len()).unwrap_or(i64::MAX)
            });
            (
                id.to_owned(),
                DerivedTagRow {
                    name: content.to_owned(),
                    usage_count,
                },
            )
        })
        .collect()
}

const TAGS_CACHE_OWNER: &str = "rebuild_tags_cache(_split) and refresh_tag_usage_count (the \
     RebuildTagsCache and RefreshTagUsageCount tasks) — and, one level up, the arms of \
     materializer::dispatch::invalidations_for_op that enqueue them: the tags view reads \
     usage_count directly, and tag_query resolves a name through this table, so a wrong \
     count is a wrong number on screen and a missing row is a tag the resolver cannot find";

/// `tags_cache` against a from-base rebuild, in both directions.
pub async fn reconcile_tags_cache(pool: &SqlitePool) -> Result<Vec<Divergence>, AppError> {
    let expected = rebuild_tags_cache_from_base(pool).await?;
    let stored = dump_tags_cache(pool).await?;

    let mut out = Vec::new();

    for (tag_id, want) in &expected {
        match stored.get(tag_id) {
            None => out.push(Divergence {
                artefact: "tags_cache.row",
                key: tag_id.clone(),
                expected: format!("a row {want:?}"),
                actual: "no row in tags_cache — the tag is unresolvable by name".to_owned(),
                owner: TAGS_CACHE_OWNER,
            }),
            Some(got) if got.name != want.name => out.push(Divergence {
                artefact: "tags_cache.name",
                key: tag_id.clone(),
                expected: format!("{:?}", want.name),
                actual: format!("{:?}", got.name),
                owner: TAGS_CACHE_OWNER,
            }),
            Some(got) if got.usage_count != want.usage_count => out.push(Divergence {
                artefact: "tags_cache.usage_count",
                key: tag_id.clone(),
                expected: format!(
                    "{} distinct live source block(s) across block_tags ∪ block_tag_refs",
                    want.usage_count
                ),
                actual: format!("{}", got.usage_count),
                owner: TAGS_CACHE_OWNER,
            }),
            Some(_) => {}
        }
    }

    for tag_id in stored.keys() {
        if expected.contains_key(tag_id) {
            continue;
        }
        out.push(Divergence {
            artefact: "tags_cache.row",
            key: tag_id.clone(),
            expected: "no row (the tag is deleted, has NULL content, or lost the #626 \
                       duplicate-name tie-break to a smaller id)"
                .to_owned(),
            actual: "a row in tags_cache".to_owned(),
            owner: TAGS_CACHE_OWNER,
        });
    }

    Ok(out)
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

// ---------------------------------------------------------------------------
// Artefact 10 — `agenda_cache`, the date roll-up (#3345)
// ---------------------------------------------------------------------------

/// One `block_properties` row, reduced to the columns the agenda reads.
#[derive(Debug, Clone)]
struct BaseProperty {
    block_id: String,
    key: String,
    /// The typed date sidecar. NON-NULL is what promotes a property to an
    /// agenda source; the untyped `value` column is never consulted.
    value_date: Option<String>,
}

async fn dump_block_properties(pool: &SqlitePool) -> Result<Vec<BaseProperty>, AppError> {
    const SQL: &str = "SELECT block_id, key, value_date FROM block_properties";
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String, Option<String>)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(block_id, key, value_date)| BaseProperty {
            block_id,
            key,
            value_date,
        })
        .collect())
}

/// Every `agenda_cache` row, keyed by its `(date, block_id)` primary key.
async fn dump_agenda_cache(
    pool: &SqlitePool,
) -> Result<BTreeMap<(String, String), String>, AppError> {
    const SQL: &str = "SELECT date, block_id, source FROM agenda_cache";
    // dynamic-sql: static SQL, test-only oracle read-back.
    let rows = sqlx::query_as::<_, (String, String, String)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(date, block_id, source)| ((date, block_id), source))
        .collect())
}

/// The date carried by a `date/YYYY-MM-DD` tag, or `None` if the content is not
/// one.
///
/// Transcribed from the second arm's grammar in `DESIRED_AGENDA_SQL`. Two
/// SQLite semantics a naive Rust reading gets wrong:
///
///   * `LIKE 'date/%'` is ASCII case-INSENSITIVE — `case_sensitive_like` is
///     never set on these connections — so `DATE/2026-01-01` IS a date tag and
///     does produce an agenda row;
///   * `GLOB '[0-9]'` is ASCII-only, so the digit test is `is_ascii_digit`, not
///     `char::is_numeric`, which also accepts `٣` and `３`.
///
/// `LENGTH()` counts characters rather than bytes, and this counts `chars()` to
/// match, but the two readings cannot actually disagree on the ANSWER: the
/// GLOBs pin all ten trailing positions to ASCII, so anything accepted is
/// 15 bytes as well as 15 characters. The char count is here for faithfulness
/// and to keep the index arithmetic below in range, not to change an outcome.
///
/// The grammar checks SHAPE, not validity: production accepts `date/2026-99-99`
/// and so does this.
fn date_tag_date(content: Option<&str>) -> Option<String> {
    let chars: Vec<char> = content?.chars().collect();
    if chars.len() != 15 {
        return None;
    }
    let (prefix, date) = chars.split_at(5);
    if !prefix
        .iter()
        .collect::<String>()
        .eq_ignore_ascii_case("date/")
    {
        return None;
    }
    // Offsets 6-9, 11-12 and 14-15 in the 1-indexed SUBSTR calls, minus the
    // five-character prefix.
    let digits_at = [0, 1, 2, 3, 5, 6, 8, 9];
    if !digits_at.iter().all(|&i| date[i].is_ascii_digit()) {
        return None;
    }
    if date[4] != '-' || date[7] != '-' {
        return None;
    }
    Some(date.iter().collect())
}

/// `agenda_cache` folded from base rows, as the SET of sources any correct
/// rebuild may store per key.
///
/// Transcribed from `DESIRED_AGENDA_SQL` (`agaric-store/src/cache/agenda.rs`)
/// and the dedup in `apply_sort_merge_rebuild`, folded in Rust rather than
/// re-expressed as SQL so this is an independent recomputation:
///
///   * four upstreams, in precedence order — any `block_properties` row with a
///     non-NULL `value_date` (`property:<key>`), a `date/YYYY-MM-DD` tag on the
///     block (`tag:<tag_id>`), then the promoted `due_date` and
///     `scheduled_date` columns;
///   * every arm requires the SOURCE block live, and the tag arm additionally
///     requires the TAG block live and `block_type = 'tag'`;
///   * every arm repeats the same template exclusion: a block whose OWNING PAGE
///     carries a `template` property contributes nothing, whatever the
///     property's value;
///   * the key is `(date, block_id)` and the merge keeps the lowest `prio`, so
///     one block with both a `due_date` and a `date/` tag on the same day
///     stores the tag.
///
/// The returned set is the honest expectation, not a convenience. Within one
/// prio the winner is genuinely ambiguous: `ORDER BY date, block_id, prio`
/// leaves two properties with the same `value_date` on one block — or two
/// distinct date tags naming one day — in unspecified order, and the dedup
/// keeps whichever SQLite emitted first. Pinning one of them would red a
/// correct rebuild, so every source at the winning prio is accepted and only a
/// source from a LOSING prio (or no row at all) is a divergence.
///
/// `page_id` is read as STORED, matching the `tp.block_id = b.page_id`
/// production writes. Auditing ownership is the page-id artefact's job; here a
/// stale `page_id` must be reported against the column that owns it rather than
/// resurfacing as a phantom agenda row.
pub async fn rebuild_agenda_cache_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<(String, String), BTreeSet<String>>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let properties = dump_block_properties(pool).await?;
    let explicit = dump_block_tags(pool).await?;
    Ok(fold_agenda_cache_from_base(&blocks, &properties, &explicit))
}

fn fold_agenda_cache_from_base(
    blocks: &[BaseBlock],
    properties: &[BaseProperty],
    explicit: &[(String, String)],
) -> BTreeMap<(String, String), BTreeSet<String>> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    // `NOT EXISTS (SELECT 1 FROM block_properties tp WHERE tp.block_id =
    // b.page_id AND tp.key = 'template')` — the KEY's presence excludes,
    // whatever its value.
    let template_pages: BTreeSet<&str> = properties
        .iter()
        .filter(|p| p.key == "template")
        .map(|p| p.block_id.as_str())
        .collect();
    let contributes = |b: &BaseBlock| {
        b.deleted_at.is_none()
            && !b
                .page_id
                .as_deref()
                .is_some_and(|page| template_pages.contains(page))
    };

    // (date, block_id) -> prio -> sources at that prio.
    let mut by_key: BTreeMap<(String, String), BTreeMap<u8, BTreeSet<String>>> = BTreeMap::new();
    let mut push = |date: &str, block_id: &str, source: String, prio: u8| {
        by_key
            .entry((date.to_owned(), block_id.to_owned()))
            .or_default()
            .entry(prio)
            .or_default()
            .insert(source);
    };

    for property in properties {
        let (Some(date), Some(block)) = (
            property.value_date.as_deref(),
            by_id.get(property.block_id.as_str()),
        ) else {
            continue;
        };
        if contributes(block) {
            push(
                date,
                &property.block_id,
                format!("property:{}", property.key),
                0,
            );
        }
    }

    for (block_id, tag_id) in explicit {
        let (Some(block), Some(tag)) = (by_id.get(block_id.as_str()), by_id.get(tag_id.as_str()))
        else {
            continue;
        };
        if tag.block_type != "tag" || tag.deleted_at.is_some() || !contributes(block) {
            continue;
        }
        if let Some(date) = date_tag_date(tag.content.as_deref()) {
            push(&date, block_id, format!("tag:{tag_id}"), 1);
        }
    }

    for block in blocks.iter().filter(|b| contributes(b)) {
        if let Some(date) = block.due_date.as_deref() {
            push(date, &block.id, "column:due_date".to_owned(), 2);
        }
        if let Some(date) = block.scheduled_date.as_deref() {
            push(date, &block.id, "column:scheduled_date".to_owned(), 3);
        }
    }

    by_key
        .into_iter()
        .filter_map(|(key, by_prio)| {
            // BTreeMap iterates prio ascending, so the first entry is the
            // winning precedence.
            by_prio.into_values().next().map(|sources| (key, sources))
        })
        .collect()
}

const AGENDA_CACHE_OWNER: &str = "rebuild_agenda_cache(_split) (the RebuildAgendaCache task) — \
     and, one level up, the arms of materializer::dispatch::invalidations_for_op that enqueue it: \
     the agenda and journal views read this table directly, so a missing row is a task that \
     silently drops off the user's day and a stale one is a task shown on a date nothing schedules \
     it for";

/// `agenda_cache` against a from-base rebuild, in both directions.
pub async fn reconcile_agenda_cache(pool: &SqlitePool) -> Result<Vec<Divergence>, AppError> {
    let expected = rebuild_agenda_cache_from_base(pool).await?;
    let stored = dump_agenda_cache(pool).await?;

    let mut out = Vec::new();

    for (key, want) in &expected {
        let (date, block_id) = key;
        match stored.get(key) {
            None => out.push(Divergence {
                artefact: "agenda_cache.row",
                key: format!("{date} / {block_id}"),
                expected: format!("a row sourced from one of {want:?}"),
                actual: "no row in agenda_cache — the block is absent from that day".to_owned(),
                owner: AGENDA_CACHE_OWNER,
            }),
            Some(got) if !want.contains(got) => out.push(Divergence {
                artefact: "agenda_cache.source",
                key: format!("{date} / {block_id}"),
                expected: format!("one of {want:?} (the highest-precedence upstream)"),
                actual: format!("{got:?}"),
                owner: AGENDA_CACHE_OWNER,
            }),
            Some(_) => {}
        }
    }

    for (date, block_id) in stored.keys() {
        if expected.contains_key(&(date.clone(), block_id.clone())) {
            continue;
        }
        out.push(Divergence {
            artefact: "agenda_cache.row",
            key: format!("{date} / {block_id}"),
            expected: "no row (the block is deleted, lives under a template page, or no longer \
                       carries that date)"
                .to_owned(),
            actual: "a row in agenda_cache".to_owned(),
            owner: AGENDA_CACHE_OWNER,
        });
    }

    Ok(out)
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

// ---------------------------------------------------------------------------
// Artefact 7 — `block_links_unresolved`, the OBLIGATIONS index (#4229)
// ---------------------------------------------------------------------------

/// Every `(source, target)` row of `block_links_unresolved`.
async fn dump_block_links_unresolved(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    const SQL: &str = "SELECT source_id, target_id FROM block_links_unresolved";
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Recompute the whole OBLIGATION set: every `(source, target)` an edge is
/// owed for, from `blocks.content` and the `block_links` rows that exist.
///
/// The rule is `sync_unresolved_links`' rule, transcribed: a live source owes
/// a target when its `content` names the token and no `block_links` row
/// carries the edge. Production reaches that answer by reading `block_links`
/// BACK after its INSERT rather than predicting which offered targets landed
/// — so `block_links` is a BASE table to this artefact, exactly as it is to
/// the two roll-ups, and that is deliberate here:
///
/// * it is what the writer actually implements. Deriving the expected side
///   from a from-CONTENT rebuild of `block_links` instead would report an
///   obligation as WRONG whenever the edge is one #3903/#4118 lost — i.e. it
///   would fire on the very state the table exists to record;
/// * it keeps the two link artefacts orthogonal, so a single defect is
///   reported once. [`reconcile_block_links`] owns "is the EDGE set right?";
///   this one owns "given that edge set, is the OWED set right?". A vault
///   missing an edge that content demands gets one MISSING from the former and
///   a correctly-recorded obligation here — which together are the accurate
///   description of a vault mid-repair.
///
/// # The one departure, and the one thing it is NOT
///
/// Live-scoped on the SOURCE, like production's read (`SELECT content FROM
/// blocks WHERE id = ? AND deleted_at IS NULL`), because a reindex of a
/// tombstoned source clears its rows. That is the expected side only: the
/// EXTRA arm below is deliberately NOT liveness-scoped, because no delete arm
/// enqueues `ReindexBlockLinks`, so a tombstoned source's rows survive by
/// design — the same asymmetry, and for the same reason, as
/// [`fold_content_link_targets`].
pub async fn rebuild_block_links_unresolved_from_content(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let links: BTreeSet<(String, String)> = dump_block_links(pool).await?.into_iter().collect();
    Ok(fold_block_links_unresolved(&blocks, &links))
}

fn fold_block_links_unresolved(
    blocks: &[BaseBlock],
    links: &BTreeSet<(String, String)>,
) -> BTreeSet<(String, String)> {
    let mut out = BTreeSet::new();
    for source in blocks {
        if source.deleted_at.is_some() {
            continue;
        }
        for target_id in fold_content_link_targets(source.content.as_deref()) {
            let pair = (source.id.clone(), target_id);
            if !links.contains(&pair) {
                out.insert(pair);
            }
        }
    }
    out
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

/// The maintenance sites that own every `block_links_unresolved` divergence.
const BLOCK_LINKS_UNRESOLVED_OWNER: &str = "sync_unresolved_links (agaric-store's cache::block_links), called at the \
     tail of BOTH reindex writers — reindex_block_links_conn and \
     reindex_block_links_split — so a source's whole owed set is recomputed \
     from its current content and its post-diff block_links rows on every \
     reindex of it; plus rebuild_block_links_unresolved, the vault-wide \
     arm (#4218) nothing in production has called since #4699. One level up: \
     the arm of \
     materializer::dispatch::invalidations_for_op that enqueues \
     ReindexBlockLinks at all (only CreateBlock and EditBlock do). A row lost \
     from here is a repair that silently never happens — the target's \
     ReindexBlockLinks asks this table who was waiting and acts only on what \
     it returns, and every other link artefact folds block_links, which does \
     NOT contain the owed edge. That invisibility is why the table needs an \
     auditor more than its sibling does, not less";

/// Diff `block_links_unresolved` against a re-derivation from block content
/// (#4229).
///
/// # Why the satellite needs its own auditor
///
/// `block_links` at least fails VISIBLY: a dropped edge is a backlink a user
/// can see is missing, and since #3955 [`reconcile_block_links`] re-derives it.
/// Its satellite fails invisibly by construction. The rows exist so that a
/// repair can find them later; a row lost from it is a repair that never
/// happens, on a vault whose visible state — an edge missing from
/// `block_links` — is indistinguishable from the state the user already had.
/// Nothing else in the system reads the table, so nothing else can notice.
///
/// # Lane, and its relationship to [`reconcile_block_links`]
///
/// **Scheduled/directed lane, NOT [`reconcile`]** — inherited from its sibling
/// for the same three reasons (the re-parse cost per op of every generated
/// chain; `reconcile`'s own fixtures writing link rows directly; MISSING being
/// triage rather than a gate on a vault carrying pre-#4118 losses).
///
/// It is also a SEPARATE entry point from
/// [`block_links_reconciliation_failure`] rather than an extra arm inside it.
/// The two artefacts answer different questions and can legitimately disagree
/// with the world in opposite directions at the same moment — a vault mid-
/// repair has a MISSING edge and a correct obligation — so folding them into
/// one report would make each one's fixtures noise for the other.
///
/// # The two arms
///
/// * **MISSING** (content owes the edge, no row). Sound for the shape it
///   exists to catch: a writer that dropped a token without recording it, the
///   #4118 defect itself, and the restore path #4218 was. It CAN also fire on
///   a vault whose losses predate #4118 (the index is populated by the
///   reindexes that run after it landed, and — outside a snapshot restore —
///   is not backfilled), and transiently between a content edit landing and
///   its `ReindexBlockLinks` draining. Triage, not a regression signal.
///
///   One window is this artefact's ALONE and is irreducible, so it is
///   enumerated rather than discovered during a triage: a `PurgeBlock` of a
///   linked TARGET hard-deletes the row, the `ON DELETE CASCADE` on
///   `block_links.target_id` takes the edge with it, and no delete/purge arm
///   reindexes the referrer (`lifecycle_rebuild_tasks` fans out cache
///   REBUILDS, none of which is a `ReindexBlockLinks`). The referrer's content
///   still names the token, so the debt becomes real with nothing recording
///   it, on a vault where every writer behaved exactly as designed.
///   [`reconcile_block_links`] does NOT share this window — its expected side
///   requires the target to EXIST in `blocks`, so a purged target simply drops
///   out of it — and this one cannot borrow that escape: an obligation whose
///   target is absent is #4118 case 1, the primary shape the table exists for,
///   and `owed_with_a_live_target` exists precisely to catch a fold that
///   quietly required the target to be missing. A purged target and a
///   never-yet-created one are indistinguishable from state alone, so the
///   choice is which of the two to serve, and the table's whole purpose picks
///   the second.
/// * **EXTRA** (row, nothing owes it). Scoped to production's DELETE rule
///   exactly — `sync_unresolved_links` deletes a source's row when the current
///   content no longer names the target OR when `block_links` now carries the
///   edge — so both of those, and only those, are reported. A row is NOT
///   reported merely because its source is now tombstoned: no delete arm
///   enqueues `ReindexBlockLinks`, so those rows survive by design, and an arm
///   that fired on them would redden on every ordinary block deletion and get
///   muted.
///
/// A row whose source has been PURGED cannot exist (`source_id REFERENCES
/// blocks(id) ON DELETE CASCADE`) and is skipped rather than reported, for the
/// same reason the sibling skips an absent source.
///
/// Divergences come back MISSING-first, each arm sorted by `(source, target)`,
/// so `first` is deterministic.
///
/// # Errors
/// Returns [`AppError`] if any dump fails.
pub async fn reconcile_block_links_unresolved(
    pool: &SqlitePool,
) -> Result<Vec<Divergence>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let links: BTreeSet<(String, String)> = dump_block_links(pool).await?.into_iter().collect();
    let expected = fold_block_links_unresolved(&blocks, &links);
    let stored: BTreeSet<(String, String)> = dump_block_links_unresolved(pool)
        .await?
        .into_iter()
        .collect();

    let mut out = Vec::new();

    // --- MISSING: an edge is owed, and nothing records the debt -------------
    //
    // #4241 — the target's presence/liveness is folded into `expected` so a
    // triager does not have to re-derive it by hand. `by_id` is already built
    // above from the SAME `dump_blocks` this arm's `expected`/`stored` diff
    // uses, so this costs no extra query — just a map lookup per divergence.
    //
    // A LIVE target names a debt that is actively repairable right now (the
    // #4118 case-2 timing/cross-space shape, or a genuinely lost repair): the
    // target could be reindexed today and nothing would happen, because
    // nothing points a `ReindexBlockLinks` at THIS source. An ABSENT target
    // is the one case this arm cannot narrow further — a target that was
    // purged (the irreducible window this doc's MISSING section already
    // enumerates) and a target that has simply never been created yet are
    // indistinguishable from `blocks` alone, so both render the same way
    // rather than one masquerading as the other.
    for (source_id, target_id) in expected.difference(&stored) {
        let target_state = match by_id.get(target_id.as_str()) {
            None => {
                "the target does NOT exist in blocks right now — either it has never been \
                 created (the ongoing #4118 case-1 debt this table exists for) or it WAS a \
                 live block that a PurgeBlock hard-deleted, taking its block_links edge with \
                 it via ON DELETE CASCADE (the irreducible purge window, permanent residue \
                 rather than a defect); the two are indistinguishable from state alone"
            }
            Some(t) if t.deleted_at.is_some() => {
                "the target exists in blocks but is SOFT-deleted, so this debt is dormant \
                 unless the target is restored"
            }
            Some(_) => {
                "the target exists in blocks and is LIVE right now — this debt is actively \
                 repairable the moment something reindexes the source, and nothing currently \
                 does"
            }
        };
        out.push(Divergence {
            artefact: "block_links_unresolved.row",
            key: format!("{source_id} -> {target_id}"),
            expected: format!(
                "a block_links_unresolved row: the live source's content names this \
                 token and no block_links row carries the edge, so the edge is OWED \
                 and this row is the only record of it — {target_state}"
            ),
            actual: "no row in block_links_unresolved — the repair that would re-link this \
                     edge when the target becomes linkable can no longer be found"
                .to_owned(),
            owner: BLOCK_LINKS_UNRESOLVED_OWNER,
        });
    }

    // --- EXTRA: a debt nothing owes ----------------------------------------
    for (source_id, target_id) in &stored {
        let Some(source) = by_id.get(source_id.as_str()) else {
            // Unstorable: `source_id REFERENCES blocks(id) ON DELETE CASCADE`
            // (migration 0112), so a purge takes the row with it.
            continue;
        };
        // Deliberately UNSCOPED by liveness — see the doc above. A tombstoned
        // source keeps both its edges and its obligations because nothing
        // reindexes it on delete.
        let named = fold_content_link_targets(source.content.as_deref()).contains(target_id);
        let linked = links.contains(&(source_id.clone(), target_id.clone()));
        if named && !linked {
            continue;
        }
        let reason = if linked {
            "block_links now carries the edge, so the DELETE arm's \
             `target_id IN (SELECT target_id FROM block_links WHERE source_id = ?1)` \
             clause must have removed it — leaving it re-drives a repair that is done"
        } else {
            "the source block's content column names no such [[ULID]] / ((ULID)) token, \
             so the DELETE arm's `target_id NOT IN (parsed tokens)` clause must have \
             removed it — leaving it re-links an edge the source has since deleted"
        };
        out.push(Divergence {
            artefact: "block_links_unresolved.row",
            key: format!("{source_id} -> {target_id}"),
            expected: format!("no block_links_unresolved row ({reason})"),
            actual: "a row in block_links_unresolved".to_owned(),
            owner: BLOCK_LINKS_UNRESOLVED_OWNER,
        });
    }

    Ok(out)
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

// ---------------------------------------------------------------------------
// Artefact 8 — `fts_blocks`, the full-text search index (#3345)
// ---------------------------------------------------------------------------

/// `blocks.block_type` for a tag block — the rows whose content is a tag NAME.
const TAG_BLOCK_TYPE: &str = "tag";

/// Fold the tag-name and page-title reference maps out of the `blocks` dump.
///
/// Production loads these with two `SELECT id, content FROM blocks WHERE
/// block_type = … AND deleted_at IS NULL` queries (`fts::strip::load_ref_maps`,
/// `pub(crate)` and therefore unreachable from here anyway). Folding them from
/// the same flat dump every other artefact uses keeps the whole rebuild on one
/// base-table read and keeps the predicate in Rust where it can be compared
/// against, rather than delegated to the same SQL the maintainer runs.
///
/// A NULL-content tag or page contributes no entry: an unresolvable `#[ULID]`
/// / `[[ULID]]` token strips to the empty string on both sides.
fn fold_ref_maps(
    blocks: &[BaseBlock],
) -> (
    std::collections::HashMap<String, String>,
    std::collections::HashMap<String, String>,
) {
    let mut tag_names = std::collections::HashMap::new();
    let mut page_titles = std::collections::HashMap::new();
    for block in blocks {
        if block.deleted_at.is_some() {
            continue;
        }
        let Some(content) = block.content.as_deref() else {
            continue;
        };
        match block.block_type.as_str() {
            TAG_BLOCK_TYPE => {
                tag_names.insert(block.id.clone(), content.to_owned());
            }
            PAGE_BLOCK_TYPE => {
                page_titles.insert(block.id.clone(), content.to_owned());
            }
            _ => {}
        }
    }
    (tag_names, page_titles)
}

/// Recompute the whole FTS index from `blocks` alone.
///
/// The membership rule, transcribed from the column semantics rather than from
/// a maintainer's query: **a block has exactly one `fts_blocks` row iff it is
/// live and its `content` is not NULL.** Every writer in
/// `agaric_store::fts::index` observes it — the single-block upsert deletes
/// when the row is absent, tombstoned, or content-less, and the vault-wide
/// rebuild selects `WHERE deleted_at IS NULL AND content IS NOT NULL`. There
/// is no `block_type` term and no conflict term: a tag block and a page block
/// are indexed exactly like a content block.
///
/// # The projection is production's, and that is the point
///
/// The `stripped` VALUE is computed by calling production's own
/// `strip_for_fts_with_maps`, so this rebuild is NOT independent of it — a
/// specification bug in the strip rules is invisible here, because both sides
/// have it. That is a deliberate line, not an oversight:
///
/// * `strip_for_fts_with_maps` is a PURE function of `(content, tag_names,
///   page_titles)`. It has no per-op-type arms, so it is not the thing this
///   module exists to audit; it is unit-tested in `fts/strip.rs` and fuzzed by
///   `fuzz/fuzz_targets/fts_strip.rs` (#2945).
/// * What IS hand-maintained per op arm — and therefore what this artefact
///   audits — is *which blocks get reindexed and when*:
///   `materializer::dispatch::invalidations_for_op` decides whether an op
///   enqueues `UpdateFtsBlock`, `RemoveFtsBlock`, `ReindexFtsReferences`, a
///   full `RebuildFtsIndex`, or nothing at all. Nothing writes this index
///   inside `apply_op_tx` — same shape as `page_link_cache` (#3296).
/// * A 400-line Rust transcription of markdown stripping, NFC normalisation,
///   reference substitution and the `FTS_MAX_INDEXED_BYTES` cap would drift
///   from production on its first bug fix and report the drift as a data
///   divergence. That is a worse oracle, not a stronger one.
///
/// So the claim this artefact makes is precise: **membership, freshness and
/// row multiplicity**, not projection semantics.
///
/// # A tombstoned block's row is a divergence (#4733)
///
/// It used to be tolerated, and counted, because production really did leave
/// one behind: `DeleteBlock` soft-deletes the whole cohort but its dispatch
/// arm emitted `RemoveFtsBlock` for `record.block_id` ALONE, and
/// `RebuildFtsIndex` is not a member of `FULL_CACHE_REBUILD_TASKS`, so every
/// DESCENDANT of a deleted subtree kept its row until the next full rebuild
/// (boot, or a large inbound sync). The rows were unreachable — every search
/// read inner-joins `blocks` and filters `b.deleted_at IS NULL`
/// (`fts/search/fetch.rs`, `fts/toggle_filter.rs`) — but they cost trigram
/// index size and skewed bm25 corpus statistics.
///
/// #4733 closed it with a post-commit fan-out over the cohort the cascade
/// consumed (`remove_deleted_cohort_fts` / `reindex_restored_cohort_fts`,
/// beside the engine fan-outs at every delete and restore site), so the rule
/// the column semantics state is now the rule production keeps, and this
/// rebuild states it without a carve-out: a tombstoned block owes no row, and
/// a row it still has is reported.
///
/// The reference maps ARE folded independently (see [`fold_ref_maps`]) and
/// re-read on every call, which is what makes a stale row after a tag rename
/// or a page retitle expressible: production propagates those through
/// `ReindexFtsReferences`, and an arm that forgets to enqueue it leaves the
/// old name sitting in `stripped` while this rebuild resolves the new one.
pub async fn rebuild_fts_index_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, String>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let (tag_names, page_titles) = fold_ref_maps(&blocks);

    let mut expected = BTreeMap::new();
    for block in &blocks {
        let Some(content) = block.content.as_deref() else {
            continue;
        };
        if block.deleted_at.is_some() {
            continue;
        }
        expected.insert(
            block.id.clone(),
            agaric_store::fts::strip::strip_for_fts_with_maps(
                &block.id,
                content,
                &tag_names,
                &page_titles,
            ),
        );
    }
    Ok(expected)
}

/// Read the maintained index, keeping EVERY row per `block_id`.
///
/// The multiplicity is the point: one row per block is convention, not a
/// constraint (`fts/index.rs` § "Single-row-per-`block_id` invariant"), and the
/// two guards that exist — `debug_assert_single_fts_row`, compiled out of
/// release, and `assert_no_duplicate_fts_rows`, on one write path — are
/// narrow. Folding the rows into a `Vec` lets [`reconcile`] report a duplicate
/// on every path B6 drives.
async fn read_fts_blocks(pool: &SqlitePool) -> Result<BTreeMap<String, Vec<String>>, AppError> {
    // dynamic-sql: static SQL, test-only oracle read-back of the derived index.
    let rows = sqlx::query_as::<_, (String, String)>("SELECT block_id, stripped FROM fts_blocks")
        .fetch_all(pool)
        .await?;
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (block_id, stripped) in rows {
        out.entry(block_id).or_default().push(stripped);
    }
    Ok(out)
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
                owner: "set_block_page_id_from_parent_in_tx (the scoped leaf-create arm) / \
                        agaric_store::block_descendants::rederive_page_and_space_ids (the in-tx \
                        move arm — a MOVE deliberately does NOT enqueue the vault-wide \
                        rebuild, #2200) / cache::rebuild_page_ids (the vault-wide arm \
                        dispatch enqueues for create/delete/restore/purge and inbound \
                        sync) — the denormalised owner disagrees with the parent_id \
                        tree it caches, so every page_id-keyed count, filter and \
                        backlink below it is computed for the wrong page",
            });
        }
    }

    // --- Artefact 9: blocks.space_id on DERIVED rows (#3345) -----------------
    //
    // Directly after ownership, because it is keyed on the same `parent_id`
    // walk: a block whose owner drifted would otherwise report twice, and
    // reporting it here keeps `first` naming the root cause.
    const SPACE_OWNER: &str = "maintain_pages_cache_counts_after_op's PreOpState::Create arm (the in-tx \
         stamp from the owning page, apply/pages_cache.rs) + set_block_space_id_from_parent \
         (the post-commit re-stamp, the space half of the SetBlockPageId task) / \
         project_set_property_to_sql + project_delete_property_to_sql \
         (the in-tx page-group write of a SetProperty/DeleteProperty(space)) / \
         agaric_store::block_descendants::rederive_page_and_space_ids (the in-tx move arm) / \
         cache::rebuild_space_ids (the vault-wide arm the RebuildPageIds task runs second) — \
         every space-scoped read (page lists, trash, the cross-space link filter) filters on \
         this column, so a block whose value lags its page is invisible in its space or \
         listed in the wrong one";
    let expected_spaces = fold_block_space_ids(&blocks);
    let stored_spaces: BTreeMap<&str, Option<&str>> = blocks
        .iter()
        .map(|b| (b.id.as_str(), b.space_id.as_deref()))
        .collect();
    for (block_id, derived) in &expected_spaces {
        // Both sides come from the same `blocks` dump, so the key is always
        // present; a `None` here would be an absent row, which is the same
        // divergence as a NULL column and is reported as one.
        let actual_space = stored_spaces.get(block_id.as_str()).copied().flatten();
        if derived.space_id.as_deref() != actual_space {
            out.push(Divergence {
                artefact: "blocks.space_id",
                key: block_id.clone(),
                expected: match &derived.space_id {
                    Some(space) => {
                        format!("{space} (owning page {}'s space_id)", derived.owning_page)
                    }
                    None => format!(
                        "NULL (owning page {} carries no space_id)",
                        derived.owning_page
                    ),
                },
                actual: actual_space.map_or_else(|| "NULL".to_owned(), str::to_owned),
                owner: SPACE_OWNER,
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

    // --- Artefact 8: fts_blocks (#3345) --------------------------------------
    //
    // Last, and independent of everything above it: the index derives from
    // `blocks.content` plus the tag/page reference maps, not from `page_id`,
    // so it shares no key with the `pages_cache` family and cannot double-
    // report an ownership drift.
    const FTS_OWNER: &str = "update_fts_for_block(_with_maps) / remove_fts_for_block / \
         reindex_fts_references / rebuild_fts_index (the UpdateFtsBlock, RemoveFtsBlock, \
         ReindexFtsReferences and RebuildFtsIndex tasks — NOTHING maintains this index \
         inside apply_op_tx) plus the post-commit cohort fan-outs \
         remove_deleted_cohort_fts / reindex_restored_cohort_fts (#4733) — and, one level \
         up, the arm of materializer::dispatch::invalidations_for_op that decides whether \
         any of the tasks is enqueued at all: search reads fts_blocks EXCLUSIVELY, so a \
         block missing from it is a block the user cannot find";
    let expected_fts = &rebuild_fts_index_from_base(pool).await?;
    let actual_fts = read_fts_blocks(pool).await?;
    for (block_id, expected) in expected_fts {
        match actual_fts.get(block_id) {
            None => out.push(Divergence {
                artefact: "fts_blocks.row",
                key: block_id.clone(),
                expected: format!("one indexed row, stripped={expected:?}"),
                actual: "no row in fts_blocks — the block is unsearchable".to_owned(),
                owner: FTS_OWNER,
            }),
            // #345 / C6 — see `read_fts_blocks`.
            Some(rows) if rows.len() > 1 => out.push(Divergence {
                artefact: "fts_blocks.duplicate_row",
                key: block_id.clone(),
                expected: "exactly one row (FTS5 cannot enforce it — every writer \
                           DELETEs before it INSERTs)"
                    .to_owned(),
                actual: format!("{} rows: {rows:?}", rows.len()),
                owner: FTS_OWNER,
            }),
            Some(rows) if rows[0] != *expected => out.push(Divergence {
                artefact: "fts_blocks.stripped",
                key: block_id.clone(),
                expected: format!("{expected:?}"),
                actual: format!("{:?}", rows[0]),
                owner: FTS_OWNER,
            }),
            Some(_) => {}
        }
    }
    for (block_id, rows) in &actual_fts {
        if expected_fts.contains_key(block_id) {
            continue;
        }
        out.push(Divergence {
            artefact: "fts_blocks.row",
            key: block_id.clone(),
            expected: "no indexed row (the block is tombstoned, gone from `blocks`, or \
                       its content is NULL)"
                .to_owned(),
            actual: format!("{} row(s) in fts_blocks: {rows:?}", rows.len()),
            owner: FTS_OWNER,
        });
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
