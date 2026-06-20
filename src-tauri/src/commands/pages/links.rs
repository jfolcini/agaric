//! Page-to-page link (graph view) command handlers (#644 split).
//!
//! `list_page_links` and its `*_inner` / read-write-split cores plus the
//! graph-edge telemetry tripwire.

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::error::AppError;
use crate::space::SpaceScope;

use super::super::*;

/// #426: telemetry tripwire for the unbounded graph edge set. NOT a functional
/// limit — `list_page_links_inner_split` never truncates (the graph renderer
/// wants the whole set); this only governs when a `warn!` fires so a vault
/// whose edge set has grown into the mobile-OOM-risk regime is observable in
/// logs. Deliberately generous (well beyond any normal vault) and to be
/// calibrated against real device-memory measurements when the mobile
/// graph-degradation (ego-graph / edge cap) is designed.
const GRAPH_EDGE_WARN_THRESHOLD: usize = 50_000;

/// List all links between pages (for graph view).
///
/// Returns edges where both source and target are non-deleted page blocks.
/// Block-level links (where source is a content block) are rolled up to
/// their parent page.
///
/// `scope` — [`SpaceScope::Active`] restricts the result set
/// to edges where **both** the source page (`COALESCE(sb.parent_id,
/// bl.source_id)`) and the target page (`bl.target_id`) carry
/// `space = ?space_id`. This is the policy enforcement point for
/// "no live links between spaces, ever" in the graph view: an edge
/// crossing space boundaries must not surface in either space's
/// Graph. [`SpaceScope::Global`] keeps the pre- cross-space
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
) -> Result<Vec<PageLink>, AppError> {
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
/// `write_pool` via [`crate::cache::rebuild_page_link_cache_split`].
#[instrument(skip(write_pool, read_pool, tag_ids), err)]
pub async fn list_page_links_inner_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    scope: &SpaceScope,
    tag_ids: Option<&[String]>,
) -> Result<Vec<PageLink>, AppError> {
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
            crate::cache::rebuild_page_link_cache_split(write_pool, read_pool).await?;
        }
    }

    // SQL-review §H-2: read from the materialised `page_link_cache`
    // (populated by `cache::reindex_page_link_cache_for_block` on every
    // `ReindexBlockLinks` task, and rebuilt en masse by
    // `RebuildPageLinkCache` on delete/restore/purge cascades) instead
    // of recomputing the 3-JOIN `block_links × blocks × block_properties`
    // roll-up on every call. The cache holds one row per
    // `(source_page_id, target_page_id, edge_count)` triple, so the
    // read collapses to two index joins (one per endpoint of `blocks`
    // for the `deleted_at IS NULL` filter) plus the optional
    // space / tag filters. Replaces the documented 1.3 s @ 100K
    // bottleneck called out in docs/architecture/operations.md
    // § Product SLO (the Problem-tier row in `interactive_slo`).
    //
    // The cache mirrors the legacy query's semantics ("source page =
    // COALESCE(parent_id, source_id), target page = target_id, drop
    // self-edges, soft-deleted source blocks contribute zero edges")
    // inside the materializer (see
    // `cache::page_links::reindex_page_link_cache_for_block`), so the
    // read no longer needs to re-derive any of that. The remaining
    // `blocks` joins enforce only the soft-delete filter — `block_type
    // = 'page'` stays on the target side because `block_links.target_id`
    // is by construction a page id (the `[[ULID]]` token only ever
    // resolves to a page in the markdown serializer).
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
    let links = sqlx::query_as!(
        PageLink,
        r#"WITH space_members AS MATERIALIZED (
             SELECT id AS block_id FROM blocks
             WHERE space_id = ?1
         )
         SELECT
            plc.source_page_id AS "source_id!: crate::ulid::ActiveBlockId",
            plc.target_page_id AS "target_id!: crate::ulid::ActiveBlockId",
            plc.edge_count AS "ref_count!: i64"
         FROM page_link_cache plc
         JOIN blocks src ON src.id = plc.source_page_id
             AND src.deleted_at IS NULL
         JOIN blocks tgt ON tgt.id = plc.target_page_id
             AND tgt.block_type = 'page'
             AND tgt.deleted_at IS NULL
         WHERE plc.source_page_id != plc.target_page_id
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
    .fetch_all(pool)
    .await?;

    // #426: the graph view loads the ENTIRE edge set in one shot (no LIMIT —
    // intentional, the renderer wants the whole graph). That is fine at normal
    // scale, but on a 10k+ page vault with high link density the edge set can
    // grow large enough to strain the mobile webview once it crosses the IPC
    // boundary (every edge is decoded into `Vec<PageLink>`, serialized, and
    // held in JS). We do NOT truncate here — silently dropping graph edges is a
    // UX decision (the audit's "degrade to an ego-graph / count-then-warn cap"
    // remedy) that needs product sign-off and a real mobile-memory measurement
    // first. Instead emit a telemetry tripwire so the scaling regime is
    // observable in logs BEFORE it OOMs a device — the "measure/surface before
    // shipping mobile" minimum the audit asks for. `GRAPH_EDGE_WARN_THRESHOLD`
    // is a logging tripwire, NOT a functional limit: nothing is dropped, so its
    // exact value only governs when the warn fires; calibrate it against real
    // device measurements when the mobile graph degradation is designed.
    if links.len() > GRAPH_EDGE_WARN_THRESHOLD {
        tracing::warn!(
            target: "agaric::list_page_links",
            edges = links.len(),
            threshold = GRAPH_EDGE_WARN_THRESHOLD,
            "graph edge set exceeds the telemetry tripwire; the full set is \
             still returned (no truncation), but at this scale the IPC payload \
             may strain the mobile webview — see #426 (ego-graph / edge-cap \
             degradation is a deferred UX + measurement decision)"
        );
    }

    Ok(links)
}

/// Tauri command: list all page-to-page links for graph visualization.
///
/// `tag_ids` — when non-empty, restricts edges to
/// those whose target page carries at least one of the listed tags. The
/// frontend GraphView passes its active tag filter here so the backend
/// no longer ships every space-wide edge for the renderer to discard.
#[tauri::command]
#[specta::specta]
pub async fn list_page_links(
    write_pool: State<'_, WritePool>,
    read_pool: State<'_, ReadPool>,
    scope: SpaceScope,
    tag_ids: Option<Vec<String>>,
) -> Result<Vec<PageLink>, AppError> {
    // SQL/C1 (#341): the lazy `page_link_cache` rebuild is a DELETE+INSERT
    // and must run on the write pool — the read pool is `query_only=ON`.
    list_page_links_inner_split(&write_pool.0, &read_pool.0, &scope, tag_ids.as_deref())
        .await
        .map_err(sanitize_internal_error)
}
