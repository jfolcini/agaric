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
/// agenda and tag paths remain unscoped in Phase 2 and gain scoping in
/// Phase 4 (see REVIEW-LATER FEAT-3).
///
/// # Errors
///
/// - [`AppError::Validation`] — multiple conflicting filters, or invalid date format
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
/// database are silently omitted (no error). Soft-deleted blocks are included
/// with `deleted = true`.
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction.
///
/// # Errors
///
/// - [`AppError::Validation`] — `ids` is empty
#[instrument(skip(pool, ids), err)]
pub async fn batch_resolve_inner(
    pool: &SqlitePool,
    ids: Vec<String>,
) -> Result<Vec<ResolvedBlock>, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation("ids list cannot be empty".into()));
    }

    let ids_json = serde_json::to_string(&ids)?;

    let rows = sqlx::query_as!(
        ResolvedBlockRow,
        r#"SELECT
             id,
             content AS title,
             block_type,
             (CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS "deleted: bool"
           FROM blocks
           WHERE id IN (SELECT value FROM json_each(?1))"#,
        ids_json,
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
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn batch_resolve(
    pool: State<'_, ReadPool>,
    ids: Vec<String>,
) -> Result<Vec<ResolvedBlock>, AppError> {
    batch_resolve_inner(&pool.0, ids)
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
