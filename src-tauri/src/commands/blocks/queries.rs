use std::collections::HashMap;

use tracing::instrument;

use super::super::*;

/// List blocks with pagination, applying at most one exclusive filter.
///
/// Dispatches to the appropriate pagination query based on which filter
/// parameter is set: `show_deleted` (trash), `agenda_date`, `tag_id`,
/// `block_type`, or `parent_id` (children, the default). Page size is
/// clamped to `[1, 100]`.
///
/// `space_id` (FEAT-3 Phase 2) further restricts the result set to blocks
/// whose owning page carries `space = ?space_id`. Passing `None` keeps
/// the pre-FEAT-3 behaviour (no filter) so existing callsites stay green.
/// The filter is applied inside the child / by-type / trash paths; the
/// agenda and tag paths reject `space_id` at validation in Phase 2 and
/// gain scoping in Phase 4 (see REVIEW-LATER FEAT-3).
///
/// # Errors
///
/// - [`AppError::Validation`] — multiple conflicting filters, or invalid date format
/// - [`AppError::Validation`] — `space_id` combined with an agenda or tag filter
///   (not yet supported; deferred to FEAT-3 Phase 4)
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool), err)]
pub async fn list_blocks_inner(
    pool: &SqlitePool,
    parent_id: Option<String>,
    block_type: Option<String>,
    tag_id: Option<String>,
    show_deleted: Option<bool>,
    agenda_date: Option<String>,
    agenda_date_start: Option<String>,
    agenda_date_end: Option<String>,
    agenda_source: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
    space_id: Option<String>,
) -> Result<PageResponse<BlockRow>, AppError> {
    // Treat agenda_date_start/end as an agenda filter for conflict detection
    let has_agenda_range = agenda_date_start.is_some() && agenda_date_end.is_some();

    // Reject conflicting filters: only one of the exclusive filter parameters
    // may be set. `parent_id` is the default (list children) so it only
    // counts as a filter when explicitly provided alongside another.
    let filter_count = [
        parent_id.is_some(),
        block_type.is_some(),
        tag_id.is_some(),
        show_deleted == Some(true),
        agenda_date.is_some(),
        has_agenda_range,
    ]
    .iter()
    .filter(|&&b| b)
    .count();

    if filter_count > 1 {
        return Err(AppError::Validation(
            "conflicting filters: only one of parent_id, block_type, tag_id, show_deleted, agenda_date, agenda_date_start+end may be set".to_string(),
        ));
    }

    // Validate: if only one of start/end is provided, reject
    if agenda_date_start.is_some() != agenda_date_end.is_some() {
        return Err(AppError::Validation(
            "agenda_date_start and agenda_date_end must both be provided together".to_string(),
        ));
    }

    // FEAT-3 Phase 2: agenda and tag dispatch paths do not yet honour
    // space_id (deferred to Phase 4). Reject the combination explicitly
    // instead of silently dropping the filter — the caller is almost
    // certainly expecting their results to be space-scoped.
    if space_id.is_some() && (agenda_date.is_some() || has_agenda_range || tag_id.is_some()) {
        return Err(AppError::Validation(
            "space_id is not supported on agenda or tag filters yet (FEAT-3 Phase 4)".to_string(),
        ));
    }

    // F06: Clamp page_size to [1, 100] to prevent oversized result sets
    // or nonsensical zero/negative limits.
    let clamped_limit = limit.map(|l| l.clamp(1, 100));
    let page = pagination::PageRequest::new(cursor, clamped_limit)?;

    // FEAT-3 Phase 2: the space filter applies to the "scopeable" paths
    // (trash, list-by-type, list-children). Agenda and tag paths remain
    // unscoped in this phase per the rollout plan — they migrate in
    // Phase 4 (REVIEW-LATER FEAT-3).
    let space_id_opt: Option<&str> = space_id.as_deref();
    if show_deleted == Some(true) {
        pagination::list_trash(pool, &page, space_id_opt).await
    } else if has_agenda_range {
        let start = agenda_date_start.as_ref().unwrap();
        let end = agenda_date_end.as_ref().unwrap();
        validate_date_format(start)?;
        validate_date_format(end)?;
        if start > end {
            return Err(AppError::Validation(
                "agenda_date_start must be <= agenda_date_end".to_string(),
            ));
        }
        pagination::list_agenda_range(pool, start, end, agenda_source.as_deref(), &page).await
    } else if let Some(ref d) = agenda_date {
        validate_date_format(d)?;
        pagination::list_agenda(pool, d, agenda_source.as_deref(), &page).await
    } else if let Some(ref t) = tag_id {
        pagination::list_by_tag(pool, t, &page).await
    } else if let Some(ref bt) = block_type {
        pagination::list_by_type(pool, bt, &page, space_id_opt).await
    } else {
        pagination::list_children(pool, parent_id.as_deref(), &page, space_id_opt).await
    }
}

/// Fetch a single block by ID (including soft-deleted blocks).
///
/// # Errors
///
/// - [`AppError::NotFound`] — no block with the given ID exists
#[instrument(skip(pool), err)]
pub async fn get_block_inner(pool: &SqlitePool, block_id: String) -> Result<BlockRow, AppError> {
    let row: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(pool)
    .await?;

    row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))
}

/// Batch-resolve block metadata for a list of IDs in a single query.
///
/// Returns one [`ResolvedBlock`] per matched ID. IDs that don't exist in the
/// database **or whose owning page lives in a different space** are silently
/// omitted (no error). Soft-deleted blocks are included with `deleted = true`.
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction.
///
/// FEAT-3 Phase 7 — `space_id` is required (not optional). Targets whose
/// `COALESCE(b.page_id, b.id)` does not carry `space = ?space_id` are
/// dropped from the result. This is the policy enforcement point for
/// "no live links between spaces, ever": foreign-space chips fall into
/// the "unknown id" branch in the frontend and render as broken-link
/// chips via the existing UX. See REVIEW-LATER FEAT-3p7.
///
/// # Errors
///
/// - [`AppError::Validation`] — `ids` is empty
///
/// `space_id` is `Option<String>` — when `Some`, results are scoped to that
/// space (FEAT-3p7's broken-chip rendering for foreign-space `[[ULID]]`
/// targets); when `None`, the call is cross-space (used by legacy surfaces
/// like trash, search, agenda views that have not yet been promoted to
/// per-space scoping — tracked under FEAT-3p4). The transitional `Option`
/// shape mirrors `list_page_history`'s FEAT-3p8 pattern.
#[instrument(skip(pool, ids), err)]
pub async fn batch_resolve_inner(
    pool: &SqlitePool,
    ids: Vec<String>,
    space_id: Option<String>,
) -> Result<Vec<ResolvedBlock>, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation("ids list cannot be empty".into()));
    }

    let ids_json = serde_json::to_string(&ids)?;

    // FEAT-3 Phase 7: scope to the current space using the canonical
    // `COALESCE(b.page_id, b.id) IN (SELECT bp.block_id FROM block_properties bp
    // WHERE bp.key = 'space' AND bp.value_ref = ?)` filter (matches the pattern
    // shipped in `pagination/{hierarchy,trash}.rs` and `fts/search.rs`).
    // The `?2 IS NULL OR …` shape lets cross-space callers (None) bypass
    // the filter entirely while space-scoped callers (Some) get the
    // foreign-target-drops-out behaviour the spec demands.
    //
    // AGENTS.md invariant #9 — `is_conflict = 0` filter prevents conflict
    // copies from leaking into resolution results. A conflict copy carries
    // its own ULID + the same content as the original; without this guard
    // a `[[ULID]]` chip targeting the original would resolve to either the
    // original or its conflict copy depending on row ordering, surfacing
    // duplicate / corrupted titles in breadcrumbs and link chips. Mirrors
    // the pattern in every other space-scoped query we ship.
    let rows = sqlx::query_as!(
        ResolvedBlockRow,
        r#"SELECT
             b.id,
             b.content AS title,
             b.block_type,
             (CASE WHEN b.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS "deleted: bool"
           FROM blocks b
           WHERE b.id IN (SELECT value FROM json_each(?1))
             AND b.is_conflict = 0
             AND (?2 IS NULL OR COALESCE(b.page_id, b.id) IN (
                 SELECT bp.block_id
                 FROM block_properties bp
                 WHERE bp.key = 'space' AND bp.value_ref = ?2
             ))"#,
        ids_json,
        space_id,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| ResolvedBlock {
            id: r.id,
            title: r.title,
            block_type: r.block_type,
            deleted: r.deleted.unwrap_or(false),
        })
        .collect())
}

/// Tauri command: list blocks with filtering and pagination. Delegates to [`list_blocks_inner`].
///
/// The three agenda knobs (`date`, `date_range`, `source`) are bundled
/// into a single [`AgendaQuery`] to keep this wrapper under the
/// `tauri-specta` 10-arg limit after FEAT-3 Phase 2 added `space_id`.
/// The hand-written TS wrapper in `src/lib/tauri.ts` keeps the flat
/// public API (accepts `agendaDate` / `agendaDateRange` / `agendaSource`
/// at the top level and marshals them into this struct for the IPC
/// boundary).
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn list_blocks(
    pool: State<'_, ReadPool>,
    parent_id: Option<String>,
    block_type: Option<String>,
    tag_id: Option<String>,
    show_deleted: Option<bool>,
    agenda: Option<AgendaQuery>,
    cursor: Option<String>,
    limit: Option<i64>,
    space_id: Option<String>,
) -> Result<PageResponse<BlockRow>, AppError> {
    let (agenda_date, agenda_date_start, agenda_date_end, agenda_source) = match agenda {
        Some(a) => (
            a.date,
            a.date_range.as_ref().map(|r| r.start.clone()),
            a.date_range.as_ref().map(|r| r.end.clone()),
            a.source,
        ),
        None => (None, None, None, None),
    };
    list_blocks_inner(
        &pool.0,
        parent_id,
        block_type,
        tag_id,
        show_deleted,
        agenda_date,
        agenda_date_start,
        agenda_date_end,
        agenda_source,
        cursor,
        limit,
        space_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: fetch a single block by ID. Delegates to [`get_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_block(pool: State<'_, ReadPool>, block_id: String) -> Result<BlockRow, AppError> {
    get_block_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-resolve block metadata. Delegates to [`batch_resolve_inner`].
///
/// FEAT-3 Phase 7 — `space_id` is required so the resolve store cannot
/// surface foreign-space titles. The frontend always knows the current
/// space and threads it through `useResolveStore.preload(spaceId)`.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn batch_resolve(
    pool: State<'_, ReadPool>,
    ids: Vec<String>,
    space_id: Option<String>,
) -> Result<Vec<ResolvedBlock>, AppError> {
    batch_resolve_inner(&pool.0, ids, space_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Batch-count cascade-deleted descendants per trash root.
///
/// Given a list of trash-root ids (as returned by `list_blocks({ show_deleted: true })`),
/// return a map of `root_id -> descendant_count`. Descendants are blocks
/// sharing the root's `deleted_at` timestamp, excluding the root itself and
/// any conflict copies. Roots with zero descendants are omitted — callers
/// should default to `0` for missing entries.
///
/// # Errors
///
/// - [`AppError::Json`] — failed to serialize `root_ids`.
/// - [`AppError::Database`] — propagated from sqlx.
#[instrument(skip(pool, root_ids), err)]
pub async fn trash_descendant_counts_inner(
    pool: &SqlitePool,
    root_ids: Vec<String>,
) -> Result<HashMap<String, u64>, AppError> {
    pagination::trash_descendant_counts(pool, &root_ids).await
}

/// Tauri command: batch-count cascade-deleted descendants per trash root.
/// Delegates to [`trash_descendant_counts_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn trash_descendant_counts(
    pool: State<'_, ReadPool>,
    root_ids: Vec<String>,
) -> Result<HashMap<String, u64>, AppError> {
    trash_descendant_counts_inner(&pool.0, root_ids)
        .await
        .map_err(sanitize_internal_error)
}
