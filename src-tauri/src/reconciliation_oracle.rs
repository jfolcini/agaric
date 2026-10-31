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
//! * `assert_reconciled` (test harness) diffs every artefact and reports the **first**
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
//! Since #4886 the rebuild-and-diff half is also compiled into the release
//! build, behind ONE user-triggered command
//! (`commands::reconciliation::compute_reconciliation_report`, which calls
//! [`reconcile_all`]) so the oracle can be pointed at a real vault — years of
//! op history no fixture can manufacture. That command reads through the
//! reader pool and an export of each engine, and writes nothing: a divergence
//! is data to return, never a panic and never a repair. Repair stays out on
//! purpose (#5628): rebuilding on a non-empty report erases the evidence the
//! check exists to produce, and no rebuild repairs SQL that has drifted from
//! the engine. Everything that WRITES (the `settle_*` helpers
//! that run production's deferred maintainers) or exists to fail a test loudly
//! (`assert_*`, the `*_reconciliation_failure` formatters, the coverage
//! counters) lives in `harness.rs` under `cfg(test)` and is re-exported from
//! here for the drivers.
//!
//! The base-table dumps are compile-checked `sqlx::query!` literals like every
//! other production query (invariant 6). Independence from the maintenance path
//! lives in the Rust folds, not in the form of the SQL: each dump is an
//! aggregate-free column read, and no JOIN, COUNT, DISTINCT or recursive CTE
//! is pushed into SQLite.
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
//! | `block_links` ITSELF (#3955) | `blocks` — **`blocks.content`**, not `block_links` | `reindex_block_links_conn` / `reindex_block_links_split` (the incremental writers) / `backfill_block_links` (the one-shot vault-wide arm, marker-gated at boot, #4905) — audited by [`reconcile_block_links`], NOT by [`reconcile`] |
//! | `block_links_unresolved` (#4229) | `blocks.content` **and** `block_links` | `sync_unresolved_links` (inside both reindex writers) / `rebuild_block_links_unresolved` (the vault-wide arm, #4218; no production caller since #4699 — `backfill_block_links` reaches this table through the reindex writers instead) — audited by [`reconcile_block_links_unresolved`], NOT by [`reconcile`] |
//! | `fts_blocks` (#3345) | `blocks` — `content`, `deleted_at`, and the tag/page names the refs resolve to | `update_fts_for_block` / `remove_fts_for_block` / `reindex_fts_references` / `rebuild_fts_index` (the four FTS tasks; NOTHING writes it inside `apply_op_tx`) |
//! | `blocks.space_id` on DERIVED rows (#3345) | `blocks` — `parent_id`, `block_type`, and the owning PAGE's own `space_id` | `maintain_pages_cache_counts_after_op`'s Create arm (in-tx, from the owning page) + `set_block_space_id_from_parent` (the post-commit re-stamp, the space half of the `SetBlockPageId` task) / `project_set_property_to_sql` + `project_delete_property_to_sql` (the in-tx page-group write of a `space` op) / `rederive_page_and_space_ids` (the in-tx move arm) / `rebuild_space_ids` (the vault-wide arm, second half of `RebuildPageIds`) — see [`fold_block_space_ids`] for what "derived" excludes |
//! | `block_tag_refs` (the INLINE tag index, #3345) | `blocks` — **`blocks.content`** | `reindex_block_tag_refs(_in_tx/_split/_split_in_tx)` / `rebuild_block_tag_refs_cache` (the vault-wide arm) — audited by [`reconcile_block_tag_refs`], NOT by [`reconcile`] |
//! | `tags_cache.usage_count` (#3345) | `blocks`, `block_tags` **and** `block_tag_refs` (explicit + inline, so it rides on Artefact 12) | `rebuild_tags_cache(_split)` / `refresh_tag_usage_count` — audited by [`reconcile_tags_cache`], NOT by [`reconcile`] |
//! | `agenda_cache` (the date roll-up, #3345) | `blocks`, `block_properties` **and** `block_tags` | `rebuild_agenda_cache(_split)` (the `RebuildAgendaCache` task) — audited by [`reconcile_agenda_cache`], NOT by [`reconcile`] |
//! | `projected_agenda_cache` (the recurrence horizon, #3345) | `blocks` **and** `block_properties`, plus a `today` the caller supplies | `rebuild_projected_agenda_cache(_split)` (the `RebuildProjectedAgendaCache` task) — audited by [`reconcile_projected_agenda`], NOT by [`reconcile`] |
//! | `pages_cache.{title_sort_key,last_edited_ms,space_id}` (the Pages sort keys, #5371) | the cached `pages_cache.title`; `op_log` and `blocks.page_id` for a floor; the page's `blocks.space_id` | the page-row rebuild, its restore insert (`insert_missing_pages_cache_rows`) and the page-create INSERT (key, space) / `raise_pages_last_edited_ms` on every op-landing path (last edited) / `sync_pages_cache_space_ids` in a `space` op's projection (space) — audited by [`reconcile_pages_cache_sort_keys`], NOT by [`reconcile`] |
//! | `block_tag_inherited` (tag inheritance, #5628) | `blocks` — `parent_id`, `deleted_at` — **and** `block_tags` | the in-transaction arms of `tag_inheritance::apply_op_tag_inheritance`, the purge cascades, `loro_sync`'s post-import refresh / `rebuild_all` (the `RebuildTagInheritanceCache` task) — row membership in [`reconcile`], `inherited_from` in [`diff_block_tag_inherited_provenance`] only |
//! | SQL `blocks` ITSELF against the Loro engine (#5628) | the live engine docs — not a SQL table | the per-op projections in `loro::projection` (`project_*_to_sql`) after every engine apply / the SQL-only fallbacks, which write SQL without the engine — audited by [`reconcile_engine`], NOT by [`reconcile`] |
//! | SQL `attachments` against the Loro engine (#5608) | the attachment entries the live engine docs' nodes hold | `apply::attachments` (the op path) / `reproject_attachments_from_engine` (imports and recovery) / `repair::attachments` (the boot backfill) — audited by [`reconcile_engine`], NOT by [`reconcile`] |
//! | SQL `block_tags` and `page_aliases` against the Loro engine (#6207) | each space doc's tag maps and `page_aliases` root, for the blocks both sides hold | `project_add_tag_to_sql` / `project_remove_tag_to_sql` and `project_add_page_alias_to_sql` / `project_remove_page_alias_to_sql` (the op apply arms, the op-log recovery arms) / `reproject_block_tags_from_engine` and `reproject_page_aliases_from_engine` (imports and recovery) / `repair::page_aliases` (the boot backfill) / the purge cascades — audited by [`reconcile_engine`], NOT by [`reconcile`] |
//! | SQL `block_properties` and `property_definitions` against the Loro engine (#6206) | each held node's property map, typed by its space's `property_definitions` rows and the built-ins, for the blocks both sides hold; each space doc's `property_definitions` root | `project_set_property_to_sql` / `project_delete_property_to_sql` (the op apply arms, the op-log recovery arms) / `reproject_block_properties_from_engine` (imports and recovery) / `reproject_key_values` and `project_property_value_writes` (retypes and rewrites) / the rename projections / the purge cascades; `project_property_def_to_sql` (every definition op, `project_pass_defs`, recovery) / `repair::property_definitions` (the boot backfill) — audited by [`reconcile_engine`], NOT by [`reconcile`] |
//! | `spaces`, the registry (#6207) | `block_properties` — the `is_space = 'true'` rows, a soft-deleted space's included | the `spaces_register_is_space` trigger (migration 0089), fired by every `is_space` property insert / the FK cascade of a purge (the only removal) — in [`reconcile`] |
//!
//! # `page_link_cache` has NO synchronous arm at all (#3296)
//!
//! Unlike the `pages_cache` counts, this roll-up is maintained **only** by
//! background tasks the DISPATCHER decides to enqueue: nothing in
//! `apply_op_tx` writes it. That makes the dispatch table itself — not a
//! projection helper — the thing that can be wrong, and it is a table with one
//! arm per op type, hand-maintained (`materializer::dispatch::
//! invalidations_for_op`). So the settle for this artefact
//! (`settle_page_link_cache_for_op`, test harness) does not run a fixed list of
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
//! column and agree. [`fold_page_ownership`] closes that by
//! auditing the column ITSELF against a structural `parent_id` walk, and
//! [`reconcile`] diffs ownership BEFORE the counts. A drift in `page_id` is
//! therefore reported at its root (`blocks.page_id`) rather than silently
//! agreed on, which is what makes the count comparison meaningful rather than
//! self-confirming.
//!
//! # `block_links` used to be a base table with no independent expected side (#3955)
//!
//! Two artefacts above fold `block_links` as GROUND TRUTH, and so does the
//! roll-up's vault-wide maintainer (`rebuild_page_link_cache_impl` reads
//! `FROM block_links bl` — it rolls *up from* the table and never re-parses
//! content). A wrong row in `block_links` therefore produced a
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
//! * `maintain_pages_cache_counts_after_op` adds nothing to its affected set for
//!   `PreOpState::Deferred` (#2042) and
//!   `materializer::dispatch` enqueues `MaterializeTask::RebuildPagesCacheCounts`
//!   instead;
//! * `delete_attachment_inner` / the purge paths never unlink bytes or prune
//!   `attachment_blobs` (#1993/#3259); `cleanup_orphaned_attachments` does.
//!
//! A peer's attachment is the same shape from the other side (#5728): its row
//! lands in the op-sync phase with the hash it was added with, and its
//! `attachment_blobs` entry is written when the file phase lands the bytes or
//! links ones already held. Until then its bytes are pending, not lost, and
//! [`reconcile_all`] leaves out a hash with no blob whose referrers' files are
//! all absent; [`reconcile`] has no attachments directory to look in, so it
//! still names that hash under `attachment_blobs.refcount`.
//!
//! So the oracle is a statement about the **settled** state. A caller that
//! drives an op which production defers MUST also drive production's
//! deferred pass before asserting — that is what
//! `settle_deferred_pages_cache_counts` and the GC call in the attachment
//! tests do. Both deferred passes are production code, so breaking either of
//! them still turns the oracle red; nothing is repaired by test-local code.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::LazyLock;

use agaric_core::error::AppError;
use agaric_engine::loro::engine::PropertyValue;
use agaric_store::op::PropertyDefState;
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

// ---------------------------------------------------------------------------
// Base-table snapshots
//
// Every rebuild below folds one of these dumps in Rust. No aggregate, no
// JOIN, no correlated subquery is pushed into SQLite — that is the whole
// point: the maintenance path expresses its aggregates as SQL, so an oracle
// written in the same SQL would be a copy of the thing it audits.
// ---------------------------------------------------------------------------

/// One `blocks` row, reduced to the columns the derived artefacts depend on.
///
/// [`reconcile_all`] dumps it once and hands the same slice to every artefact
/// (#4901): each `rebuild_*_from_base` / `reconcile_*` below takes the dump
/// rather than reading `blocks` — every row, including `content`, and no
/// liveness filter — for itself.
#[derive(Debug, Clone)]
pub struct BaseBlock {
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
    /// The promoted TODO state. `Some("DONE")` takes a repeating block out of
    /// the projected agenda entirely.
    todo_state: Option<String>,
    /// The promoted priority. Read only to compare against the engine.
    priority: Option<String>,
    /// The dense sibling rank the engine's tree order projects to. Read only
    /// to compare against the engine.
    position: Option<i64>,
}

/// One `attachments` row: the columns the blob store depends on, and the ones
/// the engine owns.
#[derive(Debug, Clone)]
pub struct BaseAttachment {
    id: String,
    block_id: String,
    filename: String,
    mime_type: String,
    size_bytes: i64,
    created_at: i64,
    fs_path: String,
    content_hash: Option<String>,
    /// `None` = live. `attachments.deleted_at` is still TEXT (out of #109 scope).
    deleted_at: Option<String>,
}

async fn dump_blocks(pool: &SqlitePool) -> Result<Vec<BaseBlock>, AppError> {
    // Deliberately aggregate-free — the fold happens in Rust so this shares
    // nothing with the maintenance path. In particular there is no recursive
    // CTE here: the ancestor walk that derives page ownership is the one thing
    // `rebuild_page_ids` expresses as a `WITH RECURSIVE`, so expressing it the
    // same way would make the oracle a copy of the code it audits.
    let rows = sqlx::query!(
        "SELECT id, parent_id, page_id, block_type, content, deleted_at, space_id, due_date, \
         scheduled_date, todo_state, priority, position FROM blocks"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| BaseBlock {
            id: r.id,
            parent_id: r.parent_id,
            page_id: r.page_id,
            block_type: r.block_type,
            content: r.content,
            deleted_at: r.deleted_at,
            space_id: r.space_id,
            due_date: r.due_date,
            scheduled_date: r.scheduled_date,
            todo_state: r.todo_state,
            priority: r.priority,
            position: r.position,
        })
        .collect())
}

async fn dump_block_links(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query!("SELECT source_id, target_id FROM block_links")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.source_id, r.target_id))
        .collect())
}

async fn dump_attachments(pool: &SqlitePool) -> Result<Vec<BaseAttachment>, AppError> {
    let rows = sqlx::query!(
        "SELECT id, block_id, filename, mime_type, size_bytes, created_at, fs_path, \
         content_hash, deleted_at FROM attachments"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| BaseAttachment {
            id: r.id,
            block_id: r.block_id,
            filename: r.filename,
            mime_type: r.mime_type,
            size_bytes: r.size_bytes,
            created_at: r.created_at,
            fs_path: r.fs_path,
            content_hash: r.content_hash,
            deleted_at: r.deleted_at,
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

/// Read the key set of `pages_cache` as it stands.
async fn read_pages_cache_page_ids(pool: &SqlitePool) -> Result<BTreeSet<String>, AppError> {
    let rows = sqlx::query_scalar!("SELECT page_id FROM pages_cache")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
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
///   orphaned (`page_id IS NULL`), on page `P` (same-page/self links), or
///   outside `P`'s space (#5275 — a `block_links` row survives a move to
///   another space, and the count must match the space-scoped panel).
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
/// [`fold_page_ownership`] now audits that column against the
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
    blocks: &[BaseBlock],
) -> Result<BTreeMap<String, PageCounts>, AppError> {
    let links = dump_block_links(pool).await?;
    let page_ids = sqlx::query_scalar!("SELECT page_id FROM pages_cache")
        .fetch_all(pool)
        .await?;

    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    // One pass over each dump, attributed to the page a row counts towards. A
    // page with no cache row collects nothing: whether it should have one is
    // Artefact 3's question.
    let mut out: BTreeMap<String, PageCounts> = page_ids
        .into_iter()
        .map(|page| {
            (
                page,
                PageCounts {
                    inbound_link_count: 0,
                    child_block_count: 0,
                },
            )
        })
        .collect();
    for b in blocks {
        let Some(page) = b.page_id.as_deref() else {
            continue;
        };
        if b.deleted_at.is_some() || b.id == page {
            continue;
        }
        if let Some(counts) = out.get_mut(page) {
            counts.child_block_count += 1;
        }
    }

    let mut sources: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for (source_id, target_id) in &links {
        // Target must be a LIVE block owned by a page with a cache row.
        let Some(target) = by_id.get(target_id.as_str()) else {
            continue;
        };
        let Some(page) = target.page_id.as_deref() else {
            continue;
        };
        if target.deleted_at.is_some() {
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
        if by_id
            .get(page)
            .is_none_or(|p| p.space_id != source.space_id)
        {
            continue;
        }
        sources.entry(page).or_default().insert(source_id.as_str());
    }
    for (page, distinct) in sources {
        if let Some(counts) = out.get_mut(page) {
            counts.inbound_link_count = i64::try_from(distinct.len()).unwrap_or(i64::MAX);
        }
    }
    Ok(out)
}

/// Read the incrementally-maintained `pages_cache` counts as they stand.
async fn read_pages_cache_counts(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, PageCounts>, AppError> {
    let rows =
        sqlx::query!("SELECT page_id, inbound_link_count, child_block_count FROM pages_cache")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.page_id,
                PageCounts {
                    inbound_link_count: r.inbound_link_count,
                    child_block_count: r.child_block_count,
                },
            )
        })
        .collect())
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
            // A row with no hash (an add that predates the op's hash, or a
            // row the boot hash backfill has not reached) imposes no blob
            // obligation.
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
    let rows = sqlx::query!("SELECT content_hash, on_disk_path FROM attachment_blobs")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.content_hash, r.on_disk_path))
        .collect())
}

// ---------------------------------------------------------------------------
// Artefact 5 — `page_link_cache` (the page-level `block_links` roll-up, #3296)
// ---------------------------------------------------------------------------

/// The payload of one `page_link_cache` row; its `(source_page, target)` PK is
/// the map key.
///
/// All five columns are diffed, not just `edge_count`. The three flags
/// (migration 0096) and `space_id` (0122) exist so `list_page_links_inner`
/// can filter with an index and ZERO `blocks` joins — which means a stale
/// value is not cosmetic: it is a link the Graph view silently drops
/// (`src_deleted`/`tgt_deleted` stuck at 1, `space_id` left behind by a
/// page that changed space) or a link it silently shows (`tgt_is_page` stuck
/// at 1, a cross-space `space_id`). Auditing `edge_count` alone would leave
/// the entire reason the denormalisation exists unchecked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageLinkEdge {
    /// Live `block_links` rows whose source block rolls up to this page.
    pub edge_count: i64,
    /// Is the SOURCE PAGE (the group key) soft-deleted — or gone entirely?
    pub src_deleted: bool,
    /// Is the target block soft-deleted?
    pub tgt_deleted: bool,
    /// Is the target block a `page`?
    pub tgt_is_page: bool,
    /// The space both ends share, when both are pages (#5426).
    pub space_id: Option<String>,
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
/// * `tgt_deleted` / `tgt_is_page` come from the single target block;
/// * `space_id` is the `space_id` the source and the target share when both
///   are pages, and none otherwise (#5426).
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
    blocks: &[BaseBlock],
) -> Result<BTreeMap<(String, String), PageLinkEdge>, AppError> {
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
        let space_id = source_page_block.space_id.clone().filter(|space| {
            source_page_block.block_type == PAGE_BLOCK_TYPE
                && target.block_type == PAGE_BLOCK_TYPE
                && target.space_id.as_ref() == Some(space)
        });

        let entry = out
            .entry((source_page, target_id.clone()))
            .or_insert(PageLinkEdge {
                edge_count: 0,
                src_deleted,
                tgt_deleted: target.deleted_at.is_some(),
                tgt_is_page: target.block_type == PAGE_BLOCK_TYPE,
                space_id,
            });
        entry.edge_count += 1;
    }
    Ok(out)
}

/// Read the incrementally-maintained `page_link_cache` as it stands.
async fn read_page_link_cache(
    pool: &SqlitePool,
) -> Result<BTreeMap<(String, String), PageLinkEdge>, AppError> {
    let rows = sqlx::query!(
        "SELECT source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, \
         tgt_is_page, space_id FROM page_link_cache"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                (r.source_page_id, r.target_page_id),
                PageLinkEdge {
                    edge_count: r.edge_count,
                    src_deleted: r.src_deleted != 0,
                    tgt_deleted: r.tgt_deleted != 0,
                    tgt_is_page: r.tgt_is_page != 0,
                    space_id: r.space_id,
                },
            )
        })
        .collect())
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
/// Crockford base-32, exactly 26 uppercase alphanumerics, an optional
/// `|label` (#5160 D9); mixed delimiters (`[[ULID))`) match, exactly as
/// production's does.
static ORACLE_LINK_TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\[\[|\(\()([0-9A-Z]{26})(?:\|[^\]\n]*)?(?:\]\]|\)\))")
        .expect("invalid oracle link regex")
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
/// `blocks`. Production recomputes this set once per vault
/// (`cache::backfill_block_links`, #4905) and never again: the per-block
/// reindexer is a DIFF driven by content change alone. The gap between the two
/// is real and is enumerated on [`reconcile_block_links`].
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

/// The maintenance sites that own every `block_links` divergence — one pair
/// of incremental writers, and one vault-wide pass that runs once.
const BLOCK_LINKS_OWNER: &str = "reindex_block_links_conn (the single-pool writer, called both by the \
     ReindexBlockLinks task and IN-TRANSACTION by agaric-engine's \
     maintain_pages_cache_counts_after_op) / reindex_block_links_split (the \
     read/write-split writer) — one level up, the arm of \
     materializer::dispatch::invalidations_for_op that enqueues \
     ReindexBlockLinks at all (only CreateBlock and EditBlock do) — plus \
     recovery::cache_refresh's draft-recovery path, which enqueues it \
     directly. Vault-wide, only cache::backfill_block_links (#4905): a \
     one-shot pass, marker-gated at boot, that runs reindex_block_links_conn \
     over every live block whose content carries a link token — so it fills \
     block_links_unresolved through the same writer — and then retires \
     itself. Every other link artefact (pages_cache.inbound_link_count, \
     page_link_cache) folds this table as ground truth, so a loss here is \
     consistent on both sides of their diffs and invisible to reconcile(). \
     Since #4118 the SOURCE-triggered writer is no longer the only path back: \
     a token the INSERT declines is recorded in block_links_unresolved, keyed \
     by target, and the ReindexBlockLinks handler re-links those referrers when \
     the target itself is reindexed (create, edit, or the SetBlockPageId \
     page/space stamp)";

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
///   re-linked when the target is next reindexed — and `backfill_block_links`
///   (#4905) reindexed every token-bearing block once, so losses from before
///   either landed are repaired too. The arm can still fire transiently, in
///   the window between the target becoming linkable and the referrer's
///   repair draining. That is a finding to triage, not a regression signal,
///   which is what keeps this artefact in a scheduled lane.
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
pub async fn reconcile_block_links(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<Vec<Divergence>, AppError> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let expected = fold_block_links_from_content(blocks);
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

// ---------------------------------------------------------------------------
// Artefact 12 — `block_tag_refs`, the INLINE tag index (#3345)
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
    let rows = sqlx::query!("SELECT source_id, tag_id FROM block_tag_refs")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.source_id, r.tag_id)).collect())
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
pub async fn reconcile_block_tag_refs(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<Vec<Divergence>, AppError> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let expected = fold_block_tag_refs_from_content(blocks);
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

// ---------------------------------------------------------------------------
// Artefact 13 — `tags_cache`, the tag roll-up (#3345)
// ---------------------------------------------------------------------------

/// One `tags_cache` row's derived content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedTagRow {
    /// The surviving tag's raw `blocks.content` — production selects the
    /// column, not the normalised key.
    pub name: String,
    /// Distinct LIVE source blocks referencing this tag, explicitly or inline.
    pub usage_count: i64,
    /// The tag block's own `blocks.space_id` (#5237): the name slot is
    /// `UNIQUE (space_id, name)`, so this is half of the dedup key.
    pub space_id: Option<String>,
}

async fn dump_block_tags(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query!("SELECT block_id, tag_id FROM block_tags")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.block_id, r.tag_id)).collect())
}

async fn dump_tags_cache(pool: &SqlitePool) -> Result<BTreeMap<String, DerivedTagRow>, AppError> {
    let rows = sqlx::query!("SELECT tag_id, name, usage_count, space_id FROM tags_cache")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            (
                r.tag_id,
                DerivedTagRow {
                    name: r.name,
                    usage_count: r.usage_count,
                    space_id: r.space_id,
                },
            )
        })
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
///     pairs whose SOURCE block is live and in the tag's own space (#5275 —
///     the rows survive the block's move to another space). A tag with no
///     usages still gets a row, via the `LEFT JOIN` + `COALESCE(…, 0)`;
///   * duplicate names collapse (#626): `tags_cache` is `UNIQUE (space_id,
///     name)` but `blocks.content` is not, so among live tags of ONE SPACE
///     sharing a name only the SMALLEST `id` survives; the same name in
///     another space is its own row (#5237). Identity is
///     [`agaric_core::tag_norm::normalize_tag_name`] — NFC → full-Unicode
///     lowercase → NFC — and NOT `COLLATE NOCASE`, which folds ASCII only and
///     split non-ASCII case-variants the sync engine had already merged
///     (#1990).
///
/// `block_tag_refs` is read as STORED rather than re-derived from content.
/// It is audited by Artefact 12, so each artefact checks one derivation step and
/// a stale inline-ref row is reported against the table that owns it instead of
/// being misattributed to this roll-up.
pub async fn rebuild_tags_cache_from_base(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<BTreeMap<String, DerivedTagRow>, AppError> {
    let explicit = dump_block_tags(pool).await?;
    let inline = dump_block_tag_refs(pool).await?;
    Ok(fold_tags_cache_from_base(blocks, &explicit, &inline))
}

fn fold_tags_cache_from_base(
    blocks: &[BaseBlock],
    explicit: &[(String, String)],
    inline: &[(String, String)],
) -> BTreeMap<String, DerivedTagRow> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    // Distinct (tag, source) pairs from both arms, source-liveness and
    // same-space enforced — the `UNION`'s dedup and each arm's `JOIN blocks …
    // WHERE deleted_at IS NULL AND blk.space_id IS tag.space_id`.
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
        let (Some(source), Some(tag)) = (by_id.get(source_id), by_id.get(tag_id)) else {
            continue;
        };
        if source.deleted_at.is_some() || source.space_id != tag.space_id {
            continue;
        }
        usages.entry(tag_id).or_default().insert(source_id);
    }

    // Survivors: smallest id per (space, normalised name), among live named
    // tags. The content travels WITH the winner: recovering it afterwards
    // would need a fallback for the NULL the `else { continue }` above already
    // excluded, and that fallback would assert `name: ""` instead of failing.
    let mut winner_by_norm: BTreeMap<(Option<&str>, String), (&str, &str)> = BTreeMap::new();
    for tag in blocks
        .iter()
        .filter(|b| b.block_type == "tag" && b.deleted_at.is_none())
    {
        let Some(content) = tag.content.as_deref() else {
            continue;
        };
        let key = (
            tag.space_id.as_deref(),
            agaric_core::tag_norm::normalize_tag_name(content),
        );
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
        .into_iter()
        .map(|((space_id, _), (id, content))| {
            let usage_count = usages.get(id).map_or(0, |sources| {
                i64::try_from(sources.len()).unwrap_or(i64::MAX)
            });
            (
                id.to_owned(),
                DerivedTagRow {
                    name: content.to_owned(),
                    usage_count,
                    space_id: space_id.map(str::to_owned),
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
pub async fn reconcile_tags_cache(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<Vec<Divergence>, AppError> {
    let expected = rebuild_tags_cache_from_base(pool, blocks).await?;
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
                    "{} distinct live same-space source block(s) across block_tags ∪ block_tag_refs",
                    want.usage_count
                ),
                actual: format!("{}", got.usage_count),
                owner: TAGS_CACHE_OWNER,
            }),
            Some(got) if got.space_id != want.space_id => out.push(Divergence {
                artefact: "tags_cache.space_id",
                key: tag_id.clone(),
                expected: format!("{:?} (the tag block's own blocks.space_id)", want.space_id),
                actual: format!("{:?}", got.space_id),
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
                       duplicate-name tie-break to a smaller id in its space)"
                .to_owned(),
            actual: "a row in tags_cache".to_owned(),
            owner: TAGS_CACHE_OWNER,
        });
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// Artefact 14 — `block_tag_inherited`, materialised tag inheritance (#5628)
// ---------------------------------------------------------------------------

/// How many parents up a tag can reach a block. Production's walk seeds a
/// tagger's children at depth 0 and recurses while `depth < 100`
/// (`tag_inh_descendant_tags_full!`), so the farthest tagger sits 101 parents
/// up. Real trees are far shallower (`MAX_BLOCK_DEPTH`); the bound only bites
/// on a `parent_id` cycle, where it also ends the walk.
const TAG_INHERITANCE_REACH: usize = 101;

/// The `(block_id, tag_id) → inherited_from` map `block_tag_inherited` must
/// hold.
///
/// Transcribed from the definition on `tag_inheritance::rebuild_all` — the
/// arbiter every incremental maintainer converges on (#3876) — and folded
/// UPWARD from each block in Rust rather than re-expressed as its recursive
/// CTE:
///
/// * only explicit `block_tags` edges are sources; inline `block_tag_refs`
///   never inherit;
/// * a live block inherits every tag a STRICT ancestor holds, climbing
///   through live blocks only — the climb stops at the first tombstone, so a
///   tombstoned tagger is never a source either;
/// * the NEAREST such ancestor is `inherited_from`;
/// * a block that holds the tag itself still inherits it from above (#3876);
/// * neither the tag block's liveness nor any `block_type` is consulted.
///
/// No `visited` set, deliberately: production's `UNION ALL` recursion walks a
/// `parent_id` cycle until its depth cap, so a cycle member inherits even its
/// own tag, and a climb capped at [`TAG_INHERITANCE_REACH`] does the same.
fn fold_block_tag_inherited(
    blocks: &[BaseBlock],
    block_tags: &[(String, String)],
) -> BTreeMap<(String, String), String> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let mut tags_held: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (block_id, tag_id) in block_tags {
        tags_held
            .entry(block_id.as_str())
            .or_default()
            .push(tag_id.as_str());
    }

    let mut out = BTreeMap::new();
    for block in blocks.iter().filter(|b| b.deleted_at.is_none()) {
        let mut parent_id = block.parent_id.as_deref();
        for _ in 0..TAG_INHERITANCE_REACH {
            let Some(ancestor) = parent_id.and_then(|p| by_id.get(p)) else {
                break;
            };
            if ancestor.deleted_at.is_some() {
                break;
            }
            for tag_id in tags_held.get(ancestor.id.as_str()).into_iter().flatten() {
                out.entry((block.id.clone(), (*tag_id).to_owned()))
                    .or_insert_with(|| ancestor.id.clone());
            }
            parent_id = ancestor.parent_id.as_deref();
        }
    }
    out
}

/// [`fold_block_tag_inherited`] over the caller's `blocks` dump and a fresh
/// `block_tags` read.
pub async fn rebuild_block_tag_inherited_from_base(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<BTreeMap<(String, String), String>, AppError> {
    Ok(fold_block_tag_inherited(
        blocks,
        &dump_block_tags(pool).await?,
    ))
}

async fn dump_block_tag_inherited(
    pool: &SqlitePool,
) -> Result<BTreeMap<(String, String), String>, AppError> {
    let rows = sqlx::query!("SELECT block_id, tag_id, inherited_from FROM block_tag_inherited")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| ((r.block_id, r.tag_id), r.inherited_from))
        .collect())
}

const BLOCK_TAG_INHERITED_OWNER: &str = "the in-transaction arms of \
     tag_inheritance::apply_op_tag_inheritance (inherit_parent_tags on create, \
     remove_subtree_inherited on delete, recompute_subtree_inheritance on move, restore and a \
     page's space migration, propagate_tag_to_descendants / remove_inherited_tag on add / \
     remove tag), the purge cascades and loro_sync's post-import refresh, backstopped by \
     rebuild_all (the RebuildTagInheritanceCache task): tag filters and inherited-tag queries \
     read this table, so a missing row hides a block from a filter that should match it";

const BLOCK_TAG_INHERITED_PROVENANCE_OWNER: &str = "propagate_tag_to_descendants is a plain \
     INSERT OR IGNORE, so tagging a nearer ancestor after a farther one keeps the farther one \
     here until the RebuildTagInheritanceCache task add_tag enqueues has run (#2669); on a \
     settled vault a mismatch is a maintainer that stored the wrong ancestor";

/// `block_tag_inherited` MEMBERSHIP against the fold, both directions,
/// MISSING first, each sorted by `(block, tag)`.
///
/// Membership only: every in-transaction arm must leave exactly these rows,
/// so this belongs in the per-op gate. Provenance does not — see
/// [`diff_block_tag_inherited_provenance`].
fn diff_block_tag_inherited_rows(
    expected: &BTreeMap<(String, String), String>,
    stored: &BTreeMap<(String, String), String>,
    out: &mut Vec<Divergence>,
) {
    for ((block_id, tag_id), inherited_from) in expected {
        if stored.contains_key(&(block_id.clone(), tag_id.clone())) {
            continue;
        }
        out.push(Divergence {
            artefact: "block_tag_inherited.row",
            key: format!("{block_id} -> {tag_id}"),
            expected: format!(
                "a row inherited from {inherited_from} (the nearest live ancestor holding the \
                 tag, reached through live blocks)"
            ),
            actual: "no row in block_tag_inherited".to_owned(),
            owner: BLOCK_TAG_INHERITED_OWNER,
        });
    }
    for ((block_id, tag_id), inherited_from) in stored {
        if expected.contains_key(&(block_id.clone(), tag_id.clone())) {
            continue;
        }
        out.push(Divergence {
            artefact: "block_tag_inherited.row",
            key: format!("{block_id} -> {tag_id}"),
            expected: "no row (the block is tombstoned, or no live ancestor reached through \
                       live blocks holds the tag in block_tags)"
                .to_owned(),
            actual: format!("a row inherited from {inherited_from}"),
            owner: BLOCK_TAG_INHERITED_OWNER,
        });
    }
}

/// `block_tag_inherited.inherited_from` against the fold, for the rows both
/// sides hold.
///
/// Kept out of [`reconcile`]: `add_tag`'s in-transaction arm leaves a stale
/// ancestor here by design and relies on the vault-wide rebuild it enqueues
/// (#2669). Running that rebuild as a per-op settle would also repair every
/// delete and restore a generated chain drives, which is what the gate exists
/// to audit. A whole-vault run after the app has settled is the place for it.
fn diff_block_tag_inherited_provenance(
    expected: &BTreeMap<(String, String), String>,
    stored: &BTreeMap<(String, String), String>,
) -> Vec<Divergence> {
    expected
        .iter()
        .filter_map(|(key, want)| {
            let got = stored.get(key)?;
            (got != want).then(|| Divergence {
                artefact: "block_tag_inherited.inherited_from",
                key: format!("{} -> {}", key.0, key.1),
                expected: want.clone(),
                actual: got.clone(),
                owner: BLOCK_TAG_INHERITED_PROVENANCE_OWNER,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Artefact 15 — SQL `blocks` against the Loro engine (#5628)
// ---------------------------------------------------------------------------

/// The promoted property keys the engine holds like any other key, each with
/// the divergence it reports as.
const ENGINE_PROMOTED_COLUMNS: [(&str, &str); 4] = [
    ("todo_state", "engine.blocks.todo_state"),
    ("priority", "engine.blocks.priority"),
    ("due_date", "engine.blocks.due_date"),
    ("scheduled_date", "engine.blocks.scheduled_date"),
];

/// One engine node, reduced to the `blocks` columns the engine owns.
struct EngineBlock {
    block_type: String,
    content: String,
    parent_id: Option<String>,
    /// Dense rank in the doc's tree order — the value SQL `position` projects.
    position: i64,
    /// [`ENGINE_PROMOTED_COLUMNS`] order.
    promoted: [Option<String>; 4],
    /// No `deleted_at` register on the node.
    live: bool,
    /// The node's tag map, as `read_tags` dedups it.
    tags: Vec<String>,
    /// The node's alias map; `None` when it never held one.
    aliases: Option<Vec<String>>,
    /// The node's property map, the promoted keys and `space` included.
    properties: Vec<(String, PropertyValue)>,
}

/// One engine attachment entry and the node that holds it.
struct EngineAttachmentEntry {
    space_id: String,
    block_id: String,
    entry: agaric_engine::loro::engine::EngineAttachment,
}

/// Every engine the registry holds, read without writing anything.
#[derive(Default)]
struct EngineView {
    /// Keyed `(space_id, block_id)`.
    blocks: BTreeMap<(String, String), EngineBlock>,
    /// Every space with an engine, including empty ones: a block SQL places
    /// in one of these must be in it.
    spaces: BTreeSet<String>,
    /// Keyed by attachment id: the entries the docs' nodes hold, tombstones
    /// included (#5608).
    attachments: BTreeMap<String, EngineAttachmentEntry>,
    /// Keyed `(space_id, key)`: each doc's `property_definitions` root.
    definitions: BTreeMap<(String, String), PropertyDefState>,
}

/// One exported doc's nodes, the attachment entries they hold, and its
/// property definitions.
type EngineSpace = (
    Vec<(String, EngineBlock)>,
    Vec<(String, agaric_engine::loro::engine::EngineAttachment)>,
    Vec<(String, PropertyDefState)>,
);

/// Every node of one exported doc: the import-then-read that
/// `db::recovery::reproject_space_from_engine` runs on a persisted snapshot,
/// without its SQL writes.
fn read_engine_space(bytes: &[u8]) -> Result<EngineSpace, AppError> {
    let mut engine = agaric_engine::loro::engine::LoroEngine::new();
    engine.import(bytes)?;
    let ids = engine.live_blocks_preorder();
    let id_refs: Vec<&str> = ids.iter().map(agaric_core::ulid::BlockId::as_str).collect();
    let cores = engine.read_blocks_bulk(&id_refs)?;
    let mut out = Vec::with_capacity(id_refs.len());
    let mut attachments = Vec::new();
    for (block_id, core) in id_refs.into_iter().zip(cores) {
        for entry in engine.read_attachments(block_id)?.unwrap_or_default() {
            attachments.push((block_id.to_owned(), entry));
        }
        let core = core.ok_or_else(|| {
            AppError::validation(format!("engine enumerates {block_id} but cannot read it"))
        })?;
        let properties = engine.read_all_properties_typed(block_id)?;
        let promoted = ENGINE_PROMOTED_COLUMNS.map(|(key, _)| {
            properties
                .iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, value)| value.as_legacy_string())
        });
        out.push((
            block_id.to_owned(),
            EngineBlock {
                block_type: core.block_type,
                content: core.content,
                parent_id: core.parent_id,
                position: core.position,
                promoted,
                live: engine.read_deleted_at(block_id)?.is_none(),
                tags: engine.read_tags(block_id)?,
                aliases: engine.read_page_aliases(block_id)?,
                properties,
            },
        ));
    }
    Ok((out, attachments, engine.read_property_defs()?))
}

/// Read every engine the registry holds.
///
/// The LIVE registry, exported doc by doc, not `loro_doc_state`: a persisted
/// snapshot lags the engine by every op since the last snapshot pass, which
/// would read as a divergence on every recent edit. `snapshot_all_engines`
/// neither marks a space dirty nor creates an engine. A doc that cannot be
/// exported or read fails the run, as a table the oracle cannot read does.
fn read_engine_view(
    registry: &agaric_engine::loro::registry::LoroEngineRegistry,
) -> Result<EngineView, AppError> {
    let mut view = EngineView::default();
    for (space_id, bytes) in registry.snapshot_all_engines() {
        let space_id = space_id.as_str().to_owned();
        let (blocks, attachments, definitions) = read_engine_space(&bytes?)?;
        for (block_id, block) in blocks {
            view.blocks.insert((space_id.clone(), block_id), block);
        }
        for (key, def) in definitions {
            view.definitions.insert((space_id.clone(), key), def);
        }
        for (block_id, entry) in attachments {
            view.attachments.insert(
                entry.attachment_id.clone(),
                EngineAttachmentEntry {
                    space_id: space_id.clone(),
                    block_id,
                    entry,
                },
            );
        }
        view.spaces.insert(space_id);
    }
    Ok(view)
}

const ENGINE_ROW_MISSING_OWNER: &str = "the block's ops took the SQL-only fallback \
     (SqlOnlyFallbackReason::EngineMissingTarget, or SpaceUnresolved before its space \
     resolved) and nothing replayed them into the engine: since #5418 a snapshot pass advances \
     the apply cursor, so boot replays only the ops after it. The engine is what syncs and what \
     an engine-first recovery reprojects, so this block reaches no peer and does not survive \
     that recovery. Expected, not a defect, while the block is in sync_deferred_purges: a sync \
     import took it out of its doc and the next completed pull purges it, or keeps it if \
     another space's doc claims it (#5712)";

const ENGINE_ROW_EXTRA_OWNER: &str = "a purge or projection cleared SQL without the engine, or \
     an inbound import's projection never committed: a peer importing this doc, or an \
     engine-first recovery, brings the block back";

const ENGINE_COLUMN_OWNER: &str = "the per-op projections in agaric-engine's loro::projection \
     (project_*_to_sql), which every apply path runs after the engine apply, and the SQL-only \
     fallbacks that write SQL without the engine (a cross-space move, the #5418 replay \
     window): SQL shows one value while the next sync merge and an engine-first recovery act \
     on the engine's";

const ENGINE_LIVENESS_OWNER: &str = "a delete that reached SQL but not the engine: the \
     post-commit cohort fan-out (dispatch_delete_descendants) skipped or not yet run, or a \
     delete replayed at boot that could not resolve its space (#5630). While it stands the \
     #1257 freshness gate in loro_sync::prepare_outgoing refuses to export this space, so \
     sync stops for it";

/// Row membership in both directions: an engine node SQL has no row for, and
/// a LIVE SQL block whose resolved space has a doc that lacks it. A block
/// whose space resolves to nothing, or to a space with no engine, is expected
/// in no doc; a tombstone is left out the way `resolve_block_space` leaves it
/// out when routing an op.
fn diff_engine_membership(
    view: &EngineView,
    by_id: &BTreeMap<&str, &BaseBlock>,
    out: &mut Vec<Divergence>,
) {
    for block_id in by_id.keys() {
        let Some(space_id) = fold_block_space(by_id, block_id) else {
            continue;
        };
        if !view.spaces.contains(&space_id)
            || view
                .blocks
                .contains_key(&(space_id.clone(), (*block_id).to_owned()))
        {
            continue;
        }
        out.push(Divergence {
            artefact: "engine.blocks.row",
            key: format!("{space_id} / {block_id}"),
            expected: format!("a node in space {space_id}'s engine"),
            actual: "a live SQL row the engine does not hold".to_owned(),
            owner: ENGINE_ROW_MISSING_OWNER,
        });
    }
    for (space_id, block_id) in view.blocks.keys() {
        if by_id.contains_key(block_id.as_str()) {
            continue;
        }
        out.push(Divergence {
            artefact: "engine.blocks.row",
            key: format!("{space_id} / {block_id}"),
            expected: "a blocks row (the engine holds the node)".to_owned(),
            actual: "no row in blocks".to_owned(),
            owner: ENGINE_ROW_EXTRA_OWNER,
        });
    }
}

/// Each block's 1-based place among the siblings BOTH sides hold under the
/// same parent, as `(engine place, SQL place)`, keyed `(space, block)`.
///
/// Places, not rank values: a purge takes the node out of the engine tree
/// and leaves its SQL siblings' ranks with a gap, which is the same order
/// under other numbers — every reader orders by `(position, id)`. Siblings on
/// one side only, or under another parent, are reported by the membership
/// and `parent_id` arms and left out here so they do not shift every later
/// sibling's place.
fn sibling_places(
    view: &EngineView,
    by_id: &BTreeMap<&str, &BaseBlock>,
) -> BTreeMap<(String, String), (usize, usize)> {
    type Sibling<'a> = (&'a str, i64, Option<i64>);
    let mut groups: BTreeMap<(&str, Option<&str>), Vec<Sibling<'_>>> = BTreeMap::new();
    for ((space_id, block_id), engine) in &view.blocks {
        let Some(sql) = by_id.get(block_id.as_str()) else {
            continue;
        };
        if sql.parent_id == engine.parent_id {
            groups
                .entry((space_id.as_str(), engine.parent_id.as_deref()))
                .or_default()
                .push((block_id.as_str(), engine.position, sql.position));
        }
    }
    let mut places = BTreeMap::new();
    for ((space_id, _), mut siblings) in groups {
        siblings.sort_by_key(|&(id, engine_rank, _)| (engine_rank, id));
        let engine_places: BTreeMap<&str, usize> = siblings
            .iter()
            .enumerate()
            .map(|(place, &(id, _, _))| (id, place + 1))
            .collect();
        // SQLite's ascending `ORDER BY position` puts NULL first, as `None` sorts.
        siblings.sort_by_key(|&(id, _, sql_position)| (sql_position, id));
        for (place, &(id, _, _)) in siblings.iter().enumerate() {
            places.insert(
                (space_id.to_owned(), id.to_owned()),
                (engine_places[id], place + 1),
            );
        }
    }
    places
}

/// Every engine-owned column of every node SQL also holds, then the one
/// liveness direction production already requires to be empty (#1257).
///
/// `deleted_at` is not compared value for value: the register holds a delete
/// seed on the import path but the whole cohort on the op path
/// (`reproject_block_deleted_at_from_engine`), so only "live in the engine,
/// deleted in SQL" is a defect on every path. SQL NULL content reads as the
/// empty string the engine holds for it.
fn diff_engine_columns(
    view: &EngineView,
    by_id: &BTreeMap<&str, &BaseBlock>,
    out: &mut Vec<Divergence>,
) {
    let places = sibling_places(view, by_id);
    for ((space_id, block_id), engine) in &view.blocks {
        let Some(sql) = by_id.get(block_id.as_str()) else {
            continue;
        };
        let key = format!("{space_id} / {block_id}");
        let mut differ = |artefact: &'static str, expected: String, actual: String, owner| {
            if expected != actual {
                out.push(Divergence {
                    artefact,
                    key: key.clone(),
                    expected,
                    actual,
                    owner,
                });
            }
        };
        let sql_promoted = [
            &sql.todo_state,
            &sql.priority,
            &sql.due_date,
            &sql.scheduled_date,
        ];
        let o = ENGINE_COLUMN_OWNER;
        differ(
            "engine.blocks.block_type",
            engine.block_type.clone(),
            sql.block_type.clone(),
            o,
        );
        differ(
            "engine.blocks.content",
            engine.content.clone(),
            sql.content.clone().unwrap_or_default(),
            o,
        );
        differ(
            "engine.blocks.parent_id",
            format!("{:?}", engine.parent_id),
            format!("{:?}", sql.parent_id),
            o,
        );
        if let Some((engine_place, sql_place)) = places.get(&(space_id.clone(), block_id.clone())) {
            differ(
                "engine.blocks.position",
                format!("place {engine_place} among the siblings both sides hold"),
                format!("place {sql_place} among the siblings both sides hold"),
                o,
            );
        }
        for ((_, artefact), (want, got)) in ENGINE_PROMOTED_COLUMNS
            .iter()
            .zip(engine.promoted.iter().zip(sql_promoted))
        {
            differ(artefact, format!("{want:?}"), format!("{got:?}"), o);
        }
        if let (true, Some(deleted_at)) = (engine.live, sql.deleted_at) {
            out.push(Divergence {
                artefact: "engine.blocks.deleted_at",
                key,
                expected: "live (the engine node carries no delete register)".to_owned(),
                actual: format!("soft-deleted at {deleted_at}"),
                owner: ENGINE_LIVENESS_OWNER,
            });
        }
    }
}

const ENGINE_ATTACHMENT_ROW_MISSING_OWNER: &str = "a delete or purge that removed the row \
     without the engine (the SQL-only fallback), or an import whose projection never committed: \
     peers still show the attachment, and an engine-first recovery brings the row back";

const ENGINE_ATTACHMENT_ROW_EXTRA_OWNER: &str = "the add took the SQL-only fallback and the \
     boot backfill (repair::attachments) has not run since, or a delete reached the engine but \
     not SQL: peers do not show this attachment, and an engine-first recovery drops the row";

const ENGINE_ATTACHMENT_FIELD_OWNER: &str = "the attachment writers in agaric-engine's \
     apply::attachments and loro::projection::reproject_attachments_from_engine, which write the \
     row from the op or the engine: SQL shows one value while peers and an engine-first recovery \
     use the engine's";

/// `attachments` against the engine entries the docs' nodes hold (#5608), in
/// both directions: a live entry SQL has no row for, a row the engine holds
/// deleted, and a row whose block resolves to a space with an engine that
/// holds no entry for it. Each field the projection writes from the engine is
/// compared, the filename as the projection sanitises it.
///
/// Not compared: `fs_path` and an absent `content_hash` on either side,
/// which belong to the device once its row exists (dedup repoints the path;
/// a row older than the op's hash gets one from the boot hash backfill).
fn diff_engine_attachments(
    view: &EngineView,
    by_id: &BTreeMap<&str, &BaseBlock>,
    attachments: &[BaseAttachment],
    out: &mut Vec<Divergence>,
) {
    let rows: BTreeMap<&str, &BaseAttachment> =
        attachments.iter().map(|a| (a.id.as_str(), a)).collect();
    for (id, held) in &view.attachments {
        let key = format!("{} / {id}", held.space_id);
        let row = rows.get(id.as_str());
        let (row, deleted) = match (row, held.entry.deleted_at) {
            (None, None) => {
                out.push(Divergence {
                    artefact: "engine.attachments.row",
                    key,
                    expected: format!("a row on block {}", held.block_id),
                    actual: "no row in attachments".to_owned(),
                    owner: ENGINE_ATTACHMENT_ROW_MISSING_OWNER,
                });
                continue;
            }
            (None, Some(_)) => continue,
            (Some(row), deleted) => (row, deleted),
        };
        if let Some(deleted_at) = deleted {
            out.push(Divergence {
                artefact: "engine.attachments.deleted_at",
                key,
                expected: format!("no row (the engine deleted it at {deleted_at})"),
                actual: "a row in attachments".to_owned(),
                owner: ENGINE_ATTACHMENT_ROW_EXTRA_OWNER,
            });
            continue;
        }
        diff_attachment_fields(&key, held, row, out);
    }
    for row in attachments {
        let Some(space_id) = fold_block_space(by_id, &row.block_id) else {
            continue;
        };
        if view.attachments.contains_key(&row.id) || !view.spaces.contains(&space_id) {
            continue;
        }
        out.push(Divergence {
            artefact: "engine.attachments.row",
            key: format!("{space_id} / {}", row.id),
            expected: "no row (the engine holds no entry)".to_owned(),
            actual: format!("a row on block {}", row.block_id),
            owner: ENGINE_ATTACHMENT_ROW_EXTRA_OWNER,
        });
    }
}

/// The row fields the projection writes from a live engine entry, the
/// filename as the projection sanitises it, and the hash only when both sides
/// hold one.
fn diff_attachment_fields(
    key: &str,
    held: &EngineAttachmentEntry,
    row: &BaseAttachment,
    out: &mut Vec<Divergence>,
) {
    let f = &held.entry.fields;
    let hashes = match (&f.content_hash, &row.content_hash) {
        (Some(engine), Some(sql)) => (engine.clone(), sql.clone()),
        _ => (String::new(), String::new()),
    };
    for (artefact, expected, actual) in [
        (
            "engine.attachments.block_id",
            held.block_id.clone(),
            row.block_id.clone(),
        ),
        (
            "engine.attachments.filename",
            agaric_core::attachment_filename::sanitize_attachment_filename(&f.filename),
            row.filename.clone(),
        ),
        (
            "engine.attachments.mime_type",
            f.mime_type.clone(),
            row.mime_type.clone(),
        ),
        (
            "engine.attachments.size_bytes",
            f.size_bytes.to_string(),
            row.size_bytes.to_string(),
        ),
        (
            "engine.attachments.created_at",
            f.created_at.to_string(),
            row.created_at.to_string(),
        ),
        ("engine.attachments.content_hash", hashes.0, hashes.1),
    ] {
        if expected != actual {
            out.push(Divergence {
                artefact,
                key: key.to_owned(),
                expected,
                actual,
                owner: ENGINE_ATTACHMENT_FIELD_OWNER,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Artefact 16 — `block_tags` and `page_aliases` against the Loro engine (#6207)
// ---------------------------------------------------------------------------

async fn dump_page_aliases(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query!("SELECT page_id, alias FROM page_aliases")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.page_id, r.alias)).collect())
}

const ENGINE_BLOCK_TAGS_OWNER: &str = "the tag writers in agaric-engine: \
     project_add_tag_to_sql / project_remove_tag_to_sql after the engine apply (the local \
     apply arms, the op-log recovery arms) and the SQL-only fallback that runs them without \
     the engine, reproject_block_tags_from_engine (sync import, engine-first recovery), and \
     the purge cascades: SQL shows one tag set while peers and an engine-first recovery use \
     the engine's";

const ENGINE_PAGE_ALIASES_OWNER: &str = "the alias writers in agaric-engine: \
     project_add_page_alias_to_sql / project_remove_page_alias_to_sql after the engine apply \
     (the local apply arms, the op-log recovery arms), reproject_page_aliases_from_engine \
     (sync import, engine-first recovery; it gives a contested alias to the lower page id), \
     the purge cascades, and repair::page_aliases, the boot backfill of rows written before \
     #5387. Removing or purging a contested alias's holder does not hand the alias to the \
     next claimant (#6229), which reads here as a missing row until an engine-first recovery \
     projects it";

/// The blocks a doc holds and `blocks` has a row for, each with that doc's
/// space and node. A block on one side only is [`diff_engine_membership`]'s,
/// and a block in a space with no engine has nothing to compare against.
fn engine_held_blocks<'a>(
    view: &'a EngineView,
    by_id: &BTreeMap<&str, &BaseBlock>,
) -> BTreeMap<&'a str, (&'a str, &'a EngineBlock)> {
    view.blocks
        .iter()
        .filter(|((_, block_id), _)| by_id.contains_key(block_id.as_str()))
        .map(|((space_id, block_id), node)| (block_id.as_str(), (space_id.as_str(), node)))
        .collect()
}

/// `block_tags` as the held nodes' tag maps make it, less the tag ids with no
/// `blocks` row: a purged tag's id stays in the map of every block it tagged,
/// and no row can reference it.
fn fold_engine_block_tags(
    held: &BTreeMap<&str, (&str, &EngineBlock)>,
    by_id: &BTreeMap<&str, &BaseBlock>,
) -> BTreeSet<(String, String)> {
    held.iter()
        .flat_map(|(block_id, (_, node))| {
            node.tags
                .iter()
                .filter(|tag_id| by_id.contains_key(tag_id.as_str()))
                .map(|tag_id| ((*block_id).to_owned(), tag_id.clone()))
        })
        .collect()
}

/// `page_aliases` as the held pages' alias maps make it. An alias belongs to
/// the lowest page id that claims it, spelled as that page's map holds it,
/// whichever device merged the claims (#5387); claims are keyed by the alias
/// trimmed and ASCII-lowercased, the fold `COLLATE NOCASE` compares with.
fn fold_engine_page_aliases(
    held: &BTreeMap<&str, (&str, &EngineBlock)>,
) -> BTreeSet<(String, String)> {
    let mut holders: BTreeMap<String, (&str, &str)> = BTreeMap::new();
    // `held` iterates by page id, so a key's first claim is the lowest page's.
    for (page_id, (_, node)) in held {
        for alias in node.aliases.iter().flatten() {
            let alias = alias.trim();
            holders
                .entry(alias.to_ascii_lowercase())
                .or_insert((page_id, alias));
        }
    }
    holders
        .into_values()
        .map(|(page_id, alias)| (page_id.to_owned(), alias.to_owned()))
        .collect()
}

/// `(block, tag)` rows against the engine's, both directions, over the held
/// blocks only.
fn diff_engine_block_tags(
    held: &BTreeMap<&str, (&str, &EngineBlock)>,
    by_id: &BTreeMap<&str, &BaseBlock>,
    block_tags: &[(String, String)],
    out: &mut Vec<Divergence>,
) {
    let expected = fold_engine_block_tags(held, by_id);
    let stored: BTreeSet<(String, String)> = block_tags
        .iter()
        .filter(|(block_id, _)| held.contains_key(block_id.as_str()))
        .cloned()
        .collect();
    let key = |block_id: &str, tag_id: &str| {
        let space_id = held.get(block_id).map_or("", |(space_id, _)| space_id);
        format!("{space_id} / {block_id} -> {tag_id}")
    };
    for (block_id, tag_id) in expected.difference(&stored) {
        out.push(Divergence {
            artefact: "engine.block_tags.row",
            key: key(block_id, tag_id),
            expected: "a block_tags row (the engine's tag map holds the tag)".to_owned(),
            actual: "no row in block_tags".to_owned(),
            owner: ENGINE_BLOCK_TAGS_OWNER,
        });
    }
    for (block_id, tag_id) in stored.difference(&expected) {
        out.push(Divergence {
            artefact: "engine.block_tags.row",
            key: key(block_id, tag_id),
            expected: "no row (the engine's tag map does not hold the tag)".to_owned(),
            actual: "a row in block_tags".to_owned(),
            owner: ENGINE_BLOCK_TAGS_OWNER,
        });
    }
}

/// `(page, alias)` rows against the engine's, both directions, over the held
/// pages only. The key carries ids alone: an alias is the user's text, and the
/// report a user files keeps keys and drops values (#609).
fn diff_engine_page_aliases(
    held: &BTreeMap<&str, (&str, &EngineBlock)>,
    page_aliases: &[(String, String)],
    out: &mut Vec<Divergence>,
) {
    let expected = fold_engine_page_aliases(held);
    let stored: BTreeSet<(String, String)> = page_aliases
        .iter()
        .filter(|(page_id, _)| held.contains_key(page_id.as_str()))
        .cloned()
        .collect();
    let key = |page_id: &str| {
        let space_id = held.get(page_id).map_or("", |(space_id, _)| space_id);
        format!("{space_id} / {page_id}")
    };
    for (page_id, alias) in expected.difference(&stored) {
        out.push(Divergence {
            artefact: "engine.page_aliases.row",
            key: key(page_id),
            expected: format!("a page_aliases row for {alias:?} (the lowest page id claiming it)"),
            actual: format!("no row for {alias:?} on this page"),
            owner: ENGINE_PAGE_ALIASES_OWNER,
        });
    }
    for (page_id, alias) in stored.difference(&expected) {
        out.push(Divergence {
            artefact: "engine.page_aliases.row",
            key: key(page_id),
            expected: format!("no row for {alias:?} (no claim, or a lower page id's)"),
            actual: format!("a page_aliases row for {alias:?}"),
            owner: ENGINE_PAGE_ALIASES_OWNER,
        });
    }
}

/// `block_tags` and `page_aliases` against the engine view.
fn diff_engine_tags_and_aliases(
    view: &EngineView,
    by_id: &BTreeMap<&str, &BaseBlock>,
    block_tags: &[(String, String)],
    page_aliases: &[(String, String)],
    out: &mut Vec<Divergence>,
) {
    let held = engine_held_blocks(view, by_id);
    diff_engine_block_tags(&held, by_id, block_tags, out);
    diff_engine_page_aliases(&held, page_aliases, out);
}

// ---------------------------------------------------------------------------
// Artefact 18 — `block_properties` and `property_definitions` against the
// Loro engine (#6206)
// ---------------------------------------------------------------------------

/// One `property_definitions` row: a space's own definition of a key. The
/// built-ins are code constants with no row (migration 0128).
#[derive(Debug, Clone)]
pub struct BaseDefinition {
    space_id: String,
    key: String,
    value_type: String,
    /// A select's options, as the JSON array the row stores.
    options: Option<String>,
}

async fn dump_property_definitions(pool: &SqlitePool) -> Result<Vec<BaseDefinition>, AppError> {
    let rows = sqlx::query!("SELECT space_id, key, value_type, options FROM property_definitions")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| BaseDefinition {
            space_id: r.space_id,
            key: r.key,
            value_type: r.value_type,
            options: r.options,
        })
        .collect())
}

const ENGINE_BLOCK_PROPERTIES_OWNER: &str = "the property writers in agaric-engine: \
     project_set_property_to_sql / project_delete_property_to_sql after the engine apply (the \
     local apply arms, the op-log recovery arms), reproject_block_properties_from_engine and its \
     per-key reproject_property_row_from_engine (sync import, engine-first recovery), \
     reproject_key_values (the retype a SetPropertyDef or RewriteProperties runs, and the \
     import's definitions pass), project_property_value_writes (RewriteProperties), \
     project_rename_property_key_to_sql / project_rename_property_option_to_sql, and the purge \
     cascades: SQL shows one value while peers and an engine-first recovery use the engine's. \
     A ref to a block the same import projects later (a page's ref to its own child) reads \
     here as a missing row: the import's property pass runs block by block, the FK guard in \
     reproject_property_row_from_engine drops the ref, and nothing projects it again until \
     the referring block changes (#6232)";

const ENGINE_PROPERTY_DEFINITIONS_OWNER: &str = "project_property_def_to_sql after the engine \
     apply of SetPropertyDef, RenamePropertyOption and RewriteProperties, \
     project_rename_property_key_to_sql, the import's definitions pass (project_pass_defs), \
     engine-first recovery (project_engine_property_defs) and the space purge cascade: SQL types \
     this space's values by one definition while peers and an engine-first recovery use the \
     doc's";

const ENGINE_PROPERTY_DEFINITIONS_SQL_ONLY_OWNER: &str = "repair_property_definitions, the \
     boot backfill that gives a row written before #5841 its SetPropertyDef: it runs at every \
     boot, after recovery (which keeps such a row), so the row is one it has not landed yet (it \
     failed and logged, and the next boot retries it) or one a writer put in SQL without the \
     engine: no peer receives this definition";

/// A Crockford base32 ULID in either case that fits 128 bits: 26 characters,
/// the first at most `7`.
static ORACLE_ULID_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-7][0-9A-HJKMNP-TV-Z]{25}$").expect("ULID pattern compiles")
});

/// `s` is a calendar-valid `YYYY-MM-DD`: ten characters that chrono reads as a
/// date and prints back unchanged, which no unpadded or signed form survives.
fn oracle_is_date(s: &str) -> bool {
    s.len() == 10
        && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == s)
}

/// One `block_properties` value, by the column that holds it.
#[derive(Debug, Clone, PartialEq)]
enum PropertyCell {
    Text(String),
    Num(f64),
    Date(String),
    Ref(String),
    Bool(bool),
}

impl std::fmt::Display for PropertyCell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Text(s) => write!(f, "value_text {s:?}"),
            Self::Num(n) => write!(f, "value_num {n}"),
            Self::Date(s) => write!(f, "value_date {s:?}"),
            Self::Ref(s) => write!(f, "value_ref {s}"),
            Self::Bool(b) => write!(f, "value_bool {b}"),
        }
    }
}

/// `row`'s value, in the one column `exactly_one_value` lets it fill.
fn stored_cell(row: &BaseProperty) -> Option<PropertyCell> {
    row.value_text
        .clone()
        .map(PropertyCell::Text)
        .or_else(|| row.value_num.map(PropertyCell::Num))
        .or_else(|| row.value_date.clone().map(PropertyCell::Date))
        .or_else(|| row.value_ref.clone().map(PropertyCell::Ref))
        .or_else(|| row.value_bool.map(PropertyCell::Bool))
}

/// Each row a correct vault can hold for one engine value under `value_type`
/// (`None`: neither a built-in nor the space declares the key), `None` among
/// them meaning no row. The oracle's own type check, written from the rules
/// and sharing nothing with `coerce`:
///
/// * a number, a boolean: its own column, whatever the type; a null: no row;
/// * a string under a number, boolean or date key: that column when it parses
///   as the type (trimmed and finite, exactly `true` / `false`, a strict
///   calendar date), else `value_text`;
/// * a string under a ref key: `value_ref`, uppercased, when it is a ULID whose
///   block has a row, no row when that block has none (the FK guard, and the
///   purge cascade that deletes a row its target takes with it), else
///   `value_text`;
/// * a string under any other type, or none: `value_text`, or the slot a local
///   write named. The local apply writes the payload's slot,
///   `validate_declared_type` lets text and select take a ref and an
///   undeclared key any slot, and no retype between types whose strings land
///   in `value_text` (`str_column_for`) moves the row. A re-projection writes
///   `value_text`, so devices already differ here: a ULID can be in
///   `value_ref`, or no row once its block is purged, and a date in
///   `value_date`. The cost: a projection that wrongly sends such a string to
///   `value_ref` or `value_date` reads as a local write and is not reported.
fn admissible_rows(
    value: &PropertyValue,
    value_type: Option<&str>,
    by_id: &BTreeMap<&str, &BaseBlock>,
) -> Vec<Option<PropertyCell>> {
    use PropertyCell as C;
    let s = match value {
        PropertyValue::Num(n) => return vec![Some(C::Num(*n))],
        PropertyValue::Bool(b) => return vec![Some(C::Bool(*b))],
        PropertyValue::Null => return vec![None],
        PropertyValue::Str(s) => s,
    };
    let text = Some(C::Text(s.clone()));
    let as_ref = ORACLE_ULID_RE.is_match(s).then(|| {
        let id = s.to_ascii_uppercase();
        by_id.contains_key(id.as_str()).then_some(C::Ref(id))
    });
    let as_date = oracle_is_date(s).then(|| Some(C::Date(s.clone())));
    match value_type {
        Some("number") => {
            let num = s.trim().parse::<f64>().ok().filter(|n| n.is_finite());
            vec![num.map(C::Num).or(text)]
        }
        Some("boolean") => vec![match s.as_str() {
            "true" => Some(C::Bool(true)),
            "false" => Some(C::Bool(false)),
            _ => text,
        }],
        Some("date") => vec![as_date.unwrap_or(text)],
        Some("ref") => vec![as_ref.unwrap_or(text)],
        _ => std::iter::once(text).chain(as_ref).chain(as_date).collect(),
    }
}

/// The type `key` has in `space_id`: the built-in's, else the space's own
/// definition's.
fn declared_type<'a>(
    definitions: &'a BTreeMap<(&str, &str), &BaseDefinition>,
    space_id: &str,
    key: &str,
) -> Option<&'a str> {
    agaric_store::op::BUILTIN_PROPERTY_DEFS
        .iter()
        .find(|def| def.key == key)
        .map(|def| def.value_type)
        .or_else(|| {
            definitions
                .get(&(space_id, key))
                .map(|def| def.value_type.as_str())
        })
}

/// `"when" (date): value_date "2026-01-05" or no row`.
fn describe_rows(key: &str, value_type: Option<&str>, rows: &[Option<PropertyCell>]) -> String {
    let rows: Vec<String> = rows
        .iter()
        .map(|row| {
            row.as_ref()
                .map_or_else(|| "no row".to_owned(), ToString::to_string)
        })
        .collect();
    format!(
        "{key:?} ({}): {}",
        value_type.unwrap_or("undeclared"),
        rows.join(" or ")
    )
}

/// One held block's rows against its node's values, every key either side
/// holds. The promoted keys live in `blocks` columns, compared by
/// [`diff_engine_columns`], and `space` is `blocks.space_id`, the doc
/// [`diff_engine_membership`] expects the block in.
fn diff_block_property_rows(
    (block_id, space_id, node): (&str, &str, &EngineBlock),
    stored: Option<&BTreeMap<&str, Option<PropertyCell>>>,
    definitions: &BTreeMap<(&str, &str), &BaseDefinition>,
    by_id: &BTreeMap<&str, &BaseBlock>,
    out: &mut Vec<Divergence>,
) {
    let column_backed =
        |key: &str| key == "space" || ENGINE_PROMOTED_COLUMNS.iter().any(|(k, _)| *k == key);
    let engine: BTreeMap<&str, &PropertyValue> = node
        .properties
        .iter()
        .filter(|(key, _)| !column_backed(key))
        .map(|(key, value)| (key.as_str(), value))
        .collect();
    let keys: BTreeSet<&str> = engine
        .keys()
        .copied()
        .chain(stored.into_iter().flat_map(|rows| rows.keys().copied()))
        .collect();
    for key in keys {
        let value_type = declared_type(definitions, space_id, key);
        let admissible = engine
            .get(key)
            .map_or_else(|| vec![None], |v| admissible_rows(v, value_type, by_id));
        let actual = stored.and_then(|rows| rows.get(key)).cloned().flatten();
        if admissible.contains(&actual) {
            continue;
        }
        out.push(Divergence {
            artefact: "engine.block_properties.row",
            key: format!("{space_id} / {block_id}"),
            expected: describe_rows(key, value_type, &admissible),
            actual: describe_rows(key, value_type, &[actual]),
            owner: ENGINE_BLOCK_PROPERTIES_OWNER,
        });
    }
}

/// `block_properties` against the held nodes' property maps, both directions:
/// each engine value against [`admissible_rows`] under its space's
/// definitions (the SQL rows, as the projection types by them, and the
/// built-ins), and each row against an engine value. The key carries ids
/// alone: the property key and the values are the user's text, and the report
/// a user files keeps keys and drops values (#609).
fn diff_engine_block_properties(
    held: &BTreeMap<&str, (&str, &EngineBlock)>,
    by_id: &BTreeMap<&str, &BaseBlock>,
    properties: &[BaseProperty],
    definitions: &[BaseDefinition],
    out: &mut Vec<Divergence>,
) {
    let definitions: BTreeMap<(&str, &str), &BaseDefinition> = definitions
        .iter()
        .map(|def| ((def.space_id.as_str(), def.key.as_str()), def))
        .collect();
    let mut stored: BTreeMap<&str, BTreeMap<&str, Option<PropertyCell>>> = BTreeMap::new();
    for row in properties
        .iter()
        .filter(|row| held.contains_key(row.block_id.as_str()))
    {
        stored
            .entry(row.block_id.as_str())
            .or_default()
            .insert(row.key.as_str(), stored_cell(row));
    }
    for (block_id, (space_id, node)) in held {
        diff_block_property_rows(
            (block_id, space_id, node),
            stored.get(block_id),
            &definitions,
            by_id,
            out,
        );
    }
}

/// A definition as both sides are compared: its type, and a select's options
/// as stored. Both sides take the one string the op carries.
fn comparable_definition(value_type: &str, options: Option<&str>) -> String {
    options.map_or_else(
        || value_type.to_owned(),
        |options| format!("{value_type} {options}"),
    )
}

/// `property_definitions` against each doc's root, both directions, for the
/// spaces with an engine. Built-ins are in neither. `created_at` is SQL's
/// alone. Keyed by the space; the property key is the user's text.
fn diff_engine_property_definitions(
    view: &EngineView,
    definitions: &[BaseDefinition],
    out: &mut Vec<Divergence>,
) {
    let doc: BTreeMap<(&str, &str), String> = view
        .definitions
        .iter()
        .map(|((space_id, key), def)| {
            let def = comparable_definition(&def.value_type, def.options.as_deref());
            ((space_id.as_str(), key.as_str()), def)
        })
        .collect();
    let stored: BTreeMap<(&str, &str), String> = definitions
        .iter()
        .filter(|def| view.spaces.contains(&def.space_id))
        .map(|def| {
            let comparable = comparable_definition(&def.value_type, def.options.as_deref());
            ((def.space_id.as_str(), def.key.as_str()), comparable)
        })
        .collect();
    let keys: BTreeSet<&(&str, &str)> = doc.keys().chain(stored.keys()).collect();
    for &(space_id, key) in keys {
        let (want, got) = (doc.get(&(space_id, key)), stored.get(&(space_id, key)));
        if want == got {
            continue;
        }
        let describe = |def: Option<&String>, side: &str| {
            def.map_or_else(
                || format!("{key:?}: {side}"),
                |def| format!("{key:?}: {def}"),
            )
        };
        out.push(Divergence {
            artefact: "engine.property_definitions.row",
            key: space_id.to_owned(),
            expected: describe(want, "no definition (the doc's root does not declare it)"),
            actual: describe(got, "no row in property_definitions"),
            owner: if want.is_some() {
                ENGINE_PROPERTY_DEFINITIONS_OWNER
            } else {
                ENGINE_PROPERTY_DEFINITIONS_SQL_ONLY_OWNER
            },
        });
    }
}

/// `block_properties` and `property_definitions` against the engine view.
fn diff_engine_properties(
    view: &EngineView,
    by_id: &BTreeMap<&str, &BaseBlock>,
    properties: &[BaseProperty],
    definitions: &[BaseDefinition],
    out: &mut Vec<Divergence>,
) {
    let held = engine_held_blocks(view, by_id);
    diff_engine_block_properties(&held, by_id, properties, definitions, out);
    diff_engine_property_definitions(view, definitions, out);
}

/// SQL `blocks` against the Loro engine — the merge truth for text, the tree
/// and typed scalar properties (AGENTS.md invariant 2). Every other artefact
/// audits a cache against SQL base tables; this one audits the base table.
///
/// Compared: row membership, `block_type`, `content`, `parent_id`, sibling
/// order (see [`sibling_places`]) and the four promoted property columns,
/// plus "live in the engine, deleted in SQL", the `attachments` rows (see
/// [`diff_engine_attachments`]), the `block_tags` and `page_aliases` rows
/// of the blocks both sides hold (#6207), with a purged tag's id dropped (see
/// [`fold_engine_block_tags`]) and a contested alias given to the lower page
/// id (see [`fold_engine_page_aliases`]), the other `block_properties` rows of
/// those blocks against the rows their values admit (see [`admissible_rows`]),
/// and `property_definitions` against each doc's root (#6206). Not compared,
/// because a correct vault legitimately differs: the reverse liveness
/// direction (see [`diff_engine_columns`]).
///
/// The engine side is read through the engine's own read API, the calls
/// `db::recovery::reproject_space_from_engine` makes; none of the projection
/// writers it audits runs. Divergences come back membership first, then
/// columns, attachments, tags, aliases, property rows and definitions, in a
/// stable order.
pub fn reconcile_engine(
    state: &agaric_engine::loro::shared::LoroState,
    blocks: &[BaseBlock],
    attachments: &[BaseAttachment],
    block_tags: &[(String, String)],
    page_aliases: &[(String, String)],
    properties: &[BaseProperty],
    definitions: &[BaseDefinition],
) -> Result<Vec<Divergence>, AppError> {
    let view = read_engine_view(&state.registry)?;
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let mut out = Vec::new();
    diff_engine_membership(&view, &by_id, &mut out);
    diff_engine_columns(&view, &by_id, &mut out);
    diff_engine_attachments(&view, &by_id, attachments, &mut out);
    diff_engine_tags_and_aliases(&view, &by_id, block_tags, page_aliases, &mut out);
    diff_engine_properties(&view, &by_id, properties, definitions, &mut out);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Artefact 10 — `agenda_cache`, the date roll-up (#3345)
// ---------------------------------------------------------------------------

/// One `block_properties` row: its five value columns, exactly one of them set
/// (CHECK `exactly_one_value`, migration 0062).
#[derive(Debug, Clone)]
pub struct BaseProperty {
    block_id: String,
    key: String,
    /// The typed date sidecar. NON-NULL is what promotes a property to an
    /// agenda source; the untyped `value` column is never consulted.
    value_date: Option<String>,
    /// Carries the `repeat` rule and, via `repeat-until`, nothing else — the
    /// projected agenda reads a rule only from here.
    value_text: Option<String>,
    /// Carries `repeat-count` / `repeat-seq`. REAL in the schema, whole numbers
    /// in practice.
    value_num: Option<f64>,
    /// Read only to compare against the engine.
    value_ref: Option<String>,
    /// Read only to compare against the engine.
    value_bool: Option<bool>,
}

async fn dump_block_properties(pool: &SqlitePool) -> Result<Vec<BaseProperty>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT block_id, key, value_date, value_text, value_num, value_ref,
                  value_bool AS "value_bool: bool"
           FROM block_properties"#
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| BaseProperty {
            block_id: r.block_id,
            key: r.key,
            value_date: r.value_date,
            value_text: r.value_text,
            value_num: r.value_num,
            value_ref: r.value_ref,
            value_bool: r.value_bool,
        })
        .collect())
}

/// Every `agenda_cache` row, keyed by its `(date, block_id)` primary key.
async fn dump_agenda_cache(
    pool: &SqlitePool,
) -> Result<BTreeMap<(String, String), String>, AppError> {
    let rows = sqlx::query!("SELECT date, block_id, source FROM agenda_cache")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| ((r.date, r.block_id), r.source))
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
    // The 1-indexed SUBSTR offsets 6-9, 11-12 and 14-15, re-expressed 0-indexed
    // on `date`: minus the five-character prefix AND minus one for the indexing
    // base.
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
///     non-NULL `value_date` (`property:<key>`) other than the lifecycle
///     timestamps `created_at` / `completed_at` / `repeat-until` (#5074), a
///     `date/YYYY-MM-DD` tag on the block (`tag:<tag_id>`), then the promoted
///     `due_date` and `scheduled_date` columns;
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
    blocks: &[BaseBlock],
) -> Result<BTreeMap<(String, String), BTreeSet<String>>, AppError> {
    let properties = dump_block_properties(pool).await?;
    let explicit = dump_block_tags(pool).await?;
    Ok(fold_agenda_cache_from_base(blocks, &properties, &explicit))
}

/// The pages both agenda folds exclude — `NOT EXISTS (SELECT 1 FROM
/// block_properties tp WHERE tp.block_id = b.page_id AND tp.key = 'template')`:
/// the KEY's presence excludes, whatever its value.
fn fold_template_pages(properties: &[BaseProperty]) -> BTreeSet<&str> {
    properties
        .iter()
        .filter(|p| p.key == "template")
        .map(|p| p.block_id.as_str())
        .collect()
}

fn fold_agenda_cache_from_base(
    blocks: &[BaseBlock],
    properties: &[BaseProperty],
    explicit: &[(String, String)],
) -> BTreeMap<(String, String), BTreeSet<String>> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let template_pages = fold_template_pages(properties);
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
        if matches!(
            property.key.as_str(),
            "created_at" | "completed_at" | "repeat-until"
        ) {
            continue;
        }
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
pub async fn reconcile_agenda_cache(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<Vec<Divergence>, AppError> {
    let expected = rebuild_agenda_cache_from_base(pool, blocks).await?;
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

// ---------------------------------------------------------------------------
// Artefact 11 — `projected_agenda_cache`, the recurrence horizon (#3345)
// ---------------------------------------------------------------------------

/// One `projected_agenda_cache` row: `(block_id, projected_date, source)`, the
/// table's whole primary key.
type ProjectedRow = (String, String, String);

async fn dump_projected_agenda_cache(
    pool: &SqlitePool,
) -> Result<BTreeSet<ProjectedRow>, AppError> {
    let rows = sqlx::query!("SELECT block_id, projected_date, source FROM projected_agenda_cache")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.block_id, r.projected_date, r.source))
        .collect())
}

/// `projected_agenda_cache` folded from base rows, for a PINNED `today`.
///
/// Transcribed from `rebuild_projected_agenda_cache_impl`'s source `SELECT` and
/// `project_block_into` (`agaric-store/src/cache/projected_agenda.rs`).
///
/// # This artefact audits ONE layer, and it is not the arithmetic
///
/// Every other artefact folds base rows into expected rows with no help from
/// the code it audits. This one cannot: the occurrence arithmetic lives in
/// [`agaric_store::recurrence_math::project_block_dates`], and a second
/// implementation of a recurrence expander would be a large new surface whose
/// own bugs would read as production defects. So the fold CALLS it, and audits
/// the layer around it — which blocks are eligible, and with which parameters:
///
///   * a row exists per LIVE block carrying a `repeat` property with a NON-NULL
///     `value_text`. `project_block_into` additionally skips an EMPTY rule, and
///     that guard is deliberately not mirrored: `project_block_dates`
///     normalises and returns on an empty rule anyway, so mirroring it would add
///     a branch no test could redden;
///   * `todo_state = 'DONE'` removes the block entirely;
///   * the block must carry at least one of `due_date` / `scheduled_date`;
///   * the same template exclusion as `agenda_cache`: a block whose owning page
///     carries a `template` property contributes nothing;
///   * `remaining` is `count - seq` when both are present and `count > seq`,
///     `count` when `seq` is absent, and `0` when `count <= seq` — the arm that
///     silently stops a finished series;
///   * two windows: every occurrence in
///     `[today - BACKWARD_WINDOW_DAYS, today - 1]`, uncapped (#5421), then
///     `range_start = today` with `NaiveDate::MAX` as the end sentinel, capped
///     at `HORIZON_OCCURRENCES` occurrences PER SOURCE.
///
/// So a divergence here means the wrong blocks were projected, or the right
/// ones with the wrong bounds — not that a `RRULE` was expanded incorrectly.
/// `recurrence_math` has its own tests for that. Stating the boundary is the
/// point: an oracle that quietly shares the code it audits is worse than no
/// oracle, because it reports confidence it does not have.
///
/// # `today` is a parameter, and that is load-bearing
///
/// Production reads `chrono::Local::now()`. The expected contents of this table
/// therefore change at local midnight, which makes this the one artefact that is
/// not a pure function of the database. It takes `today` explicitly, and callers
/// must pass the SAME date the rebuild used — otherwise a day rollover between
/// the rebuild and the check reads as a divergence, which is a flake rather than
/// a defect. That is also why it is deliberately NOT wired into the aggregate
/// [`reconcile`] sweep, which has no date to pin.
pub async fn rebuild_projected_agenda_from_base(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
    today: chrono::NaiveDate,
) -> Result<BTreeSet<ProjectedRow>, AppError> {
    let properties = dump_block_properties(pool).await?;
    Ok(fold_projected_agenda_from_base(blocks, &properties, today))
}

/// `remaining` as `project_block_into` derives it: `count - seq` while the
/// series has occurrences left, `count` with no `seq`, and `0` — the arm that
/// silently stops a finished series — once `count <= seq`.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "transcribes production's own cast; both are non-negative whole f64"
)]
fn remaining_occurrences(repeat_count: Option<f64>, repeat_seq: Option<f64>) -> Option<usize> {
    match (repeat_count, repeat_seq) {
        (Some(count), Some(seq)) if count > seq => Some((count - seq) as usize),
        (Some(count), None) => Some(count as usize),
        (Some(_), Some(_)) => Some(0usize),
        _ => None,
    }
}

fn fold_projected_agenda_from_base(
    blocks: &[BaseBlock],
    properties: &[BaseProperty],
    today: chrono::NaiveDate,
) -> BTreeSet<ProjectedRow> {
    let template_pages = fold_template_pages(properties);

    // `block_properties` is keyed `(block_id, key)`, so at most one row each —
    // indexed once, the way `fold_agenda_cache_from_base` builds `by_id`.
    let by_key: BTreeMap<(&str, &str), &BaseProperty> = properties
        .iter()
        .map(|p| ((p.block_id.as_str(), p.key.as_str()), p))
        .collect();
    let prop = |block_id: &str, key: &str| by_key.get(&(block_id, key)).copied();

    let mut out = BTreeSet::new();
    for block in blocks {
        if block.deleted_at.is_some() || block.todo_state.as_deref() == Some("DONE") {
            continue;
        }
        if block.due_date.is_none() && block.scheduled_date.is_none() {
            continue;
        }
        if block
            .page_id
            .as_deref()
            .is_some_and(|page| template_pages.contains(page))
        {
            continue;
        }
        // Only the SQL's `bp.value_text IS NOT NULL`. `project_block_into` also
        // guards `!r.is_empty()`, but that guard is redundant and is NOT
        // mirrored here: `project_block_dates` normalises the rule and returns
        // on an empty one, so an empty rule emits nothing either way. A copy of
        // it here would be a branch no test could redden.
        let Some(rule) = prop(&block.id, "repeat").and_then(|p| p.value_text.as_deref()) else {
            continue;
        };

        let repeat_until = prop(&block.id, "repeat-until")
            .and_then(|p| p.value_date.as_deref())
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
        let repeat_count = prop(&block.id, "repeat-count").and_then(|p| p.value_num);
        let repeat_seq = prop(&block.id, "repeat-seq").and_then(|p| p.value_num);

        let remaining = remaining_occurrences(repeat_count, repeat_seq);

        let mut insert = |projected: chrono::NaiveDate, source: &'static str| {
            out.insert((
                block.id.clone(),
                projected.format("%Y-%m-%d").to_string(),
                source.to_owned(),
            ));
        };
        agaric_store::recurrence_math::project_block_dates(
            block.due_date.as_deref(),
            block.scheduled_date.as_deref(),
            rule,
            repeat_until,
            remaining,
            today,
            today - chrono::Duration::days(agaric_store::cache::BACKWARD_WINDOW_DAYS),
            today - chrono::Duration::days(1),
            None,
            &mut insert,
        );
        agaric_store::recurrence_math::project_block_dates(
            block.due_date.as_deref(),
            block.scheduled_date.as_deref(),
            rule,
            repeat_until,
            remaining,
            today,
            today,
            chrono::NaiveDate::MAX,
            Some(agaric_store::cache::HORIZON_OCCURRENCES),
            &mut insert,
        );
    }
    out
}

const PROJECTED_AGENDA_OWNER: &str = "rebuild_projected_agenda_cache(_split) (the \
     RebuildProjectedAgendaCache task) and its per-block refresh update_projected_agenda_block \
     (UpdateProjectedAgendaBlock) — and, one level up, the arms of \
     materializer::dispatch::invalidations_for_op that enqueue them: a missing row is a repeating \
     task that never appears on its future date, and an extra one is a task shown on a day its \
     rule does not name";

/// `projected_agenda_cache` against a from-base rebuild, in both directions.
///
/// `today` must be the date the rebuild ran with — see
/// [`rebuild_projected_agenda_from_base`].
pub async fn reconcile_projected_agenda(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
    today: chrono::NaiveDate,
) -> Result<Vec<Divergence>, AppError> {
    let expected = rebuild_projected_agenda_from_base(pool, blocks, today).await?;
    let stored = dump_projected_agenda_cache(pool).await?;

    let mut out = Vec::new();
    for row in expected.difference(&stored) {
        let (block_id, date, source) = row;
        out.push(Divergence {
            artefact: "projected_agenda_cache.row",
            key: format!("{block_id} / {date} / {source}"),
            expected: "a row — the rule projects this occurrence inside the horizon".to_owned(),
            actual: "no row in projected_agenda_cache".to_owned(),
            owner: PROJECTED_AGENDA_OWNER,
        });
    }
    for row in stored.difference(&expected) {
        let (block_id, date, source) = row;
        out.push(Divergence {
            artefact: "projected_agenda_cache.row",
            key: format!("{block_id} / {date} / {source}"),
            expected: "no row (the block is deleted, DONE, under a template page, has no repeat \
                       rule, or the occurrence falls outside the horizon)"
                .to_owned(),
            actual: "a row in projected_agenda_cache".to_owned(),
            owner: PROJECTED_AGENDA_OWNER,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Artefact 7 — `block_links_unresolved`, the OBLIGATIONS index (#4229)
// ---------------------------------------------------------------------------

/// Every `(source, target)` row of `block_links_unresolved`.
async fn dump_block_links_unresolved(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query!("SELECT source_id, target_id FROM block_links_unresolved")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.source_id, r.target_id))
        .collect())
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

/// The maintenance sites that own every `block_links_unresolved` divergence.
const BLOCK_LINKS_UNRESOLVED_OWNER: &str = "sync_unresolved_links (agaric-store's cache::block_links), called at the \
     tail of BOTH reindex writers — reindex_block_links_conn and \
     reindex_block_links_split — so a source's whole owed set is recomputed \
     from its current content and its post-diff block_links rows on every \
     reindex of it; plus rebuild_block_links_unresolved, the vault-wide \
     arm (#4218) nothing in production has called since #4699 — the vault-wide \
     pass production does run, cache::backfill_block_links (#4905), reaches \
     this table through the reindex writers instead. One level up: \
     the arm of \
     materializer::dispatch::invalidations_for_op that enqueues \
     ReindexBlockLinks at all (only CreateBlock and EditBlock do). A row lost \
     from here is a repair that silently never happens — the target's \
     ReindexBlockLinks asks this table who was waiting and acts only on what \
     it returns, and every other link artefact folds block_links, which does \
     NOT contain the owed edge. That invisibility is why the table needs an \
     auditor more than its sibling does, not less";

/// The MISSING arm's account of the owed target, folded into the report so a
/// triager does not have to re-derive it by hand (#4241).
///
/// A LIVE target names a debt that is actively repairable right now (the
/// #4118 case-2 timing/cross-space shape, or a genuinely lost repair): the
/// target could be reindexed today and nothing would happen, because nothing
/// points a `ReindexBlockLinks` at THIS source. An ABSENT target is the one
/// case this arm cannot narrow further — a target that was purged (the
/// irreducible window [`reconcile_block_links_unresolved`]'s MISSING section
/// enumerates) and a target that has simply never been created yet are
/// indistinguishable from `blocks` alone, so both render the same way rather
/// than one masquerading as the other.
fn unresolved_target_state(by_id: &BTreeMap<&str, &BaseBlock>, target_id: &str) -> &'static str {
    match by_id.get(target_id) {
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
    }
}

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
/// triage rather than a gate).
///
/// It is also a SEPARATE entry point from
/// `block_links_reconciliation_failure` rather than an extra arm inside it.
/// The two artefacts answer different questions and can legitimately disagree
/// with the world in opposite directions at the same moment — a vault mid-
/// repair has a MISSING edge and a correct obligation — so folding them into
/// one report would make each one's fixtures noise for the other.
///
/// # The two arms
///
/// * **MISSING** (content owes the edge, no row). Sound for the shape it
///   exists to catch: a writer that dropped a token without recording it, the
///   #4118 defect itself, and the restore path #4218 was. It CAN also fire
///   transiently, between a content edit landing and its `ReindexBlockLinks`
///   draining. Triage, not a regression signal.
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
    blocks: &[BaseBlock],
) -> Result<Vec<Divergence>, AppError> {
    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();
    let links: BTreeSet<(String, String)> = dump_block_links(pool).await?.into_iter().collect();
    let expected = fold_block_links_unresolved(blocks, &links);
    let stored: BTreeSet<(String, String)> = dump_block_links_unresolved(pool)
        .await?
        .into_iter()
        .collect();

    let mut out = Vec::new();

    // --- MISSING: an edge is owed, and nothing records the debt -------------
    for (source_id, target_id) in expected.difference(&stored) {
        let target_state = unresolved_target_state(&by_id, target_id);
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
/// The rows earlier deletes had ALREADY stranded are swept once by migration
/// 0118 (#4904). Nothing else reached them: the only pass that would,
/// `RebuildFtsIndex`, is enqueued at boot solely when `fts_blocks` is entirely
/// empty, which a vault carrying residue is not.
///
/// The reference maps ARE folded independently (see [`fold_ref_maps`]) and
/// re-read on every call, which is what makes a stale row after a tag rename
/// or a page retitle expressible: production propagates those through
/// `ReindexFtsReferences`, and an arm that forgets to enqueue it leaves the
/// old name sitting in `stripped` while this rebuild resolves the new one.
pub fn rebuild_fts_index_from_base(blocks: &[BaseBlock]) -> BTreeMap<String, String> {
    let (tag_names, page_titles) = fold_ref_maps(blocks);

    let mut expected = BTreeMap::new();
    for block in blocks {
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
    expected
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
    // dynamic-sql: `fts_blocks` is an FTS5 virtual table; sqlx-macros' describe
    // SIGSEGVs on a column select over it (#4886), so this one read stays a
    // static literal — the only dynamic site in the module.
    let rows = sqlx::query_as::<_, (String, String)>("SELECT block_id, stripped FROM fts_blocks")
        .fetch_all(pool)
        .await?;
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (block_id, stripped) in rows {
        out.entry(block_id).or_default().push(stripped);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Artefact 17 — the `spaces` registry (#6207)
// ---------------------------------------------------------------------------

/// Every `is_space` property row, as `(block_id, value_text)`.
async fn dump_is_space_flags(pool: &SqlitePool) -> Result<Vec<(String, Option<String>)>, AppError> {
    let rows =
        sqlx::query!("SELECT block_id, value_text FROM block_properties WHERE key = 'is_space'")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.block_id, r.value_text))
        .collect())
}

async fn dump_spaces(pool: &SqlitePool) -> Result<BTreeSet<String>, AppError> {
    let rows = sqlx::query_scalar!("SELECT id FROM spaces")
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
}

const SPACES_MISSING_OWNER: &str = "the spaces_register_is_space trigger (migration 0089), \
     which registers the block in the transaction that inserts its is_space = 'true' property \
     row: every path that makes a space (create_space, the seeded-space bootstrap, the sync \
     and recovery projections, snapshot restore) relies on it, so no block can be placed in \
     this space";

const SPACES_EXTRA_OWNER: &str = "a spaces row leaves only with its block's purge, by FK \
     cascade (migration 0089), and no path the app offers deletes is_space (the property UI \
     hides it as internal and non-deletable, the MCP space guard refuses the space block, which \
     is in no space, and the Markdown buffer leaves it out), so a writer inserted the row \
     without the is_space = 'true' row the trigger keys on, or a DeleteProperty(is_space) got \
     past those: the registry readers and list_spaces now disagree on whether this is a space";

/// Artefact 17 — the `spaces` registry against the blocks carrying
/// `is_space = 'true'`, both directions. A soft-deleted space keeps its row,
/// as it keeps its `is_space` property (0089: a live space is a registry row
/// joined to a live block), so liveness is not consulted; a purged space has
/// neither.
fn diff_spaces_registry(
    flags: &[(String, Option<String>)],
    registry: &BTreeSet<String>,
    out: &mut Vec<Divergence>,
) {
    let flagged: BTreeSet<String> = flags
        .iter()
        .filter(|(_, value)| value.as_deref() == Some("true"))
        .map(|(block_id, _)| block_id.clone())
        .collect();
    for block_id in flagged.difference(registry) {
        out.push(Divergence {
            artefact: "spaces.row",
            key: block_id.clone(),
            expected: "a spaces row (the block carries is_space = 'true')".to_owned(),
            actual: "no row in spaces".to_owned(),
            owner: SPACES_MISSING_OWNER,
        });
    }
    for block_id in registry.difference(&flagged) {
        out.push(Divergence {
            artefact: "spaces.row",
            key: block_id.clone(),
            expected: "no row (the block carries no is_space = 'true')".to_owned(),
            actual: "a row in spaces".to_owned(),
            owner: SPACES_EXTRA_OWNER,
        });
    }
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

const ATTACHMENT_BLOBS_PRUNE_OWNER: &str = "cleanup_orphaned_attachments (the only INCREMENTAL prune arm; \
     keys on fs_path, never on content_hash — snapshot restore \
     wipes the table wholesale) — a delete/purge arm dropped the \
     last referencing row without the blob store ever noticing";

const ATTACHMENT_BLOBS_PATH_OWNER: &str = "persist_attachment (dedup INSERT arm) / \
     cleanup_orphaned_attachments (prune arm) — the GC unlinks \
     bytes whose path no `attachments.fs_path` matches, so these \
     bytes are about to be destroyed while live rows still \
     resolve this hash to them";

const ATTACHMENT_BLOBS_INSERT_OWNER: &str = "the insert arms — persist_attachment (local ingest), \
     sync_files::register_received_blob (repointing upsert after a \
     verified receive), recovery::backfill_attachment_blobs — an \
     attachments row carries a content_hash with no blob entry, so \
     the next ingest of those bytes writes a second copy and the \
     dedup target is lost";

/// Artefact 2 — `attachment_blobs` against the fold over `attachments`, in
/// both directions plus the `on_disk_path` check that is the load-bearing
/// half (see [`rebuild_attachment_blobs_from_base`]).
fn diff_attachment_blobs(
    expected: &BTreeMap<String, BlobExpectation>,
    actual: &BTreeMap<String, String>,
    out: &mut Vec<Divergence>,
) {
    for (hash, on_disk_path) in actual {
        match expected.get(hash) {
            None => out.push(Divergence {
                artefact: "attachment_blobs.refcount",
                key: hash.clone(),
                expected: "no blob row (refcount 0 — no attachments row, live or \
                           soft-deleted, carries this hash)"
                    .to_owned(),
                actual: format!("blob row present, on_disk_path={on_disk_path}"),
                owner: ATTACHMENT_BLOBS_PRUNE_OWNER,
            }),
            Some(expectation) if !expectation.referenced_paths.contains(on_disk_path) => {
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
                    owner: ATTACHMENT_BLOBS_PATH_OWNER,
                });
            }
            Some(_) => {}
        }
    }
    for (hash, expectation) in expected {
        if actual.contains_key(hash) {
            continue;
        }
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
            owner: ATTACHMENT_BLOBS_INSERT_OWNER,
        });
    }
}

const PAGE_OWNERSHIP_OWNER: &str = "set_block_page_id_from_parent_in_tx (the scoped leaf-create arm) / \
     agaric_store::block_descendants::rederive_page_and_space_ids (the in-tx \
     move arm — a MOVE deliberately does NOT enqueue the vault-wide \
     rebuild, #2200) / cache::rebuild_page_ids (the vault-wide arm \
     dispatch enqueues for create/delete/restore/purge and inbound \
     sync) — the denormalised owner disagrees with the parent_id \
     tree it caches, so every page_id-keyed count, filter and \
     backlink below it is computed for the wrong page";

/// Artefact 4 — `blocks.page_id` against the structural `parent_id` walk.
fn diff_page_ownership(blocks: &[BaseBlock], out: &mut Vec<Divergence>) {
    let expected = fold_page_ownership(blocks);
    let stored: BTreeMap<&str, Option<&str>> = blocks
        .iter()
        .map(|b| (b.id.as_str(), b.page_id.as_deref()))
        .collect();
    for (block_id, expected_owner) in &expected {
        let Some(actual_owner) = stored.get(block_id.as_str()) else {
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
                owner: PAGE_OWNERSHIP_OWNER,
            });
        }
    }
}

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

/// Artefact 9 — `blocks.space_id` on DERIVED rows against the owning page's
/// own column (#3345).
fn diff_block_space_ids(blocks: &[BaseBlock], out: &mut Vec<Divergence>) {
    let expected = fold_block_space_ids(blocks);
    let stored: BTreeMap<&str, Option<&str>> = blocks
        .iter()
        .map(|b| (b.id.as_str(), b.space_id.as_deref()))
        .collect();
    for (block_id, derived) in &expected {
        // Both sides come from the same `blocks` dump, so the key is always
        // present; a `None` here would be an absent row, which is the same
        // divergence as a NULL column and is reported as one.
        let actual_space = stored.get(block_id.as_str()).copied().flatten();
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
}

const PAGES_CACHE_SORT_KEY_OWNER: &str = "every pages_cache title writer must write the key with \
     it: cache::pages' rebuild (the RebuildPagesCache task) and restore insert \
     (insert_missing_pages_cache_rows), and the page-create INSERT in apply::pages_cache";

const PAGES_CACHE_LAST_EDITED_OWNER: &str = "cache::raise_pages_last_edited_ms, called by every path \
     that lands an op in op_log: CommandTx::commit_and_dispatch (every op a local command \
     queues, enqueue_without_dispatch's included), apply_op_projected_with_mode and \
     apply_records_in_tx (the materializer), dag::ingest_remote_record (a peer's replicated \
     op); a row the rebuild or a restore inserts is born from the op log";

const PAGES_CACHE_SPACE_OWNER: &str = "the page-create INSERT in apply::pages_cache, \
     cache::sync_pages_cache_space_ids (a `space` op's projection, which the boot placement of \
     space-less pages goes through), cache::insert_missing_pages_cache_rows (a restore) and \
     cache::pages' rebuild (every other path that moves a page) — \
     the Pages list filters on this column, so a stale value lists the page in a space it \
     left and hides it from the one it is in";

/// The Pages sort keys on `pages_cache` (#5371), for every row, and the
/// `space_id` every sort's index leads with.
///
/// `title_sort_key` must be the key of the title the row holds. The rule is
/// `agaric_core::title_sort::title_sort_key` itself, pinned by its own
/// vectors, so this audits that every title writer stored the key with the
/// title, not the rule.
///
/// `last_edited_ms` only ever rises and outlives the ops compaction deletes,
/// so the op log gives a floor, not the value: a row below the newest op on
/// one of its page's blocks missed a raise. The page is the dumped
/// `blocks.page_id`, the ownership the raise reads; the per-block newest op
/// is the one aggregate pushed into SQLite, because a raw `op_log` dump does
/// not fit a phone's heap.
///
/// `space_id` must be the dumped page's own `blocks.space_id`.
pub async fn reconcile_pages_cache_sort_keys(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<Vec<Divergence>, AppError> {
    let rows = sqlx::query!(
        "SELECT page_id, title, title_sort_key, last_edited_ms, space_id FROM pages_cache"
    )
    .fetch_all(pool)
    .await?;
    let newest_ops = sqlx::query!(
        r#"SELECT block_id AS "block_id!", MAX(created_at) AS "newest!: i64"
             FROM op_log WHERE block_id IS NOT NULL GROUP BY block_id"#
    )
    .fetch_all(pool)
    .await?;

    let page_of: BTreeMap<&str, &str> = blocks
        .iter()
        .filter_map(|b| b.page_id.as_deref().map(|page| (b.id.as_str(), page)))
        .collect();
    let space_of: BTreeMap<&str, Option<&str>> = blocks
        .iter()
        .map(|b| (b.id.as_str(), b.space_id.as_deref()))
        .collect();
    let mut newest_by_page: BTreeMap<&str, i64> = BTreeMap::new();
    for op in &newest_ops {
        if let Some(&page) = page_of.get(op.block_id.as_str()) {
            let newest = newest_by_page.entry(page).or_insert(op.newest);
            *newest = (*newest).max(op.newest);
        }
    }

    let mut out = Vec::new();
    for row in &rows {
        let want = agaric_core::title_sort::title_sort_key(&row.title);
        if row.title_sort_key != want {
            out.push(Divergence {
                artefact: "pages_cache.title_sort_key",
                key: row.page_id.clone(),
                expected: format!("{want:?} (the key of the cached title)"),
                actual: format!("{:?}", row.title_sort_key),
                owner: PAGES_CACHE_SORT_KEY_OWNER,
            });
        }
        if let Some(&floor) = newest_by_page.get(row.page_id.as_str())
            && row.last_edited_ms < floor
        {
            out.push(Divergence {
                artefact: "pages_cache.last_edited_ms",
                key: row.page_id.clone(),
                expected: format!("at least {floor} (the newest op on the page's blocks)"),
                actual: row.last_edited_ms.to_string(),
                owner: PAGES_CACHE_LAST_EDITED_OWNER,
            });
        }
        let want_space = space_of.get(row.page_id.as_str()).copied().flatten();
        if row.space_id.as_deref() != want_space {
            out.push(Divergence {
                artefact: "pages_cache.space_id",
                key: row.page_id.clone(),
                expected: want_space.map_or_else(
                    || "NULL (the page carries no space_id)".to_owned(),
                    |space| format!("{space} (the page's space_id)"),
                ),
                actual: row.space_id.clone().unwrap_or_else(|| "NULL".to_owned()),
                owner: PAGES_CACHE_SPACE_OWNER,
            });
        }
    }
    Ok(out)
}

const PAGES_CACHE_ROW_MISSING_OWNER: &str = "rebuild_pages_cache (the RebuildPagesCache task — row membership has \
     NO synchronous per-op arm) — the page is missing from the Pages \
     list, its title never materialises, and the count arms have no row \
     to maintain";

const PAGES_CACHE_ROW_EXTRA_OWNER: &str = "rebuild_pages_cache (its delete-orphans sweep) — a deleted, purged, \
     demoted or title-cleared page still occupies the Pages list and \
     still carries counts";

/// Artefact 3 — `pages_cache` ROW MEMBERSHIP, both directions.
fn diff_pages_cache_rows(
    blocks: &[BaseBlock],
    actual: &BTreeSet<String>,
    out: &mut Vec<Divergence>,
) {
    let expected = fold_live_page_blocks(blocks);
    for page_id in expected.difference(actual) {
        out.push(Divergence {
            artefact: "pages_cache.row",
            key: page_id.clone(),
            expected: "a cache row (live page block carrying a title)".to_owned(),
            actual: "no row in pages_cache".to_owned(),
            owner: PAGES_CACHE_ROW_MISSING_OWNER,
        });
    }
    for page_id in actual.difference(&expected) {
        out.push(Divergence {
            artefact: "pages_cache.row",
            key: page_id.clone(),
            expected: "no cache row (the block is not a live page block with a title)".to_owned(),
            actual: "a row in pages_cache".to_owned(),
            owner: PAGES_CACHE_ROW_EXTRA_OWNER,
        });
    }
}

const PAGES_CACHE_COUNTS_OWNER: &str = "maintain_pages_cache_counts_after_op (PreOpState arms for \
     Create/Edit/Move) + rebuild_pages_cache_counts (the deferred \
     cohort pass dispatch enqueues for Delete/Restore/Purge)";

/// Artefact 1 — both `pages_cache` count columns, for every page that has a
/// cache row (row membership is Artefact 3's question).
fn diff_pages_cache_counts(
    expected: &BTreeMap<String, PageCounts>,
    actual: &BTreeMap<String, PageCounts>,
    out: &mut Vec<Divergence>,
) {
    for (page_id, want) in expected {
        let Some(got) = actual.get(page_id) else {
            continue;
        };
        if want.child_block_count != got.child_block_count {
            out.push(Divergence {
                artefact: "pages_cache.child_block_count",
                key: page_id.clone(),
                expected: want.child_block_count.to_string(),
                actual: got.child_block_count.to_string(),
                owner: PAGES_CACHE_COUNTS_OWNER,
            });
        }
        if want.inbound_link_count != got.inbound_link_count {
            out.push(Divergence {
                artefact: "pages_cache.inbound_link_count",
                key: page_id.clone(),
                expected: want.inbound_link_count.to_string(),
                actual: got.inbound_link_count.to_string(),
                owner: PAGES_CACHE_COUNTS_OWNER,
            });
        }
    }
}

const PAGE_LINK_OWNER: &str = "reindex_page_link_cache_for_block (the ReindexBlockLinks task — the SOLE \
     per-block writer; NOTHING maintains this roll-up inside apply_op_tx) / \
     rebuild_page_link_cache (the RebuildPageLinkCache task, in the lifecycle + \
     inbound-sync rebuild sets) — and, one level up, the arm of \
     materializer::dispatch::invalidations_for_op that decides whether either \
     task is enqueued at all (#3296): the Graph view and the page-links panel \
     read page_link_cache EXCLUSIVELY, and the read path's lazy rebuild only \
     fires when the table is ENTIRELY empty";

/// Artefact 5 — `page_link_cache` against the roll-up fold, all four columns
/// (#3296).
fn diff_page_link_cache(
    expected: &BTreeMap<(String, String), PageLinkEdge>,
    actual: &BTreeMap<(String, String), PageLinkEdge>,
    out: &mut Vec<Divergence>,
) {
    for (key, want) in expected {
        let label = format!("{} -> {}", key.0, key.1);
        match actual.get(key) {
            None => out.push(Divergence {
                artefact: "page_link_cache.row",
                key: label,
                expected: format!("a cache row {want:?}"),
                actual: "no row in page_link_cache".to_owned(),
                owner: PAGE_LINK_OWNER,
            }),
            Some(got) if got != want => out.push(Divergence {
                artefact: "page_link_cache.edge",
                key: label,
                expected: format!("{want:?}"),
                actual: format!("{got:?}"),
                owner: PAGE_LINK_OWNER,
            }),
            Some(_) => {}
        }
    }
    for (key, got) in actual {
        if expected.contains_key(key) {
            continue;
        }
        out.push(Divergence {
            artefact: "page_link_cache.row",
            key: format!("{} -> {}", key.0, key.1),
            expected: "no cache row (no live source block on this page links to this \
                       target, or an endpoint block is gone)"
                .to_owned(),
            actual: format!("a row in page_link_cache {got:?}"),
            owner: PAGE_LINK_OWNER,
        });
    }
}

const FTS_OWNER: &str = "update_fts_for_block(_with_maps) / remove_fts_for_block / \
     reindex_fts_references / rebuild_fts_index (the UpdateFtsBlock, RemoveFtsBlock, \
     ReindexFtsReferences and RebuildFtsIndex tasks — NOTHING maintains this index \
     inside apply_op_tx) plus the post-commit cohort fan-outs \
     remove_deleted_cohort_fts / reindex_restored_cohort_fts (#4733) — and, one level \
     up, the arm of materializer::dispatch::invalidations_for_op that decides whether \
     any of the tasks is enqueued at all: search reads fts_blocks EXCLUSIVELY, so a \
     block missing from it is a block the user cannot find";

/// Artefact 8 — `fts_blocks` membership, freshness and row multiplicity
/// (#3345; the duplicate arm is #345 / C6, see [`read_fts_blocks`]).
fn diff_fts_blocks(
    expected: &BTreeMap<String, String>,
    actual: &BTreeMap<String, Vec<String>>,
    out: &mut Vec<Divergence>,
) {
    for (block_id, want) in expected {
        match actual.get(block_id) {
            None => out.push(Divergence {
                artefact: "fts_blocks.row",
                key: block_id.clone(),
                expected: format!("one indexed row, stripped={want:?}"),
                actual: "no row in fts_blocks — the block is unsearchable".to_owned(),
                owner: FTS_OWNER,
            }),
            Some(rows) if rows.len() > 1 => out.push(Divergence {
                artefact: "fts_blocks.duplicate_row",
                key: block_id.clone(),
                expected: "exactly one row (FTS5 cannot enforce it — every writer \
                           DELETEs before it INSERTs)"
                    .to_owned(),
                actual: format!("{} rows: {rows:?}", rows.len()),
                owner: FTS_OWNER,
            }),
            Some(rows) if rows[0] != *want => out.push(Divergence {
                artefact: "fts_blocks.stripped",
                key: block_id.clone(),
                expected: format!("{want:?}"),
                actual: format!("{:?}", rows[0]),
                owner: FTS_OWNER,
            }),
            Some(_) => {}
        }
    }
    for (block_id, rows) in actual {
        if expected.contains_key(block_id) {
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
}

/// Diff every covered derived artefact against its from-base rebuild.
///
/// Divergences come back in a stable order, each artefact sorted by key, so
/// `first` is deterministic and a shrunk proptest counter-example reports the
/// same line every run. The order is ROOT-CAUSE FIRST within the `pages_cache`
/// family: ownership (`blocks.page_id`) precedes row membership, which
/// precedes the counts, because the counts are keyed on both of the others. A
/// single missed `page_id` re-derivation therefore reports as one ownership
/// divergence rather than as an unexplained count difference on two pages.
///
/// `blocks` is the caller's `dump_blocks`; every artefact here folds that one
/// slice.
#[cfg(test)]
pub async fn reconcile(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
) -> Result<Vec<Divergence>, AppError> {
    Ok(reconcile_keeping_inherited(pool, blocks, None).await?.0)
}

/// `block_tag_inherited` as the fold expects it, then as stored.
type InheritedMaps = (
    BTreeMap<(String, String), String>,
    BTreeMap<(String, String), String>,
);

/// [`reconcile`], also handing back the `block_tag_inherited` maps it read so
/// [`reconcile_all`]'s provenance diff does not read and fold them again.
/// With `app_data_dir`, a hash with no blob whose referrers' files are all
/// absent is left out: a peer's bytes that have not landed yet (#5728).
async fn reconcile_keeping_inherited(
    pool: &SqlitePool,
    blocks: &[BaseBlock],
    app_data_dir: Option<&Path>,
) -> Result<(Vec<Divergence>, InheritedMaps), AppError> {
    let mut out = Vec::new();

    // Artefact 2 first: it shares no key with anything below.
    let mut expected_blobs = rebuild_attachment_blobs_from_base(pool).await?;
    let actual_blobs = read_attachment_blobs(pool).await?;
    if let Some(dir) = app_data_dir {
        expected_blobs.retain(|hash, blob| {
            actual_blobs.contains_key(hash)
                || blob
                    .referenced_paths
                    .iter()
                    .any(|path| dir.join(path).exists())
        });
    }
    diff_attachment_blobs(&expected_blobs, &actual_blobs, &mut out);

    // The `pages_cache` family, root cause first: ownership (Artefact 4), then
    // the space column keyed on the same `parent_id` walk (Artefact 9, so a
    // block whose owner drifted reports once), then row membership (3), then
    // the counts keyed on both (1).
    diff_page_ownership(blocks, &mut out);
    diff_block_space_ids(blocks, &mut out);
    diff_pages_cache_rows(blocks, &read_pages_cache_page_ids(pool).await?, &mut out);
    let expected_counts = rebuild_pages_cache_counts_from_base(pool, blocks).await?;
    diff_pages_cache_counts(
        &expected_counts,
        &read_pages_cache_counts(pool).await?,
        &mut out,
    );

    // Artefact 5 after ownership, deliberately: the roll-up is keyed on the
    // same `page_id`, so a drift there would otherwise report twice — once at
    // its root and once as an unexplained link-attribution difference.
    let expected_links = rebuild_page_link_cache_from_base(pool, blocks).await?;
    diff_page_link_cache(
        &expected_links,
        &read_page_link_cache(pool).await?,
        &mut out,
    );

    // Artefact 8 last, and independent of everything above it: the index
    // derives from `blocks.content` plus the tag/page reference maps, not from
    // `page_id`, so it cannot double-report an ownership drift.
    let expected_fts = rebuild_fts_index_from_base(blocks);
    diff_fts_blocks(&expected_fts, &read_fts_blocks(pool).await?, &mut out);

    // Artefact 14 (membership only), independent of `page_id` for the same
    // reason: it folds `parent_id`, `deleted_at` and `block_tags`.
    let expected_inherited = rebuild_block_tag_inherited_from_base(pool, blocks).await?;
    let stored_inherited = dump_block_tag_inherited(pool).await?;
    diff_block_tag_inherited_rows(&expected_inherited, &stored_inherited, &mut out);

    // Artefact 17, maintained in the transaction of the property write, so a
    // per-op gate like the rest. It folds `block_properties` alone.
    diff_spaces_registry(
        &dump_is_space_flags(pool).await?,
        &dump_spaces(pool).await?,
        &mut out,
    );

    Ok((out, (expected_inherited, stored_inherited)))
}

/// Every artefact this module audits, in one sweep — the release entry point
/// behind `commands::reconciliation::compute_reconciliation_report` (#4886).
///
/// [`reconcile`] is the per-op gate the drivers assert after every generated
/// op. The artefacts it leaves out are triaged deep checks — see
/// [`reconcile_block_links`] for the lane decision — whose MISSING arms can
/// fire on eventual-consistency residue (a reindex not yet drained, a loss
/// that predates #4118, the purge window) rather than on a defect. A
/// whole-vault, user-triggered run IS the triage lane, so it runs all of them
/// and lets the report carry the artefact name; the reader decides.
///
/// `engines` is the live engine registry [`reconcile_engine`] reads, and
/// `app_data_dir` the directory attachment `fs_path`s resolve against.
///
/// `today` pins the projected-agenda rebuild. The caller records it in the
/// report so a run that straddles local midnight is diagnosable rather than a
/// phantom divergence. The order is [`reconcile`]'s, then the rest in the
/// order the header table lists them, so `first` stays deterministic.
///
/// # One `blocks` dump, not one snapshot (#4901)
///
/// `blocks` is read once and every artefact folds that slice, so the
/// `blocks`-derived expectations agree with each other and the sweep does not
/// pull every row's `content` a dozen times. That is NOT snapshot isolation:
/// `block_links`, `block_properties`, `block_tags`, `attachments`, every
/// derived table and the engine docs are still read on their own, so a
/// write that lands between the dump and a later read still reports as a
/// divergence a second run will not reproduce
/// (`a_write_after_the_blocks_dump_still_reads_as_a_divergence_4901` pins
/// that this is so). Closing it means one read transaction around every
/// read, i.e. every `dump_*` / `read_*` taking a connection instead of the
/// pool — not taken here.
pub async fn reconcile_all(
    pool: &SqlitePool,
    engines: &agaric_engine::loro::shared::LoroState,
    app_data_dir: Option<&Path>,
    today: chrono::NaiveDate,
) -> Result<Vec<Divergence>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let (mut out, (expected_inherited, stored_inherited)) =
        reconcile_keeping_inherited(pool, &blocks, app_data_dir).await?;
    out.extend(reconcile_block_links(pool, &blocks).await?);
    out.extend(reconcile_block_links_unresolved(pool, &blocks).await?);
    out.extend(reconcile_block_tag_refs(pool, &blocks).await?);
    out.extend(reconcile_tags_cache(pool, &blocks).await?);
    out.extend(reconcile_agenda_cache(pool, &blocks).await?);
    out.extend(reconcile_projected_agenda(pool, &blocks, today).await?);
    out.extend(reconcile_pages_cache_sort_keys(pool, &blocks).await?);
    out.extend(diff_block_tag_inherited_provenance(
        &expected_inherited,
        &stored_inherited,
    ));
    out.extend(reconcile_engine(
        engines,
        &blocks,
        &dump_attachments(pool).await?,
        &dump_block_tags(pool).await?,
        &dump_page_aliases(pool).await?,
        &dump_block_properties(pool).await?,
        &dump_property_definitions(pool).await?,
    )?);
    Ok(out)
}

#[cfg(test)]
mod harness;
#[cfg(test)]
pub use harness::*;

#[cfg(test)]
mod tests;
