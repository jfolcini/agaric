//! Page listing / lookup command handlers (#644 split).
//!
//! `list_pages_inner`, `get_page(_unscoped)_inner`, `list_all_pages_in_space`,
//! `list_template_page_ids_in_space`, `load_page_subtree` and their cores,
//! plus the response/heading shapes and the MCP page-limit cap.

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::ReadPool;
use crate::error::AppError;
use crate::pagination::{
    self, BlockRow, Cursor, NULL_POSITION_SENTINEL, PageRequest, PageResponse,
};
use crate::ulid::BlockId;

use super::super::*;

/// Soft cap applied to `list_pages_inner` / `get_page_inner` at the tool
/// boundary. Callers may pass any `Option<i64>`; the value is clamped to
/// [1, 100] before being forwarded to the underlying pagination layer.
/// Matches the FEAT-4c tool-surface cap.
pub const MCP_PAGE_LIMIT_CAP: i64 = 100;

/// List all pages in the database with cursor pagination.
///
/// Returns non-deleted, non-conflict blocks with `block_type = 'page'`,
/// ordered by `id ASC` (ULID ≈ chronological). `limit` is clamped to
/// `[1, MCP_PAGE_LIMIT_CAP]` at this boundary; callers can still fetch
/// all pages via the returned cursor.
///
/// Thin wrapper over [`pagination::list_by_type`]; used directly by the
/// FEAT-4c MCP `list_pages` tool. Frontend code reaches for backlinks /
/// FTS instead and does not call this.
#[instrument(skip(pool), err)]
pub async fn list_pages_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<BlockRow>, AppError> {
    // limit-clamp-followup Phase 1: reject limits outside
    // `[1, MCP_PAGE_LIMIT_CAP]` loudly (was silently clamped).
    if let Some(l) = limit
        && !(1..=MCP_PAGE_LIMIT_CAP).contains(&l)
    {
        return Err(AppError::Validation(format!(
            "list_pages limit must be in [1, {MCP_PAGE_LIMIT_CAP}]; got {l}. \
                 For larger result sets, use cursor pagination."
        )));
    }
    let page = PageRequest::new(cursor, limit)?;
    // FEAT-3 Phase 2: `list_pages` is the MCP (agent) page enumeration
    // and stays unscoped — agents see every space. Frontend-facing page
    // lookups go through `list_blocks_inner` which threads `space_id`.
    // Downcast at the MCP-facing boundary to keep the tool's wire shape
    // stable; the active-typing invariant lives inside `list_by_type`.
    let resp = pagination::list_by_type(pool, "page", &page, None).await?;
    Ok(PageResponse {
        items: resp.items.into_iter().map(BlockRow::from).collect(),
        next_cursor: resp.next_cursor,
        has_more: resp.has_more,
        total_count: resp.total_count,
    })
}

/// Response shape for [`get_page_inner`] — the page itself plus its
/// paginated subtree of non-conflict descendants.
///
/// `children` is ordered `(position ASC, id ASC)` over the keyset, where
/// the keyset walks **all** non-conflict, non-deleted blocks whose
/// `page_id` column points at the requested page (so grandchildren /
/// deeper descendants are included, not just direct children). This
/// matches the FEAT-4c tool-surface definition of
/// `list_blocks_inner(root, subtree=true)` — we denormalize via the
/// `page_id` column the materializer maintains rather than running a
/// recursive CTE at every call.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PageSubtreeResponse {
    /// The page block itself (root of the subtree).
    pub page: BlockRow,
    /// Non-conflict, non-deleted descendants under `page`, ordered by
    /// `(position, id)` and paginated by [`MCP_PAGE_LIMIT_CAP`].
    pub children: Vec<BlockRow>,
    /// Opaque cursor for the next page of `children`; `None` when there
    /// are no further descendants.
    pub next_cursor: Option<String>,
    /// `true` when more `children` remain beyond `next_cursor`.
    pub has_more: bool,
}

/// Fetch a page and a paginated slice of its non-conflict subtree.
///
/// Composes [`get_active_block_inner`] for the root and a
/// `page_id`-column descendant walk for the children. Validates that
/// the requested block exists and is actually a `page`. Returns
/// [`AppError::NotFound`] for unknown **or soft-deleted** IDs (M-98),
/// and [`AppError::Validation`] when the ID resolves to a non-page
/// block, or when the page does not belong to `space_id`.
///
/// FEAT-3 Phase 7 — `space_id` is required (not optional). Pages whose
/// `space` property does not match `space_id` are rejected with
/// [`AppError::Validation`]. This is the policy enforcement point for
/// "no live links between spaces, ever": deep-linking into a foreign
/// page from inside a different space's tab stack is impossible. See
/// FEAT-3p7.
///
/// The descendant walk intentionally uses the denormalized `page_id`
/// column (index `idx_blocks_page_id`) rather than a recursive CTE —
/// the materializer maintains the column on every command path, and the
/// index makes the query O(log n + k) at any scale. Liveness is enforced
/// solely by `deleted_at IS NULL`; the former `is_conflict` /
/// conflict-copy exclusion was dropped in migration 0058.
#[instrument(skip(pool), err)]
pub async fn get_page_inner(
    pool: &SqlitePool,
    page_id: &str,
    space_id: &str,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageSubtreeResponse, AppError> {
    // L-136: validate ULID format upfront so malformed inputs surface
    // `AppError::Ulid` rather than the imprecise `AppError::NotFound`
    // that the SQL `WHERE id = ?` lookup would otherwise produce.
    BlockId::from_string(page_id)?;

    // M-98 — `get_active_block_inner` (not `get_block_inner`) so the
    // page-fetch surface never returns a soft-deleted row to the
    // frontend / MCP. A tombstoned page now surfaces as
    // `AppError::NotFound`, matching the unknown-id case the
    // frontend's deep-link / journal-nav already handles.
    let page = get_active_block_inner(pool, page_id.into()).await?;
    if page.block_type != "page" {
        return Err(AppError::Validation(format!(
            "block '{page_id}' has block_type '{}', expected 'page'",
            page.block_type
        )));
    }

    // FEAT-3 Phase 7: enforce space membership. The page must carry a
    // `space` property equal to `space_id`, otherwise the request crosses
    // a space boundary — which the locked-in design forbids. Returning
    // `Validation` keeps the error category consistent with other
    // policy-violation rejections (e.g. wrong block_type above).
    let space_match = sqlx::query_scalar!(
        r#"SELECT 1 AS "ok!: i32" FROM blocks
           WHERE id = ? AND space_id = ?"#,
        page_id,
        space_id,
    )
    .fetch_optional(pool)
    .await?;
    if space_match.is_none() {
        return Err(AppError::Validation(format!(
            "page '{page_id}' not in current space '{space_id}'"
        )));
    }

    // limit-clamp-followup Phase 1: reject limits outside
    // `[1, MCP_PAGE_LIMIT_CAP]` loudly (was silently clamped).
    if let Some(l) = limit
        && !(1..=MCP_PAGE_LIMIT_CAP).contains(&l)
    {
        return Err(AppError::Validation(format!(
            "get_page limit must be in [1, {MCP_PAGE_LIMIT_CAP}]; got {l}. \
                 For larger result sets, use cursor pagination."
        )));
    }
    let page_req = PageRequest::new(cursor, limit)?;
    let fetch_limit = page_req.limit + 1;

    // Keyset: `(position, id)`. `NULL_POSITION_SENTINEL` is used as the
    // default cursor-position so positioned rows sort before NULL-position
    // rows, matching the ordering convention in `pagination::list_children`.
    //
    // I-CommandsCRUD-12: previously hard-coded as a function-local
    // `const NULL_POSITION_SENTINEL: i64 = i64::MAX;` to avoid widening
    // `pagination::NULL_POSITION_SENTINEL`'s visibility. Now imported from
    // `pagination` directly (still `pub(crate)`, intra-crate re-use is the
    // intended scope), so any future change to the sentinel's value is
    // automatically picked up here without a silent drift hazard.
    let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) =
        match page_req.after.as_ref() {
            Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
            None => (None, 0, ""),
        };

    // Liveness: `deleted_at IS NULL` is the sole guard for which blocks
    // appear in the user-facing subtree. (The former `is_conflict` /
    // conflict-copy exclusion was dropped in migration 0058.)
    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content,
                parent_id as "parent_id: crate::ulid::BlockId", position,
                deleted_at,
                 todo_state, priority, due_date, scheduled_date,
                page_id as "page_id: crate::ulid::BlockId"
         FROM blocks
         WHERE page_id = ?1
           AND id != ?1
           AND deleted_at IS NULL
           AND (?2 IS NULL OR (
                COALESCE(position, ?6) > ?3
                OR (COALESCE(position, ?6) = ?3 AND id > ?4)))
         ORDER BY COALESCE(position, ?6) ASC, id ASC
         LIMIT ?5"#,
        page_id,                // ?1
        cursor_flag,            // ?2
        cursor_pos,             // ?3
        cursor_id,              // ?4
        fetch_limit,            // ?5
        NULL_POSITION_SENTINEL  // ?6
    )
    .fetch_all(pool)
    .await?;

    // Mirror `build_page_response` locally because `PageSubtreeResponse`
    // is not a `PageResponse<T>` — we nest children inside the page shape.
    let limit_usize = usize::try_from(page_req.limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit_usize;
    let mut children = rows;
    if has_more {
        children.truncate(limit_usize);
    }
    let next_cursor = if has_more {
        let last = children.last().expect("has_more implies non-empty");
        let cur = Cursor {
            id: last.id.clone().into_string(),
            position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
            deleted_at: None,
            seq: None,
            rank: None,
        };
        Some(cur.encode()?)
    } else {
        None
    };

    Ok(PageSubtreeResponse {
        page,
        children,
        next_cursor,
        has_more,
    })
}

/// Fetch a page + paginated subtree without a caller-supplied
/// `space_id`. Looks up the page's own `space` property and feeds it
/// into [`get_page_inner`], so the FEAT-3 Phase 7 membership check is
/// trivially satisfied.
///
/// Used by the MCP `get_page` tool (`crate::mcp::tools_ro`) where the
/// agent is intentionally unscoped — every page the agent can name
/// belongs to its own space by construction. Frontend callers always
/// know their `space_id` and call [`get_page_inner`] directly; this
/// helper exists so the tool layer stays a "thin wrapper" instead of
/// owning a sibling `block_properties` query.
///
/// Error contract preserves the pre-Phase-7 MCP behaviour:
///
/// - unknown id → [`AppError::NotFound`]
/// - block_type ≠ `"page"` → [`AppError::Validation`]
///   (via [`get_page_inner`])
/// - page exists but has no `space` property → [`AppError::Validation`]
///   (so agents can distinguish "no such page" from "exists but
///   unscoped" via the error category).
///
/// MAINT-150 (g): pulled out of `mcp::tools_ro::handle_get_page` so
/// `mcp::tools_ro` no longer carries direct SQL — the module header
/// invariant is "thin wrapper around `*_inner`".
#[instrument(skip(pool), err)]
pub async fn get_page_unscoped_inner(
    pool: &SqlitePool,
    page_id: &str,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageSubtreeResponse, AppError> {
    // Look up the page's own space via `blocks.space_id` (Phase 2 — the
    // column is the sole source of truth for membership). `fetch_optional`
    // distinguishes "no row" (page may not exist) from "row with NULL
    // space_id" (defensive — every block carries a space, so this should
    // not occur); both fall through to the unscoped branch below.
    let space_id: Option<String> = sqlx::query_scalar!(
        r#"SELECT space_id FROM blocks
           WHERE id = ?"#,
        page_id,
    )
    .fetch_optional(pool)
    .await?
    .flatten();
    let Some(space_id) = space_id else {
        // No space property — distinguish "unknown id" (NotFound) from
        // "exists but unscoped" (Validation) by hitting
        // `get_active_block_inner` first; it returns `NotFound` for
        // unknown ids. If the block exists and is active but has no
        // space, fall through to `Validation` so the error category
        // matches what an MCP agent would have seen pre-Phase-7.
        //
        // M-98 — switched from `get_block_inner` to
        // `get_active_block_inner` so a soft-deleted page surfaces as
        // `NotFound` to the MCP read tool. Agents must not be able to
        // discover tombstoned pages via this surface; the only
        // legitimate path to soft-deleted rows is the (frontend-only)
        // trash UI.
        get_active_block_inner(pool, page_id.into()).await?;
        return Err(AppError::Validation(format!(
            "page '{page_id}' has no space property"
        )));
    };
    get_page_inner(pool, page_id, &space_id, cursor, limit).await
}

/// Page header for callers that need every page in a space without
/// pagination.  Used by the markdown export (`exportGraphAsZip`) and by
/// the graph view, which both want the full set in one shot.
///
/// Includes the four agenda-shaped native columns on `blocks`
/// (`todo_state` / `priority` / `due_date` / `scheduled_date`) because
/// the graph node renderer keys node colour / icons on them.  The
/// markdown exporter ignores them.
#[derive(Serialize, Type, Clone, Debug, sqlx::FromRow)]
pub struct PageHeading {
    pub id: BlockId,
    pub content: Option<String>,
    pub todo_state: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    pub scheduled_date: Option<String>,
}

/// Return every live page in `space_id`, ordered by content
/// (case-insensitive) then id.  No pagination, no clamp.
///
/// The result set is bounded by the space's page count — intrinsic to
/// the workspace.  Use this when the caller genuinely needs every
/// page (markdown export, graph rendering); use the paginated
/// `list_blocks_inner` for list views.
///
/// When `tag_ids` is `Some(non-empty)`, restricts the result to pages
/// that carry at least one of those tags via the direct
/// `block_tags(block_id, tag_id)` table.  Inherited tags are
/// intentionally excluded — mirrors the existing GraphView semantics
/// (its previous `queryByTags(include_inherited=false)` call).
///
/// Returns only `(id, content)` because the existing callers
/// (markdown export, graph view) ignore every other column.
#[instrument(skip(pool, tag_ids), err)]
pub async fn list_all_pages_in_space_inner(
    pool: &SqlitePool,
    space_id: &str,
    tag_ids: Option<&[String]>,
) -> Result<Vec<PageHeading>, AppError> {
    if let Some(tags) = tag_ids.filter(|t| !t.is_empty()) {
        // Tag-filter branch: build an `IN (?, ?, ...)` clause inline.  We
        // can't use `query_as!` because the placeholder count is dynamic.
        let placeholders = std::iter::repeat_n("?", tags.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT b.id, b.content, b.todo_state, b.priority, b.due_date, b.scheduled_date \
             FROM blocks b \
             WHERE b.block_type = 'page' \
               AND b.deleted_at IS NULL \
               AND b.space_id = ? \
               AND b.id IN ( \
                   SELECT block_id FROM block_tags WHERE tag_id IN ({placeholders})) \
             ORDER BY COALESCE(b.content, '') COLLATE NOCASE ASC, b.id ASC",
        );
        let mut q =
            sqlx::query_as::<_, PageHeading>(sqlx::AssertSqlSafe(sql.as_str())).bind(space_id);
        for t in tags {
            q = q.bind(t);
        }
        return Ok(q.fetch_all(pool).await?);
    }

    let rows = sqlx::query_as!(
        PageHeading,
        r#"SELECT
               b.id as "id!: BlockId",
               b.content as "content: String",
               b.todo_state as "todo_state: String",
               b.priority as "priority: String",
               b.due_date as "due_date: String",
               b.scheduled_date as "scheduled_date: String"
           FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.space_id = ?1
           ORDER BY COALESCE(b.content, '') COLLATE NOCASE ASC, b.id ASC"#,
        space_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Tauri command: list every page in `space_id` as `{ id, content }`,
/// optionally restricted to pages carrying at least one of `tag_ids`.
/// Delegates to [`list_all_pages_in_space_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_all_pages_in_space(
    pool: State<'_, ReadPool>,
    space_id: String,
    tag_ids: Option<Vec<String>>,
) -> Result<Vec<PageHeading>, AppError> {
    list_all_pages_in_space_inner(&pool.0, &space_id, tag_ids.as_deref())
        .await
        .map_err(sanitize_internal_error)
}

/// Return the IDs of every page in `space_id` whose `template`
/// property is set to `'true'`.  Used by the graph view to flag
/// template pages with a visual marker; no pagination, no clamp —
/// templates are a small, bounded set by convention.
#[instrument(skip(pool), err)]
pub async fn list_template_page_ids_in_space_inner(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query_scalar!(
        r#"SELECT b.id as "id!: String"
           FROM blocks b
           JOIN block_properties bp_tpl
               ON bp_tpl.block_id = b.id
              AND bp_tpl.key = 'template'
              AND bp_tpl.value_text = 'true'
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.space_id = ?1"#,
        space_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Tauri command: list template page IDs in `space_id`.
/// Delegates to [`list_template_page_ids_in_space_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_template_page_ids_in_space(
    pool: State<'_, ReadPool>,
    space_id: String,
) -> Result<Vec<String>, AppError> {
    list_template_page_ids_in_space_inner(&pool.0, &space_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Safety bound on the FE page-tree loader.  Pages with deeper / wider
/// trees than this should already be the user's signal to split the
/// page; the loader truncates rather than blocking the editor.
pub(crate) const PAGE_SUBTREE_MAX_BLOCKS: i64 = 10_000;

/// Load every active descendant under `root_block_id` in `space_id`,
/// in a single SELECT against the materializer-maintained `page_id`
/// index.  No per-parent pagination, no per-call clamp the FE can
/// silently overrun — replaces the FE-side recursive `listBlocks`
/// walk that was capped at the 100-row default and silently truncated
/// any parent with >100 children.
///
/// The returned set excludes the root block itself and any soft-deleted
/// descendant; it is bounded by [`PAGE_SUBTREE_MAX_BLOCKS`] as a safety
/// rail against pathologically large pages.
///
/// Order is `(position, id)` ascending — the FE reassembles via
/// `buildFlatTree` which groups by `parent_id`, so the global order is
/// not load-bearing, but keyset-style ordering keeps the truncation
/// boundary deterministic when the cap fires.
#[instrument(skip(pool), err)]
pub async fn load_page_subtree_inner(
    pool: &SqlitePool,
    root_block_id: &str,
    space_id: &str,
) -> Result<Vec<BlockRow>, AppError> {
    BlockId::from_string(root_block_id)?;

    // FEAT-3 Phase 7 — enforce space membership.  A request whose root
    // page does not carry `space = ?space_id` is rejected with
    // `Validation`, matching `get_page_inner`.
    let space_match = sqlx::query_scalar!(
        r#"SELECT 1 AS "ok!: i32" FROM blocks
           WHERE id = ? AND space_id = ?"#,
        root_block_id,
        space_id,
    )
    .fetch_optional(pool)
    .await?;
    if space_match.is_none() {
        return Err(AppError::Validation(format!(
            "block '{root_block_id}' not in current space '{space_id}'"
        )));
    }

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content,
                parent_id as "parent_id: crate::ulid::BlockId", position,
                deleted_at, todo_state, priority, due_date,
                scheduled_date, page_id as "page_id: crate::ulid::BlockId"
           FROM blocks
           WHERE page_id = ?1
             AND id != ?1
             AND deleted_at IS NULL
           ORDER BY COALESCE(position, ?2) ASC, id ASC
           LIMIT ?3"#,
        root_block_id,
        NULL_POSITION_SENTINEL,
        PAGE_SUBTREE_MAX_BLOCKS,
    )
    .fetch_all(pool)
    .await?;

    if i64::try_from(rows.len()).unwrap_or(i64::MAX) >= PAGE_SUBTREE_MAX_BLOCKS {
        tracing::warn!(
            root_block_id,
            max_blocks = PAGE_SUBTREE_MAX_BLOCKS,
            rows_returned = rows.len(),
            "load_page_subtree: result at the safety cap; descendants \
             may have been truncated. Consider splitting the page."
        );
    }

    Ok(rows)
}

/// Tauri command: load every active descendant under `root_block_id`
/// in `space_id`.  Delegates to [`load_page_subtree_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn load_page_subtree(
    pool: State<'_, ReadPool>,
    root_block_id: BlockId,
    space_id: String,
) -> Result<Vec<BlockRow>, AppError> {
    load_page_subtree_inner(&pool.0, root_block_id.as_str(), &space_id)
        .await
        .map_err(sanitize_internal_error)
}
