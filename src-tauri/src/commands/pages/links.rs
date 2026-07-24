//! Page-to-page link (graph view) command handlers (#644 split).
//!
//! `list_page_links` and its `*_inner` / read-write-split cores plus the
//! graph-edge telemetry tripwire. Since #2298 the edge set is capped at
//! [`PAGE_LINKS_EDGE_CAP`] (count-then-cap: the true total still ships in
//! [`PageLinksResponse::total`]).

use serde::Serialize;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{ReadPool, WritePool};
use agaric_core::error::AppError;
use agaric_store::space::SpaceScope;

use super::super::*;

/// #426: telemetry tripwire for a graph edge set that has grown into the
/// mobile-OOM-risk regime. Since #2298 the response is capped at
/// [`PAGE_LINKS_EDGE_CAP`], so the tripwire is anchored to the TRUE
/// pre-cap total (`PageLinksResponse::total`), not to the shipped edge
/// count — with a 20K cap the shipped length can never reach 50K, and
/// re-anchoring keeps the "this vault's edge set is huge" signal
/// observable in logs. Deliberately generous (well beyond any normal
/// vault); calibrate against real device-memory measurements when the
/// mobile graph degradation is designed.
const GRAPH_EDGE_WARN_THRESHOLD: usize = 50_000;

/// #2298: hard cap on the number of edges `list_page_links` ships across
/// the IPC boundary. The measured cost of the unbounded read at 300K
/// edges was the Rust-side materialization + serialization (~560-640 ms
/// against a ~30-60 ms SQL cost), so the fix is to bound the
/// materialized set. The maintainer-approved shape is count-then-cap:
/// return the strongest `PAGE_LINKS_EDGE_CAP` edges plus the TRUE total
/// count and a `truncated` flag so the FE can show a
/// "showing N of M — large graph truncated" affordance.
pub const PAGE_LINKS_EDGE_CAP: usize = 20_000;

/// Response of `list_page_links` (#2298 count-then-cap).
///
/// Mirrors the `PageSubtree` (#1258) capped-list-plus-honest-signal
/// precedent: `edges` is the (possibly capped) edge set, `total` is the
/// TRUE edge count computed independently of the cap, and `truncated`
/// (`total > edges.len()`) tells the FE the cap fired so it can surface
/// a non-blocking "showing N of M" notice instead of silently rendering
/// a partial graph.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PageLinksResponse {
    /// The (possibly capped) edge set — the strongest
    /// [`PAGE_LINKS_EDGE_CAP`] edges by `ref_count` (see the ordering
    /// note on [`list_page_links_inner_split_with_cap`]).
    pub edges: Vec<PageLink>,
    /// The true count of edges matching the filters, computed
    /// independently of the cap. `edges.len()` is `min(total, cap)`.
    pub total: i64,
    /// True when the cap fired and some edges were dropped from `edges`.
    pub truncated: bool,
}

/// List links between pages (for graph view).
///
/// Returns edges where both source and target are non-deleted page blocks.
/// Block-level links (where source is a content block) are rolled up to
/// their parent page. Since #2298 the edge set is capped at
/// [`PAGE_LINKS_EDGE_CAP`] (strongest edges first) and the response
/// carries the true total plus a `truncated` flag.
///
/// `scope` — [`SpaceScope::Active`] restricts the result set
/// to edges where **both** the source page (`COALESCE(sb.parent_id,
/// bl.source_id)`) and the target page (`bl.target_id`) carry
/// `space = ?space_id`. This is the policy enforcement point for
/// "no live links between spaces, ever" in the graph view: an edge
/// crossing space boundaries must not surface in either space's
/// Graph. [`SpaceScope::Global`] keeps the pre-spaces cross-space
/// behaviour for callers that span every space.
///
/// `tag_ids` — when `Some(non-empty)`, restricts
/// edges to those whose **target page** carries at least one of the
/// listed tags via `block_tags` or `block_tag_inherited` (the same
/// Union semantics `query_by_tags` resolves to: explicit
/// `block_tags`, materialised inheritance via `block_tag_inherited`,
/// and inline `[[ULID]]` references via `block_tag_refs`). The audit
/// implies the tag predicate filters the **page being linked TO** —
/// so a graph filtered by `#project` shows only the edges whose
/// target page is project-tagged. `None` / empty leaves the edge
/// set unfiltered (pre-Tier-4.5 behaviour).
///
/// Pushed down so the renderer no longer ships every space-wide edge
/// then drops any whose endpoint is not in the post-filtered node
/// set. The unfiltered path passes a SQL NULL via the `(?2 IS NULL OR
/// …)` short-circuit so the planner picks the same shape as before.
#[instrument(skip(pool, tag_ids), err)]
pub async fn list_page_links_inner(
    pool: &SqlitePool,
    scope: &SpaceScope,
    tag_ids: Option<&[String]>,
) -> Result<PageLinksResponse, AppError> {
    // Single-pool entry point (tests, callers without a split pool). The
    // pool is writable, so it serves as both the read and write side of
    // the split variant — preserving the lazy-rebuild behaviour.
    list_page_links_inner_split(pool, pool, scope, tag_ids).await
}

/// Read/write split variant of [`list_page_links_inner`] (SQL/C1, #341).
///
/// `read_pool` is bound with `PRAGMA query_only=ON` in production, so the
/// lazy `page_link_cache` rebuild — a DELETE+INSERT — MUST run on
/// `write_pool`. The previous single-pool form rebuilt on the read pool
/// and crashed with "attempt to write a readonly database" the first time
/// an upgrading user opened the graph/backlinks view before any edit
/// (`page_link_cache` empty, `block_links` populated, no backfill).
///
/// All reads (the cache-empty probe, the `block_links` presence probe, and
/// the final SELECT) go through `read_pool`; only the rebuild touches
/// `write_pool` via [`agaric_store::cache::rebuild_page_link_cache_split`].
#[instrument(skip(write_pool, read_pool, tag_ids), err)]
pub async fn list_page_links_inner_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    scope: &SpaceScope,
    tag_ids: Option<&[String]>,
) -> Result<PageLinksResponse, AppError> {
    list_page_links_inner_split_with_cap(write_pool, read_pool, scope, tag_ids, PAGE_LINKS_EDGE_CAP)
        .await
}

/// Cap-injectable core of [`list_page_links_inner_split`] (#2298).
///
/// Production always passes [`PAGE_LINKS_EDGE_CAP`]; tests inject a tiny
/// `cap` so the over-cap / truncation behaviour is exercised without
/// seeding 20K+ rows.
#[instrument(skip(write_pool, read_pool, tag_ids), err)]
pub async fn list_page_links_inner_split_with_cap(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    scope: &SpaceScope,
    tag_ids: Option<&[String]>,
    cap: usize,
) -> Result<PageLinksResponse, AppError> {
    let pool = read_pool;
    // Encode the tag set as a JSON array so the SQL
    // can fan it out via `json_each(?2)` (mirrors the
    // `value_text_in_json` shape in `pagination::properties`). The
    // unfiltered branch passes `None` and the `(?2 IS NULL OR …)`
    // short-circuit collapses the EXISTS subquery away.
    let tag_ids_json: Option<String> = match tag_ids {
        Some(ids) if !ids.is_empty() => Some(serde_json::to_string(ids)?),
        _ => None,
    };

    // SQL-review §H-2 — lazy-rebuild guard. The production hot path is
    // the materializer's per-`ReindexBlockLinks` rollup into
    // `page_link_cache`, so this branch is normally a no-op (the
    // `EXISTS / NOT EXISTS` short-circuit terminates after the first
    // matching row in either table). The fallback fires only when
    // `block_links` has been mutated outside the materializer (test
    // fixtures that `INSERT OR IGNORE INTO block_links` directly, or
    // a partial-migration window where the cache hasn't been backfilled
    // yet) — in that case we run a one-shot full rebuild so the read
    // path observes the same edge set the legacy query did. This keeps
    // the hard constraint "All existing list_page_links tests must pass
    // without modification" true while preserving the steady-state
    // perf win.
    //
    // SQL/C1 (#341): the rebuild is a DELETE+INSERT, so it MUST target
    // `write_pool`. Driving it through the read pool (`query_only=ON`)
    // is what produced the "attempt to write a readonly database" hard
    // error for an upgrading user opening the graph before any edit.
    let cache_empty: bool =
        sqlx::query_scalar!(r#"SELECT NOT EXISTS (SELECT 1 FROM page_link_cache) AS "v!: i32""#)
            .fetch_one(pool)
            .await?
            == 1;
    if cache_empty {
        let block_links_present: bool =
            sqlx::query_scalar!(r#"SELECT EXISTS (SELECT 1 FROM block_links) AS "v!: i32""#)
                .fetch_one(pool)
                .await?
                == 1;
        if block_links_present {
            agaric_store::cache::rebuild_page_link_cache_split(write_pool, read_pool).await?;
        }
    }

    // SQL-review §H-2: read from the materialised `page_link_cache`
    // (populated by `cache::reindex_page_link_cache_for_block` on every
    // `ReindexBlockLinks` task, and rebuilt en masse by
    // `RebuildPageLinkCache` on delete/restore/purge cascades) instead
    // of recomputing the 3-JOIN `block_links × blocks × block_properties`
    // roll-up on every call. The cache holds one row per
    // `(source_page_id, target_page_id, edge_count)` triple, so the
    // read collapses to a single indexed cache scan plus the optional
    // space / tag filters. Replaces the documented 1.3 s @ 100K
    // bottleneck called out in docs/architecture/operations.md
    // § Product SLO (the Problem-tier row in `interactive_slo`).
    //
    // #2070: the two residual `blocks` joins this read used to carry —
    // `JOIN blocks src ON … deleted_at IS NULL` and `JOIN blocks tgt ON
    // … block_type = 'page' AND deleted_at IS NULL` — were the remaining
    // bottleneck at 100K (the 0065 cache already removed the title
    // roll-up; the issue's "titles" premise is stale). Migration 0096
    // denormalises those three predicates into the cache as
    // `src_deleted` / `tgt_deleted` / `tgt_is_page` flags (kept current
    // by the rebuild + incremental reindex below), so the unscoped
    // (`SpaceScope::Global`) hot path — the one the SLO bench measures —
    // is now a single covering-index scan (`idx_page_link_cache_live`)
    // with ZERO `blocks` joins.
    //
    // The cache mirrors the legacy query's semantics ("source page =
    // COALESCE(parent_id, source_id), target page = target_id, drop
    // self-edges, soft-deleted source blocks contribute zero edges")
    // inside the materializer (see
    // `cache::page_links::reindex_page_link_cache_for_block`), so the
    // read no longer needs to re-derive any of that. `block_type =
    // 'page'` is enforced on the target side via `plc.tgt_is_page`
    // because `block_links.target_id` is by construction a page id (the
    // `[[ULID]]` token only ever resolves to a page in the markdown
    // serializer).
    //
    // (preserved) — `(?1 IS NULL OR...)` filters both
    // endpoints by space membership. Cross-space rows cannot exist in
    // `page_link_cache` to begin with because the underlying
    // `block_links` rows are write-time-filtered to same-space pairs
    // (Phase 3 in `cache::block_links::reindex_block_links`),
    // but the explicit filter here defends against legacy rows that
    // Slipped in pre-.
    //
    // F (preserved) — the `space_members` CTE is materialised
    // Once and reused for both endpoints. (preserved)
    // — the tag-EXISTS branch UNIONs `block_tags`,
    // `block_tag_inherited`, and `block_tag_refs` to mirror the
    // canonical `tag_query::resolve_tag_leaves` union semantics.
    //
    // #2298 — count-then-cap. The edge set is bounded by `?3` (production:
    // `PAGE_LINKS_EDGE_CAP`) because the measured cost of the unbounded
    // read at ~300K edges was the Rust-side materialization/serialization,
    // not the SQL. Edge-selection policy: there is no focus-page param, so
    // "keep the visible neighborhood of the focused page complete first"
    // resolves to shipping the STRONGEST edges first — `ORDER BY
    // edge_count DESC` — with a deterministic `(source_page_id,
    // target_page_id)` tiebreak so the truncation boundary is stable
    // across calls (maintainer decision on #2298).
    let cap_param = i64::try_from(cap).unwrap_or(i64::MAX);
    let edges = sqlx::query_as!(
        PageLink,
        r#"WITH space_members AS MATERIALIZED (
             SELECT id AS block_id FROM blocks
             WHERE space_id = ?1
         )
         SELECT
            plc.source_page_id AS "source_id!: agaric_core::ulid::UlidInline",
            plc.target_page_id AS "target_id!: agaric_core::ulid::UlidInline",
            plc.edge_count AS "ref_count!: i64"
         FROM page_link_cache plc
         WHERE plc.source_page_id != plc.target_page_id
             AND plc.src_deleted = 0
             AND plc.tgt_deleted = 0
             AND plc.tgt_is_page = 1
             AND (?1 IS NULL OR (
                 plc.source_page_id IN (SELECT block_id FROM space_members)
                 AND plc.target_page_id IN (SELECT block_id FROM space_members)
             ))
             AND (?2 IS NULL OR EXISTS (
                 SELECT 1 FROM block_tags bt
                 WHERE bt.block_id = plc.target_page_id
                   AND bt.tag_id IN (SELECT value FROM json_each(?2))
                 UNION ALL
                 SELECT 1 FROM block_tag_inherited bti
                 WHERE bti.block_id = plc.target_page_id
                   AND bti.tag_id IN (SELECT value FROM json_each(?2))
                 UNION ALL
                 SELECT 1 FROM block_tag_refs btr
                 WHERE btr.source_id = plc.target_page_id
                   AND btr.tag_id IN (SELECT value FROM json_each(?2))
             ))
         ORDER BY plc.edge_count DESC, plc.source_page_id ASC,
             plc.target_page_id ASC
         LIMIT ?3"#,
        scope.as_filter_param(),
        tag_ids_json.as_deref(),
        cap_param,
    )
    .fetch_all(pool)
    .await?;

    let returned = i64::try_from(edges.len()).unwrap_or(i64::MAX);

    // #2298 — compute the TRUE edge count independently of the cap
    // (same WHERE predicate, same pool) so the FE can surface
    // "showing N of M — large graph truncated". Mirrors the
    // `load_page_subtree_inner` (#1258) shape: the second query is only
    // worth running when the returned set actually hit the cap; below
    // the cap the LIMIT cannot have fired, so `total == returned`.
    let total = if returned >= cap_param {
        sqlx::query_scalar!(
            r#"WITH space_members AS MATERIALIZED (
                 SELECT id AS block_id FROM blocks
                 WHERE space_id = ?1
             )
             SELECT COUNT(*) AS "total!: i64"
             FROM page_link_cache plc
             WHERE plc.source_page_id != plc.target_page_id
                 AND plc.src_deleted = 0
                 AND plc.tgt_deleted = 0
                 AND plc.tgt_is_page = 1
                 AND (?1 IS NULL OR (
                     plc.source_page_id IN (SELECT block_id FROM space_members)
                     AND plc.target_page_id IN (SELECT block_id FROM space_members)
                 ))
                 AND (?2 IS NULL OR EXISTS (
                     SELECT 1 FROM block_tags bt
                     WHERE bt.block_id = plc.target_page_id
                       AND bt.tag_id IN (SELECT value FROM json_each(?2))
                     UNION ALL
                     SELECT 1 FROM block_tag_inherited bti
                     WHERE bti.block_id = plc.target_page_id
                       AND bti.tag_id IN (SELECT value FROM json_each(?2))
                     UNION ALL
                     SELECT 1 FROM block_tag_refs btr
                     WHERE btr.source_id = plc.target_page_id
                       AND btr.tag_id IN (SELECT value FROM json_each(?2))
                 ))"#,
            scope.as_filter_param(),
            tag_ids_json.as_deref(),
        )
        .fetch_one(pool)
        .await?
    } else {
        returned
    };

    // #426 / #2298: telemetry tripwire, re-anchored to the TRUE total.
    // The shipped edge count is now bounded by the cap, so `edges.len()`
    // can never reach the threshold — the total is what tells us a
    // vault's edge set has grown into the regime the tripwire exists to
    // observe. (When `returned < cap` the count query is skipped, but
    // then `total == returned < cap < threshold`, so no warn is missed.)
    if usize::try_from(total).unwrap_or(usize::MAX) > GRAPH_EDGE_WARN_THRESHOLD {
        tracing::warn!(
            target: "agaric::list_page_links",
            edges = edges.len(),
            total,
            threshold = GRAPH_EDGE_WARN_THRESHOLD,
            "graph edge set exceeds the telemetry tripwire; only the \
             strongest `cap` edges are returned (#2298 count-then-cap) — \
             at this scale the FE shows the 'showing N of M' truncation \
             affordance"
        );
    }

    let truncated = total > returned;

    Ok(PageLinksResponse {
        edges,
        total,
        truncated,
    })
}

/// Tauri command: list page-to-page links for graph visualization.
///
/// `tag_ids` — when non-empty, restricts edges to
/// those whose target page carries at least one of the listed tags. The
/// frontend GraphView passes its active tag filter here so the backend
/// no longer ships every space-wide edge for the renderer to discard.
///
/// #2298 — the edge set is capped at [`PAGE_LINKS_EDGE_CAP`] (strongest
/// edges first); the response carries the true `total` and a `truncated`
/// flag so the FE can show a "showing N of M" affordance.
#[tauri::command]
#[specta::specta]
pub async fn list_page_links(
    write_pool: State<'_, WritePool>,
    read_pool: State<'_, ReadPool>,
    scope: SpaceScope,
    tag_ids: Option<Vec<String>>,
) -> Result<PageLinksResponse, AppError> {
    // SQL/C1 (#341): the lazy `page_link_cache` rebuild is a DELETE+INSERT
    // and must run on the write pool — the read pool is `query_only=ON`.
    list_page_links_inner_split(&write_pool.0, &read_pool.0, &scope, tag_ids.as_deref())
        .await
        .map_err(sanitize_internal_error)
}
