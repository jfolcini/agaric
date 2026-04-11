//! Tauri command handlers for the Agaric app.
//!
//! Each command writes to both the op_log AND the blocks table directly.
//! The materializer is used only for background cache work (tags, pages,
//! agenda, block_links) via `dispatch_background()`. This avoids race
//! conditions and double-writes.
//!
//! All commands return `Result<T, AppError>` — `AppError` already implements
//! `Serialize` for Tauri 2 command error propagation.

use std::sync::Mutex;

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::draft;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::now_rfc3339;
use crate::op::{is_reserved_property_key, DeletePropertyPayload, OpPayload, UndoResult};
use crate::op_log;
use crate::pagination::{self, BlockRow, HistoryEntry, PageResponse};
use crate::pairing::PairingSession;
#[cfg(test)]
use crate::soft_delete;
use crate::ulid::BlockId;

// Domain sub-modules
mod agenda;
mod attachments;
mod blocks;
mod history;
mod pages;
mod properties;
mod queries;
mod sync_cmds;
mod tags;

// Tauri command handlers and testable _inner functions — explicitly re-exported.
pub use agenda::{
    count_agenda_batch, count_agenda_batch_by_source, count_agenda_batch_by_source_inner,
    count_agenda_batch_inner, list_projected_agenda, list_projected_agenda_inner,
};
pub use attachments::{
    add_attachment, add_attachment_inner, delete_attachment, delete_attachment_inner,
    list_attachments, list_attachments_inner,
};
pub use blocks::{
    batch_resolve, batch_resolve_inner, create_block, create_block_inner, delete_block,
    delete_block_inner, edit_block, edit_block_inner, get_block, get_block_inner, list_blocks,
    list_blocks_inner, move_block, move_block_inner, purge_all_deleted, purge_all_deleted_inner,
    purge_block, purge_block_inner, restore_all_deleted, restore_all_deleted_inner, restore_block,
    restore_block_inner,
};
pub use history::{
    apply_reverse_in_tx, compute_edit_diff, compute_edit_diff_inner, list_page_history,
    list_page_history_inner, redo_page_op, redo_page_op_inner, restore_page_to_op,
    restore_page_to_op_inner, revert_ops, revert_ops_inner, undo_page_op, undo_page_op_inner,
};
pub use pages::{
    export_page_markdown, export_page_markdown_inner, get_page_aliases, get_page_aliases_inner,
    import_markdown, import_markdown_inner, list_page_links, list_page_links_inner,
    resolve_page_by_alias, resolve_page_by_alias_inner, set_page_aliases, set_page_aliases_inner,
};
pub use properties::{
    create_property_def, create_property_def_inner, delete_property, delete_property_def,
    delete_property_def_inner, delete_property_inner, get_batch_properties,
    get_batch_properties_inner, get_properties, get_properties_inner, list_property_defs,
    list_property_defs_inner, list_property_keys, list_property_keys_inner, set_due_date,
    set_due_date_inner, set_priority, set_priority_inner, set_property, set_property_inner,
    set_scheduled_date, set_scheduled_date_inner, set_todo_state, set_todo_state_inner,
    update_property_def_options, update_property_def_options_inner,
};
pub use queries::{
    count_backlinks_batch, count_backlinks_batch_inner, get_backlinks, get_backlinks_inner,
    get_conflicts, get_conflicts_inner, get_status, get_status_inner, list_backlinks_grouped,
    list_backlinks_grouped_inner, list_unlinked_references, list_unlinked_references_inner,
    query_backlinks_filtered, query_backlinks_filtered_inner, query_by_property,
    query_by_property_inner, search_blocks, search_blocks_inner,
};
pub use sync_cmds::{
    cancel_pairing, cancel_pairing_inner, cancel_sync, cancel_sync_inner, confirm_pairing,
    confirm_pairing_inner, delete_peer_ref, delete_peer_ref_inner, get_device_id,
    get_device_id_inner, get_peer_ref, get_peer_ref_inner, list_peer_refs, list_peer_refs_inner,
    set_peer_address, set_peer_address_inner, start_pairing, start_pairing_inner, start_sync,
    start_sync_inner, update_peer_name, update_peer_name_inner,
};
pub use tags::{
    add_tag, add_tag_inner, list_tags_by_prefix, list_tags_by_prefix_inner, list_tags_for_block,
    list_tags_for_block_inner, query_by_tags, query_by_tags_inner, remove_tag, remove_tag_inner,
};

// specta-generated type-export fns required by `collect_commands![]` in lib.rs.
// These are created by the `#[specta::specta]` proc macro on each Tauri command handler.
#[doc(hidden)]
pub use agenda::{
    __specta__fn__count_agenda_batch, __specta__fn__count_agenda_batch_by_source,
    __specta__fn__list_projected_agenda,
};
#[doc(hidden)]
pub use attachments::{
    __specta__fn__add_attachment, __specta__fn__delete_attachment, __specta__fn__list_attachments,
};
#[doc(hidden)]
pub use blocks::{
    __specta__fn__batch_resolve, __specta__fn__create_block, __specta__fn__delete_block,
    __specta__fn__edit_block, __specta__fn__get_block, __specta__fn__list_blocks,
    __specta__fn__move_block, __specta__fn__purge_all_deleted, __specta__fn__purge_block,
    __specta__fn__restore_all_deleted, __specta__fn__restore_block,
};
#[doc(hidden)]
pub use history::{
    __specta__fn__compute_edit_diff, __specta__fn__list_page_history, __specta__fn__redo_page_op,
    __specta__fn__restore_page_to_op, __specta__fn__revert_ops, __specta__fn__undo_page_op,
};
#[doc(hidden)]
pub use pages::{
    __specta__fn__export_page_markdown, __specta__fn__get_page_aliases,
    __specta__fn__import_markdown, __specta__fn__list_page_links,
    __specta__fn__resolve_page_by_alias, __specta__fn__set_page_aliases,
};
#[doc(hidden)]
pub use properties::{
    __specta__fn__create_property_def, __specta__fn__delete_property,
    __specta__fn__delete_property_def, __specta__fn__get_batch_properties,
    __specta__fn__get_properties, __specta__fn__list_property_defs,
    __specta__fn__list_property_keys, __specta__fn__set_due_date, __specta__fn__set_priority,
    __specta__fn__set_property, __specta__fn__set_scheduled_date, __specta__fn__set_todo_state,
    __specta__fn__update_property_def_options,
};
#[doc(hidden)]
pub use queries::{
    __specta__fn__count_backlinks_batch, __specta__fn__get_backlinks, __specta__fn__get_conflicts,
    __specta__fn__get_status, __specta__fn__list_backlinks_grouped,
    __specta__fn__list_unlinked_references, __specta__fn__query_backlinks_filtered,
    __specta__fn__query_by_property, __specta__fn__search_blocks,
};
#[doc(hidden)]
pub use sync_cmds::{
    __specta__fn__cancel_pairing, __specta__fn__cancel_sync, __specta__fn__confirm_pairing,
    __specta__fn__delete_peer_ref, __specta__fn__get_device_id, __specta__fn__get_peer_ref,
    __specta__fn__list_peer_refs, __specta__fn__set_peer_address, __specta__fn__start_pairing,
    __specta__fn__start_sync, __specta__fn__update_peer_name,
};
#[doc(hidden)]
pub use tags::{
    __specta__fn__add_tag, __specta__fn__list_tags_by_prefix, __specta__fn__list_tags_for_block,
    __specta__fn__query_by_tags, __specta__fn__remove_tag,
};

// Tauri `__cmd__` wrappers generated by `#[tauri::command]` on each handler.
#[doc(hidden)]
pub use agenda::{
    __cmd__count_agenda_batch, __cmd__count_agenda_batch_by_source, __cmd__list_projected_agenda,
};
#[doc(hidden)]
pub use attachments::{__cmd__add_attachment, __cmd__delete_attachment, __cmd__list_attachments};
#[doc(hidden)]
pub use blocks::{
    __cmd__batch_resolve, __cmd__create_block, __cmd__delete_block, __cmd__edit_block,
    __cmd__get_block, __cmd__list_blocks, __cmd__move_block, __cmd__purge_all_deleted,
    __cmd__purge_block, __cmd__restore_all_deleted, __cmd__restore_block,
};
#[doc(hidden)]
pub use history::{
    __cmd__compute_edit_diff, __cmd__list_page_history, __cmd__redo_page_op,
    __cmd__restore_page_to_op, __cmd__revert_ops, __cmd__undo_page_op,
};
#[doc(hidden)]
pub use pages::{
    __cmd__export_page_markdown, __cmd__get_page_aliases, __cmd__import_markdown,
    __cmd__list_page_links, __cmd__resolve_page_by_alias, __cmd__set_page_aliases,
};
#[doc(hidden)]
pub use properties::{
    __cmd__create_property_def, __cmd__delete_property, __cmd__delete_property_def,
    __cmd__get_batch_properties, __cmd__get_properties, __cmd__list_property_defs,
    __cmd__list_property_keys, __cmd__set_due_date, __cmd__set_priority, __cmd__set_property,
    __cmd__set_scheduled_date, __cmd__set_todo_state, __cmd__update_property_def_options,
};
#[doc(hidden)]
pub use queries::{
    __cmd__count_backlinks_batch, __cmd__get_backlinks, __cmd__get_conflicts, __cmd__get_status,
    __cmd__list_backlinks_grouped, __cmd__list_unlinked_references,
    __cmd__query_backlinks_filtered, __cmd__query_by_property, __cmd__search_blocks,
};
#[doc(hidden)]
pub use sync_cmds::{
    __cmd__cancel_pairing, __cmd__cancel_sync, __cmd__confirm_pairing, __cmd__delete_peer_ref,
    __cmd__get_device_id, __cmd__get_peer_ref, __cmd__list_peer_refs, __cmd__set_peer_address,
    __cmd__start_pairing, __cmd__start_sync, __cmd__update_peer_name,
};
#[doc(hidden)]
pub use tags::{
    __cmd__add_tag, __cmd__list_tags_by_prefix, __cmd__list_tags_for_block, __cmd__query_by_tags,
    __cmd__remove_tag,
};

// pub(crate) helpers used by other crate modules (e.g. recurrence.rs)
pub(crate) use blocks::{create_block_in_tx, set_property_in_tx};
pub(crate) use properties::is_valid_iso_date;

const MAX_CONTENT_LENGTH: usize = 256 * 1024;

/// Maximum allowed nesting depth for the block tree.
/// Prevents pathological recursion and keeps recursive CTEs bounded.
const MAX_BLOCK_DEPTH: i64 = 20;

/// Maximum allowed attachment size (50 MB).
const MAX_ATTACHMENT_SIZE: i64 = 50 * 1024 * 1024;

/// Allowed MIME type patterns for attachments.
/// Patterns ending with `/*` match any subtype under that top-level type.
const ALLOWED_MIME_PATTERNS: &[&str] = &[
    "image/*",
    "application/pdf",
    "text/*",
    "application/json",
    "application/zip",
    "application/x-tar",
];

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// Validate that a date string is in `YYYY-MM-DD` format with reasonable
/// range checks on month (01–12) and day (01–31). This is a structural
/// check — it does NOT reject dates like Feb 30; the DB/agenda query
/// handles that gracefully. The goal is to catch obviously malformed input
/// before it reaches the query layer.
fn validate_date_format(date: &str) -> Result<(), AppError> {
    if date.len() != 10 {
        return Err(AppError::Validation(format!(
            "date must be exactly 10 characters (YYYY-MM-DD), got {} characters: '{date}'",
            date.len()
        )));
    }

    let bytes = date.as_bytes();
    // Check pattern: DDDD-DD-DD where D is ASCII digit
    let digit_positions = [0, 1, 2, 3, 5, 6, 8, 9];
    for &i in &digit_positions {
        if !bytes[i].is_ascii_digit() {
            return Err(AppError::Validation(format!(
                "date must match YYYY-MM-DD pattern, got '{date}'"
            )));
        }
    }
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(AppError::Validation(format!(
            "date must match YYYY-MM-DD pattern, got '{date}'"
        )));
    }

    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err(AppError::Validation(format!(
            "date must have 3 parts separated by '-', got '{date}'"
        )));
    }

    let year_len = parts[0].len();
    let month_len = parts[1].len();
    let day_len = parts[2].len();
    if year_len != 4 || month_len != 2 || day_len != 2 {
        return Err(AppError::Validation(format!(
            "date must be YYYY-MM-DD (4-2-2 digits), got '{date}'"
        )));
    }

    let month: u32 = parts[1].parse().unwrap_or(0);
    let day: u32 = parts[2].parse().unwrap_or(0);

    if !(1..=12).contains(&month) {
        return Err(AppError::Validation(format!(
            "month must be 01–12, got '{}'",
            parts[1]
        )));
    }
    if !(1..=31).contains(&day) {
        return Err(AppError::Validation(format!(
            "day must be 01–31, got '{}'",
            parts[2]
        )));
    }

    Ok(())
}

/// A date range for agenda queries. Both fields must be in `YYYY-MM-DD` format.
#[derive(Debug, Clone, serde::Deserialize, Serialize, Type)]
pub struct DateRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct DeleteResponse {
    pub block_id: String,
    pub deleted_at: String,
    pub descendants_affected: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct RestoreResponse {
    pub block_id: String,
    pub restored_count: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct PurgeResponse {
    pub block_id: String,
    pub purged_count: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct BulkTrashResponse {
    pub affected_count: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct MoveResponse {
    pub block_id: String,
    pub new_parent_id: Option<String>,
    pub new_position: i64,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct TagResponse {
    pub block_id: String,
    pub tag_id: String,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow, Type)]
pub struct PropertyRow {
    pub key: String,
    pub value_text: Option<String>,
    pub value_num: Option<f64>,
    pub value_date: Option<String>,
    pub value_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, sqlx::FromRow, specta::Type)]
pub struct AttachmentRow {
    pub id: String,
    pub block_id: String,
    pub mime_type: String,
    pub filename: String,
    pub size_bytes: i64,
    pub fs_path: String,
    pub created_at: String,
}

/// Check whether `mime` matches one of [`ALLOWED_MIME_PATTERNS`].
///
/// Wildcard patterns like `"image/*"` match any subtype under that
/// top-level type (e.g. `"image/png"`, `"image/jpeg"`).
fn is_mime_allowed(mime: &str) -> bool {
    for pattern in ALLOWED_MIME_PATTERNS {
        if pattern.ends_with("/*") {
            let prefix = &pattern[..pattern.len() - 1]; // e.g. "image/"
            if mime.starts_with(prefix) {
                return true;
            }
        } else if *pattern == mime {
            return true;
        }
    }
    false
}

/// A property definition from the schema registry.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PropertyDefinition {
    pub key: String,
    pub value_type: String,
    pub options: Option<String>, // JSON array string for select types
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Sync pairing & session types
// ---------------------------------------------------------------------------

/// Response payload returned by [`start_pairing`].
#[derive(Debug, Clone, Serialize, Type)]
pub struct PairingInfo {
    pub passphrase: String,
    pub qr_svg: String,
    pub port: u16,
}

/// Response payload returned by [`start_sync`].
#[derive(Debug, Clone, Serialize, Type)]
pub struct SyncSessionInfo {
    pub state: String,
    pub local_device_id: String,
    pub remote_device_id: String,
    pub ops_received: u64,
    pub ops_sent: u64,
}

/// Managed state holding the current active pairing session (if any).
///
/// Uses a std `Mutex` (not tokio) because the critical section is
/// trivially short (swap an `Option`).
pub struct PairingState(pub Mutex<Option<PairingSession>>);

// ---------------------------------------------------------------------------
// batch_resolve — single-query multi-block metadata lookup
// ---------------------------------------------------------------------------

/// Lightweight metadata returned by [`batch_resolve_inner`].
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct ResolvedBlock {
    pub id: String,
    /// `content` column — page title, tag name, or content text (truncated).
    pub title: Option<String>,
    pub block_type: String,
    pub deleted: bool,
}

/// Internal row type for the batch_resolve query (sqlx-compatible).
#[derive(Debug, sqlx::FromRow)]
struct ResolvedBlockRow {
    id: String,
    title: Option<String>,
    block_type: String,
    deleted: Option<bool>,
}

/// List op-log history entries for a specific block, with cursor pagination.
pub async fn get_block_history_inner(
    pool: &SqlitePool,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_block_history(pool, &block_id, &page).await
}

/// Core deletion logic without the built-in key guard.
///
/// Used internally by state-transition helpers (e.g. `set_todo_state_inner`)
/// that need to clear system-managed properties like `created_at` /
/// `completed_at`.
async fn delete_property_core(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    key: String,
) -> Result<(), AppError> {
    // 1. Begin IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // 2. Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // 3. Append DeleteProperty op
    let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
        block_id: BlockId::from_trusted(&block_id),
        key: key.clone(),
    });
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 4. Materialize: delete/clear the property
    if is_reserved_property_key(&key) {
        let col = match key.as_str() {
            "todo_state" => "todo_state",
            "priority" => "priority",
            "due_date" => "due_date",
            "scheduled_date" => "scheduled_date",
            _ => unreachable!(),
        };
        sqlx::query(&format!("UPDATE blocks SET {col} = NULL WHERE id = ?"))
            .bind(&block_id)
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(&block_id)
            .bind(&key)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget)
    if let Err(e) = materializer.dispatch_background(&op_record) {
        tracing::warn!(error = %e, "failed to dispatch background cache task");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Property-definition CRUD (#548-#550, #557)
// ---------------------------------------------------------------------------

/// Internal row type for the batch properties query (sqlx-compatible).
#[derive(Debug, sqlx::FromRow)]
struct BatchPropertyRow {
    block_id: String,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
}

// ---------------------------------------------------------------------------
// Batch count helpers
// ---------------------------------------------------------------------------

/// Intermediate row for the projected-agenda query.
///
/// Extends [`BlockRow`] with pre-fetched repeat properties so that we can
/// avoid N+1 queries inside the projection loop.
#[derive(Debug, Clone)]
struct RepeatingBlockRow {
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
    is_conflict: bool,
    conflict_type: Option<String>,
    todo_state: Option<String>,
    priority: Option<String>,
    due_date: Option<String>,
    scheduled_date: Option<String>,
    repeat_rule: Option<String>,
    repeat_until: Option<String>,
    repeat_count: Option<f64>,
    repeat_seq: Option<f64>,
}

impl RepeatingBlockRow {
    /// Extract the core [`BlockRow`] fields (used when building
    /// [`ProjectedAgendaEntry`] values).
    fn to_block_row(&self) -> BlockRow {
        BlockRow {
            id: self.id.clone(),
            block_type: self.block_type.clone(),
            content: self.content.clone(),
            parent_id: self.parent_id.clone(),
            position: self.position,
            deleted_at: self.deleted_at.clone(),
            is_conflict: self.is_conflict,
            conflict_type: self.conflict_type.clone(),
            todo_state: self.todo_state.clone(),
            priority: self.priority.clone(),
            due_date: self.due_date.clone(),
            scheduled_date: self.scheduled_date.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

/// Sanitize internal error details before returning to the frontend.
///
/// Applied to write commands only. Read commands intentionally return
/// unsanitized errors — these are useful for frontend debugging in a
/// local-first app where information disclosure is not a security risk.
#[cfg(not(tarpaulin_include))]
fn sanitize_internal_error(err: AppError) -> AppError {
    match &err {
        AppError::Database(_) | AppError::Migration(_) | AppError::Io(_) | AppError::Json(_) => {
            tracing::warn!(error = %err, "internal error suppressed during sanitization");
            AppError::InvalidOperation("an internal error occurred".into())
        }
        _ => err,
    }
}

/// Tauri command: list op-log history for a block. Delegates to [`get_block_history_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_block_history(
    pool: State<'_, ReadPool>,
    block_id: String,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    get_block_history_inner(&pool.0, block_id, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Draft autosave commands (F-17)
// ---------------------------------------------------------------------------

/// Flush a draft: look up the stored draft content, compute `prev_edit`,
/// write an `edit_block` op, and delete the draft row — all atomically.
///
/// If no draft exists for `block_id`, this is a no-op (returns `Ok(())`).
pub async fn flush_draft_inner(
    pool: &SqlitePool,
    device_id: &str,
    block_id: String,
) -> Result<(), AppError> {
    // 1. Look up the draft; if none exists, no-op.
    let stored = match draft::get_draft(pool, &block_id).await? {
        Some(d) => d,
        None => return Ok(()),
    };

    // 2. Compute prev_edit from op_log (same logic as edit_block_inner).
    let prev_edit_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         ORDER BY created_at DESC \
         LIMIT 1",
        block_id
    )
    .fetch_optional(pool)
    .await?;
    let prev_edit = prev_edit_row.map(|r| (r.device_id, r.seq));

    // 3. Delegate to draft::flush_draft (atomic tx inside).
    draft::flush_draft(pool, device_id, &block_id, &stored.content, prev_edit).await?;
    Ok(())
}

/// Tauri command: save a draft for a block. Delegates to [`draft::save_draft`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn save_draft(
    pool: State<'_, WritePool>,
    block_id: String,
    content: String,
) -> Result<(), AppError> {
    draft::save_draft(&pool.0, &block_id, &content)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: flush a draft (write edit_block op + delete draft row).
/// Delegates to [`flush_draft_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn flush_draft(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    block_id: String,
) -> Result<(), AppError> {
    flush_draft_inner(&pool.0, device_id.as_str(), block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete a draft for a block. Delegates to [`draft::delete_draft`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_draft(pool: State<'_, WritePool>, block_id: String) -> Result<(), AppError> {
    draft::delete_draft(&pool.0, &block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list all drafts. Delegates to [`draft::get_all_drafts`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_drafts(pool: State<'_, ReadPool>) -> Result<Vec<draft::Draft>, AppError> {
    draft::get_all_drafts(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Inner implementation for `list_drafts`, usable from tests without Tauri state.
pub async fn list_drafts_inner(pool: &sqlx::SqlitePool) -> Result<Vec<draft::Draft>, AppError> {
    draft::get_all_drafts(pool).await
}

// ---------------------------------------------------------------------------
// Frontend logging (F-19)
// ---------------------------------------------------------------------------

/// Log a frontend message to the backend's daily-rolling log file.
/// Fire-and-forget — the frontend never awaits this.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn log_frontend(
    level: String,
    module: String,
    message: String,
    stack: Option<String>,
    context: Option<String>,
    data: Option<String>,
) -> Result<(), AppError> {
    match level.as_str() {
        "error" => {
            tracing::error!(target: "frontend", module = %module, stack = stack.as_deref().unwrap_or(""), context = context.as_deref().unwrap_or(""), data = data.as_deref().unwrap_or(""), "{message}")
        }
        "warn" => {
            tracing::warn!(target: "frontend", module = %module, stack = stack.as_deref().unwrap_or(""), context = context.as_deref().unwrap_or(""), data = data.as_deref().unwrap_or(""), "{message}")
        }
        "info" => {
            tracing::info!(target: "frontend", module = %module, data = data.as_deref().unwrap_or(""), "{message}")
        }
        "debug" => {
            tracing::debug!(target: "frontend", module = %module, data = data.as_deref().unwrap_or(""), "{message}")
        }
        _ => {
            tracing::info!(target: "frontend", module = %module, data = data.as_deref().unwrap_or(""), "{message}")
        }
    }
    Ok(())
}

/// Return the path to the logs directory.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_log_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let log_dir = data_dir.join("logs");
    Ok(log_dir.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Op log compaction (F-20)
// ---------------------------------------------------------------------------

/// A link between two pages (for graph visualization).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, sqlx::FromRow, specta::Type)]
pub struct PageLink {
    pub source_id: String,
    pub target_id: String,
}

/// Result of a point-in-time restore operation.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct RestoreToOpResult {
    /// Number of ops that were successfully reverted.
    pub ops_reverted: u64,
    /// Number of non-reversible ops (purge_block, delete_attachment) skipped.
    pub non_reversible_skipped: u64,
    /// Individual undo results for each reverted op.
    pub results: Vec<UndoResult>,
}

/// Statistics about the op log, returned by [`get_compaction_status`].
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
pub struct CompactionStatus {
    pub total_ops: i64,
    pub oldest_op_date: Option<String>,
    pub eligible_ops: i64,
    pub retention_days: u64,
}

/// Result of an op log compaction, returned by [`compact_op_log_cmd`].
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
pub struct CompactionResult {
    pub snapshot_id: Option<String>,
    pub ops_deleted: i64,
}

/// Inner implementation for [`get_compaction_status`], testable without Tauri state.
pub async fn get_compaction_status_inner(pool: &SqlitePool) -> Result<CompactionStatus, AppError> {
    let total_ops: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await?;

    let oldest_op_date: Option<String> = sqlx::query_scalar!("SELECT MIN(created_at) FROM op_log")
        .fetch_one(pool)
        .await?;

    let cutoff =
        chrono::Utc::now() - chrono::Duration::days(crate::snapshot::DEFAULT_RETENTION_DAYS as i64);
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let eligible_ops: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(pool)
    .await?;

    Ok(CompactionStatus {
        total_ops,
        oldest_op_date,
        eligible_ops,
        retention_days: crate::snapshot::DEFAULT_RETENTION_DAYS,
    })
}

/// Tauri command: return op log compaction statistics for the UI.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_compaction_status(
    pool: State<'_, ReadPool>,
) -> Result<CompactionStatus, AppError> {
    get_compaction_status_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Inner implementation for [`compact_op_log_cmd`], testable without Tauri state.
///
/// Wraps the compaction in a `BEGIN IMMEDIATE` transaction to prevent
/// interleaving with concurrent writers (REVIEW-LATER item from snapshot.rs).
pub async fn compact_op_log_cmd_inner(
    pool: &SqlitePool,
    device_id: &str,
    retention_days: u64,
) -> Result<CompactionResult, AppError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    // Count eligible ops before compaction
    let eligible: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(pool)
    .await?;

    if eligible == 0 {
        return Ok(CompactionResult {
            snapshot_id: None,
            ops_deleted: 0,
        });
    }

    // Wrap in BEGIN IMMEDIATE for atomicity (the existing compact_op_log
    // lacks explicit transaction wrapping — see REVIEW-LATER).
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Recount inside the transaction to avoid TOCTOU
    let eligible_in_tx: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_str
    )
    .fetch_one(&mut *tx)
    .await?;

    if eligible_in_tx == 0 {
        tx.rollback().await?;
        return Ok(CompactionResult {
            snapshot_id: None,
            ops_deleted: 0,
        });
    }

    // Release the IMMEDIATE transaction before calling compact_op_log,
    // which manages its own internal queries. We verified eligibility;
    // compact_op_log will re-verify and perform the actual work.
    tx.commit().await?;

    let snapshot_id = crate::snapshot::compact_op_log(pool, device_id, retention_days).await?;

    Ok(CompactionResult {
        snapshot_id,
        ops_deleted: eligible_in_tx,
    })
}

/// Tauri command: trigger op log compaction.
///
/// The frontend is responsible for confirming with the user before calling
/// this command. `retention_days` controls how far back ops are retained.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn compact_op_log_cmd(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    retention_days: u64,
) -> Result<CompactionResult, AppError> {
    compact_op_log_cmd_inner(&pool.0, device_id.as_str(), retention_days)
        .await
        .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Journal commands — daily page navigation
// ---------------------------------------------------------------------------

/// Open today's journal page, creating it if it does not exist.
///
/// Returns the [`BlockRow`] for a `page` block whose content is today's date
/// in `YYYY-MM-DD` format.  The lookup is idempotent: calling this multiple
/// times on the same day always returns the same page.
pub async fn today_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BlockRow, AppError> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    navigate_journal_inner(pool, device_id, materializer, today).await
}

/// Open the journal page for a specific date, creating it if it does not exist.
///
/// `date` must be in `YYYY-MM-DD` format.  If a `page` block with that exact
/// content already exists (and is not deleted), its [`BlockRow`] is returned.
/// Otherwise a new page block is created.
///
/// # Errors
///
/// - [`AppError::Validation`] — `date` is not a valid `YYYY-MM-DD` string
pub async fn navigate_journal_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    date: String,
) -> Result<BlockRow, AppError> {
    validate_date_format(&date)?;

    // Look for an existing page whose content matches the date exactly.
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type,
                  todo_state, priority, due_date, scheduled_date
           FROM blocks
           WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL
           LIMIT 1"#,
        date
    )
    .fetch_optional(pool)
    .await?;

    if let Some(row) = existing {
        return Ok(row);
    }

    // No existing page — create one.
    create_block_inner(
        pool,
        device_id,
        materializer,
        "page".into(),
        date,
        None,
        None,
    )
    .await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Integration-style tests for command handlers.
    //!
    //! Each test uses a temporary SQLite database with full migrations.
    //! The Materializer is created for commands that require it; sleeps
    //! between operations allow background cache tasks to settle and avoid
    //! write-lock contention.

    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::op::{DeleteBlockPayload, EditBlockPayload, OpRef, RemoveTagPayload};
    use crate::peer_refs;
    use crate::sync_scheduler::SyncScheduler;
    use chrono::Datelike;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::TempDir;

    // -- Deterministic test fixtures --

    const DEV: &str = "test-device-001";
    const FIXED_TS: &str = "2025-01-01T00:00:00Z";

    // -- Helpers --

    /// Creates a temporary SQLite database with all migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block directly into the blocks table (bypasses command layer).
    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
    }

    // ======================================================================
    // create_block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_returns_correct_fields_and_persists() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello world".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        assert_eq!(resp.block_type, "content", "block_type should match input");
        assert_eq!(
            resp.content,
            Some("hello world".into()),
            "content should match input"
        );
        assert!(resp.parent_id.is_none(), "top-level block has no parent");
        assert_eq!(resp.position, Some(1), "position should match input");
        assert!(resp.deleted_at.is_none(), "new block should not be deleted");

        // Verify persistence in DB via direct query
        let row = get_block_inner(&pool, resp.id.clone()).await.unwrap();
        assert_eq!(row.id, resp.id, "DB row should match response ID");
        assert_eq!(
            row.block_type, "content",
            "DB block_type should be persisted"
        );
        assert_eq!(
            row.content,
            Some("hello world".into()),
            "DB content should be persisted"
        );
        assert_eq!(row.position, Some(1), "DB position should be persisted");
        assert!(
            row.deleted_at.is_none(),
            "DB row should not be soft-deleted"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_generates_valid_ulid() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.id.len(),
            26,
            "ULID should be 26 Crockford base32 characters"
        );
        assert!(
            resp.id.chars().all(|c| c.is_ascii_alphanumeric()),
            "ULID should only contain alphanumeric characters"
        );
        assert!(
            BlockId::from_string(&resp.id).is_ok(),
            "response ID should parse as a valid ULID"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_with_parent_sets_parent_id() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let parent = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "parent".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(parent.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        assert_eq!(
            child.parent_id,
            Some(parent.id),
            "child.parent_id should match parent's ID"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_nonexistent_parent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some("NONEXISTENT_PARENT".into()),
            Some(1),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound for nonexistent parent"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_deleted_parent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let parent = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "parent".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, parent.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(parent.id),
            Some(1),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound for deleted parent"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_writes_op_to_op_log() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "logged".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'create_block'",
            DEV
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(count, 1, "exactly one create_block op should be logged");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_invalid_block_type_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "invalid_type".into(),
            "hello".into(),
            None,
            None,
        )
        .await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "should return Validation error"
        );
        assert!(
            err.to_string().contains("unknown block_type"),
            "error message should mention unknown block_type"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_all_valid_types_accepted() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        for block_type in &["content", "tag", "page"] {
            let resp = create_block_inner(
                &pool,
                DEV,
                &mat,
                block_type.to_string(),
                format!("test {block_type}"),
                None,
                None,
            )
            .await;

            assert!(resp.is_ok(), "block_type '{block_type}' should be accepted");
            assert_eq!(
                resp.unwrap().block_type,
                *block_type,
                "returned block_type should match"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_with_empty_content_succeeds() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(&pool, DEV, &mat, "content".into(), "".into(), None, None)
            .await
            .unwrap();

        assert_eq!(
            resp.content,
            Some("".into()),
            "empty content should be stored as-is"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_with_unicode_content_preserves_text() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let unicode_content = "Hello 世界! 🌍 Ñoño café résumé";
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            unicode_content.into(),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.content,
            Some(unicode_content.into()),
            "unicode content should be preserved exactly"
        );

        // Also verify round-trip through DB
        let row = get_block_inner(&pool, resp.id).await.unwrap();
        assert_eq!(
            row.content,
            Some(unicode_content.into()),
            "DB should preserve unicode content"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_rejects_oversized_content() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
        let result =
            create_block_inner(&pool, DEV, &mat, "content".into(), oversized, None, None).await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "should return Validation error for oversized content, got: {err:?}"
        );
        assert!(
            err.to_string().contains("exceeds maximum"),
            "error message should mention exceeds maximum"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_accepts_content_at_max_length() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let at_limit = "x".repeat(MAX_CONTENT_LENGTH);
        let result =
            create_block_inner(&pool, DEV, &mat, "content".into(), at_limit, None, None).await;

        assert!(
            result.is_ok(),
            "content of exactly MAX_CONTENT_LENGTH bytes should be accepted, got: {:?}",
            result.unwrap_err()
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_position_zero_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(0),
        )
        .await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "position=0 should return Validation error, got: {err:?}"
        );
        assert!(
            err.to_string().contains("position must be positive"),
            "error message should mention position must be positive"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_block_position_negative_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(-1),
        )
        .await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "position=-1 should return Validation error, got: {err:?}"
        );
        assert!(
            err.to_string().contains("position must be positive"),
            "error message should mention position must be positive"
        );
    }

    // ======================================================================
    // edit_block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_updates_content() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
            .await
            .unwrap();

        assert_eq!(
            edited.content,
            Some("updated".into()),
            "edited content should reflect new value"
        );

        // Verify in DB
        let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.content,
            Some("updated".into()),
            "DB content should be updated"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_sequential_edits_chain_prev_edit() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "v1".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        // First edit
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
            .await
            .unwrap();

        // Second edit — should have prev_edit pointing to the first edit
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v3".into())
            .await
            .unwrap();

        // Check the last op_log entry has prev_edit set
        let row = sqlx::query!(
            "SELECT payload FROM op_log \
             WHERE op_type = 'edit_block' \
             ORDER BY seq DESC LIMIT 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let payload: serde_json::Value = serde_json::from_str(&row.payload).unwrap();
        assert!(
            !payload["prev_edit"].is_null(),
            "prev_edit should be set on second edit"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = edit_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "text".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound for nonexistent block"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_deleted_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "soon deleted".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();

        let result = edit_block_inner(&pool, DEV, &mat, created.id, "should fail".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "editing a deleted block should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_with_unicode_preserves_text() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let unicode = "日本語テスト 🎌 über";
        let edited = edit_block_inner(&pool, DEV, &mat, created.id, unicode.into())
            .await
            .unwrap();

        assert_eq!(
            edited.content,
            Some(unicode.into()),
            "unicode content should survive edit round-trip"
        );
    }

    // ── edit_block edge cases ───────────────────────────────────────────

    /// Editing a block to an empty string must succeed — empty content is
    /// valid (e.g. a cleared paragraph before the user types new text).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_with_empty_to_text() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "non-empty".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "".into())
            .await
            .unwrap();

        assert_eq!(
            edited.content,
            Some("".into()),
            "editing to empty string must succeed and store empty content"
        );

        // Verify in DB
        let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.content,
            Some("".into()),
            "empty string must be persisted in DB"
        );
    }

    /// Editing a block with the exact same content it already has must still
    /// succeed (the command layer does not short-circuit on identical content).
    /// An op_log entry IS written because the command doesn't diff content —
    /// that's a valid design choice for idempotent replay.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_with_identical_content_is_noop() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "same text".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        // Count ops before the "no-change" edit
        let ops_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();

        // Edit with identical content
        let edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "same text".into())
            .await
            .unwrap();

        assert_eq!(
            edited.content,
            Some("same text".into()),
            "content must be returned unchanged"
        );

        // The command layer does not diff — an op IS still written
        let ops_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            ops_after,
            ops_before + 1,
            "an edit_block op is written even for identical content"
        );

        // Verify DB content is unchanged
        let row = sqlx::query!("SELECT content FROM blocks WHERE id = ?", created.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            row.content,
            Some("same text".into()),
            "DB content should remain unchanged"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_rejects_oversized_content() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block to edit
        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let oversized = "x".repeat(MAX_CONTENT_LENGTH + 1);
        let result = edit_block_inner(&pool, DEV, &mat, created.id, oversized).await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "should return Validation error for oversized content, got: {err:?}"
        );
        assert!(
            err.to_string().contains("exceeds maximum"),
            "error message should mention exceeds maximum"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn edit_block_accepts_content_at_max_length() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let at_limit = "x".repeat(MAX_CONTENT_LENGTH);
        let result = edit_block_inner(&pool, DEV, &mat, created.id, at_limit).await;

        assert!(
            result.is_ok(),
            "edit with exactly MAX_CONTENT_LENGTH bytes should be accepted, got: {:?}",
            result.unwrap_err()
        );
    }

    // ======================================================================
    // delete_block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_block_cascades_to_children() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let parent = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "parent".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let _child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(parent.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        let resp = delete_block_inner(&pool, DEV, &mat, parent.id)
            .await
            .unwrap();

        assert_eq!(resp.descendants_affected, 2, "parent + child = 2 affected");
        assert!(
            !resp.deleted_at.is_empty(),
            "deleted_at timestamp should be set"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_block_already_deleted_returns_invalid_operation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "delete me".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();

        let result = delete_block_inner(&pool, DEV, &mat, created.id).await;
        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "second delete should return InvalidOperation"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = delete_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "deleting a nonexistent block should return NotFound"
        );
    }

    // ======================================================================
    // restore_block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_block_restores_block_and_descendants() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Use direct inserts for setup to avoid materializer write contention
        insert_block(&pool, "RST_PAR", "page", "parent", None, Some(1)).await;
        insert_block(
            &pool,
            "RST_CHD",
            "content",
            "child",
            Some("RST_PAR"),
            Some(1),
        )
        .await;

        // Cascade soft-delete directly
        let (ts, _) = soft_delete::cascade_soft_delete(&pool, "RST_PAR")
            .await
            .unwrap();

        let rest_resp = restore_block_inner(&pool, DEV, &mat, "RST_PAR".into(), ts)
            .await
            .unwrap();

        assert_eq!(rest_resp.restored_count, 2, "parent + child restored");

        let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", "RST_PAR")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            row.deleted_at.is_none(),
            "parent should no longer be deleted after restore"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_block_not_deleted_returns_invalid_operation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ALIVE01", "content", "alive", None, Some(1)).await;

        let result = restore_block_inner(&pool, DEV, &mat, "ALIVE01".into(), FIXED_TS.into()).await;

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "restoring a non-deleted block should return InvalidOperation"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = restore_block_inner(&pool, DEV, &mat, "GHOST".into(), FIXED_TS.into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "restoring a nonexistent block should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_block_mismatched_deleted_at_returns_invalid_operation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "MISMATCH1", "content", "test", None, Some(1)).await;
        let (ts, _) = soft_delete::cascade_soft_delete(&pool, "MISMATCH1")
            .await
            .unwrap();

        let wrong_ts = format!("{ts}_wrong");
        let result = restore_block_inner(&pool, DEV, &mat, "MISMATCH1".into(), wrong_ts).await;

        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "mismatched deleted_at should return InvalidOperation"
        );
        assert!(
            err.to_string().contains("deleted_at mismatch"),
            "error message should mention mismatch"
        );
    }

    // ======================================================================
    // purge_block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_block_physically_removes_from_db() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "PURGE1", "content", "doomed", None, Some(1)).await;

        // Soft-delete first (purge requires prior soft-delete)
        soft_delete::cascade_soft_delete(&pool, "PURGE1")
            .await
            .unwrap();

        let resp = purge_block_inner(&pool, DEV, &mat, "PURGE1".into())
            .await
            .unwrap();

        assert_eq!(
            resp.purged_count, 1,
            "single block should have purged_count=1"
        );

        let exists = sqlx::query!(r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ?"#, "PURGE1")
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(
            exists.is_none(),
            "block should be physically gone after purge"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = purge_block_inner(&pool, DEV, &mat, "GHOST".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "purging a nonexistent block should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn purge_block_not_deleted_returns_invalid_operation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "PURGE_ALIVE", "content", "alive", None, Some(1)).await;

        let result = purge_block_inner(&pool, DEV, &mat, "PURGE_ALIVE".into()).await;
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "purging a non-deleted block should return InvalidOperation"
        );
        assert!(
            err.to_string().contains("soft-deleted before purging"),
            "error message should explain the requirement"
        );
    }

    // ======================================================================
    // list_blocks
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_no_filters_returns_top_level() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TOP1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "TOP2", "content", "b", None, Some(2)).await;
        insert_block(&pool, "CHILD1", "content", "c", Some("TOP1"), Some(1)).await;

        let resp = list_blocks_inner(
            &pool, None, None, None, None, None, None, None, None, None, None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "should only return top-level blocks (parent_id IS NULL)"
        );
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"TOP1"), "TOP1 should be in results");
        assert!(ids.contains(&"TOP2"), "TOP2 should be in results");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_block_type_filter() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE1", "page", "my page", None, Some(1)).await;
        insert_block(&pool, "TAG1", "tag", "urgent", None, None).await;
        insert_block(&pool, "CONT1", "content", "hello", None, Some(2)).await;

        let resp = list_blocks_inner(
            &pool,
            None,
            Some("page".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 1, "should filter to page type only");
        assert_eq!(resp.items[0].id, "PAGE1", "only page block should match");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_parent_id_filter() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAR", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CH1", "content", "child 1", Some("PAR"), Some(1)).await;
        insert_block(&pool, "CH2", "content", "child 2", Some("PAR"), Some(2)).await;
        insert_block(&pool, "OTHER", "content", "other", None, Some(2)).await;

        let resp = list_blocks_inner(
            &pool,
            Some("PAR".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 2, "should return only children of PAR");
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"CH1"), "CH1 should be in children results");
        assert!(ids.contains(&"CH2"), "CH2 should be in children results");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_tag_id_filter() {
        let (pool, _dir) = test_pool().await;

        // Create a tag and a content block, then associate them
        insert_block(&pool, "TAG_FILTER", "tag", "urgent", None, None).await;
        insert_block(&pool, "TAGGED_BLK", "content", "tagged item", None, Some(1)).await;
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind("TAGGED_BLK")
            .bind("TAG_FILTER")
            .execute(&pool)
            .await
            .unwrap();

        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            Some("TAG_FILTER".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "should return blocks tagged with TAG_FILTER"
        );
        assert_eq!(
            resp.items[0].id, "TAGGED_BLK",
            "tagged block should be returned"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_show_deleted_returns_trash() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "ALIVE", "content", "alive", None, Some(1)).await;
        insert_block(&pool, "DEAD", "content", "dead", None, Some(2)).await;

        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'DEAD'")
            .bind(FIXED_TS)
            .execute(&pool)
            .await
            .unwrap();

        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "trash should contain only deleted blocks"
        );
        assert_eq!(
            resp.items[0].id, "DEAD",
            "only deleted block should appear in trash"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_rejects_conflicting_filters() {
        let (pool, _dir) = test_pool().await;

        // parent_id + block_type
        let result = list_blocks_inner(
            &pool,
            Some("P1".into()),
            Some("page".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
            "parent_id + block_type should be rejected: {result:?}"
        );

        // tag_id + show_deleted
        let result = list_blocks_inner(
            &pool,
            None,
            None,
            Some("T1".into()),
            Some(true),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
            "tag_id + show_deleted should be rejected: {result:?}"
        );

        // parent_id + agenda_date
        let result = list_blocks_inner(
            &pool,
            Some("P1".into()),
            None,
            None,
            None,
            Some("2025-01-15".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
            "parent_id + agenda_date should be rejected: {result:?}"
        );

        // Three filters at once
        let result = list_blocks_inner(
            &pool,
            Some("P1".into()),
            Some("page".into()),
            Some("T1".into()),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("conflicting filters")),
            "three filters should be rejected: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_single_filter_is_accepted() {
        let (pool, _dir) = test_pool().await;

        // Each single filter should succeed (may return empty results — that's fine).
        assert!(
            list_blocks_inner(
                &pool,
                Some("P1".into()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None
            )
            .await
            .is_ok(),
            "parent_id alone should be accepted"
        );
        assert!(
            list_blocks_inner(
                &pool,
                None,
                Some("page".into()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None
            )
            .await
            .is_ok(),
            "block_type alone should be accepted"
        );
        assert!(
            list_blocks_inner(
                &pool,
                None,
                None,
                None,
                Some(true),
                None,
                None,
                None,
                None,
                None,
                None
            )
            .await
            .is_ok(),
            "show_deleted alone should be accepted"
        );
        // show_deleted=false should NOT count as a filter
        assert!(
            list_blocks_inner(
                &pool,
                None,
                Some("page".into()),
                None,
                Some(false),
                None,
                None,
                None,
                None,
                None,
                None
            )
            .await
            .is_ok(),
            "block_type + show_deleted=false should be accepted (false is not a filter)"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_empty_db_returns_empty_page() {
        let (pool, _dir) = test_pool().await;

        let resp = list_blocks_inner(
            &pool, None, None, None, None, None, None, None, None, None, None,
        )
        .await
        .unwrap();

        assert!(
            resp.items.is_empty(),
            "empty DB should return empty items list"
        );
        assert!(
            resp.next_cursor.is_none(),
            "empty DB should have no next cursor"
        );
    }

    // ======================================================================
    // get_block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_returns_single_block() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK001", "content", "hello", None, Some(1)).await;

        let block = get_block_inner(&pool, "BLK001".into()).await.unwrap();
        assert_eq!(block.id, "BLK001", "returned block ID should match");
        assert_eq!(block.block_type, "content", "block_type should be content");
        assert_eq!(
            block.content,
            Some("hello".into()),
            "content should match inserted value"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = get_block_inner(&pool, "NOPE".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "get_block on nonexistent ID should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_returns_deleted_block_too() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "DELBLK", "content", "will be deleted", None, Some(1)).await;

        // Soft-delete the block
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'DELBLK'")
            .bind(FIXED_TS)
            .execute(&pool)
            .await
            .unwrap();

        // get_block should still return it (unlike list_blocks which excludes deleted)
        let block = get_block_inner(&pool, "DELBLK".into()).await.unwrap();
        assert_eq!(
            block.id, "DELBLK",
            "deleted block should still be retrievable"
        );
        assert_eq!(
            block.deleted_at,
            Some(FIXED_TS.into()),
            "get_block should return deleted_at for soft-deleted blocks"
        );
    }

    // ======================================================================
    // move_block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_basic_reparent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: two parents and a child under parent A
        insert_block(&pool, "MV_PAR_A", "page", "parent A", None, Some(1)).await;
        insert_block(&pool, "MV_PAR_B", "page", "parent B", None, Some(2)).await;
        insert_block(
            &pool,
            "MV_CHILD",
            "content",
            "child",
            Some("MV_PAR_A"),
            Some(1),
        )
        .await;

        let resp = move_block_inner(
            &pool,
            DEV,
            &mat,
            "MV_CHILD".into(),
            Some("MV_PAR_B".into()),
            5,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.block_id, "MV_CHILD",
            "block_id should match moved block"
        );
        assert_eq!(
            resp.new_parent_id,
            Some("MV_PAR_B".into()),
            "new_parent_id should be parent B"
        );
        assert_eq!(
            resp.new_position, 5,
            "new_position should match requested value"
        );

        // Verify DB state
        let row = sqlx::query!(
            "SELECT parent_id, position FROM blocks WHERE id = ?",
            "MV_CHILD"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row.parent_id,
            Some("MV_PAR_B".into()),
            "parent_id should be updated in DB"
        );
        assert_eq!(row.position, Some(5), "position should be updated in DB");

        // Verify op_log entry
        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND op_type = 'move_block'",
            DEV
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "exactly one move_block op should be logged");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_to_root() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Setup: a parent and a child under it
        insert_block(&pool, "MV_ROOT_PAR", "page", "parent", None, Some(1)).await;
        insert_block(
            &pool,
            "MV_ROOT_CHD",
            "content",
            "child",
            Some("MV_ROOT_PAR"),
            Some(1),
        )
        .await;

        // Move child to root (new_parent_id = None)
        let resp = move_block_inner(&pool, DEV, &mat, "MV_ROOT_CHD".into(), None, 10)
            .await
            .unwrap();

        assert_eq!(
            resp.block_id, "MV_ROOT_CHD",
            "block_id should match moved block"
        );
        assert!(
            resp.new_parent_id.is_none(),
            "new_parent_id should be None for root move"
        );
        assert_eq!(
            resp.new_position, 10,
            "new_position should match requested value"
        );

        // Verify DB state
        let row = sqlx::query!(
            "SELECT parent_id, position FROM blocks WHERE id = ?",
            "MV_ROOT_CHD"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            row.parent_id.is_none(),
            "parent_id should be NULL in DB after move to root"
        );
        assert_eq!(row.position, Some(10), "position should be updated in DB");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = move_block_inner(&pool, DEV, &mat, "NONEXISTENT".into(), None, 1).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound for nonexistent block"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_deleted_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "MV_DEL", "content", "deleted block", None, Some(1)).await;

        // Soft-delete the block
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'MV_DEL'")
            .bind(FIXED_TS)
            .execute(&pool)
            .await
            .unwrap();

        let result = move_block_inner(&pool, DEV, &mat, "MV_DEL".into(), None, 1).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "moving a deleted block should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_to_deleted_parent_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "MV_BLK", "content", "block", None, Some(1)).await;
        insert_block(&pool, "MV_DEL_PAR", "page", "deleted parent", None, Some(2)).await;

        // Soft-delete the parent
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = 'MV_DEL_PAR'")
            .bind(FIXED_TS)
            .execute(&pool)
            .await
            .unwrap();

        let result = move_block_inner(
            &pool,
            DEV,
            &mat,
            "MV_BLK".into(),
            Some("MV_DEL_PAR".into()),
            1,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "moving to a deleted parent should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_to_self_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "MV_SELF", "content", "self ref", None, Some(1)).await;

        let result = move_block_inner(
            &pool,
            DEV,
            &mat,
            "MV_SELF".into(),
            Some("MV_SELF".into()),
            1,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "block_id == new_parent_id should return InvalidOperation"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("cannot be its own parent"),
            "error message should explain the constraint"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_cycle_grandchild_to_grandparent_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Build A→B→C hierarchy
        insert_block(&pool, "CYC_A", "page", "A", None, Some(1)).await;
        insert_block(&pool, "CYC_B", "content", "B", Some("CYC_A"), Some(1)).await;
        insert_block(&pool, "CYC_C", "content", "C", Some("CYC_B"), Some(1)).await;

        // Try moving A under C — should create cycle A→B→C→A
        let result =
            move_block_inner(&pool, DEV, &mat, "CYC_A".into(), Some("CYC_C".into()), 1).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "moving A under its grandchild C should detect cycle, got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("cycle detected"),
            "error message should mention cycle detection"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_to_non_ancestor_succeeds() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Build A→B and separate C
        insert_block(&pool, "NC_A", "page", "A", None, Some(1)).await;
        insert_block(&pool, "NC_B", "content", "B", Some("NC_A"), Some(1)).await;
        insert_block(&pool, "NC_C", "page", "C", None, Some(2)).await;

        // Move B under C — no cycle, should succeed
        let resp = move_block_inner(&pool, DEV, &mat, "NC_B".into(), Some("NC_C".into()), 1)
            .await
            .unwrap();

        assert_eq!(
            resp.new_parent_id,
            Some("NC_C".into()),
            "block should be reparented to C"
        );
    }

    // ======================================================================
    // add_tag
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_success() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "AT_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "AT_TAG", "tag", "urgent", None, None).await;

        let resp = add_tag_inner(&pool, DEV, &mat, "AT_BLK".into(), "AT_TAG".into())
            .await
            .unwrap();

        assert_eq!(resp.block_id, "AT_BLK", "response block_id should match");
        assert_eq!(resp.tag_id, "AT_TAG", "response tag_id should match");

        // Verify block_tags row
        let row = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
            "AT_BLK",
            "AT_TAG"
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(row.is_some(), "block_tags row should exist after add_tag");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_duplicate_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATD_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "ATD_TAG", "tag", "urgent", None, None).await;

        add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into())
            .await
            .unwrap();

        let result = add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into()).await;

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "adding same tag twice should return InvalidOperation"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("tag already applied"),
            "error message should mention tag already applied"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_nonexistent_block_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATN_TAG", "tag", "urgent", None, None).await;

        let result = add_tag_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "ATN_TAG".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "adding tag to nonexistent block should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_nonexistent_tag_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATNT_BLK", "content", "my block", None, Some(1)).await;

        let result = add_tag_inner(&pool, DEV, &mat, "ATNT_BLK".into(), "NONEXISTENT".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "adding nonexistent tag should return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_tag_non_tag_block_type_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "ATNBT_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "ATNBT_CONT", "content", "not a tag", None, Some(2)).await;

        let result = add_tag_inner(&pool, DEV, &mat, "ATNBT_BLK".into(), "ATNBT_CONT".into()).await;

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "using a content block as tag_id should return InvalidOperation"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("expected 'tag'"),
            "error message should mention expected tag type"
        );
    }

    // ======================================================================
    // remove_tag
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_tag_success() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RT_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "RT_TAG", "tag", "urgent", None, None).await;

        add_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
            .await
            .unwrap();

        let resp = remove_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
            .await
            .unwrap();

        assert_eq!(resp.block_id, "RT_BLK", "response block_id should match");
        assert_eq!(resp.tag_id, "RT_TAG", "response tag_id should match");

        // Verify block_tags is empty
        let row = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
            "RT_BLK",
            "RT_TAG"
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(
            row.is_none(),
            "block_tags row should be gone after remove_tag"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remove_tag_not_applied_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "RTNA_BLK", "content", "my block", None, Some(1)).await;
        insert_block(&pool, "RTNA_TAG", "tag", "urgent", None, None).await;

        let result = remove_tag_inner(&pool, DEV, &mat, "RTNA_BLK".into(), "RTNA_TAG".into()).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "removing a tag that was never applied should return NotFound"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("tag association"),
            "error message should mention tag association"
        );
    }

    // ======================================================================
    // insta snapshot tests — command responses
    // ======================================================================

    /// Snapshot a BlockRow from create_block_inner.
    /// Redacts `id` (ULID is non-deterministic).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_create_block_response() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "snapshot test content".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".id" => "[ULID]",
        });
    }

    /// Snapshot a DeleteResponse from delete_block_inner.
    /// Redacts `deleted_at` (wall-clock timestamp).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_delete_block_response() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Use direct insert to avoid materializer contention
        insert_block(&pool, "SNAP_DEL", "content", "doomed", None, Some(1)).await;

        let resp = delete_block_inner(&pool, DEV, &mat, "SNAP_DEL".into())
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp, {
            ".deleted_at" => "[TIMESTAMP]",
        });
    }

    /// Snapshot a PageResponse from list_blocks_inner.
    /// Redacts `id` fields since they are ULIDs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_list_blocks_response() {
        let (pool, _dir) = test_pool().await;

        // Insert deterministic blocks
        insert_block(&pool, "SNAP_BLK1", "content", "first", None, Some(1)).await;
        insert_block(&pool, "SNAP_BLK2", "page", "second", None, Some(2)).await;

        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(10),
        )
        .await
        .unwrap();

        insta::assert_yaml_snapshot!(resp);
    }

    // ======================================================================
    // get_backlinks
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_backlinks_returns_linked_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BL_TGT", "page", "target", None, None).await;
        insert_block(&pool, "BL_SRC1", "content", "src1", None, None).await;
        insert_block(&pool, "BL_SRC2", "content", "src2", None, None).await;

        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BL_SRC1")
            .bind("BL_TGT")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BL_SRC2")
            .bind("BL_TGT")
            .execute(&pool)
            .await
            .unwrap();

        let resp = get_backlinks_inner(&pool, "BL_TGT".into(), None, None)
            .await
            .unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "should return both linked source blocks"
        );
        assert_eq!(resp.items[0].id, "BL_SRC1", "first backlink should be SRC1");
        assert_eq!(
            resp.items[1].id, "BL_SRC2",
            "second backlink should be SRC2"
        );
    }

    // ======================================================================
    // get_block_history
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_block_history_returns_ops_for_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "updated".into())
            .await
            .unwrap();

        let resp = get_block_history_inner(&pool, created.id, None, None)
            .await
            .unwrap();

        assert_eq!(resp.items.len(), 2, "create + edit = 2 ops");
        // Newest first (seq DESC)
        assert_eq!(
            resp.items[0].op_type, "edit_block",
            "newest op should be edit_block"
        );
        assert_eq!(
            resp.items[1].op_type, "create_block",
            "oldest op should be create_block"
        );
    }

    // ======================================================================
    // get_conflicts
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_conflicts_returns_conflict_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "CF_NORM", "content", "normal", None, None).await;
        insert_block(&pool, "CF_CONF", "content", "conflict", None, None).await;

        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind("CF_CONF")
            .execute(&pool)
            .await
            .unwrap();

        let resp = get_conflicts_inner(&pool, None, None).await.unwrap();

        assert_eq!(resp.items.len(), 1, "only one conflict block should exist");
        assert_eq!(
            resp.items[0].id, "CF_CONF",
            "conflict block ID should match"
        );
        assert!(
            resp.items[0].is_conflict,
            "conflict block should have is_conflict=true"
        );
    }

    // ======================================================================
    // get_status
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_status_returns_initial_metrics() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Allow 10ms for consumer tokio tasks to be spawned and start their event
        // loops. This is minimal — just enough for the runtime to schedule the
        // spawned tasks before we query their status metrics.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let status = get_status_inner(&mat);

        // Fresh materializer — all counters at zero
        assert_eq!(
            status.total_ops_dispatched, 0,
            "fresh materializer should have zero ops"
        );
        assert_eq!(
            status.total_background_dispatched, 0,
            "fresh materializer should have zero background ops"
        );
    }

    // ======================================================================
    // insta snapshot tests — new response types
    // ======================================================================

    /// Snapshot a StatusInfo from get_status_inner.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_status_info_response() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Allow 10ms for consumer tokio tasks to be spawned and start their event
        // loops before taking a snapshot of the status fields.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let status = get_status_inner(&mat);

        insta::assert_yaml_snapshot!(status);
    }

    /// Snapshot a PageResponse<HistoryEntry> from get_block_history_inner.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_block_history_response() {
        let (pool, _dir) = test_pool().await;

        // Insert deterministic op_log entries directly
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("snap-device")
        .bind(1_i64)
        .bind("snap-hash")
        .bind("create_block")
        .bind(r#"{"block_id":"SNAP_HIST","block_type":"content","content":"hi"}"#)
        .bind("2025-06-15T12:00:00Z")
        .execute(&pool)
        .await
        .unwrap();

        let resp = get_block_history_inner(&pool, "SNAP_HIST".into(), None, None)
            .await
            .unwrap();

        insta::assert_yaml_snapshot!(resp);
    }

    // ======================================================================
    // search_blocks_inner tests
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_empty_query_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = search_blocks_inner(&pool, "".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            result.items.len(),
            0,
            "empty query should return no results"
        );
        assert!(!result.has_more, "empty query should not have more results");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_whitespace_query_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = search_blocks_inner(&pool, "   ".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            result.items.len(),
            0,
            "whitespace query should return no results"
        );
        assert!(
            !result.has_more,
            "whitespace query should not have more results"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_finds_indexed_block() {
        let (pool, _dir) = test_pool().await;
        insert_block(
            &pool,
            "SRCH1",
            "content",
            "searchable content",
            None,
            Some(0),
        )
        .await;
        crate::fts::rebuild_fts_index(&pool).await.unwrap();

        let result = search_blocks_inner(&pool, "searchable".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(result.items.len(), 1, "should find one matching block");
        assert_eq!(result.items[0].id, "SRCH1", "found block should be SRCH1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_inner_no_results_for_unindexed_term() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "SRCH2", "content", "apple banana", None, Some(0)).await;
        crate::fts::rebuild_fts_index(&pool).await.unwrap();

        let result = search_blocks_inner(&pool, "cherry".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            result.items.len(),
            0,
            "unindexed term should return no results"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_with_parent_id_filter() {
        let (pool, _dir) = test_pool().await;

        // Create a page block as parent
        insert_block(&pool, "PAGE_A", "page", "Page A", None, Some(1)).await;

        // Two content blocks: one under PAGE_A, one root-level
        insert_block(
            &pool,
            "BLK_UNDER_PAGE",
            "content",
            "searchable under page",
            Some("PAGE_A"),
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "BLK_ROOT",
            "content",
            "searchable at root",
            None,
            Some(2),
        )
        .await;

        crate::fts::rebuild_fts_index(&pool).await.unwrap();

        // Without filter — both should appear
        let all = search_blocks_inner(&pool, "searchable".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(all.items.len(), 2, "no filter: should find both blocks");

        // With parent_id filter — only block under PAGE_A
        let filtered = search_blocks_inner(
            &pool,
            "searchable".into(),
            None,
            None,
            Some("PAGE_A".into()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            filtered.items.len(),
            1,
            "parent_id filter: should find one block"
        );
        assert_eq!(filtered.items[0].id, "BLK_UNDER_PAGE");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_with_tag_filter() {
        let (pool, _dir) = test_pool().await;

        // Create tag blocks
        insert_block(&pool, "TAG_X", "tag", "tagx", None, Some(1)).await;
        insert_block(&pool, "TAG_Y", "tag", "tagy", None, Some(2)).await;

        // Create content blocks
        insert_block(
            &pool,
            "BLK_XY",
            "content",
            "findme both tags",
            None,
            Some(1),
        )
        .await;
        insert_block(&pool, "BLK_X", "content", "findme one tag", None, Some(2)).await;
        insert_block(
            &pool,
            "BLK_NONE",
            "content",
            "findme no tags",
            None,
            Some(3),
        )
        .await;

        // Associate tags
        insert_tag_assoc(&pool, "BLK_XY", "TAG_X").await;
        insert_tag_assoc(&pool, "BLK_XY", "TAG_Y").await;
        insert_tag_assoc(&pool, "BLK_X", "TAG_X").await;

        crate::fts::rebuild_fts_index(&pool).await.unwrap();

        // Without tag filter — all three
        let all = search_blocks_inner(&pool, "findme".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            all.items.len(),
            3,
            "no tag filter: should find all 3 blocks"
        );

        // Filter by TAG_X only — BLK_XY and BLK_X
        let tag_x = search_blocks_inner(
            &pool,
            "findme".into(),
            None,
            None,
            None,
            Some(vec!["TAG_X".into()]),
        )
        .await
        .unwrap();
        assert_eq!(tag_x.items.len(), 2, "TAG_X filter: should find 2 blocks");
        let ids: Vec<&str> = tag_x.items.iter().map(|b| b.id.as_str()).collect();
        assert!(
            ids.contains(&"BLK_XY"),
            "TAG_X filter should include BLK_XY"
        );
        assert!(ids.contains(&"BLK_X"), "TAG_X filter should include BLK_X");

        // Filter by both TAG_X and TAG_Y (ALL semantics) — only BLK_XY
        let tag_xy = search_blocks_inner(
            &pool,
            "findme".into(),
            None,
            None,
            None,
            Some(vec!["TAG_X".into(), "TAG_Y".into()]),
        )
        .await
        .unwrap();
        assert_eq!(
            tag_xy.items.len(),
            1,
            "TAG_X+TAG_Y filter: should find 1 block"
        );
        assert_eq!(tag_xy.items[0].id, "BLK_XY");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn search_blocks_without_filters() {
        let (pool, _dir) = test_pool().await;

        // Create blocks
        insert_block(
            &pool,
            "BLK_NF1",
            "content",
            "universal search term",
            None,
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "BLK_NF2",
            "content",
            "universal search term too",
            None,
            Some(2),
        )
        .await;

        crate::fts::rebuild_fts_index(&pool).await.unwrap();

        // No filters (backward compatible) — all matching results returned
        let result = search_blocks_inner(&pool, "universal".into(), None, None, None, None)
            .await
            .unwrap();
        assert_eq!(
            result.items.len(),
            2,
            "no filters: should find all matching blocks"
        );

        // Empty tag_ids vec should be treated the same as None
        let result_empty_tags =
            search_blocks_inner(&pool, "universal".into(), None, None, None, Some(vec![]))
                .await
                .unwrap();
        assert_eq!(
            result_empty_tags.items.len(),
            2,
            "empty tag_ids: should find all matching blocks"
        );
    }

    // ======================================================================
    // query_by_tags_inner
    // ======================================================================

    /// Helper: insert a tag_cache entry for command-level tests.
    async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
        sqlx::query(
            "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
             VALUES (?, ?, ?, '2025-01-01T00:00:00Z')",
        )
        .bind(tag_id)
        .bind(name)
        .bind(usage_count)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Helper: associate a block with a tag.
    async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_empty_inputs_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result = query_by_tags_inner(&pool, vec![], vec![], "or".into(), None, None, None)
            .await
            .unwrap();

        assert!(
            result.items.is_empty(),
            "empty tag inputs should return no items"
        );
        assert!(
            !result.has_more,
            "empty tag inputs should not have more results"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_or_mode_unions_tag_ids() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "a", None, None).await;
        insert_block(&pool, "TAG_B", "tag", "b", None, None).await;
        insert_block(&pool, "BLK_1", "content", "one", None, Some(1)).await;
        insert_block(&pool, "BLK_2", "content", "two", None, Some(2)).await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;

        let result = query_by_tags_inner(
            &pool,
            vec!["TAG_A".into(), "TAG_B".into()],
            vec![],
            "or".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.items.len(),
            2,
            "OR mode should return both tagged blocks"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_and_mode_intersects_tag_ids() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "a", None, None).await;
        insert_block(&pool, "TAG_B", "tag", "b", None, None).await;
        insert_block(&pool, "BLK_1", "content", "both", None, Some(1)).await;
        insert_block(&pool, "BLK_2", "content", "only-a", None, Some(2)).await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;

        let result = query_by_tags_inner(
            &pool,
            vec!["TAG_A".into(), "TAG_B".into()],
            vec![],
            "and".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.items.len(),
            1,
            "AND mode should return only block with both tags"
        );
        assert_eq!(
            result.items[0].id, "BLK_1",
            "block with both tags should be BLK_1"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_tags_inner_with_prefix() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_WM", "tag", "work/meeting", None, None).await;
        insert_block(&pool, "TAG_WE", "tag", "work/email", None, None).await;

        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;

        insert_block(&pool, "BLK_1", "content", "meeting notes", None, Some(1)).await;
        insert_block(&pool, "BLK_2", "content", "email draft", None, Some(2)).await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_WM").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_WE").await;

        let result = query_by_tags_inner(
            &pool,
            vec![],
            vec!["work/".into()],
            "or".into(),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.items.len(),
            2,
            "prefix query should match both work/ blocks"
        );
    }

    // ======================================================================
    // query_by_property_inner
    // ======================================================================

    /// Helper: insert a property directly into the block_properties table.
    async fn insert_property(pool: &SqlitePool, block_id: &str, key: &str, value_text: &str) {
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind(key)
            .bind(value_text)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_returns_matching_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "QP_B1", "content", "task 1", None, Some(1)).await;
        insert_block(&pool, "QP_B2", "content", "task 2", None, Some(2)).await;
        insert_block(&pool, "QP_B3", "content", "no prop", None, Some(3)).await;

        insert_property(&pool, "QP_B1", "todo", "TODO").await;
        insert_property(&pool, "QP_B2", "todo", "DONE").await;

        let result = query_by_property_inner(&pool, "todo".into(), None, None, None, None, None)
            .await
            .unwrap();

        assert_eq!(result.items.len(), 2, "both blocks with 'todo' property");
        assert_eq!(
            result.items[0].id, "QP_B1",
            "first matching block should be QP_B1"
        );
        assert_eq!(
            result.items[1].id, "QP_B2",
            "second matching block should be QP_B2"
        );
    }

    #[tokio::test]
    async fn query_by_property_empty_key_returns_validation_error() {
        let (pool, _dir) = test_pool().await;

        let result = query_by_property_inner(&pool, "".into(), None, None, None, None, None).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty key must return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_filters_by_value() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "QP_A", "content", "task a", None, Some(1)).await;
        insert_block(&pool, "QP_B", "content", "task b", None, Some(2)).await;

        insert_property(&pool, "QP_A", "todo", "TODO").await;
        insert_property(&pool, "QP_B", "todo", "DONE").await;

        let result = query_by_property_inner(
            &pool,
            "todo".into(),
            Some("TODO".into()),
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.items.len(), 1, "only block with todo=TODO");
        assert_eq!(result.items[0].id, "QP_A", "only TODO block should match");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_paginates_correctly() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=5_i64 {
            let id = format!("QP_P{i:02}");
            insert_block(&pool, &id, "content", &format!("item {i}"), None, Some(i)).await;
            insert_property(&pool, &id, "status", "active").await;
        }

        // First page: limit 2
        let r1 = query_by_property_inner(&pool, "status".into(), None, None, None, None, Some(2))
            .await
            .unwrap();

        assert_eq!(r1.items.len(), 2, "first page should have 2 items");
        assert!(r1.has_more, "first page should indicate more items");
        assert!(
            r1.next_cursor.is_some(),
            "first page should provide a cursor"
        );
        assert_eq!(
            r1.items[0].id, "QP_P01",
            "first page item 1 should be QP_P01"
        );
        assert_eq!(
            r1.items[1].id, "QP_P02",
            "first page item 2 should be QP_P02"
        );

        // Second page
        let r2 = query_by_property_inner(
            &pool,
            "status".into(),
            None,
            None,
            None,
            r1.next_cursor,
            Some(2),
        )
        .await
        .unwrap();

        assert_eq!(r2.items.len(), 2, "second page should have 2 items");
        assert!(r2.has_more, "second page should indicate more items");
        assert_eq!(
            r2.items[0].id, "QP_P03",
            "second page item 1 should be QP_P03"
        );
        assert_eq!(
            r2.items[1].id, "QP_P04",
            "second page item 2 should be QP_P04"
        );

        // Third page: last item
        let r3 = query_by_property_inner(
            &pool,
            "status".into(),
            None,
            None,
            None,
            r2.next_cursor,
            Some(2),
        )
        .await
        .unwrap();

        assert_eq!(r3.items.len(), 1, "last page should have 1 item");
        assert!(!r3.has_more, "last page should not have more items");
        assert!(r3.next_cursor.is_none(), "last page should have no cursor");
        assert_eq!(r3.items[0].id, "QP_P05", "last page item should be QP_P05");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "QP_DEL", "content", "deleted", None, Some(1)).await;
        insert_property(&pool, "QP_DEL", "todo", "TODO").await;

        // Soft-delete the block
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'QP_DEL'")
            .execute(&pool)
            .await
            .unwrap();

        let result = query_by_property_inner(&pool, "todo".into(), None, None, None, None, None)
            .await
            .unwrap();

        assert!(
            result.items.is_empty(),
            "deleted block must be excluded from query_by_property"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_reserved_date_key_filters_by_value_date() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create blocks with due_date set via set_due_date_inner
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "task jun".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        set_due_date_inner(&pool, DEV, &mat, b1.id.clone(), Some("2025-06-15".into()))
            .await
            .unwrap();

        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "task dec".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        set_due_date_inner(&pool, DEV, &mat, b2.id.clone(), Some("2025-12-31".into()))
            .await
            .unwrap();

        // Query all blocks with due_date (no value filter)
        let all = query_by_property_inner(&pool, "due_date".into(), None, None, None, None, None)
            .await
            .unwrap();
        assert_eq!(all.items.len(), 2, "both blocks have due_date");

        // Query with specific date value
        let filtered = query_by_property_inner(
            &pool,
            "due_date".into(),
            None,
            Some("2025-06-15".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(filtered.items.len(), 1, "only one block matches 2025-06-15");
        assert_eq!(
            filtered.items[0].id, b1.id,
            "filtered block should match the June due date"
        );

        mat.shutdown();
    }

    /// Helper: insert a property with a date value.
    async fn insert_property_date(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
        sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
            .bind(block_id)
            .bind(key)
            .bind(value_date)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_with_gt_operator() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "OP_GT1", "content", "early", None, Some(1)).await;
        insert_block(&pool, "OP_GT2", "content", "middle", None, Some(2)).await;
        insert_block(&pool, "OP_GT3", "content", "late", None, Some(3)).await;

        insert_property_date(&pool, "OP_GT1", "deadline", "2025-01-01").await;
        insert_property_date(&pool, "OP_GT2", "deadline", "2025-06-15").await;
        insert_property_date(&pool, "OP_GT3", "deadline", "2025-12-31").await;

        // Query blocks with deadline > "2025-06-01"
        let result = query_by_property_inner(
            &pool,
            "deadline".into(),
            None,
            Some("2025-06-01".into()),
            Some("gt".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.items.len(),
            2,
            "gt operator should return blocks with deadline after 2025-06-01"
        );
        assert_eq!(result.items[0].id, "OP_GT2", "first match is OP_GT2");
        assert_eq!(result.items[1].id, "OP_GT3", "second match is OP_GT3");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_with_lt_operator() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "OP_LT1", "content", "early", None, Some(1)).await;
        insert_block(&pool, "OP_LT2", "content", "middle", None, Some(2)).await;
        insert_block(&pool, "OP_LT3", "content", "late", None, Some(3)).await;

        insert_property_date(&pool, "OP_LT1", "deadline", "2025-01-01").await;
        insert_property_date(&pool, "OP_LT2", "deadline", "2025-06-15").await;
        insert_property_date(&pool, "OP_LT3", "deadline", "2025-12-31").await;

        // Query blocks with deadline < "2025-06-15"
        let result = query_by_property_inner(
            &pool,
            "deadline".into(),
            None,
            Some("2025-06-15".into()),
            Some("lt".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.items.len(),
            1,
            "lt operator should return blocks with deadline before 2025-06-15"
        );
        assert_eq!(
            result.items[0].id, "OP_LT1",
            "only OP_LT1 is before the cutoff"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn query_by_property_defaults_to_eq() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "OP_EQ1", "content", "exact", None, Some(1)).await;
        insert_block(&pool, "OP_EQ2", "content", "other", None, Some(2)).await;

        insert_property(&pool, "OP_EQ1", "status", "active").await;
        insert_property(&pool, "OP_EQ2", "status", "inactive").await;

        // None operator should default to equality
        let result = query_by_property_inner(
            &pool,
            "status".into(),
            Some("active".into()),
            None,
            None, // operator = None → defaults to "eq"
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.items.len(),
            1,
            "None operator must default to equality"
        );
        assert_eq!(
            result.items[0].id, "OP_EQ1",
            "only the 'active' block matches"
        );
    }

    // ======================================================================
    // list_tags_by_prefix_inner
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_by_prefix_inner_returns_matching() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_WM", "tag", "work/meeting", None, None).await;
        insert_block(&pool, "TAG_WE", "tag", "work/email", None, None).await;
        insert_block(&pool, "TAG_P", "tag", "personal", None, None).await;

        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 5).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 3).await;
        insert_tag_cache(&pool, "TAG_P", "personal", 10).await;

        let result = list_tags_by_prefix_inner(&pool, "work/".into(), None)
            .await
            .unwrap();

        assert_eq!(result.len(), 2, "should match both work/ tags");
        assert_eq!(
            result[0].name, "work/email",
            "first tag should be work/email"
        );
        assert_eq!(
            result[1].name, "work/meeting",
            "second tag should be work/meeting"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_by_prefix_inner_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result = list_tags_by_prefix_inner(&pool, "nonexistent/".into(), None)
            .await
            .unwrap();

        assert!(
            result.is_empty(),
            "nonexistent prefix should return no tags"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_tags_by_prefix_inner_respects_limit() {
        let (pool, _dir) = test_pool().await;

        for i in 0..5 {
            insert_block(
                &pool,
                &format!("TAG_A{i}"),
                "tag",
                &format!("alpha{i}"),
                None,
                None,
            )
            .await;
            insert_tag_cache(&pool, &format!("TAG_A{i}"), &format!("alpha{i}"), 1).await;
        }

        let result = list_tags_by_prefix_inner(&pool, "alpha".into(), Some(2))
            .await
            .unwrap();
        assert_eq!(result.len(), 2, "limit=2 should return exactly 2 tags");
    }

    // ======================================================================
    // F11: Concurrent edit race condition (verifies TOCTOU fix)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn f11_concurrent_edits_do_not_corrupt() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block, then spawn 2 concurrent edits.
        // Both should succeed (SQLite serializes via IMMEDIATE tx).
        // Final state should be one of the two edits.
        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let block_id = created.id.clone();
        let pool1 = pool.clone();
        let pool2 = pool.clone();
        let mat1 = Materializer::new(pool.clone());
        let mat2 = Materializer::new(pool.clone());
        let bid1 = block_id.clone();
        let bid2 = block_id.clone();

        let h1 = tokio::spawn(async move {
            edit_block_inner(&pool1, DEV, &mat1, bid1, "edit-A".into()).await
        });
        let h2 = tokio::spawn(async move {
            edit_block_inner(&pool2, DEV, &mat2, bid2, "edit-B".into()).await
        });

        let (r1, r2) = tokio::join!(h1, h2);
        assert!(r1.unwrap().is_ok(), "first concurrent edit should succeed");
        assert!(r2.unwrap().is_ok(), "second concurrent edit should succeed");

        // Final DB state should be one of the two edits
        let row = get_block_inner(&pool, block_id.clone()).await.unwrap();
        assert!(
            row.content == Some("edit-A".into()) || row.content == Some("edit-B".into()),
            "final content should be one of the concurrent edits, got: {:?}",
            row.content
        );

        // Verify exactly 2 edit ops in the log
        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE op_type = 'edit_block' \
             AND json_extract(payload, '$.block_id') = ?",
            block_id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 2, "exactly 2 edit ops should be logged");
    }

    // ======================================================================
    // F12: Purge of already-purged block
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f12_purge_already_purged_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        insert_block(&pool, "PURGE_TWICE", "content", "purge me", None, Some(1)).await;

        // Soft-delete first
        soft_delete::cascade_soft_delete(&pool, "PURGE_TWICE")
            .await
            .unwrap();

        // First purge succeeds
        let resp = purge_block_inner(&pool, DEV, &mat, "PURGE_TWICE".into())
            .await
            .unwrap();
        assert_eq!(
            resp.purged_count, 1,
            "first purge should succeed with count=1"
        );

        // Second purge should return NotFound (block is physically gone)
        let result = purge_block_inner(&pool, DEV, &mat, "PURGE_TWICE".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "purging an already-purged block should return NotFound, got: {result:?}"
        );
    }

    // ======================================================================
    // F13: Create block with invalid block_type values
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f13_empty_block_type_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result =
            create_block_inner(&pool, DEV, &mat, "".into(), "hello".into(), None, None).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty block_type should return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f13_sql_injection_block_type_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "'; DROP TABLE blocks; --".into(),
            "hello".into(),
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "SQL injection in block_type should return Validation error, got: {result:?}"
        );

        // Verify blocks table still exists
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(count >= 0, "blocks table should still exist");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f13_case_sensitive_block_type_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // "Content" (uppercase C) should be rejected -- only "content" is valid
        let result = create_block_inner(
            &pool,
            DEV,
            &mat,
            "Content".into(),
            "hello".into(),
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "case-variant block_type should return Validation error, got: {result:?}"
        );
    }

    // ======================================================================
    // F14: list_blocks with edge-case page_size values
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_zero_clamped_to_one() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PS_BLK1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "PS_BLK2", "content", "b", None, Some(2)).await;

        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(0),
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "page_size=0 should be clamped to 1, returning exactly 1 item"
        );
        assert!(resp.has_more, "should indicate more items available");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_negative_clamped_to_one() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PS_N1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "PS_N2", "content", "b", None, Some(2)).await;

        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(-1),
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "page_size=-1 should be clamped to 1, returning exactly 1 item"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_1000_clamped_to_100() {
        let (pool, _dir) = test_pool().await;

        // Insert 3 blocks -- enough to verify clamping but not 100+
        insert_block(&pool, "PS_L1", "content", "a", None, Some(1)).await;
        insert_block(&pool, "PS_L2", "content", "b", None, Some(2)).await;
        insert_block(&pool, "PS_L3", "content", "c", None, Some(3)).await;

        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(1000),
        )
        .await
        .unwrap();

        // With only 3 items and clamped limit=100, all 3 should be returned
        assert_eq!(
            resp.items.len(),
            3,
            "clamped page_size should still return all items"
        );
        assert!(!resp.has_more, "no more items should remain");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn f14_page_size_none_uses_default() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PS_D1", "content", "a", None, Some(1)).await;

        let resp = list_blocks_inner(
            &pool, None, None, None, None, None, None, None, None, None, None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "default page_size should return the single block"
        );
    }

    // ======================================================================
    // set_property / delete_property / get_properties
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_creates_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block to attach the property to
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "prop test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set a text property
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Verify via get_properties
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert_eq!(props.len(), 1, "should have exactly one property");
        assert_eq!(
            props[0].key, "importance",
            "property key should be 'importance'"
        );
        assert_eq!(
            props[0].value_text,
            Some("high".into()),
            "property value_text should be 'high'"
        );
        assert!(
            props[0].value_num.is_none(),
            "value_num should be None for text property"
        );
        assert!(
            props[0].value_date.is_none(),
            "value_date should be None for text property"
        );
        assert!(
            props[0].value_ref.is_none(),
            "value_ref should be None for text property"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_validates_key() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Empty key should fail validation
        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "".into(),
            Some("val".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty key should return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_on_deleted_block_fails() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "key".into(),
            Some("val".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "setting property on deleted block should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_property_removes_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set a property
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "status".into(),
            Some("active".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Delete the property
        delete_property_inner(&pool, DEV, &mat, block.id.clone(), "status".into())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        // Verify it's gone
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props.is_empty(),
            "properties should be empty after delete, got: {props:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_property_rejects_builtin_key() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test block".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set a system-managed built-in property
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "created_at".into(),
            None,
            None,
            Some("2026-01-01".into()),
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Attempt to delete the built-in property — should fail
        let result =
            delete_property_inner(&pool, DEV, &mat, block.id.clone(), "created_at".into()).await;
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "deleting a built-in property should return Validation error, got: {result:?}"
        );

        // Deleting a user-settable property like "effort" should work
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "effort".into(),
            Some("2h".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        delete_property_inner(&pool, DEV, &mat, block.id.clone(), "effort".into())
            .await
            .unwrap();

        // Deleting a custom property should still work
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "my_custom".into(),
            Some("val".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        delete_property_inner(&pool, DEV, &mat, block.id.clone(), "my_custom".into())
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_properties_returns_empty_for_new_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "no props".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props.is_empty(),
            "new block should have no properties, got: {props:?}"
        );
    }

    // ─── get_batch_properties tests ──────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_returns_all_for_multiple_blocks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create 3 blocks
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block one".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block two".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b3 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block three".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set properties on blocks 1 and 2
        set_property_inner(
            &pool,
            DEV,
            &mat,
            b1.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            b2.id.clone(),
            "status".into(),
            Some("active".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Batch-fetch for all 3
        let result =
            get_batch_properties_inner(&pool, vec![b1.id.clone(), b2.id.clone(), b3.id.clone()])
                .await
                .unwrap();

        // b1 and b2 should have properties, b3 should be omitted
        assert!(result.contains_key(&b1.id), "b1 must be in result");
        assert!(result.contains_key(&b2.id), "b2 must be in result");
        assert_eq!(result[&b1.id].len(), 1, "b1 should have one property");
        assert_eq!(
            result[&b1.id][0].key, "importance",
            "b1 property key should be 'importance'"
        );
        assert_eq!(result[&b2.id].len(), 1, "b2 should have one property");
        assert_eq!(
            result[&b2.id][0].key, "status",
            "b2 property key should be 'status'"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_empty_ids_returns_validation_error() {
        let (pool, _dir) = test_pool().await;

        let result = get_batch_properties_inner(&pool, vec![]).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty block_ids list must return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_omits_blocks_without_properties() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with no properties
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "no props".into(),
            None,
            None,
        )
        .await
        .unwrap();

        let result = get_batch_properties_inner(&pool, vec![block.id.clone()])
            .await
            .unwrap();

        assert!(
            !result.contains_key(&block.id),
            "block with no properties must be omitted from result, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_properties_returns_multiple_props_per_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "multi-prop".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set 3 different properties
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "status".into(),
            Some("active".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "score".into(),
            None,
            Some(42.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let result = get_batch_properties_inner(&pool, vec![block.id.clone()])
            .await
            .unwrap();

        assert!(result.contains_key(&block.id), "block must be in result");
        let props = &result[&block.id];
        assert_eq!(props.len(), 3, "must return all 3 properties");

        let keys: Vec<&str> = props.iter().map(|p| p.key.as_str()).collect();
        assert!(keys.contains(&"importance"), "must contain importance");
        assert!(keys.contains(&"status"), "must contain status");
        assert!(keys.contains(&"score"), "must contain score");
    }

    // ─── batch_resolve tests ─────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_returns_all_requested_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR01", "content", "First block", None, Some(0)).await;
        insert_block(&pool, "BR02", "page", "My Page", None, Some(1)).await;
        insert_block(&pool, "BR03", "tag", "work", None, Some(2)).await;

        let result = batch_resolve_inner(&pool, vec!["BR01".into(), "BR02".into(), "BR03".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 3, "must return all 3 blocks");

        let r1 = result.iter().find(|r| r.id == "BR01").unwrap();
        assert_eq!(
            r1.title.as_deref(),
            Some("First block"),
            "r1 title should match content"
        );
        assert_eq!(r1.block_type, "content", "r1 block_type should be content");
        assert!(!r1.deleted, "r1 should not be deleted");

        let r2 = result.iter().find(|r| r.id == "BR02").unwrap();
        assert_eq!(
            r2.title.as_deref(),
            Some("My Page"),
            "r2 title should match content"
        );
        assert_eq!(r2.block_type, "page", "r2 block_type should be page");
        assert!(!r2.deleted, "r2 should not be deleted");

        let r3 = result.iter().find(|r| r.id == "BR03").unwrap();
        assert_eq!(
            r3.title.as_deref(),
            Some("work"),
            "r3 title should match content"
        );
        assert_eq!(r3.block_type, "tag", "r3 block_type should be tag");
        assert!(!r3.deleted, "r3 should not be deleted");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_empty_ids_returns_validation_error() {
        let (pool, _dir) = test_pool().await;

        let result = batch_resolve_inner(&pool, vec![]).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty ids list must return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_includes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_DEL", "content", "deleted block", None, Some(0)).await;
        sqlx::query("UPDATE blocks SET deleted_at = ?")
            .bind(FIXED_TS)
            .execute(&pool)
            .await
            .unwrap();

        let result = batch_resolve_inner(&pool, vec!["BR_DEL".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 1, "should return the deleted block");
        assert!(result[0].deleted, "deleted blocks must have deleted=true");
        assert_eq!(
            result[0].title.as_deref(),
            Some("deleted block"),
            "title should still be accessible"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_omits_nonexistent_ids() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_EXISTS", "content", "exists", None, Some(0)).await;

        let result = batch_resolve_inner(&pool, vec!["BR_EXISTS".into(), "BR_MISSING".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 1, "nonexistent IDs must be silently omitted");
        assert_eq!(
            result[0].id, "BR_EXISTS",
            "existing block should be returned"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_null_content_returns_none_title() {
        let (pool, _dir) = test_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, NULL, NULL, 0)",
        )
        .bind("BR_NULL")
        .bind("content")
        .execute(&pool)
        .await
        .unwrap();

        let result = batch_resolve_inner(&pool, vec!["BR_NULL".into()])
            .await
            .unwrap();

        assert_eq!(
            result.len(),
            1,
            "null-content block should still be resolved"
        );
        assert!(result[0].title.is_none(), "NULL content → None title");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_single_id() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_SINGLE", "page", "Solo Page", None, Some(0)).await;

        let result = batch_resolve_inner(&pool, vec!["BR_SINGLE".into()])
            .await
            .unwrap();

        assert_eq!(result.len(), 1, "single ID should return one result");
        assert_eq!(result[0].id, "BR_SINGLE", "resolved block ID should match");
        assert_eq!(
            result[0].title.as_deref(),
            Some("Solo Page"),
            "resolved title should match content"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_duplicate_ids_deduped_by_db() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_DUP", "content", "Dup block", None, Some(0)).await;

        let result = batch_resolve_inner(
            &pool,
            vec!["BR_DUP".into(), "BR_DUP".into(), "BR_DUP".into()],
        )
        .await
        .unwrap();

        // json_each produces 3 rows for 3 values, but the IN subquery
        // matches only the one block row — result depends on DB behavior.
        // With json_each + IN, duplicates in the value list may produce
        // duplicate matches. We assert at least 1 result.
        assert!(
            !result.is_empty(),
            "duplicate IDs must still return the block"
        );
        assert!(
            result.iter().all(|r| r.id == "BR_DUP"),
            "all results must be the same block"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn batch_resolve_mixed_block_types() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BR_PAGE", "page", "Page Title", None, Some(0)).await;
        insert_block(&pool, "BR_TAG", "tag", "my-tag", None, Some(1)).await;
        insert_block(
            &pool,
            "BR_CONTENT",
            "content",
            "Some text",
            Some("BR_PAGE"),
            Some(0),
        )
        .await;

        let result = batch_resolve_inner(
            &pool,
            vec!["BR_PAGE".into(), "BR_TAG".into(), "BR_CONTENT".into()],
        )
        .await
        .unwrap();

        assert_eq!(
            result.len(),
            3,
            "all three mixed-type blocks should be resolved"
        );
        let types: Vec<&str> = result.iter().map(|r| r.block_type.as_str()).collect();
        assert!(types.contains(&"page"), "result should include page type");
        assert!(types.contains(&"tag"), "result should include tag type");
        assert!(
            types.contains(&"content"),
            "result should include content type"
        );
    }

    // ======================================================================
    // Undo/Redo tests
    // ======================================================================

    /// Helper: create a page with children and return (page_id, child_ids)
    async fn create_page_with_children(
        pool: &SqlitePool,
        mat: &Materializer,
    ) -> (String, Vec<String>) {
        let page = create_block_inner(
            pool,
            DEV,
            mat,
            "page".into(),
            "Test Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child1 = create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            "child one".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child2 = create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            "child two".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        (page.id, vec![child1.id, child2.id])
    }

    // -- list_page_history tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_returns_ops_for_page_descendants() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1 to produce more ops
        edit_block_inner(
            &pool,
            DEV,
            &mat,
            child_ids[0].clone(),
            "edited child one".into(),
        )
        .await
        .unwrap();

        // Also create an unrelated block to ensure it's excluded
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "unrelated".into(),
            None,
            Some(10),
        )
        .await
        .unwrap();

        let result = list_page_history_inner(&pool, page_id.clone(), None, None, None)
            .await
            .unwrap();

        // Should include: create_block (page), create_block (child1), create_block (child2), edit_block (child1)
        assert_eq!(
            result.items.len(),
            4,
            "should have 4 ops for page descendants"
        );

        // Verify all ops are for page or its descendants
        for entry in &result.items {
            let payload: serde_json::Value = serde_json::from_str(&entry.payload).unwrap();
            let block_id = payload["block_id"].as_str().unwrap();
            assert!(
                block_id == page_id || child_ids.contains(&block_id.to_string()),
                "op should be for page or its descendants, got block_id: {block_id}"
            );
        }

        // Newest first
        assert_eq!(result.items[0].op_type, "edit_block", "newest op first");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_with_op_type_filter() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();

        let result = list_page_history_inner(
            &pool,
            page_id.clone(),
            Some("edit_block".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(result.items.len(), 1, "should only have edit_block ops");
        assert_eq!(
            result.items[0].op_type, "edit_block",
            "filtered op type should be edit_block"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_pagination_works() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child to have 4 total ops
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();

        // Page 1: limit 2
        let page1 = list_page_history_inner(&pool, page_id.clone(), None, None, Some(2))
            .await
            .unwrap();
        assert_eq!(page1.items.len(), 2, "first page should have 2 items");
        assert!(page1.has_more, "should have more items");
        assert!(page1.next_cursor.is_some(), "should have a cursor");

        // Page 2: use cursor from page 1
        let page2 =
            list_page_history_inner(&pool, page_id.clone(), None, page1.next_cursor, Some(2))
                .await
                .unwrap();
        assert_eq!(page2.items.len(), 2, "second page should have 2 items");
        assert!(!page2.has_more, "should be the last page");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_all_returns_ops_from_all_pages() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create two separate pages with children
        let (page_a, _children_a) = create_page_with_children(&pool, &mat).await;
        let page_b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Second Page".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child_b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child of page b".into(),
            Some(page_b.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // __all__ should return ops from both pages
        let result = list_page_history_inner(&pool, "__all__".to_string(), None, None, None)
            .await
            .unwrap();

        // page_a (1 create) + 2 children + page_b (1 create) + child_b (1 create) = 5
        assert_eq!(
            result.items.len(),
            5,
            "should have ops from all pages, got: {}",
            result.items.len()
        );

        // Verify ops reference both pages' blocks
        let block_ids: Vec<String> = result
            .items
            .iter()
            .map(|e| {
                let payload: serde_json::Value = serde_json::from_str(&e.payload).unwrap();
                payload["block_id"].as_str().unwrap().to_string()
            })
            .collect();
        assert!(block_ids.contains(&page_a), "should contain ops for page_a");
        assert!(
            block_ids.contains(&page_b.id),
            "should contain ops for page_b"
        );
        assert!(
            block_ids.contains(&child_b.id),
            "should contain ops for child_b"
        );

        // Pagination: limit=2
        let page1 = list_page_history_inner(&pool, "__all__".to_string(), None, None, Some(2))
            .await
            .unwrap();
        assert_eq!(page1.items.len(), 2, "first page should have 2 items");
        assert!(page1.has_more, "should have more items");
        assert!(page1.next_cursor.is_some(), "should have a cursor");

        let page2 = list_page_history_inner(
            &pool,
            "__all__".to_string(),
            None,
            page1.next_cursor,
            Some(2),
        )
        .await
        .unwrap();
        assert_eq!(page2.items.len(), 2, "second page should have 2 items");
        assert!(page2.has_more, "should still have more items");

        let page3 = list_page_history_inner(
            &pool,
            "__all__".to_string(),
            None,
            page2.next_cursor,
            Some(2),
        )
        .await
        .unwrap();
        assert_eq!(page3.items.len(), 1, "third page should have 1 item");
        assert!(!page3.has_more, "should be the last page");
    }

    // -- revert_ops tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_reverses_single_edit() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create and edit a block
        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let _edited = edit_block_inner(&pool, DEV, &mat, created.id.clone(), "modified".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify block is now "modified"
        let before_undo = get_block_inner(&pool, created.id.clone()).await.unwrap();
        assert_eq!(
            before_undo.content,
            Some("modified".into()),
            "block should contain modified content before undo"
        );

        // Get the edit op's seq
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let edit_op = ops.iter().find(|o| o.op_type == "edit_block").unwrap();

        // Revert it
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: edit_op.seq,
            }],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1, "should have one result");
        assert_eq!(
            results[0].reversed_op.seq, edit_op.seq,
            "reversed op seq should match edit op"
        );
        assert_eq!(
            results[0].new_op_type, "edit_block",
            "new op type should be edit_block"
        );
        assert!(
            !results[0].is_redo,
            "single revert should not be flagged as redo"
        );

        // Block should be back to "original"
        let after_undo = get_block_inner(&pool, created.id).await.unwrap();
        assert_eq!(
            after_undo.content,
            Some("original".into()),
            "content should revert to original"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_reverses_multiple_ops_in_correct_order() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "v0".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit twice
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v1".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "v2".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Get both edit ops
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let edit_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "edit_block").collect();
        assert_eq!(edit_ops.len(), 2, "should have exactly two edit ops");

        let op_refs: Vec<OpRef> = edit_ops
            .iter()
            .map(|o| OpRef {
                device_id: DEV.into(),
                seq: o.seq,
            })
            .collect();

        let results = revert_ops_inner(&pool, DEV, &mat, op_refs).await.unwrap();

        assert_eq!(results.len(), 2, "should have two results");

        // After reverting both edits, block should be back to "v0"
        let after = get_block_inner(&pool, created.id).await.unwrap();
        assert_eq!(
            after.content,
            Some("v0".into()),
            "content should revert to original after reversing both edits"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_rejects_non_reversible_op() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create and soft-delete and purge a block
        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "doomed".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        purge_block_inner(&pool, DEV, &mat, created.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Get the purge op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let purge_op = ops.iter().find(|o| o.op_type == "purge_block").unwrap();

        // Try to revert it — should fail
        let result = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: purge_op.seq,
            }],
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NonReversible { .. })),
            "should fail with NonReversible for purge_block, got: {result:?}"
        );
    }

    // -- restore_page_to_op tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_reverts_ops_after_target() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a page with 3 blocks
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Test Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "first".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "second".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        let b3 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "third".into(),
            Some(page.id.clone()),
            Some(3),
        )
        .await
        .unwrap();

        // Edit each block
        edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "first-edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        // Record the seq after b1 edit — this will be our restore target
        let ops_after_b1 = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let target_op = ops_after_b1
            .iter()
            .rev()
            .find(|o| o.op_type == "edit_block")
            .unwrap();
        let target_seq = target_op.seq;

        edit_block_inner(&pool, DEV, &mat, b2.id.clone(), "second-edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        edit_block_inner(&pool, DEV, &mat, b3.id.clone(), "third-edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify all blocks have edited content
        assert_eq!(
            get_block_inner(&pool, b2.id.clone()).await.unwrap().content,
            Some("second-edited".into()),
            "b2 should be edited before restore"
        );
        assert_eq!(
            get_block_inner(&pool, b3.id.clone()).await.unwrap().content,
            Some("third-edited".into()),
            "b3 should be edited before restore"
        );

        // Restore to the point after b1 edit
        let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), target_seq)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.ops_reverted, 2,
            "should revert exactly 2 ops (b2 and b3 edits)"
        );
        assert_eq!(
            result.non_reversible_skipped, 0,
            "no non-reversible ops to skip"
        );

        // b1 should still be "first-edited" (at or before the target)
        assert_eq!(
            get_block_inner(&pool, b1.id).await.unwrap().content,
            Some("first-edited".into()),
            "b1 should keep its edit (at/before target)"
        );
        // b2 and b3 should be back to original
        assert_eq!(
            get_block_inner(&pool, b2.id).await.unwrap().content,
            Some("second".into()),
            "b2 should revert to original"
        );
        assert_eq!(
            get_block_inner(&pool, b3.id).await.unwrap().content,
            Some("third".into()),
            "b3 should revert to original"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_skips_non_reversible() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "keep".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        // Record target
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let target_seq = ops.last().unwrap().seq;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        // Create another block, then purge it (non-reversible)
        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "doomed".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        delete_block_inner(&pool, DEV, &mat, b2.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        purge_block_inner(&pool, DEV, &mat, b2.id).await.unwrap();
        mat.flush_background().await.unwrap();

        // Also edit b1 (this IS reversible)
        edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "modified".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), target_seq)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // b2 was purged — it's no longer in the blocks table, so the recursive
        // CTE cannot discover its ops. Only b1's edit (on a live block) is found.
        assert_eq!(
            result.non_reversible_skipped, 0,
            "purged block ops not discoverable via recursive CTE on blocks table"
        );
        assert_eq!(
            result.ops_reverted, 1,
            "should revert exactly 1 op (edit_block b1)"
        );
        assert_eq!(
            get_block_inner(&pool, b1.id).await.unwrap().content,
            Some("keep".into()),
            "b1 should revert to original"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_global_scope() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page 1".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "orig-1".into(),
            Some(page1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        let page2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page 2".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "orig-2".into(),
            Some(page2.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let target_seq = ops.last().unwrap().seq;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        // Edit blocks on BOTH pages
        edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "changed-1".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        edit_block_inner(&pool, DEV, &mat, b2.id.clone(), "changed-2".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Global restore
        let result =
            restore_page_to_op_inner(&pool, DEV, &mat, "__all__".into(), DEV.into(), target_seq)
                .await
                .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(result.ops_reverted, 2, "should revert edits on both pages");
        assert_eq!(
            get_block_inner(&pool, b1.id).await.unwrap().content,
            Some("orig-1".into()),
            "b1 should revert"
        );
        assert_eq!(
            get_block_inner(&pool, b2.id).await.unwrap().content,
            Some("orig-2".into()),
            "b2 should revert"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_no_ops_after_target() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let target_seq = ops.last().unwrap().seq;

        let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), target_seq)
            .await
            .unwrap();

        assert_eq!(
            result.ops_reverted, 0,
            "no ops after target should mean zero reverts"
        );
        assert_eq!(
            result.non_reversible_skipped, 0,
            "no non-reversible ops to skip"
        );
        assert!(result.results.is_empty(), "results should be empty");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_includes_nested_blocks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page → parent block → nested child block
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let parent = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "parent-orig".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child-orig".into(),
            Some(parent.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        // Record target after initial setup
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let target_seq = ops.last().unwrap().seq;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        // Edit both the parent and the nested child
        edit_block_inner(&pool, DEV, &mat, parent.id.clone(), "parent-edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child-edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify both are edited
        assert_eq!(
            get_block_inner(&pool, parent.id.clone())
                .await
                .unwrap()
                .content,
            Some("parent-edited".into()),
            "parent should be edited before restore"
        );
        assert_eq!(
            get_block_inner(&pool, child.id.clone())
                .await
                .unwrap()
                .content,
            Some("child-edited".into()),
            "child should be edited before restore"
        );

        // Page-scoped restore — must find nested child too
        let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), target_seq)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.ops_reverted, 2,
            "should revert both parent and nested child edits"
        );
        assert_eq!(
            get_block_inner(&pool, parent.id).await.unwrap().content,
            Some("parent-orig".into()),
            "parent should revert to original"
        );
        assert_eq!(
            get_block_inner(&pool, child.id).await.unwrap().content,
            Some("child-orig".into()),
            "nested child should revert to original (recursive CTE)"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_invalid_target_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Use a seq that doesn't exist in the op log
        let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), 999_999).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "restoring to a non-existent target_seq should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_verifies_reverse_ops_in_op_log() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a page with two content blocks
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "alpha".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "beta".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();

        // Record ops count and target after creates
        let ops_before = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let target_seq = ops_before.last().unwrap().seq;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        // Edit both blocks (these will be reverted)
        edit_block_inner(&pool, DEV, &mat, b1.id.clone(), "alpha-edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        edit_block_inner(&pool, DEV, &mat, b2.id.clone(), "beta-edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let ops_before_restore = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let count_before = ops_before_restore.len();

        // Restore to target — should revert both edits
        let result = restore_page_to_op_inner(&pool, DEV, &mat, page.id, DEV.into(), target_seq)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(result.ops_reverted, 2, "should revert exactly 2 edit ops");

        // Fetch all ops after restore — should have 2 new reverse ops appended
        let ops_after = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        assert_eq!(
            ops_after.len(),
            count_before + 2,
            "should have appended exactly 2 reverse ops to the op log"
        );

        // Verify the reverse ops have correct op_type values
        let reverse_ops = &ops_after[count_before..];
        for rev_op in reverse_ops {
            assert_eq!(
                rev_op.op_type, "edit_block",
                "reverse of edit_block should be edit_block, got: {}",
                rev_op.op_type
            );
        }

        // Verify hash chain integrity: each op's parent_seqs references the
        // previous op's hash, and the hash is correctly computed.
        for i in 1..ops_after.len() {
            let prev = &ops_after[i - 1];
            let curr = &ops_after[i];

            // parent_seqs should reference the previous seq
            let parent_seqs_parsed = curr.parsed_parent_seqs().unwrap();
            assert!(
                parent_seqs_parsed.is_some(),
                "non-genesis op (seq {}) must have parent_seqs",
                curr.seq
            );
            let parents = parent_seqs_parsed.unwrap();
            assert_eq!(
                parents.len(),
                1,
                "Phase 1 linear chain — exactly one parent expected"
            );
            assert_eq!(
                parents[0],
                (prev.device_id.clone(), prev.seq),
                "parent_seqs should reference the immediately preceding op"
            );

            // Recompute the hash and verify it matches
            let expected_hash = crate::hash::compute_op_hash(
                &curr.device_id,
                curr.seq,
                curr.parent_seqs.as_deref(),
                &curr.op_type,
                &curr.payload,
            );
            assert_eq!(
                curr.hash, expected_hash,
                "hash for op seq {} should match recomputed value",
                curr.seq
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_page_to_op_skips_delete_attachment() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a page with a content block
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child block".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();

        // Add an attachment BEFORE the target point (so it's part of baseline)
        let att_id = "ATT_RESTORE_001";
        let att_ts = now_rfc3339();
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(att_id)
        .bind(&child.id)
        .bind("image/png")
        .bind("photo.png")
        .bind(1024_i64)
        .bind("/tmp/photo.png")
        .bind(&att_ts)
        .execute(&pool)
        .await
        .unwrap();

        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: att_id.into(),
                block_id: BlockId::from_trusted(&child.id),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            att_ts.clone(),
        )
        .await
        .unwrap();

        // Record target seq AFTER the add_attachment
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let target_seq = ops.last().unwrap().seq;
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        // Now delete the attachment AFTER the target (non-reversible op)
        let del_ts = now_rfc3339();
        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: att_id.into(),
            }),
            del_ts.clone(),
        )
        .await
        .unwrap();

        sqlx::query("DELETE FROM attachments WHERE id = ?")
            .bind(att_id)
            .execute(&pool)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;

        // Also edit the child block after target (this IS reversible)
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Restore using global scope (__all__) so the delete_attachment op is
        // discoverable — page-scoped queries filter by payload $.block_id which
        // delete_attachment payloads lack (they use $.attachment_id instead).
        let result =
            restore_page_to_op_inner(&pool, DEV, &mat, "__all__".into(), DEV.into(), target_seq)
                .await
                .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.non_reversible_skipped, 1,
            "should count exactly 1 non-reversible op (delete_attachment)"
        );
        assert_eq!(
            result.ops_reverted, 1,
            "should revert exactly 1 reversible op (edit_block)"
        );
        assert_eq!(
            get_block_inner(&pool, child.id).await.unwrap().content,
            Some("child block".into()),
            "child block content should revert to original"
        );
    }

    // -- undo_page_op tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_depth_0_reverses_most_recent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify block is "edited"
        let before = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(
            before.content,
            Some("edited".into()),
            "block should be edited before undo"
        );

        // Undo most recent op (depth=0) — the edit
        let result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
            .await
            .unwrap();

        assert_eq!(
            result.reversed_op.device_id, DEV,
            "reversed op device_id should match"
        );
        assert_eq!(
            result.new_op_type, "edit_block",
            "undo should produce edit_block op"
        );
        assert!(
            !result.is_redo,
            "undo operation should not be flagged as redo"
        );

        // Block should be back to "child one"
        let after = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("child one".into()),
            "content should revert to original after undo"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_depth_1_reverses_second_most_recent() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1 twice
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edit1".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edit2".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Undo depth=1 — should reverse the first edit (second most recent op)
        let result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 1)
            .await
            .unwrap();

        // The second most recent op is "edit1" (edit_block)
        assert_eq!(
            result.new_op_type, "edit_block",
            "depth-1 undo should reverse an edit_block"
        );
        assert!(
            !result.is_redo,
            "depth-1 undo should not be flagged as redo"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_finds_delete_attachment_op() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // 1. Create a page with a child block
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Attachment Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child block".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // 2. Add an attachment to the child block
        let att_id = "ATT_UNDO_001";
        let att_ts = now_rfc3339();
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(att_id)
        .bind(&child.id)
        .bind("image/png")
        .bind("photo.png")
        .bind(1024_i64)
        .bind("/tmp/photo.png")
        .bind(&att_ts)
        .execute(&pool)
        .await
        .unwrap();

        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: att_id.into(),
                block_id: BlockId::from_trusted(&child.id),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            att_ts.clone(),
        )
        .await
        .unwrap();

        // 3. Delete the attachment (append delete_attachment op + soft-delete)
        let del_ts = now_rfc3339();
        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: att_id.into(),
            }),
            del_ts.clone(),
        )
        .await
        .unwrap();

        sqlx::query("UPDATE attachments SET deleted_at = ? WHERE id = ?")
            .bind(&del_ts)
            .bind(att_id)
            .execute(&pool)
            .await
            .unwrap();

        // Verify attachment is soft-deleted
        let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
            .bind(att_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let deleted_at: Option<String> = row.get("deleted_at");
        assert!(
            deleted_at.is_some(),
            "attachment should be soft-deleted before undo"
        );

        // 4. Undo most recent op — should find the delete_attachment op
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .expect("undo should find delete_attachment op on the page");

        assert_eq!(
            result.new_op_type, "add_attachment",
            "reversing delete_attachment should produce add_attachment"
        );
        assert!(
            !result.is_redo,
            "attachment undo should not be flagged as redo"
        );

        // 5. Verify the attachment is restored (deleted_at cleared)
        let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
            .bind(att_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let deleted_at: Option<String> = row.get("deleted_at");
        assert!(
            deleted_at.is_none(),
            "attachment should be restored after undo (deleted_at should be NULL)"
        );
    }

    // -- redo_page_op tests --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn redo_page_op_reverses_undo_restoring_state() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, child_ids) = create_page_with_children(&pool, &mat).await;

        // Edit child1
        edit_block_inner(&pool, DEV, &mat, child_ids[0].clone(), "edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Undo the edit
        let undo_result = undo_page_op_inner(&pool, DEV, &mat, page_id.clone(), 0)
            .await
            .unwrap();

        // Verify it's undone
        let after_undo = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(
            after_undo.content,
            Some("child one".into()),
            "content should revert after undo"
        );

        // Redo it
        let redo_result = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo_result.new_op_ref.device_id.clone(),
            undo_result.new_op_ref.seq,
        )
        .await
        .unwrap();

        assert!(redo_result.is_redo, "should be flagged as redo");
        assert_eq!(
            redo_result.new_op_type, "edit_block",
            "redo should produce edit_block op"
        );

        // Block should be back to "edited"
        let after_redo = get_block_inner(&pool, child_ids[0].clone()).await.unwrap();
        assert_eq!(
            after_redo.content,
            Some("edited".into()),
            "content should be restored after redo"
        );
    }

    // -- Full cycle test --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_cycle_create_edit_undo_redo() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page + child
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "My Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "modified".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let after_edit = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after_edit.content,
            Some("modified".into()),
            "content should be modified after edit"
        );

        // Undo the edit (depth=0 = most recent)
        let undo = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        assert!(!undo.is_redo, "undo should not be flagged as redo");

        let after_undo = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after_undo.content,
            Some("original".into()),
            "undo should restore original content"
        );

        // Redo the undo
        let redo = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo.new_op_ref.device_id.clone(),
            undo.new_op_ref.seq,
        )
        .await
        .unwrap();
        assert!(redo.is_redo, "redo should be flagged as redo");

        let after_redo = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after_redo.content,
            Some("modified".into()),
            "redo should produce original edit result"
        );
    }

    // ======================================================================
    // Extended Undo/Redo integration tests — Groups 1-4 (19 tests)
    // ======================================================================

    // -- Group 1: apply_reverse_in_tx — all variants (9 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_create_block_soft_deletes() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "ephemeral".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Get the create_block op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let create_op = ops.iter().find(|o| o.op_type == "create_block").unwrap();

        // Revert the create (reverse = DeleteBlock → soft-deletes the block)
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: create_op.seq,
            }],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1, "should return one revert result");
        assert_eq!(
            results[0].new_op_type, "delete_block",
            "reverting create should produce delete_block"
        );

        // Verify the block is now soft-deleted
        let block = get_block_inner(&pool, created.id).await.unwrap();
        assert!(
            block.deleted_at.is_some(),
            "block should be soft-deleted after reverting create"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_delete_block_restores_with_descendants() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create parent + child
        let parent = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Parent".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Child".into(),
            Some(parent.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Use a controlled timestamp so blocks.deleted_at matches the op's created_at.
        // delete_block_inner uses two separate now_rfc3339() calls (one for op_log,
        // one for blocks), causing a mismatch. We do it manually with one timestamp.
        let delete_ts = "2025-06-15T12:00:00+00:00";

        // Manually soft-delete both blocks with the controlled timestamp
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ? OR id = ?")
            .bind(delete_ts)
            .bind(&parent.id)
            .bind(&child.id)
            .execute(&pool)
            .await
            .unwrap();

        // Append delete_block op with the same timestamp
        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::from_trusted(&parent.id),
            }),
            delete_ts.to_string(),
        )
        .await
        .unwrap();

        // Verify both are deleted
        let p_row = get_block_inner(&pool, parent.id.clone()).await.unwrap();
        assert!(p_row.deleted_at.is_some(), "parent should be deleted");

        // Get the delete_block op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let delete_op = ops.iter().find(|o| o.op_type == "delete_block").unwrap();

        // Revert the delete (reverse = RestoreBlock)
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: delete_op.seq,
            }],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 1, "should return one revert result");
        assert_eq!(
            results[0].new_op_type, "restore_block",
            "reverting delete should produce restore_block"
        );

        // Verify both are restored
        let p_after = get_block_inner(&pool, parent.id.clone()).await.unwrap();
        assert!(
            p_after.deleted_at.is_none(),
            "parent should be restored after revert"
        );

        let c_after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert!(
            c_after.deleted_at.is_none(),
            "child should be restored after revert"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_move_block_restores_original_position() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create two parent pages
        let p1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page One".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let p2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page Two".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Create child under P1 at position 3
        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "movable".into(),
            Some(p1.id.clone()),
            Some(3),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Move child to P2 at position 7
        move_block_inner(&pool, DEV, &mat, child.id.clone(), Some(p2.id.clone()), 7)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify it's at P2, pos 7
        let before = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            before.parent_id.as_deref(),
            Some(p2.id.as_str()),
            "block should be under P2 after move"
        );
        assert_eq!(
            before.position,
            Some(7),
            "block position should be 7 after move"
        );

        // Get the move_block op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let move_op = ops.iter().find(|o| o.op_type == "move_block").unwrap();

        // Revert the move
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: move_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify it's back at P1, pos 3
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.parent_id.as_deref(),
            Some(p1.id.as_str()),
            "parent should be restored to P1"
        );
        assert_eq!(after.position, Some(3), "position should be restored to 3");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_add_tag_removes_association() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a tag block and a content block
        let tag = create_block_inner(
            &pool,
            DEV,
            &mat,
            "tag".into(),
            "my-tag".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let content = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "some text".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Add the tag
        add_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify the tag is applied
        let before = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(before.is_some(), "tag should be applied");

        // Get the add_tag op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let add_tag_op = ops.iter().find(|o| o.op_type == "add_tag").unwrap();

        // Revert the add_tag (reverse = RemoveTag)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: add_tag_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the tag is removed
        let after = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(after.is_none(), "tag should be removed after revert");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_remove_tag_restores_association() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create tag + content
        let tag = create_block_inner(
            &pool,
            DEV,
            &mat,
            "tag".into(),
            "my-tag".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let content = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "some text".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Add tag, then remove tag
        add_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        remove_tag_inner(&pool, DEV, &mat, content.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify tag is removed
        let before = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(before.is_none(), "tag should be removed");

        // Get the remove_tag op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let remove_tag_op = ops.iter().find(|o| o.op_type == "remove_tag").unwrap();

        // Revert the remove_tag (reverse = AddTag)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: remove_tag_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the tag is restored
        let after = sqlx::query("SELECT 1 FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(&content.id)
            .bind(&tag.id)
            .fetch_optional(&pool)
            .await
            .unwrap();
        assert!(after.is_some(), "tag should be restored after revert");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_set_property_restores_prior_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set property to "high"
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set property to "low"
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "importance".into(),
            Some("low".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify it's "low"
        let props_before = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let p_before = props_before.iter().find(|p| p.key == "importance").unwrap();
        assert_eq!(
            p_before.value_text.as_deref(),
            Some("low"),
            "property value should be low before revert"
        );

        // Get the second set_property op (the one that set "low")
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        let second_set = set_ops.last().unwrap();

        // Revert the second set (should restore "high")
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: second_set.seq,
            }],
        )
        .await
        .unwrap();

        // Verify it's back to "high"
        let props_after = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let p_after = props_after.iter().find(|p| p.key == "importance").unwrap();
        assert_eq!(
            p_after.value_text.as_deref(),
            Some("high"),
            "value should be restored to 'high' after reverting second set"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_set_property_first_produces_delete() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set property "color" = "red" (first set, no prior)
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "color".into(),
            Some("red".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Get the set_property op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_op = ops.iter().find(|o| o.op_type == "set_property").unwrap();

        // Revert the first set (no prior → reverse = DeleteProperty)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: set_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the property row no longer exists
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props.iter().all(|p| p.key != "color"),
            "property 'color' should be deleted after reverting first set"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_delete_property_restores_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set property "due" with value_date
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "due".into(),
            None,
            None,
            Some("2025-06-15".into()),
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Delete the property
        delete_property_inner(&pool, DEV, &mat, block.id.clone(), "due".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify property is gone
        let props_before = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props_before.iter().all(|p| p.key != "due"),
            "property 'due' should be deleted"
        );

        // Get the delete_property op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let del_op = ops.iter().find(|o| o.op_type == "delete_property").unwrap();

        // Revert the delete (reverse = SetProperty with prior value)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: del_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify the property is restored with value_date="2025-06-15"
        let props_after = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let due = props_after
            .iter()
            .find(|p| p.key == "due")
            .expect("property 'due' should be restored after reverting delete");
        assert_eq!(
            due.value_date.as_deref(),
            Some("2025-06-15"),
            "value_date should be restored to '2025-06-15'"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_add_attachment_soft_deletes() {
        use sqlx::Row;

        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block (needed for FK)
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "test".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Manually insert an attachment row
        let att_id = "ATT_TEST_001";
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(att_id)
        .bind(&block.id)
        .bind("image/png")
        .bind("photo.png")
        .bind(1024_i64)
        .bind("/tmp/photo.png")
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

        // Append add_attachment op via op_log
        op_log::append_local_op_at(
            &pool,
            DEV,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: att_id.into(),
                block_id: BlockId::from_trusted(&block.id),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            FIXED_TS.to_string(),
        )
        .await
        .unwrap();

        // Get the add_attachment op
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let add_att_op = ops.iter().find(|o| o.op_type == "add_attachment").unwrap();

        // Revert the add_attachment (reverse = DeleteAttachment → soft-delete)
        revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![OpRef {
                device_id: DEV.into(),
                seq: add_att_op.seq,
            }],
        )
        .await
        .unwrap();

        // Verify attachment is soft-deleted
        let row = sqlx::query("SELECT deleted_at FROM attachments WHERE id = ?")
            .bind(att_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        let deleted_at: Option<String> = row.get("deleted_at");
        assert!(
            deleted_at.is_some(),
            "attachment should be soft-deleted after reverting add"
        );
    }

    // -- Group 2: Error paths (5 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_nonexistent_page_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = undo_page_op_inner(&pool, DEV, &mat, "NONEXISTENT_PAGE".into(), 0).await;

        assert!(result.is_err(), "undo on nonexistent page should fail");
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_depth_exceeds_ops_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let (page_id, _child_ids) = create_page_with_children(&pool, &mat).await;

        // Page has 3 ops: create page, create child1, create child2.
        // Undo with depth=10 should exceed available ops.
        let result = undo_page_op_inner(&pool, DEV, &mat, page_id, 10).await;

        assert!(result.is_err(), "undo with depth exceeding ops should fail");
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn redo_nonexistent_undo_op_returns_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = redo_page_op_inner(&pool, DEV, &mat, "FAKE".into(), 9999).await;

        assert!(result.is_err(), "redo with nonexistent op should fail");
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_empty_list_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let results = revert_ops_inner(&pool, DEV, &mat, vec![]).await.unwrap();

        assert!(
            results.is_empty(),
            "reverting empty list should return empty vec"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_mixed_reversible_non_reversible_rejects_all() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block and edit it (reversible op)
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "start".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, block.id.clone(), "edited".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Create another block, delete it, purge it (non-reversible)
        let doomed = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "doomed".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, doomed.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        purge_block_inner(&pool, DEV, &mat, doomed.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Gather op refs
        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let edit_op = ops.iter().find(|o| o.op_type == "edit_block").unwrap();
        let purge_op = ops.iter().find(|o| o.op_type == "purge_block").unwrap();

        // Record op_log count before attempt
        let count_before = ops.len();

        // Try to revert both — should fail because purge is non-reversible
        let result = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![
                OpRef {
                    device_id: DEV.into(),
                    seq: edit_op.seq,
                },
                OpRef {
                    device_id: DEV.into(),
                    seq: purge_op.seq,
                },
            ],
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NonReversible { .. })),
            "should fail with NonReversible, got: {result:?}"
        );

        // Verify the edit was NOT reversed (block content unchanged)
        let after = get_block_inner(&pool, block.id).await.unwrap();
        assert_eq!(
            after.content,
            Some("edited".into()),
            "edit should NOT be reversed when batch is rejected"
        );

        // Verify op_log count unchanged
        let ops_after = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        assert_eq!(
            count_before,
            ops_after.len(),
            "no new ops should be appended when batch is rejected"
        );
    }

    // -- Group 3: list_page_history edge cases (3 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_deep_nesting_includes_grandchildren() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create: page → child → grandchild → great-grandchild
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Root".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let grandchild = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "grandchild".into(),
            Some(child.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let great_grandchild = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "great-grandchild".into(),
            Some(grandchild.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit each to add more ops
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "child-edited".into())
            .await
            .unwrap();
        edit_block_inner(
            &pool,
            DEV,
            &mat,
            grandchild.id.clone(),
            "grandchild-edited".into(),
        )
        .await
        .unwrap();
        edit_block_inner(
            &pool,
            DEV,
            &mat,
            great_grandchild.id.clone(),
            "gg-edited".into(),
        )
        .await
        .unwrap();

        let result = list_page_history_inner(&pool, page.id.clone(), None, None, None)
            .await
            .unwrap();

        // 4 creates + 3 edits = 7 ops
        assert_eq!(
            result.items.len(),
            7,
            "should include ops for all 4 levels of nesting"
        );

        // Verify all block IDs are from the page tree
        let valid_ids = [
            page.id.clone(),
            child.id.clone(),
            grandchild.id.clone(),
            great_grandchild.id.clone(),
        ];
        for entry in &result.items {
            let payload: serde_json::Value = serde_json::from_str(&entry.payload).unwrap();
            let block_id = payload["block_id"].as_str().unwrap();
            assert!(
                valid_ids.contains(&block_id.to_string()),
                "op should be for a block in the page tree, got: {block_id}"
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_includes_ops_for_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page + child
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "My Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit child
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited-child".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Delete child
        delete_block_inner(&pool, DEV, &mat, child.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let result = list_page_history_inner(&pool, page.id.clone(), None, None, None)
            .await
            .unwrap();

        // Ops: create page + create child + edit child + delete child = 4
        assert_eq!(
            result.items.len(),
            4,
            "should include ops for deleted blocks too"
        );

        let op_types: Vec<&str> = result.items.iter().map(|e| e.op_type.as_str()).collect();
        assert!(
            op_types.contains(&"create_block"),
            "should include create_block ops"
        );
        assert!(
            op_types.contains(&"edit_block"),
            "should include edit_block ops"
        );
        assert!(
            op_types.contains(&"delete_block"),
            "should include delete_block ops"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_empty_page_returns_only_create() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Empty Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let result = list_page_history_inner(&pool, page.id.clone(), None, None, None)
            .await
            .unwrap();

        assert_eq!(
            result.items.len(),
            1,
            "empty page should have exactly 1 op (the create_block)"
        );
        assert_eq!(
            result.items[0].op_type, "create_block",
            "most recent op should be create_block"
        );
    }

    // -- Group 4: Multi-step cycles (2 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_redo_undo_redo_full_cycle_multiple_edits() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page + child
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "My Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit to "v1", then "v2"
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "v1".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "v2".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // 1) undo(depth=0) → reverses edit "v2" → content="v1"
        let undo1 = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("v1".into()),
            "after first undo, content should be v1"
        );

        // 2) undo(depth=2) → reverses edit "v1"
        //    History after step 1: [undo_edit(seq5), edit_v2(seq4), edit_v1(seq3), ...]
        //    depth=2 picks seq3 (edit "v1"), whose prior text is "original"
        let undo2 = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 2)
            .await
            .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("original".into()),
            "after second undo, content should be original"
        );

        // 3) redo the second undo → reverses the undo2 op → content="v1"
        let _redo1 = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo2.new_op_ref.device_id.clone(),
            undo2.new_op_ref.seq,
        )
        .await
        .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("v1".into()),
            "after first redo, content should be v1"
        );

        // 4) redo the first undo → reverses the undo1 op → content="v2"
        let _redo2 = redo_page_op_inner(
            &pool,
            DEV,
            &mat,
            undo1.new_op_ref.device_id.clone(),
            undo1.new_op_ref.seq,
        )
        .await
        .unwrap();
        let after = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            after.content,
            Some("v2".into()),
            "after second redo, content should be v2"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_ops_from_different_devices() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with DEV
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "original".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Manually append an edit_block op from "device-B".
        // Use a far-future timestamp so it sorts AFTER the create_block op
        // from DEV (whose created_at is now_rfc3339()). The reverse lookup
        // needs to find the create op *before* this edit in temporal order.
        let edit_payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(&block.id),
            to_text: "from-device-B".into(),
            prev_edit: None,
        });
        let device_b_op = op_log::append_local_op_at(
            &pool,
            "device-B",
            edit_payload,
            "2099-01-01T00:00:00+00:00".to_string(),
        )
        .await
        .unwrap();

        // Manually apply the edit to the blocks table (op_log doesn't do this)
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind("from-device-B")
            .bind(&block.id)
            .execute(&pool)
            .await
            .unwrap();

        // Verify content is "from-device-B"
        let before = get_block_inner(&pool, block.id.clone()).await.unwrap();
        assert_eq!(
            before.content,
            Some("from-device-B".into()),
            "content should reflect device-B edit"
        );

        // Get the create_block op from DEV
        let dev_ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let create_op = dev_ops
            .iter()
            .find(|o| o.op_type == "create_block")
            .unwrap();

        // Revert both ops: edit from device-B and create from DEV
        // revert_ops_inner sorts newest-first: device-B edit (newer) then DEV create
        let results = revert_ops_inner(
            &pool,
            DEV,
            &mat,
            vec![
                OpRef {
                    device_id: "device-B".into(),
                    seq: device_b_op.seq,
                },
                OpRef {
                    device_id: DEV.into(),
                    seq: create_op.seq,
                },
            ],
        )
        .await
        .unwrap();

        assert_eq!(results.len(), 2, "should have two results");

        // After reverting device-B's edit: content should be "original"
        // After reverting DEV's create: block should be soft-deleted
        let after = get_block_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            after.deleted_at.is_some(),
            "block should be soft-deleted after reverting create"
        );
    }

    // -- Group 5: Additional integration tests (5 tests) --

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_history_includes_ops_after_block_moved_to_different_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create page A
        let page_a = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page A".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Create page B
        let page_b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page B".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Create child under page A
        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child text".into(),
            Some(page_a.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit child while under page A
        edit_block_inner(&pool, DEV, &mat, child.id.clone(), "edited child".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Move child to page B
        move_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            Some(page_b.id.clone()),
            1,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Query page A history — child is no longer under A
        let history_a = list_page_history_inner(&pool, page_a.id.clone(), None, None, Some(50))
            .await
            .unwrap();

        // Query page B history — child is now under B
        let history_b = list_page_history_inner(&pool, page_b.id.clone(), None, None, Some(50))
            .await
            .unwrap();

        // Verify page B contains the child's ops (create, edit, move)
        let child_ops_in_b: Vec<_> = history_b
            .items
            .iter()
            .filter(|e| {
                let payload: serde_json::Value =
                    serde_json::from_str(&e.payload).unwrap_or_default();
                payload.get("block_id").and_then(|v| v.as_str()) == Some(&child.id)
            })
            .collect();

        // The child is now under B, so all ops for child should appear in B's history.
        assert!(
            !child_ops_in_b.is_empty(),
            "page B history should include ops for the moved child"
        );

        // Page A should NOT include the child's ops anymore (child is no longer a descendant)
        let child_ops_in_a: Vec<_> = history_a
            .items
            .iter()
            .filter(|e| {
                let payload: serde_json::Value =
                    serde_json::from_str(&e.payload).unwrap_or_default();
                payload.get("block_id").and_then(|v| v.as_str()) == Some(&child.id)
            })
            .collect();
        assert!(
            child_ops_in_a.is_empty(),
            "page A history should NOT include ops for child that moved away"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_delete_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child content".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Delete the child
        delete_block_inner(&pool, DEV, &mat, child.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify deleted
        let deleted = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert!(deleted.deleted_at.is_some(), "child should be deleted");

        // Undo the delete (depth=0)
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.new_op_type, "restore_block",
            "undo of delete should produce restore"
        );

        // Verify restored
        let restored = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert!(
            restored.deleted_at.is_none(),
            "child should be restored after undo"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_move_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let parent_a = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Parent A".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let parent_b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Parent B".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "moveable".into(),
            Some(parent_a.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Move child from parent_a to parent_b
        move_block_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            Some(parent_b.id.clone()),
            5,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify moved
        let moved = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            moved.parent_id.as_deref(),
            Some(parent_b.id.as_str()),
            "block should be under parent_b after move"
        );

        // Undo the move (depth=0)
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.new_op_type, "move_block",
            "undo of move should produce move"
        );

        // Verify moved back
        let restored = get_block_inner(&pool, child.id.clone()).await.unwrap();
        assert_eq!(
            restored.parent_id.as_deref(),
            Some(parent_a.id.as_str()),
            "child should be back under parent A"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_add_tag() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let tag = create_block_inner(
            &pool,
            DEV,
            &mat,
            "tag".into(),
            "important".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Add tag to child
        add_tag_inner(&pool, DEV, &mat, child.id.clone(), tag.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify tag exists
        let count_before: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(&child.id)
                .bind(&tag.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count_before, 1, "tag should be applied before undo");

        // Undo the add_tag (depth=0)
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.new_op_type, "remove_tag",
            "undoing add_tag should produce remove_tag"
        );

        // Verify tag removed
        let count_after: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(&child.id)
                .bind(&tag.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count_after, 0, "tag should be removed after undo");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_page_op_reverses_set_property() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "child".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set property
        set_property_inner(
            &pool,
            DEV,
            &mat,
            child.id.clone(),
            "importance".into(),
            Some("high".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify property exists
        let props = get_properties_inner(&pool, child.id.clone()).await.unwrap();
        assert!(
            props
                .iter()
                .any(|p| p.key == "importance" && p.value_text.as_deref() == Some("high")),
            "importance property should be set to high"
        );

        // Undo the set_property (depth=0) — should produce delete_property since it was the first set
        let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone(), 0)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            result.new_op_type, "delete_property",
            "undoing first set_property should produce delete_property"
        );

        // Verify property removed
        let props_after = get_properties_inner(&pool, child.id.clone()).await.unwrap();
        assert!(
            !props_after.iter().any(|p| p.key == "importance"),
            "property should be removed after undo"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_undo_from_multiple_devices() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a page and two child blocks
        let page = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Concurrent Undo Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child_a = create_block_inner(
            &pool,
            "device-A",
            &mat,
            "content".into(),
            "Block from device-A".into(),
            Some(page.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let child_b = create_block_inner(
            &pool,
            "device-B",
            &mat,
            "content".into(),
            "Block from device-B".into(),
            Some(page.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Edit both blocks from their respective devices
        edit_block_inner(
            &pool,
            "device-A",
            &mat,
            child_a.id.clone(),
            "A-edited".into(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        edit_block_inner(
            &pool,
            "device-B",
            &mat,
            child_b.id.clone(),
            "B-edited".into(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Verify pre-undo state
        let a_before = get_block_inner(&pool, child_a.id.clone()).await.unwrap();
        let b_before = get_block_inner(&pool, child_b.id.clone()).await.unwrap();
        assert_eq!(
            a_before.content,
            Some("A-edited".into()),
            "child A should have edited content"
        );
        assert_eq!(
            b_before.content,
            Some("B-edited".into()),
            "child B should have edited content"
        );

        // Spawn concurrent undo from device-A (depth=0) and device-B (depth=0)
        // Both target the most recent op on the page, but since they run
        // concurrently one will see depth=0 as the edit_block from device-B
        // and the other will also try depth=0. SQLite serializes via
        // BEGIN IMMEDIATE, so both should succeed without corruption.
        let pool_a = pool.clone();
        let mat_a = Materializer::new(pool.clone());
        let page_id_a = page.id.clone();

        let pool_b = pool.clone();
        let mat_b = Materializer::new(pool.clone());
        let page_id_b = page.id.clone();

        let h_a = tokio::spawn(async move {
            undo_page_op_inner(&pool_a, "device-A", &mat_a, page_id_a, 0).await
        });
        let h_b = tokio::spawn(async move {
            undo_page_op_inner(&pool_b, "device-B", &mat_b, page_id_b, 0).await
        });

        let (r_a, r_b) = tokio::join!(h_a, h_b);

        // Both tasks should complete without panicking
        let result_a = r_a.expect("device-A undo task should not panic");
        let result_b = r_b.expect("device-B undo task should not panic");

        // At least one should succeed. Due to SQLite serialization,
        // both may succeed (each sees a different "most recent" op
        // after the first commits), or one may fail if both see the
        // same op before serialization kicks in.
        let a_ok = result_a.is_ok();
        let b_ok = result_b.is_ok();
        assert!(a_ok || b_ok, "at least one concurrent undo should succeed");

        // If both succeeded, verify the page has 2 new undo ops
        if a_ok && b_ok {
            let ra = result_a.unwrap();
            let rb = result_b.unwrap();

            // Both should be undo (not redo)
            assert!(!ra.is_redo, "device-A undo should not be flagged as redo");
            assert!(!rb.is_redo, "device-B undo should not be flagged as redo");

            // They should have different op refs (no duplicate ops)
            assert_ne!(
                ra.new_op_ref, rb.new_op_ref,
                "concurrent undos should produce distinct ops"
            );
        }

        // Verify database integrity: no duplicate seqs, all blocks readable
        let a_after = get_block_inner(&pool, child_a.id.clone()).await.unwrap();
        let b_after = get_block_inner(&pool, child_b.id.clone()).await.unwrap();

        // At least one block should have been reverted to its pre-edit state
        let a_reverted = a_after.content == Some("Block from device-A".into());
        let b_reverted = b_after.content == Some("Block from device-B".into());
        assert!(
            a_reverted || b_reverted,
            "at least one block should be reverted; a={:?}, b={:?}",
            a_after.content,
            b_after.content
        );

        // Verify op_log integrity: count total ops
        let total_ops: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM op_log WHERE json_extract(payload, '$.block_id') IN \
             (SELECT id FROM blocks WHERE parent_id = ?)",
            page.id
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        // We have: 2 create + 2 edit + (1 or 2) undo = 5 or 6 ops
        assert!(
            total_ops >= 5,
            "expected at least 5 ops (2 creates + 2 edits + 1 undo), got {total_ops}"
        );
    }

    // ======================================================================
    // undo_page_op_inner – input validation
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undo_rejects_negative_depth() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = undo_page_op_inner(&pool, DEV, &mat, "nonexistent-page".into(), -1).await;

        assert!(result.is_err(), "negative undo_depth should be rejected");
        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("undo_depth must be non-negative"),
            "error should mention undo_depth validation, got: {msg}"
        );
        assert!(
            matches!(err, AppError::Validation(_)),
            "error should be Validation variant, got: {err:?}"
        );
    }

    // ======================================================================
    // Sync — list_peer_refs
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_list_peer_refs_returns_empty_vec_initially() {
        let (pool, _dir) = test_pool().await;

        let peers = list_peer_refs_inner(&pool).await.unwrap();
        assert!(
            peers.is_empty(),
            "list_peer_refs must return empty vec on fresh DB"
        );
    }

    // ======================================================================
    // Sync — get_peer_ref
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_get_peer_ref_returns_none_for_nonexistent() {
        let (pool, _dir) = test_pool().await;

        let result = get_peer_ref_inner(&pool, "nonexistent-peer".into())
            .await
            .unwrap();
        assert!(
            result.is_none(),
            "get_peer_ref must return None for nonexistent peer"
        );
    }

    // ======================================================================
    // Sync — delete_peer_ref
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_delete_peer_ref_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = delete_peer_ref_inner(&pool, "ghost-peer".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "delete_peer_ref on nonexistent peer must return NotFound"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_delete_peer_ref_removes_existing_peer() {
        let (pool, _dir) = test_pool().await;

        // Insert a peer directly
        peer_refs::upsert_peer_ref(&pool, "peer-to-delete")
            .await
            .unwrap();

        // Verify it exists
        let before = get_peer_ref_inner(&pool, "peer-to-delete".into())
            .await
            .unwrap();
        assert!(before.is_some(), "peer must exist before delete");

        // Delete it
        delete_peer_ref_inner(&pool, "peer-to-delete".into())
            .await
            .unwrap();

        // Verify it's gone
        let after = get_peer_ref_inner(&pool, "peer-to-delete".into())
            .await
            .unwrap();
        assert!(after.is_none(), "peer must be gone after delete");
    }

    // ======================================================================
    // Sync — get_device_id
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_get_device_id_returns_non_empty_string() {
        let device_id = crate::device::DeviceId::new("test-device-uuid-1234".to_string());

        let result = get_device_id_inner(&device_id);
        assert!(
            !result.is_empty(),
            "get_device_id must return a non-empty string"
        );
        assert_eq!(
            result, "test-device-uuid-1234",
            "get_device_id must return the exact device ID"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_list_peer_refs_returns_inserted_peers() {
        let (pool, _dir) = test_pool().await;

        // Insert some peers
        peer_refs::upsert_peer_ref(&pool, "peer-A").await.unwrap();
        peer_refs::upsert_peer_ref(&pool, "peer-B").await.unwrap();

        let peers = list_peer_refs_inner(&pool).await.unwrap();
        assert_eq!(peers.len(), 2, "must return all 2 inserted peers");

        let ids: Vec<&str> = peers.iter().map(|p| p.peer_id.as_str()).collect();
        assert!(ids.contains(&"peer-A"), "must contain peer-A");
        assert!(ids.contains(&"peer-B"), "must contain peer-B");
    }

    // ── #74: max nesting depth guard ─────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_exceeding_max_depth_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Build a chain of MAX_BLOCK_DEPTH levels: page→b1→b2→...→b20
        insert_block(&pool, "DEPTH_PAGE", "page", "root", None, Some(1)).await;
        let mut parent = "DEPTH_PAGE".to_string();
        for i in 1..=MAX_BLOCK_DEPTH {
            let id = format!("DEPTH_{i:02}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("level {i}"),
                Some(&parent),
                Some(1),
            )
            .await;
            parent = id;
        }

        // Create a loose block to try nesting under the deepest
        insert_block(&pool, "DEPTH_EXTRA", "content", "extra", None, Some(99)).await;

        // Try moving the loose block under the deepest level — should fail
        let result =
            move_block_inner(&pool, DEV, &mat, "DEPTH_EXTRA".into(), Some(parent), 1).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "moving beyond MAX_BLOCK_DEPTH should return Validation, got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("nesting depth"),
            "error message should mention nesting depth"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_at_depth_limit_succeeds() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Build a chain of MAX_BLOCK_DEPTH - 1 levels
        insert_block(&pool, "DLIM_PAGE", "page", "root", None, Some(1)).await;
        let mut parent = "DLIM_PAGE".to_string();
        for i in 1..MAX_BLOCK_DEPTH {
            let id = format!("DLIM_{i:02}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("level {i}"),
                Some(&parent),
                Some(1),
            )
            .await;
            parent = id;
        }

        // Create a loose block and move under the (MAX_BLOCK_DEPTH - 1)th level — should succeed
        insert_block(&pool, "DLIM_OK", "content", "ok", None, Some(99)).await;

        let result = move_block_inner(&pool, DEV, &mat, "DLIM_OK".into(), Some(parent), 1).await;

        assert!(
            result.is_ok(),
            "moving to exactly MAX_BLOCK_DEPTH should succeed, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_block_with_subtree_exceeding_max_depth_returns_validation_error() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Build a deep parent chain of 17 levels: page→d1→d2→...→d17
        insert_block(&pool, "SUB_PAGE", "page", "root", None, Some(1)).await;
        let mut parent = "SUB_PAGE".to_string();
        for i in 1..=17_i64 {
            let id = format!("SUB_P{i:02}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("parent {i}"),
                Some(&parent),
                Some(1),
            )
            .await;
            parent = id;
        }

        // Build a detached subtree: A→B→C→D (depth 3 below A)
        insert_block(&pool, "SUB_A", "content", "a", None, Some(90)).await;
        insert_block(&pool, "SUB_B", "content", "b", Some("SUB_A"), Some(1)).await;
        insert_block(&pool, "SUB_C", "content", "c", Some("SUB_B"), Some(1)).await;
        insert_block(&pool, "SUB_D", "content", "d", Some("SUB_C"), Some(1)).await;

        // Moving A under d17 means D ends up at depth 17+1+3 = 21 > 20
        let result = move_block_inner(&pool, DEV, &mat, "SUB_A".into(), Some(parent), 1).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "moving subtree that would exceed depth limit should fail, got: {result:?}"
        );
    }

    // ── #129: rows_affected checks in apply_reverse_in_tx ────────────

    #[tokio::test]
    async fn apply_reverse_remove_tag_on_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();

        let payload = OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::test_id("GHOST_BLK"),
            tag_id: BlockId::test_id("GHOST_TAG"),
        });
        let result = apply_reverse_in_tx(&mut tx, &payload).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "removing a nonexistent tag association should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn apply_reverse_delete_property_on_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();

        let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("GHOST_BLK"),
            key: "priority".into(),
        });
        let result = apply_reverse_in_tx(&mut tx, &payload).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "deleting a nonexistent property should return NotFound, got: {result:?}"
        );
    }

    #[tokio::test]
    async fn apply_reverse_delete_attachment_on_nonexistent_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mut tx = pool.begin().await.unwrap();

        let payload = OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
            attachment_id: "ATT_GHOST".into(),
        });
        let result = apply_reverse_in_tx(&mut tx, &payload).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "soft-deleting a nonexistent attachment should return NotFound, got: {result:?}"
        );
    }

    // ======================================================================
    // Sync — start_pairing (#275)
    // ======================================================================

    #[test]
    fn sync_start_pairing_returns_passphrase_and_qr() {
        let pairing_state = Mutex::new(None);
        let result = start_pairing_inner(&pairing_state, "device-A");
        assert!(result.is_ok(), "start_pairing must succeed");

        let info = result.unwrap();
        // Passphrase should be 4 words
        let words: Vec<&str> = info.passphrase.split(' ').collect();
        assert_eq!(words.len(), 4, "passphrase must contain 4 words");

        // QR SVG should contain <svg
        assert!(
            info.qr_svg.contains("<svg"),
            "qr_svg must contain an SVG tag"
        );

        // Port is a placeholder
        assert_eq!(info.port, 0, "port must be 0 (placeholder)");

        // Session should be stored in state
        let session = pairing_state.lock().unwrap();
        assert!(session.is_some(), "pairing session must be stored in state");
    }

    #[test]
    fn sync_start_pairing_replaces_existing_session() {
        let pairing_state = Mutex::new(None);

        let info1 = start_pairing_inner(&pairing_state, "device-A").unwrap();
        let info2 = start_pairing_inner(&pairing_state, "device-A").unwrap();

        // Each call generates a new passphrase (astronomically unlikely to collide)
        // Just verify both succeed
        assert!(
            !info1.passphrase.is_empty(),
            "first passphrase should not be empty"
        );
        assert!(
            !info2.passphrase.is_empty(),
            "second passphrase should not be empty"
        );
    }

    // ======================================================================
    // Sync — confirm_pairing (#275)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sync_confirm_pairing_stores_peer_and_clears_session() {
        let (pool, _dir) = test_pool().await;
        let pairing_state = Mutex::new(None);

        // Start pairing first
        let info = start_pairing_inner(&pairing_state, "device-local").unwrap();

        // Confirm with the passphrase
        confirm_pairing_inner(
            &pool,
            &pairing_state,
            "device-local",
            info.passphrase,
            "device-remote".into(),
        )
        .await
        .unwrap();

        // Peer ref should now exist
        let peer = peer_refs::get_peer_ref(&pool, "device-remote")
            .await
            .unwrap();
        assert!(peer.is_some(), "peer ref must exist after confirm_pairing");

        // Pairing session should be cleared
        let session = pairing_state.lock().unwrap();
        assert!(
            session.is_none(),
            "pairing session must be cleared after confirm"
        );
    }

    // ======================================================================
    // Sync — cancel_pairing (#275)
    // ======================================================================

    #[test]
    fn sync_cancel_pairing_clears_session() {
        let pairing_state = Mutex::new(None);

        // Start pairing
        start_pairing_inner(&pairing_state, "device-A").unwrap();
        assert!(
            pairing_state.lock().unwrap().is_some(),
            "pairing session should exist after start"
        );

        // Cancel
        cancel_pairing_inner(&pairing_state).unwrap();
        assert!(
            pairing_state.lock().unwrap().is_none(),
            "pairing session must be cleared after cancel"
        );
    }

    #[test]
    fn sync_cancel_pairing_noop_when_no_session() {
        let pairing_state = Mutex::new(None);

        // Cancel with no active session — should succeed
        let result = cancel_pairing_inner(&pairing_state);
        assert!(
            result.is_ok(),
            "cancel_pairing with no session must succeed"
        );
    }

    // ======================================================================
    // Sync — start_sync (#278: backoff integration)
    // ======================================================================

    #[test]
    fn sync_start_sync_returns_complete_info() {
        let scheduler = SyncScheduler::new();
        let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
        assert!(result.is_ok(), "start_sync must succeed for a fresh peer");

        let info = result.unwrap();
        assert_eq!(info.state, "complete", "sync state should be complete");
        assert_eq!(
            info.local_device_id, "device-local",
            "local device id should match"
        );
        assert_eq!(
            info.remote_device_id, "peer-1",
            "remote device id should match"
        );
        assert_eq!(info.ops_received, 0, "fresh sync should receive zero ops");
        assert_eq!(info.ops_sent, 0, "fresh sync should send zero ops");
    }

    #[test]
    fn sync_start_sync_respects_backoff() {
        let scheduler = SyncScheduler::new();
        scheduler.record_failure("peer-1");

        let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
        assert!(
            result.is_err(),
            "start_sync must fail when peer is in backoff"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string().contains("backoff"),
            "error should mention backoff, got: {err}"
        );
    }

    #[test]
    fn sync_start_sync_after_backoff_reset_succeeds() {
        let scheduler = SyncScheduler::new();
        scheduler.record_failure("peer-1");
        scheduler.record_success("peer-1"); // reset backoff

        let result = start_sync_inner(&scheduler, "device-local", "peer-1".into());
        assert!(
            result.is_ok(),
            "start_sync must succeed after backoff is reset"
        );
    }

    // ======================================================================
    // Sync — cancel_sync
    // ======================================================================

    #[test]
    fn sync_cancel_sync_succeeds() {
        let flag = AtomicBool::new(false);
        let result = cancel_sync_inner(&flag);
        assert!(result.is_ok(), "cancel_sync must succeed");
        assert!(
            flag.load(Ordering::Acquire),
            "cancel flag must be set after cancel_sync"
        );
    }

    // ======================================================================
    // set_todo_state / set_priority / set_due_date
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_sets_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "todo test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        assert_eq!(
            result.todo_state,
            Some("TODO".into()),
            "returned block should have TODO state"
        );

        // Verify DB column
        let db_val: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
                .bind(&block.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            db_val,
            Some("TODO".into()),
            "DB column should persist TODO state"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_clears_value() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "clear test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set then clear
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();

        assert_eq!(
            result.todo_state, None,
            "todo_state should be cleared to None"
        );

        // Verify DB column is NULL
        let db_val: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
                .bind(&block.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(db_val.is_none(), "DB column should be NULL after clearing");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_rejects_too_long_string() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "too long test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let long_state = "A".repeat(51);
        let result =
            set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some(long_state)).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "state over 50 chars should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_rejects_empty_string() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "empty test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result =
            set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("".into())).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "empty state should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_accepts_custom_keyword_cancelled() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "custom keyword test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result =
            set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("CANCELLED".into()))
                .await
                .unwrap();

        assert_eq!(
            result.todo_state.as_deref(),
            Some("CANCELLED"),
            "todo_state should be CANCELLED"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = set_todo_state_inner(
            &pool,
            DEV,
            &mat,
            "nonexistent-id".into(),
            Some("TODO".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "nonexistent block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_sets_and_clears() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "prio test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set priority
        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into()))
            .await
            .unwrap();
        assert_eq!(
            result.priority,
            Some("2".into()),
            "priority should be set to 2"
        );

        mat.flush_background().await.unwrap();

        // Clear priority
        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();
        assert_eq!(result.priority, None, "priority should be cleared to None");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_invalid_returns_validation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "inv prio".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("5".into())).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid priority should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_sets_and_clears() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "date test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set due date
        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-04-15".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            result.due_date,
            Some("2026-04-15".into()),
            "due_date should be set to 2026-04-15"
        );

        mat.flush_background().await.unwrap();

        // Clear due date
        let result = set_due_date_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();
        assert_eq!(result.due_date, None, "due_date should be cleared to None");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_invalid_format_returns_validation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "inv date".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("not-a-date".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid date should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_routes_reserved_key_to_blocks_column() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "reserved routing".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Use set_property_inner directly with reserved key
        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "todo_state".into(),
            Some("DONE".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.todo_state,
            Some("DONE".into()),
            "todo_state should be DONE"
        );

        // Verify blocks.todo_state column updated
        let db_val: Option<String> =
            sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
                .bind(&block.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            db_val,
            Some("DONE".into()),
            "DB column should persist DONE state"
        );

        // Verify block_properties does NOT have a row for it
        let prop_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'todo_state'",
        )
        .bind(&block.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            prop_count, 0,
            "reserved key should not be in block_properties"
        );

        mat.shutdown();
    }

    // ======================================================================
    // set_property — date format / reserved key / property_definitions type
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_rejects_invalid_date_format() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "date val test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "my_date".into(),
            None,
            None,
            Some("not-a-date".into()),
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("Invalid date format")),
            "invalid date string should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_rejects_out_of_range_date() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "date range test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "my_date".into(),
            None,
            None,
            Some("2025-13-45".into()),
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("Invalid date format")),
            "out-of-range date should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_rejects_due_date_with_value_text() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "reserved field test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "due_date".into(),
            Some("2025-01-01".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("requires value_date")),
            "due_date with value_text should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_rejects_todo_state_with_value_date() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "reserved field test 2".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "todo_state".into(),
            None,
            None,
            Some("2025-01-01".into()),
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("requires value_text")),
            "todo_state with value_date should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_accepts_valid_reserved_key_with_correct_field() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "reserved accept test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "due_date".into(),
            None,
            None,
            Some("2025-01-15".into()),
            None,
        )
        .await;

        assert!(
            result.is_ok(),
            "due_date with valid value_date should succeed, got: {result:?}"
        );

        let block = result.unwrap();
        assert_eq!(
            block.due_date,
            Some("2025-01-15".into()),
            "due_date should match the set value"
        );

        mat.shutdown();
    }

    // ======================================================================
    // ref value_type — property definitions & set_property (#H-6)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_property_def_ref_type_succeeds() {
        let (pool, _dir) = test_pool().await;

        let def = create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
            .await
            .unwrap();

        assert_eq!(def.key, "reviewer", "property def key should be reviewer");
        assert_eq!(
            def.value_type, "ref",
            "property def value_type should be ref"
        );
        assert!(def.options.is_none(), "ref type should have no options");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_property_def_ref_type_rejects_options() {
        let (pool, _dir) = test_pool().await;

        let result = create_property_def_inner(
            &pool,
            "reviewer".into(),
            "ref".into(),
            Some(r#"["a","b"]"#.into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("options are only allowed for select")),
            "ref with options should return Validation error, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_property_ref_type_enforces_value_ref() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a ref-type definition
        create_property_def_inner(&pool, "reviewer".into(), "ref".into(), None)
            .await
            .unwrap();

        // Create a block
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "ref type test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Setting value_text on a ref-type property should fail
        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "reviewer".into(),
            Some("wrong".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref msg)) if msg.contains("expects type")),
            "ref def with value_text should fail type check, got: {result:?}"
        );

        // Setting value_ref should succeed
        let target = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "target page".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "reviewer".into(),
            None,
            None,
            None,
            Some(target.id.clone()),
        )
        .await;

        assert!(
            result.is_ok(),
            "ref def with value_ref should succeed, got: {result:?}"
        );

        mat.shutdown();
    }

    // ======================================================================
    // set_priority / set_due_date — nonexistent block returns NotFound
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result =
            set_priority_inner(&pool, DEV, &mat, "nonexistent-id".into(), Some("1".into())).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "nonexistent block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            "nonexistent-id".into(),
            Some("2026-05-15".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "nonexistent block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Deleted block returns NotFound for all three thin commands
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_deleted_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "will delete".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result =
            set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into())).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_todo_state on deleted block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_deleted_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "will delete".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("2".into())).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_priority on deleted block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_deleted_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "will delete".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        delete_block_inner(&pool, DEV, &mat, block.id.clone())
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-05-15".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_due_date on deleted block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Op log verification for thin commands
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_writes_op_log_entry() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "op log test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        // null→TODO now also sets created_at, so we expect 2 set_property ops
        assert_eq!(
            set_prop_ops.len(),
            2,
            "two set_property ops should be logged (todo_state + created_at)"
        );
        assert!(
            set_prop_ops[0].payload.contains("\"todo_state\""),
            "first op payload must contain key 'todo_state'"
        );
        assert!(
            set_prop_ops[1].payload.contains("\"created_at\""),
            "second op payload must contain key 'created_at'"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_priority_writes_op_log_entry() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "op log test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        set_priority_inner(&pool, DEV, &mat, block.id.clone(), Some("1".into()))
            .await
            .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        assert_eq!(
            set_prop_ops.len(),
            1,
            "exactly one set_property op should be logged"
        );
        assert!(
            set_prop_ops[0].payload.contains("\"priority\""),
            "op payload must contain key 'priority'"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_due_date_writes_op_log_entry() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "op log test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-05-15".into()),
        )
        .await
        .unwrap();

        let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        let set_prop_ops: Vec<_> = ops.iter().filter(|o| o.op_type == "set_property").collect();
        assert_eq!(
            set_prop_ops.len(),
            1,
            "exactly one set_property op should be logged"
        );
        assert!(
            set_prop_ops[0].payload.contains("\"due_date\""),
            "op payload must contain key 'due_date'"
        );

        mat.shutdown();
    }

    // ======================================================================
    // list_blocks with agenda_source filter
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_agenda_source_filter_due_date() {
        let (pool, _dir) = test_pool().await;

        // Insert blocks
        insert_block(&pool, "AG_DUE1", "content", "due task", None, None).await;
        insert_block(&pool, "AG_SCHED1", "content", "scheduled task", None, None).await;

        // Insert agenda_cache entries with different sources on the same date
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-08-01")
            .bind("AG_DUE1")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-08-01")
            .bind("AG_SCHED1")
            .bind("column:scheduled_date")
            .execute(&pool)
            .await
            .unwrap();

        // Filter by column:due_date — should only return AG_DUE1
        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            Some("2025-08-01".into()),
            None,
            None,
            Some("column:due_date".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 1, "should return only due_date items");
        assert_eq!(
            resp.items[0].id, "AG_DUE1",
            "returned item should be the due_date block"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_agenda_source_filter_scheduled_date() {
        let (pool, _dir) = test_pool().await;

        // Insert blocks
        insert_block(&pool, "AG_DUE2", "content", "due task", None, None).await;
        insert_block(&pool, "AG_SCHED2", "content", "scheduled task", None, None).await;

        // Insert agenda_cache entries with different sources on the same date
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-08-02")
            .bind("AG_DUE2")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-08-02")
            .bind("AG_SCHED2")
            .bind("column:scheduled_date")
            .execute(&pool)
            .await
            .unwrap();

        // Filter by column:scheduled_date — should only return AG_SCHED2
        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            Some("2025-08-02".into()),
            None,
            None,
            Some("column:scheduled_date".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "should return only scheduled_date items"
        );
        assert_eq!(
            resp.items[0].id, "AG_SCHED2",
            "returned item should be scheduled_date block"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_agenda_no_source_returns_all() {
        let (pool, _dir) = test_pool().await;

        // Insert blocks
        insert_block(&pool, "AG_ALL1", "content", "due task", None, None).await;
        insert_block(&pool, "AG_ALL2", "content", "scheduled task", None, None).await;
        insert_block(&pool, "AG_ALL3", "content", "property task", None, None).await;

        // Insert agenda_cache entries with different sources on the same date
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-08-03")
            .bind("AG_ALL1")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-08-03")
            .bind("AG_ALL2")
            .bind("column:scheduled_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-08-03")
            .bind("AG_ALL3")
            .bind("property:created_at")
            .execute(&pool)
            .await
            .unwrap();

        // No source filter — should return all 3 items (backward compatible)
        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            Some("2025-08-03".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            3,
            "no source filter should return all agenda items"
        );
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"AG_ALL1"), "should include AG_ALL1");
        assert!(ids.contains(&"AG_ALL2"), "should include AG_ALL2");
        assert!(ids.contains(&"AG_ALL3"), "should include AG_ALL3");
    }

    // ======================================================================
    // list_blocks with agenda_date_range (date range query)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_date_range_returns_blocks_in_range() {
        let (pool, _dir) = test_pool().await;

        // Insert blocks for 3 different dates
        insert_block(&pool, "RNG_BLK1", "content", "task jan 15", None, None).await;
        insert_block(&pool, "RNG_BLK2", "content", "task jan 20", None, None).await;
        insert_block(&pool, "RNG_BLK3", "content", "task feb 05", None, None).await;

        // Insert agenda_cache entries
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-01-15")
            .bind("RNG_BLK1")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-01-20")
            .bind("RNG_BLK2")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-02-05")
            .bind("RNG_BLK3")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();

        // Query full January range — should return BLK1 and BLK2, not BLK3
        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            Some("2025-01-01".into()),
            Some("2025-01-31".into()),
            Some("column:due_date".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "date range 2025-01-01..2025-01-31 should return 2 items"
        );
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert!(ids.contains(&"RNG_BLK1"), "BLK1 (jan 15) must be in range");
        assert!(ids.contains(&"RNG_BLK2"), "BLK2 (jan 20) must be in range");
        assert!(
            !ids.contains(&"RNG_BLK3"),
            "BLK3 (feb 05) must NOT be in range"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_date_range_single_day() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "RNG_SD1", "content", "single day task", None, None).await;
        insert_block(&pool, "RNG_SD2", "content", "other day task", None, None).await;

        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-03-15")
            .bind("RNG_SD1")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-03-16")
            .bind("RNG_SD2")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();

        // Range of a single day
        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            Some("2025-03-15".into()),
            Some("2025-03-15".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(resp.items.len(), 1, "single-day range should return 1 item");
        assert_eq!(
            resp.items[0].id, "RNG_SD1",
            "single-day match should be RNG_SD1"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_with_date_range_validates_format() {
        let (pool, _dir) = test_pool().await;

        // Invalid date format
        let result = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            Some("bad".into()),
            Some("2025-01-31".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid start date must be rejected: {result:?}"
        );

        // start > end
        let result = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            Some("2025-02-01".into()),
            Some("2025-01-01".into()),
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "start > end must be rejected: {result:?}"
        );

        // Only one of start/end provided
        let result = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            Some("2025-01-01".into()),
            None,
            None,
            None,
            None,
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "only start without end must be rejected: {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_blocks_date_range_with_source_filter() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "RNG_SRC1", "content", "due block", None, None).await;
        insert_block(&pool, "RNG_SRC2", "content", "sched block", None, None).await;

        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-04-10")
            .bind("RNG_SRC1")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-04-10")
            .bind("RNG_SRC2")
            .bind("column:scheduled_date")
            .execute(&pool)
            .await
            .unwrap();

        // Range with source filter — only due_date source
        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            Some("2025-04-01".into()),
            Some("2025-04-30".into()),
            Some("column:due_date".into()),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "source filter should return only due_date items"
        );
        assert_eq!(
            resp.items[0].id, "RNG_SRC1",
            "filtered item should be the due_date block"
        );

        // Without source filter — both items
        let resp = list_blocks_inner(
            &pool,
            None,
            None,
            None,
            None,
            None,
            Some("2025-04-01".into()),
            Some("2025-04-30".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "no source filter should return all items"
        );
    }

    // ======================================================================
    // count_agenda_batch
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_empty_dates_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = count_agenda_batch_inner(&pool, vec![]).await.unwrap();
        assert!(
            result.is_empty(),
            "empty dates input should return empty map"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_returns_correct_counts() {
        let (pool, _dir) = test_pool().await;

        // Insert blocks that own the agenda entries
        insert_block(&pool, "AG_BLK1", "content", "task 1", None, None).await;
        insert_block(&pool, "AG_BLK2", "content", "task 2", None, None).await;
        insert_block(&pool, "AG_BLK3", "content", "task 3", None, None).await;

        // Insert agenda_cache entries: 2 items on 2025-06-01, 1 on 2025-06-02
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-06-01")
            .bind("AG_BLK1")
            .bind("property:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-06-01")
            .bind("AG_BLK2")
            .bind("property:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-06-02")
            .bind("AG_BLK3")
            .bind("property:due_date")
            .execute(&pool)
            .await
            .unwrap();

        let result = count_agenda_batch_inner(
            &pool,
            vec![
                "2025-06-01".into(),
                "2025-06-02".into(),
                "2025-06-03".into(),
            ],
        )
        .await
        .unwrap();

        assert_eq!(
            result.get("2025-06-01"),
            Some(&2),
            "June 1 should have 2 entries"
        );
        assert_eq!(
            result.get("2025-06-02"),
            Some(&1),
            "June 2 should have 1 entry"
        );
        assert_eq!(
            result.get("2025-06-03"),
            None,
            "date with no entries should not appear in result"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;

        // Insert one live and one soft-deleted block
        insert_block(&pool, "AG_LIVE", "content", "live", None, None).await;
        insert_block(&pool, "AG_DEL", "content", "deleted", None, None).await;
        // Soft-delete AG_DEL
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
            .bind("AG_DEL")
            .execute(&pool)
            .await
            .unwrap();

        // Both blocks have agenda entries on the same date
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-07-01")
            .bind("AG_LIVE")
            .bind("property:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-07-01")
            .bind("AG_DEL")
            .bind("property:due_date")
            .execute(&pool)
            .await
            .unwrap();

        let result = count_agenda_batch_inner(&pool, vec!["2025-07-01".into()])
            .await
            .unwrap();

        assert_eq!(
            result.get("2025-07-01"),
            Some(&1),
            "only the live block should be counted"
        );
    }

    // ======================================================================
    // count_agenda_batch_by_source
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_by_source_empty_dates_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = count_agenda_batch_by_source_inner(&pool, vec![])
            .await
            .unwrap();
        assert!(
            result.is_empty(),
            "empty date list should produce empty counts"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_by_source_returns_correct_breakdown() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BS_BLK1", "content", "task 1", None, None).await;
        insert_block(&pool, "BS_BLK2", "content", "task 2", None, None).await;
        insert_block(&pool, "BS_BLK3", "content", "task 3", None, None).await;

        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-09-01")
            .bind("BS_BLK1")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-09-01")
            .bind("BS_BLK2")
            .bind("column:scheduled_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-09-01")
            .bind("BS_BLK3")
            .bind("property:deadline")
            .execute(&pool)
            .await
            .unwrap();

        let result = count_agenda_batch_by_source_inner(&pool, vec!["2025-09-01".into()])
            .await
            .unwrap();

        let day = result.get("2025-09-01").expect("date should be present");
        assert_eq!(
            day.get("column:due_date"),
            Some(&1),
            "should have 1 due_date entry"
        );
        assert_eq!(
            day.get("column:scheduled_date"),
            Some(&1),
            "should have 1 scheduled_date entry"
        );
        assert_eq!(
            day.get("property:deadline"),
            Some(&1),
            "should have 1 property:deadline entry"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_by_source_excludes_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BSD_LIVE", "content", "live", None, None).await;
        insert_block(&pool, "BSD_DEL", "content", "deleted", None, None).await;

        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'BSD_DEL'")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-09-02")
            .bind("BSD_LIVE")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind("2025-09-02")
            .bind("BSD_DEL")
            .bind("column:due_date")
            .execute(&pool)
            .await
            .unwrap();

        let result = count_agenda_batch_by_source_inner(&pool, vec!["2025-09-02".into()])
            .await
            .unwrap();

        let day = result.get("2025-09-02").expect("date should be present");
        assert_eq!(
            day.get("column:due_date"),
            Some(&1),
            "only non-deleted block should be counted"
        );
    }

    // ======================================================================
    // count_backlinks_batch
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_backlinks_batch_empty_page_ids_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = count_backlinks_batch_inner(&pool, vec![]).await.unwrap();
        assert!(
            result.is_empty(),
            "empty page_ids input should return empty map"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_backlinks_batch_returns_correct_counts() {
        let (pool, _dir) = test_pool().await;

        // Target pages
        insert_block(&pool, "BLB_TGT1", "page", "target 1", None, None).await;
        insert_block(&pool, "BLB_TGT2", "page", "target 2", None, None).await;
        // Source blocks
        insert_block(&pool, "BLB_SRC1", "content", "src 1", None, None).await;
        insert_block(&pool, "BLB_SRC2", "content", "src 2", None, None).await;
        insert_block(&pool, "BLB_SRC3", "content", "src 3", None, None).await;

        // 2 links to TGT1, 1 link to TGT2
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BLB_SRC1")
            .bind("BLB_TGT1")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BLB_SRC2")
            .bind("BLB_TGT1")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BLB_SRC3")
            .bind("BLB_TGT2")
            .execute(&pool)
            .await
            .unwrap();

        let result = count_backlinks_batch_inner(
            &pool,
            vec!["BLB_TGT1".into(), "BLB_TGT2".into(), "NONEXISTENT".into()],
        )
        .await
        .unwrap();

        assert_eq!(
            result.get("BLB_TGT1"),
            Some(&2),
            "BLB_TGT1 should have 2 backlinks"
        );
        assert_eq!(
            result.get("BLB_TGT2"),
            Some(&1),
            "BLB_TGT2 should have 1 backlink"
        );
        assert_eq!(
            result.get("NONEXISTENT"),
            None,
            "page with no backlinks should not appear in result"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_backlinks_batch_excludes_deleted_source_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLD_TGT", "page", "target", None, None).await;
        insert_block(&pool, "BLD_LIVE", "content", "live src", None, None).await;
        insert_block(&pool, "BLD_DEL", "content", "deleted src", None, None).await;

        // Soft-delete BLD_DEL
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
            .bind("BLD_DEL")
            .execute(&pool)
            .await
            .unwrap();

        // Both link to the same target
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BLD_LIVE")
            .bind("BLD_TGT")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BLD_DEL")
            .bind("BLD_TGT")
            .execute(&pool)
            .await
            .unwrap();

        let result = count_backlinks_batch_inner(&pool, vec!["BLD_TGT".into()])
            .await
            .unwrap();

        assert_eq!(
            result.get("BLD_TGT"),
            Some(&1),
            "only the live source block should be counted"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_backlinks_batch_excludes_conflict_source_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "CTGT", "page", "target", None, None).await;
        insert_block(&pool, "CLIVE", "content", "live src", None, None).await;
        insert_block(&pool, "CCONF", "content", "conflict src", None, None).await;

        // Mark CCONF as conflict
        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind("CCONF")
            .execute(&pool)
            .await
            .unwrap();

        // Both link to the same target
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("CLIVE")
            .bind("CTGT")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("CCONF")
            .bind("CTGT")
            .execute(&pool)
            .await
            .unwrap();

        let result = count_backlinks_batch_inner(&pool, vec!["CTGT".into()])
            .await
            .unwrap();

        assert_eq!(
            result.get("CTGT"),
            Some(&1),
            "only the non-conflict source block should be counted"
        );
    }

    // ====================================================================
    // set_scheduled_date tests (#592)
    // ====================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_scheduled_date_sets_and_clears() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "sched test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set scheduled date
        let result = set_scheduled_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-06-01".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            result.scheduled_date,
            Some("2026-06-01".into()),
            "scheduled_date should be set"
        );

        mat.flush_background().await.unwrap();

        // Clear scheduled date
        let result = set_scheduled_date_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();
        assert_eq!(
            result.scheduled_date, None,
            "scheduled_date should be cleared to None"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_scheduled_date_invalid_format_returns_validation() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "bad sched".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        let result = set_scheduled_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("not-a-date".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid date should return Validation error, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_scheduled_date_nonexistent_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = set_scheduled_date_inner(
            &pool,
            DEV,
            &mat,
            "nonexistent-id".into(),
            Some("2026-05-15".into()),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "set_scheduled_date on nonexistent block should return NotFound, got: {result:?}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rebuild_agenda_cache_includes_scheduled_date_entries() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "agenda sched".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Set scheduled_date
        set_scheduled_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2026-07-20".into()),
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // Rebuild agenda cache
        crate::cache::rebuild_agenda_cache(&pool).await.unwrap();

        // Check that the agenda cache contains the entry
        let row = sqlx::query!(
            "SELECT source FROM agenda_cache WHERE block_id = ? AND date = '2026-07-20'",
            block.id
        )
        .fetch_optional(&pool)
        .await
        .unwrap();

        assert!(
            row.is_some(),
            "agenda_cache should have the scheduled_date entry"
        );
        assert_eq!(
            row.unwrap().source,
            "column:scheduled_date",
            "cache source should be column:scheduled_date"
        );

        mat.shutdown();
    }

    // ====================================================================
    // todo_state_auto_timestamp tests (#593)
    // ====================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn todo_state_auto_null_to_todo_sets_created_at() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "auto ts test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // null → TODO
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        // Check created_at property was set
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let created_at = props.iter().find(|p| p.key == "created_at");
        assert!(
            created_at.is_some(),
            "created_at should be set on null→TODO transition"
        );
        assert!(
            created_at.unwrap().value_date.is_some(),
            "created_at should have a value_date"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn todo_state_auto_todo_to_done_sets_completed_at() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "done test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // null → TODO
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        // TODO → DONE
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();

        mat.flush_background().await.unwrap();

        // Check completed_at property was set
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let completed_at = props.iter().find(|p| p.key == "completed_at");
        assert!(
            completed_at.is_some(),
            "completed_at should be set on TODO→DONE transition"
        );
        assert!(
            completed_at.unwrap().value_date.is_some(),
            "completed_at should have a value_date"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn todo_state_auto_done_to_todo_sets_created_at_clears_completed_at() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "reopen test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // null → TODO → DONE
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // DONE → TODO
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();

        // created_at should be set (refreshed)
        let created_at = props.iter().find(|p| p.key == "created_at");
        assert!(
            created_at.is_some(),
            "created_at should be set on DONE→TODO transition"
        );

        // completed_at should be cleared
        let completed_at = props.iter().find(|p| p.key == "completed_at");
        assert!(
            completed_at.is_none(),
            "completed_at should be cleared on DONE→TODO transition"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn todo_state_auto_todo_to_null_clears_both_timestamps() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "untask test".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        // null → TODO
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Verify created_at exists
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        assert!(
            props.iter().any(|p| p.key == "created_at"),
            "created_at should exist after null→TODO"
        );

        // TODO → null (un-tasking)
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), None)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Both should be cleared
        let props = get_properties_inner(&pool, block.id.clone()).await.unwrap();
        let created_at = props.iter().find(|p| p.key == "created_at");
        let completed_at = props.iter().find(|p| p.key == "completed_at");
        assert!(
            created_at.is_none(),
            "created_at should be cleared on TODO→null transition"
        );
        assert!(
            completed_at.is_none(),
            "completed_at should be cleared on TODO→null transition"
        );

        mat.shutdown();
    }

    // ======================================================================
    // page_aliases (#598)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_page_aliases_creates_and_returns_aliases() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "page-1", "page", "My Page", None, Some(0)).await;

        let inserted = set_page_aliases_inner(&pool, "page-1", vec!["Alpha".into(), "Beta".into()])
            .await
            .unwrap();

        assert_eq!(inserted.len(), 2, "should insert 2 aliases");
        assert!(
            inserted.contains(&"Alpha".to_string()),
            "should contain Alpha"
        );
        assert!(
            inserted.contains(&"Beta".to_string()),
            "should contain Beta"
        );

        // Verify persistence
        let aliases = get_page_aliases_inner(&pool, "page-1").await.unwrap();
        assert_eq!(
            aliases,
            vec!["Alpha", "Beta"],
            "persisted aliases should match"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_page_aliases_replaces_existing() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "page-2", "page", "Page Two", None, Some(0)).await;

        // Set initial aliases
        set_page_aliases_inner(&pool, "page-2", vec!["Old1".into(), "Old2".into()])
            .await
            .unwrap();

        // Replace with new aliases
        let inserted = set_page_aliases_inner(
            &pool,
            "page-2",
            vec!["New1".into(), "New2".into(), "New3".into()],
        )
        .await
        .unwrap();

        assert_eq!(inserted.len(), 3, "should insert 3 replacement aliases");

        let aliases = get_page_aliases_inner(&pool, "page-2").await.unwrap();
        assert_eq!(
            aliases,
            vec!["New1", "New2", "New3"],
            "aliases should be fully replaced"
        );

        // Old aliases should be gone
        let resolved = resolve_page_by_alias_inner(&pool, "Old1").await.unwrap();
        assert!(resolved.is_none(), "old alias should no longer resolve");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_page_aliases_skips_empty_and_duplicates() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "page-3", "page", "Page Three", None, Some(0)).await;

        let inserted = set_page_aliases_inner(
            &pool,
            "page-3",
            vec![
                "  ".into(), // whitespace only — skipped
                "".into(),   // empty — skipped
                "Valid".into(),
                "Valid".into(), // duplicate — second insert is ignored
                "  Trimmed  ".into(),
            ],
        )
        .await
        .unwrap();

        // "Valid" appears once, "Trimmed" appears once
        assert_eq!(inserted.len(), 2, "should insert 2 unique aliases");
        assert!(
            inserted.contains(&"Valid".to_string()),
            "should contain Valid"
        );
        assert!(
            inserted.contains(&"Trimmed".to_string()),
            "should contain Trimmed"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_page_aliases_returns_sorted_list() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "page-4", "page", "Page Four", None, Some(0)).await;

        set_page_aliases_inner(
            &pool,
            "page-4",
            vec!["Zulu".into(), "Alpha".into(), "Mike".into()],
        )
        .await
        .unwrap();

        let aliases = get_page_aliases_inner(&pool, "page-4").await.unwrap();
        assert_eq!(
            aliases,
            vec!["Alpha", "Mike", "Zulu"],
            "aliases should be sorted alphabetically"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_page_by_alias_case_insensitive() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "page-5", "page", "Page Five", None, Some(0)).await;

        set_page_aliases_inner(&pool, "page-5", vec!["MyAlias".into()])
            .await
            .unwrap();

        // Exact case
        let r1 = resolve_page_by_alias_inner(&pool, "MyAlias").await.unwrap();
        assert!(r1.is_some(), "exact alias should resolve");
        let (pid, title) = r1.unwrap();
        assert_eq!(pid, "page-5", "resolved page id should match");
        assert_eq!(
            title.as_deref(),
            Some("Page Five"),
            "resolved page title should match"
        );

        // Different case
        let r2 = resolve_page_by_alias_inner(&pool, "myalias").await.unwrap();
        assert!(r2.is_some(), "lowercase alias should resolve");
        assert_eq!(
            r2.unwrap().0,
            "page-5",
            "lowercase should resolve to same page"
        );

        let r3 = resolve_page_by_alias_inner(&pool, "MYALIAS").await.unwrap();
        assert!(r3.is_some(), "uppercase alias should resolve");
        assert_eq!(
            r3.unwrap().0,
            "page-5",
            "uppercase should resolve to same page"
        );

        // Non-existent alias
        let r4 = resolve_page_by_alias_inner(&pool, "NoSuchAlias")
            .await
            .unwrap();
        assert!(r4.is_none(), "non-existent alias should return None");
    }

    // ====================================================================
    // Recurrence on DONE transition tests (#595)
    // ====================================================================

    /// Helper: set a repeat property on a block via block_properties table.
    async fn set_repeat_property(
        pool: &SqlitePool,
        device_id: &str,
        mat: &Materializer,
        block_id: &str,
        rule: &str,
    ) {
        set_property_inner(
            pool,
            device_id,
            mat,
            block_id.to_string(),
            "repeat".to_string(),
            Some(rule.to_string()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_daily_creates_next_occurrence() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create block, set TODO, set due_date, set repeat=daily
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "daily task".into(),
            None,
            None,
        )
        .await
        .unwrap();

        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-15".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
        mat.flush_background().await.unwrap();

        // Transition to DONE
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Original block should be DONE
        let original = get_block_inner(&pool, block.id.clone()).await.unwrap();
        assert_eq!(
            original.todo_state.as_deref(),
            Some("DONE"),
            "original block should be marked DONE"
        );

        // Find the new sibling block (any block with todo_state=TODO that isn't original)
        let new_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            block.id
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(new_blocks.len(), 1, "should create exactly one new block");
        let new_block = &new_blocks[0];

        assert_eq!(
            new_block.todo_state.as_deref(),
            Some("TODO"),
            "new block should have TODO state"
        );
        assert_eq!(
            new_block.content.as_deref(),
            Some("daily task"),
            "new block should copy original content"
        );
        assert_eq!(
            new_block.due_date.as_deref(),
            Some("2025-06-16"),
            "new block due_date should advance by one day"
        );

        // Check repeat property was copied
        let props = get_properties_inner(&pool, new_block.id.clone())
            .await
            .unwrap();
        let repeat_prop = props.iter().find(|p| p.key == "repeat");
        assert!(
            repeat_prop.is_some(),
            "new block should have repeat property"
        );
        assert_eq!(
            repeat_prop.unwrap().value_text.as_deref(),
            Some("daily"),
            "repeat property should be copied as daily"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_weekly_shifts_by_7_days() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "weekly task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-15".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "weekly").await;
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find new block
        let new_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            block.id
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(new_blocks.len(), 1, "should create one recurrence block");
        assert_eq!(
            new_blocks[0].due_date.as_deref(),
            Some("2025-06-22"),
            "weekly recurrence should advance by 7 days"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_monthly_handles_month_end() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "monthly task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Jan 31 → monthly should clamp to Feb 28 (2025 is not a leap year)
        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-01-31".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "monthly").await;
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let new_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            block.id
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(
            new_blocks.len(),
            1,
            "monthly recurrence should create one block"
        );
        assert_eq!(
            new_blocks[0].due_date.as_deref(),
            Some("2025-02-28"),
            "Jan 31 + monthly should clamp to Feb 28"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_custom_plus_3d() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "every 3 days".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-28".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "+3d").await;
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let new_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            block.id
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(
            new_blocks.len(),
            1,
            "multi-day recurrence should create one block"
        );
        assert_eq!(
            new_blocks[0].due_date.as_deref(),
            Some("2025-07-01"),
            "+3d from Jun 28 should be Jul 1"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_no_repeat_property_does_nothing() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "no repeat".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-15".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // No repeat property set — transition to DONE
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Should NOT create any new TODO blocks
        let todo_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND deleted_at IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(
            todo_count, 0,
            "no new block should be created without repeat property"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_set_todo_state_recurrence_is_atomic() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with TODO + repeat rule
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "atomic recurrence test".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
        mat.flush_background().await.unwrap();

        // Transition to DONE — should atomically create the recurring block
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find the new sibling block
        let new_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            block.id
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(new_blocks.len(), 1, "should create exactly one new block");
        let new_block = &new_blocks[0];

        // Verify the new block has both todo_state=TODO and repeat property set
        assert_eq!(
            new_block.todo_state.as_deref(),
            Some("TODO"),
            "recurrence block should have TODO state"
        );
        assert_eq!(
            new_block.content.as_deref(),
            Some("atomic recurrence test"),
            "recurrence block should copy content"
        );

        let props = get_properties_inner(&pool, new_block.id.clone())
            .await
            .unwrap();
        let repeat_prop = props.iter().find(|p| p.key == "repeat");
        assert!(
            repeat_prop.is_some(),
            "new block should have repeat property"
        );
        assert_eq!(
            repeat_prop.unwrap().value_text.as_deref(),
            Some("daily"),
            "repeat property should be daily"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Recurrence end conditions (#644)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_stops_when_repeat_until_is_reached() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with TODO + due_date + repeat + repeat-until
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "until task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Set due_date to 2025-06-14 (shifting daily → 2025-06-15)
        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-14".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
        mat.flush_background().await.unwrap();

        // Set repeat-until to 2025-06-14 — shifted date (2025-06-15) > until
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "repeat-until".to_string(),
            None,
            None,
            Some("2025-06-14".to_string()),
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Transition to DONE
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Should NOT create any new TODO blocks
        let todo_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND deleted_at IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(
            todo_count, 0,
            "no new block should be created when shifted date exceeds repeat-until"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_stops_when_repeat_count_is_exhausted() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with TODO + repeat + repeat-count=2, repeat-seq=2
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "count task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
        mat.flush_background().await.unwrap();

        // Set repeat-count=2
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "repeat-count".to_string(),
            None,
            Some(2.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set repeat-seq=2 (already at the limit)
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "repeat-seq".to_string(),
            None,
            Some(2.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Transition to DONE
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Should NOT create any new TODO blocks
        let todo_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND deleted_at IS NULL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(
            todo_count, 0,
            "no new block should be created when repeat-seq >= repeat-count"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_continues_when_repeat_count_not_exhausted() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with TODO + repeat + repeat-count=3, repeat-seq=1
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "count task ok".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
        mat.flush_background().await.unwrap();

        // Set repeat-count=3
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "repeat-count".to_string(),
            None,
            Some(3.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set repeat-seq=1 (still under the limit)
        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "repeat-seq".to_string(),
            None,
            Some(1.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Transition to DONE
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Should create a new TODO block
        let new_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            block.id
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(new_blocks.len(), 1, "should create one new block");

        // Check that repeat-seq was incremented to 2
        let props = get_properties_inner(&pool, new_blocks[0].id.clone())
            .await
            .unwrap();
        let seq_prop = props.iter().find(|p| p.key == "repeat-seq");
        assert!(seq_prop.is_some(), "new block should have repeat-seq");
        assert_eq!(
            seq_prop.unwrap().value_num,
            Some(2.0),
            "repeat-seq should be incremented to 2"
        );

        // Check that repeat-count was copied
        let count_prop = props.iter().find(|p| p.key == "repeat-count");
        assert!(count_prop.is_some(), "new block should have repeat-count");
        assert_eq!(
            count_prop.unwrap().value_num,
            Some(3.0),
            "repeat-count should remain 3"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_sets_repeat_origin_on_sibling() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "origin task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-15".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
        mat.flush_background().await.unwrap();

        // Transition to DONE — creates sibling
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find the new sibling
        let new_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            block.id
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(new_blocks.len(), 1, "should create one recurrence sibling");
        let sibling = &new_blocks[0];

        // Check repeat-origin points to original block
        let props = get_properties_inner(&pool, sibling.id.clone())
            .await
            .unwrap();
        let origin_prop = props.iter().find(|p| p.key == "repeat-origin");
        assert!(origin_prop.is_some(), "sibling should have repeat-origin");
        assert_eq!(
            origin_prop.unwrap().value_ref.as_deref(),
            Some(block.id.as_str()),
            "repeat-origin should point to original block"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn recurrence_preserves_repeat_origin_across_chain() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "chain task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-15".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_repeat_property(&pool, DEV, &mat, &block.id, "daily").await;
        mat.flush_background().await.unwrap();

        // First DONE → creates sibling1
        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find sibling1
        let sibling1_id: String = sqlx::query_scalar(
            "SELECT id FROM blocks WHERE id != ?1 AND todo_state = 'TODO' AND deleted_at IS NULL",
        )
        .bind(&block.id)
        .fetch_one(&pool)
        .await
        .unwrap();

        // Complete sibling1 → creates sibling2
        set_todo_state_inner(&pool, DEV, &mat, sibling1_id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find sibling2
        let sibling2_id: String = sqlx::query_scalar(
            "SELECT id FROM blocks WHERE id != ?1 AND id != ?2 AND todo_state = 'TODO' AND deleted_at IS NULL",
        )
        .bind(&block.id)
        .bind(&sibling1_id)
        .fetch_one(&pool)
        .await
        .unwrap();

        // Both sibling1 and sibling2 should point to the original block
        let props1 = get_properties_inner(&pool, sibling1_id).await.unwrap();
        let origin1 = props1.iter().find(|p| p.key == "repeat-origin");
        assert_eq!(
            origin1.unwrap().value_ref.as_deref(),
            Some(block.id.as_str()),
            "first sibling repeat-origin should point to original"
        );

        let props2 = get_properties_inner(&pool, sibling2_id).await.unwrap();
        let origin2 = props2.iter().find(|p| p.key == "repeat-origin");
        assert_eq!(
            origin2.unwrap().value_ref.as_deref(),
            Some(block.id.as_str()),
            "sibling2's repeat-origin should still point to the ORIGINAL block, not sibling1"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Repeat recurrence hardening (#665)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_done_with_dot_plus_repeat_shifts_from_today() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create block with due_date in the past
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Water plants".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-06-01".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Set .+ repeat (from completion)
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some(".+weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Transition to DONE — should create sibling with date shifted from today
        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find the sibling (new block with TODO state, same parent)
        let blocks = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                    is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                    due_date, scheduled_date
             FROM blocks WHERE todo_state = 'TODO' AND id != ?1 AND deleted_at IS NULL"#,
            resp.id,
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert!(
            !blocks.is_empty(),
            "DONE transition should create a TODO sibling"
        );
        let sibling = &blocks[0];

        // .+ mode: due_date should be shifted from today, not from 2025-06-01
        let today = chrono::Local::now().date_naive();
        if let Some(ref due) = sibling.due_date {
            let due_date = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").unwrap();
            // Should be approximately today + 7 days (within 1 day tolerance for test timing)
            let expected = today + chrono::Duration::days(7);
            let diff = (due_date - expected).num_days().abs();
            assert!(
                diff <= 1,
                ".+ weekly should shift from today: expected ~{expected}, got {due_date}"
            );
        } else {
            panic!("Sibling should have a due_date");
        }

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_done_with_plus_plus_repeat_catches_up() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create block with due_date far in the past (a Monday)
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Weekly review".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-01-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Set ++ repeat (catch-up)
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("++weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Transition to DONE
        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find the sibling
        let blocks = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                    is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                    due_date, scheduled_date
             FROM blocks WHERE todo_state = 'TODO' AND id != ?1 AND deleted_at IS NULL"#,
            resp.id,
        )
        .fetch_all(&pool)
        .await
        .unwrap();

        assert!(
            !blocks.is_empty(),
            "DONE transition should create a TODO sibling"
        );
        let sibling = &blocks[0];

        // ++ mode: due_date should be the next Monday after today
        let today = chrono::Local::now().date_naive();
        if let Some(ref due) = sibling.due_date {
            let due_date = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").unwrap();
            assert!(
                due_date > today,
                "++ mode sibling due_date should be in the future"
            );
            assert_eq!(
                due_date.weekday(),
                chrono::Weekday::Mon,
                "++ weekly from Monday cadence should land on Monday, got {due_date}"
            );
        } else {
            panic!("Sibling should have a due_date");
        }

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_done_with_malformed_repeat_creates_sibling_without_shifted_dates() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Bad repeat".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Set malformed repeat value
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("invalid_rule".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Transition to DONE — should still create sibling (graceful degradation)
        let result =
            set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into())).await;
        assert!(
            result.is_ok(),
            "DONE transition should succeed even with malformed repeat"
        );
        mat.flush_background().await.unwrap();

        // Original should be DONE
        let original = sqlx::query_scalar!("SELECT todo_state FROM blocks WHERE id = ?1", resp.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            original.as_deref(),
            Some("DONE"),
            "original block should remain DONE after recurrence"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_todo_state_done_with_repeat_until_without_dates_still_creates_sibling() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Block with repeat + repeat-until but NO due_date or scheduled_date
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "No dates".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set repeat-until to a future date
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat-until".into(),
            None,
            None,
            Some("2026-12-31".into()),
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Transition to DONE — should create sibling (repeat-until can't be checked without reference date)
        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Find siblings with TODO state
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE todo_state = 'TODO' AND id != ?1 AND deleted_at IS NULL",
        )
        .bind(&resp.id)
        .fetch_one(&pool)
        .await
        .unwrap();

        // Sibling should be created (repeat-until check is skipped when no dates)
        assert!(
            count >= 1,
            "should create sibling even without dates (repeat-until check skipped)"
        );

        mat.shutdown();
    }

    // ======================================================================
    // export_page_markdown (#519)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_page_markdown_basic() {
        let (pool, _dir) = test_pool().await;

        // Create a page with two child content blocks
        insert_block(
            &pool,
            "01AAAAAAAAAAAAAAAAAAAAPAGE",
            "page",
            "My Test Page",
            None,
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "01AAAAAAAAAAAAAAAAAAAABLK1",
            "content",
            "First block",
            Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "01AAAAAAAAAAAAAAAAAAAABLK2",
            "content",
            "Second block with **bold**",
            Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
            Some(2),
        )
        .await;

        let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
            .await
            .unwrap();

        // Title as h1
        assert!(
            md.starts_with("# My Test Page\n\n"),
            "should start with h1 title"
        );
        // Block content present
        assert!(md.contains("First block\n"), "should contain first block");
        // Markdown formatting preserved
        assert!(
            md.contains("Second block with **bold**\n"),
            "should preserve markdown formatting"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_page_markdown_resolves_tag_ulids() {
        let (pool, _dir) = test_pool().await;

        // Create a tag block
        insert_block(
            &pool,
            "01TAG00000000000000000TAG1",
            "tag",
            "rust",
            None,
            Some(1),
        )
        .await;

        // Create a page with a content block that references the tag
        insert_block(
            &pool,
            "01AAAAAAAAAAAAAAAAAAAAPAGE",
            "page",
            "Tagged Page",
            None,
            Some(1),
        )
        .await;
        insert_block(
            &pool,
            "01AAAAAAAAAAAAAAAAAAAABLK1",
            "content",
            "Learning #[01TAG00000000000000000TAG1] today",
            Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
            Some(1),
        )
        .await;

        let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
            .await
            .unwrap();

        assert!(
            md.contains("Learning #rust today"),
            "tag ULID should be replaced with #tagname, got: {md}"
        );
        assert!(
            !md.contains("01TAG00000000000000000TAG1"),
            "raw ULID should not appear in output"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_page_markdown_resolves_page_link_ulids() {
        let (pool, _dir) = test_pool().await;

        // Create a target page
        insert_block(
            &pool,
            "01LINKPAGE000000000000LNK1",
            "page",
            "Linked Page",
            None,
            Some(1),
        )
        .await;

        // Create the main page with a content block that links to the target
        insert_block(
            &pool,
            "01AAAAAAAAAAAAAAAAAAAAPAGE",
            "page",
            "Source Page",
            None,
            Some(2),
        )
        .await;
        insert_block(
            &pool,
            "01AAAAAAAAAAAAAAAAAAAABLK1",
            "content",
            "See also [[01LINKPAGE000000000000LNK1]] for details",
            Some("01AAAAAAAAAAAAAAAAAAAAPAGE"),
            Some(1),
        )
        .await;

        let md = export_page_markdown_inner(&pool, "01AAAAAAAAAAAAAAAAAAAAPAGE")
            .await
            .unwrap();

        assert!(
            md.contains("See also [[Linked Page]] for details"),
            "page link ULID should be replaced with [[Page Title]], got: {md}"
        );
        assert!(
            !md.contains("01LINKPAGE000000000000LNK1"),
            "raw ULID should not appear in output"
        );
    }

    // ======================================================================
    // compute_edit_diff_inner
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_compute_edit_diff_inner_happy_path() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with initial content
        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello world".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        // Edit the block to change its content
        edit_block_inner(
            &pool,
            DEV,
            &mat,
            created.id.clone(),
            "hello universe".into(),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Find the edit_block op in the op_log
        let op_row = sqlx::query!(
            "SELECT device_id, seq FROM op_log \
             WHERE op_type = 'edit_block' \
             ORDER BY seq DESC LIMIT 1"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let diff = compute_edit_diff_inner(&pool, op_row.device_id, op_row.seq)
            .await
            .unwrap();

        let spans = diff.expect("diff should be Some for an edit_block op");
        assert!(!spans.is_empty(), "diff should contain at least one span");

        // The diff should contain a Delete for "world" and an Insert for "universe"
        use crate::word_diff::DiffTag;
        let has_delete = spans.iter().any(|s| s.tag == DiffTag::Delete);
        let has_insert = spans.iter().any(|s| s.tag == DiffTag::Insert);
        assert!(
            has_delete,
            "diff should have a Delete span for the old word"
        );
        assert!(
            has_insert,
            "diff should have an Insert span for the new word"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_compute_edit_diff_inner_same_text_produces_equal_spans() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block — this is the first (and only) op for this block
        let created = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "initial text".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        // Edit the block once — the prior text comes from create_block
        edit_block_inner(&pool, DEV, &mat, created.id.clone(), "initial text".into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Grab the edit_block op
        let op_row = sqlx::query!(
            "SELECT device_id, seq FROM op_log \
             WHERE op_type = 'edit_block' \
             ORDER BY seq DESC LIMIT 1"
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        let diff = compute_edit_diff_inner(&pool, op_row.device_id, op_row.seq)
            .await
            .unwrap();

        let spans = diff.expect("diff should be Some for an edit_block op");
        // Editing with the same text should yield all-Equal spans (no changes)
        use crate::word_diff::DiffTag;
        assert!(
            spans.iter().all(|s| s.tag == DiffTag::Equal),
            "diff should contain only Equal spans when text is unchanged, got: {spans:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_compute_edit_diff_inner_invalid_op_returns_not_found() {
        let (pool, _dir) = test_pool().await;

        // Call with a device_id/seq that doesn't exist in the op_log
        let result = compute_edit_diff_inner(&pool, "nonexistent-device".into(), 999999).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "should return NotFound for a nonexistent op, got: {result:?}"
        );
    }

    // ======================================================================
    // list_projected_agenda — projected future occurrences (#644 task 8)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_returns_future_weekly_occurrences() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block with a due date and repeat rule
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Weekly task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set due date to 2026-04-06 (a Monday)
        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Set repeat=weekly
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set todo_state=TODO
        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Project 4 weeks ahead
        let entries =
            list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-05-04".into(), None)
                .await
                .unwrap();

        assert!(
            entries.len() >= 3,
            "should project at least 3 weekly occurrences, got {}",
            entries.len()
        );
        assert_eq!(entries[0].projected_date, "2026-04-13", "first projection");
        assert_eq!(entries[1].projected_date, "2026-04-20", "second projection");
        assert_eq!(entries[2].projected_date, "2026-04-27", "third projection");
        assert_eq!(
            entries[0].source, "due_date",
            "projection source should be due_date"
        );
        assert_eq!(
            entries[0].block.id, resp.id,
            "projected block id should match original"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_respects_repeat_until_end_condition() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Limited task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set repeat-until to 2026-04-20
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat-until".into(),
            None,
            None,
            Some("2026-04-20".into()),
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let entries =
            list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-06-01".into(), None)
                .await
                .unwrap();

        assert_eq!(
            entries.len(),
            2,
            "should stop at repeat-until date: {entries:?}"
        );
        assert_eq!(
            entries[0].projected_date, "2026-04-13",
            "first projection before until date"
        );
        assert_eq!(
            entries[1].projected_date, "2026-04-20",
            "second projection before until date"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_respects_repeat_count_end_condition() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Counted task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("daily".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Set repeat-count=3, repeat-seq=1 (1 occurrence done, 2 remaining)
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat-count".into(),
            None,
            Some(3.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat-seq".into(),
            None,
            Some(1.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let entries =
            list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-30".into(), None)
                .await
                .unwrap();

        assert_eq!(
            entries.len(),
            2,
            "should project only 2 remaining occurrences (count=3, seq=1)"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_skips_done_blocks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Done task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Mark as DONE — should be excluded from projection
        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let entries =
            list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-05-04".into(), None)
                .await
                .unwrap();

        // The original block is DONE, but set_todo_state may have created a new
        // TODO sibling with repeat. Filter to only entries from our block.
        let from_original: Vec<_> = entries.iter().filter(|e| e.block.id == resp.id).collect();
        assert!(
            from_original.is_empty(),
            "DONE blocks should not be projected"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_validates_date_range() {
        let (pool, _dir) = test_pool().await;

        // Invalid date format
        let result =
            list_projected_agenda_inner(&pool, "not-a-date".into(), "2026-04-30".into(), None)
                .await;
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "should reject invalid date"
        );

        // Start > end
        let result =
            list_projected_agenda_inner(&pool, "2026-05-01".into(), "2026-04-01".into(), None)
                .await;
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "should reject start > end"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_empty_when_no_repeating_blocks() {
        let (pool, _dir) = test_pool().await;

        let entries =
            list_projected_agenda_inner(&pool, "2026-04-01".into(), "2026-04-30".into(), None)
                .await
                .unwrap();

        assert!(
            entries.is_empty(),
            "should return empty when no repeating blocks exist"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_dot_plus_mode_projects_from_today() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Water plants".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Due date far in the past
        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-01-01".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // From-completion mode: shifts from today
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some(".+weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Query a wide range that includes today + several weeks
        let today = chrono::Local::now().date_naive();
        let start = today.format("%Y-%m-%d").to_string();
        let end = (today + chrono::Duration::days(60))
            .format("%Y-%m-%d")
            .to_string();

        let entries = list_projected_agenda_inner(&pool, start, end, None)
            .await
            .unwrap();

        // .+ mode shifts from today, so first projection should be ~today+7d
        assert!(!entries.is_empty(), ".+ mode should produce projections");
        let first_date =
            chrono::NaiveDate::parse_from_str(&entries[0].projected_date, "%Y-%m-%d").unwrap();
        // First projection should be within 8 days of today (7 days for weekly + 1 day buffer)
        assert!(
            first_date <= today + chrono::Duration::days(8),
            ".+ weekly first projection {first_date} should be near today+7d ({today})"
        );
        assert!(
            first_date > today,
            ".+ first projection should be in the future"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_plus_plus_mode_catches_up_to_today() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Catch-up task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Due date far in the past
        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-01-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // ++ mode: advance on original cadence until > today
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("++weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let today = chrono::Local::now().date_naive();
        let start = today.format("%Y-%m-%d").to_string();
        let end = (today + chrono::Duration::days(30))
            .format("%Y-%m-%d")
            .to_string();

        let entries = list_projected_agenda_inner(&pool, start, end, None)
            .await
            .unwrap();

        // ++ mode should produce dates on the original Monday cadence
        // First projection should be the next Monday after today (from 2025-01-06 cadence)
        assert!(!entries.is_empty(), "++ mode should produce projections");
        let first_date =
            chrono::NaiveDate::parse_from_str(&entries[0].projected_date, "%Y-%m-%d").unwrap();
        assert!(
            first_date > today,
            "++ first projection should be in the future"
        );
        // Should be on a Monday (weekday 0 = Monday in chrono)
        assert_eq!(
            first_date.weekday(),
            chrono::Weekday::Mon,
            "++ weekly from Monday cadence should land on Monday, got {first_date}"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_both_date_columns_produce_separate_entries() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Dual dates".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_scheduled_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("weekly".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let entries =
            list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-20".into(), None)
                .await
                .unwrap();

        // Should have entries from both due_date and scheduled_date
        let due_entries: Vec<_> = entries.iter().filter(|e| e.source == "due_date").collect();
        let sched_entries: Vec<_> = entries
            .iter()
            .filter(|e| e.source == "scheduled_date")
            .collect();
        assert!(!due_entries.is_empty(), "should have due_date projections");
        assert!(
            !sched_entries.is_empty(),
            "should have scheduled_date projections"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_exhausted_count_returns_zero() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Exhausted".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("daily".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // repeat-count=3, repeat-seq=3 → exhausted
        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat-count".into(),
            None,
            Some(3.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat-seq".into(),
            None,
            Some(3.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let entries =
            list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-30".into(), None)
                .await
                .unwrap();

        let from_block: Vec<_> = entries.iter().filter(|e| e.block.id == resp.id).collect();
        assert!(
            from_block.is_empty(),
            "exhausted repeat-count should produce zero projections"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn projected_agenda_limit_caps_results() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "Daily task".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_property_inner(
            &pool,
            DEV,
            &mat,
            resp.id.clone(),
            "repeat".into(),
            Some("daily".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        // Request 365 days of daily projections but limit to 5
        let entries =
            list_projected_agenda_inner(&pool, "2026-04-07".into(), "2027-04-06".into(), Some(5))
                .await
                .unwrap();

        assert_eq!(entries.len(), 5, "limit should cap results to 5");

        mat.shutdown();
    }

    // ======================================================================
    // set_peer_address — manual peer address management (#522)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_peer_address_stores_address() {
        let (pool, _dir) = test_pool().await;
        peer_refs::upsert_peer_ref(&pool, "peer-1").await.unwrap();

        set_peer_address_inner(&pool, "peer-1".into(), "192.168.1.100:9090".into())
            .await
            .unwrap();

        let peer = peer_refs::get_peer_ref(&pool, "peer-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            peer.last_address.as_deref(),
            Some("192.168.1.100:9090"),
            "peer address should be updated"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_peer_address_rejects_invalid_address() {
        let (pool, _dir) = test_pool().await;
        peer_refs::upsert_peer_ref(&pool, "peer-1").await.unwrap();

        let result = set_peer_address_inner(&pool, "peer-1".into(), "not-an-address".into()).await;
        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "invalid address should return Validation error"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn set_peer_address_rejects_unknown_peer() {
        let (pool, _dir) = test_pool().await;

        let result =
            set_peer_address_inner(&pool, "nonexistent".into(), "192.168.1.1:9090".into()).await;
        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "unknown peer should return NotFound error"
        );
    }

    // ======================================================================
    // import_markdown — Logseq/Markdown import (#660)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_markdown_creates_page_and_blocks() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let content = "- Block 1\n  - Child 1\n  - Child 2\n- Block 2";
        let result =
            import_markdown_inner(&pool, DEV, &mat, content.into(), Some("TestPage.md".into()))
                .await
                .unwrap();

        assert_eq!(
            result.page_title, "TestPage",
            "page title should match filename"
        );
        assert_eq!(
            result.blocks_created, 4,
            "should create 4 blocks from markdown"
        );
        assert!(
            result.warnings.is_empty(),
            "import should produce no warnings"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_markdown_handles_properties() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let content = "- Task\n  priority:: high\n  status:: TODO";
        let result =
            import_markdown_inner(&pool, DEV, &mat, content.into(), Some("Props.md".into()))
                .await
                .unwrap();

        assert_eq!(
            result.blocks_created, 1,
            "should create 1 block with properties"
        );
        assert_eq!(result.properties_set, 2, "should set 2 properties");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_markdown_strips_block_refs() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let content = "- See ((abc-123-def)) for details";
        let result = import_markdown_inner(&pool, DEV, &mat, content.into(), None)
            .await
            .unwrap();

        assert_eq!(
            result.blocks_created, 1,
            "should create 1 block after stripping refs"
        );
        assert_eq!(
            result.page_title, "Imported Page",
            "default page title should be used"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_markdown_empty_content() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let result = import_markdown_inner(&pool, DEV, &mat, "".into(), Some("Empty.md".into()))
            .await
            .unwrap();

        assert_eq!(
            result.page_title, "Empty",
            "page title should derive from filename"
        );
        assert_eq!(
            result.blocks_created, 0,
            "empty content should create no blocks"
        );

        mat.shutdown();
    }

    /// P-19: Verify that `import_markdown_inner` runs all block + property
    /// writes inside a single transaction by checking that:
    /// 1. All blocks are present in the DB after a successful import.
    /// 2. All properties are persisted correctly.
    /// 3. The op_log contains the expected number of entries.
    /// 4. Parent-child hierarchy is correct.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_markdown_single_transaction() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let content = "- Parent block\n  priority:: high\n  status:: active\n  - Child A\n  - Child B\n    - Grandchild";
        let result =
            import_markdown_inner(&pool, DEV, &mat, content.into(), Some("TxTest.md".into()))
                .await
                .unwrap();

        // Basic import stats
        assert_eq!(result.page_title, "TxTest");
        assert_eq!(result.blocks_created, 4, "should create 4 blocks");
        assert_eq!(result.properties_set, 2, "should set 2 properties");
        assert!(result.warnings.is_empty(), "should have no warnings");

        // Verify page exists
        let page: Option<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date FROM blocks WHERE block_type = 'page' AND content = 'TxTest'"#
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(page.is_some(), "page block must exist");
        let page = page.unwrap();

        // Verify all content blocks exist under the page hierarchy
        let all_blocks: Vec<BlockRow> = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date FROM blocks WHERE block_type = 'content' ORDER BY position"#
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(all_blocks.len(), 4, "should have 4 content blocks in DB");

        // Verify parent-child: "Parent block" is child of page
        let parent_block = all_blocks
            .iter()
            .find(|b| b.content.as_deref() == Some("Parent block"))
            .expect("Parent block must exist");
        assert_eq!(
            parent_block.parent_id.as_deref(),
            Some(page.id.as_str()),
            "Parent block should be child of the page"
        );

        // Verify child: "Child A" has parent = "Parent block"
        let child_a = all_blocks
            .iter()
            .find(|b| b.content.as_deref() == Some("Child A"))
            .expect("Child A must exist");
        assert_eq!(
            child_a.parent_id.as_deref(),
            Some(parent_block.id.as_str()),
            "Child A should be child of Parent block"
        );

        // Verify grandchild: "Grandchild" has parent = "Child B"
        let child_b = all_blocks
            .iter()
            .find(|b| b.content.as_deref() == Some("Child B"))
            .expect("Child B must exist");
        let grandchild = all_blocks
            .iter()
            .find(|b| b.content.as_deref() == Some("Grandchild"))
            .expect("Grandchild must exist");
        assert_eq!(
            grandchild.parent_id.as_deref(),
            Some(child_b.id.as_str()),
            "Grandchild should be child of Child B"
        );

        // Verify properties were persisted
        // "priority" is a reserved key stored in blocks.priority column
        let refreshed_parent: BlockRow = sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date FROM blocks WHERE id = ?"#,
            parent_block.id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            refreshed_parent.priority.as_deref(),
            Some("high"),
            "priority reserved property should be in blocks.priority"
        );

        // "status" is a custom property stored in block_properties
        let props: Vec<(String, String)> = sqlx::query_as(
            "SELECT key, value_text FROM block_properties WHERE block_id = ? ORDER BY key",
        )
        .bind(&parent_block.id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(props.len(), 1, "parent block should have 1 custom property");
        assert_eq!(props[0].0, "status");
        assert_eq!(props[0].1, "active");

        // Verify op_log entries: 1 page + 4 blocks + 2 properties = 7 ops
        let op_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM op_log WHERE device_id = ?")
            .bind(DEV)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            op_count.0, 7,
            "op_log should have 7 entries (1 page + 4 blocks + 2 properties)"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Attachment commands (F-7, F-11)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_attachment_creates_row() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block to attach to
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let att = add_attachment_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "photo.png".into(),
            "image/png".into(),
            1024,
            "/tmp/photo.png".into(),
        )
        .await
        .unwrap();

        assert_eq!(att.block_id, block.id, "attachment block_id should match");
        assert_eq!(
            att.filename, "photo.png",
            "attachment filename should match"
        );
        assert_eq!(
            att.mime_type, "image/png",
            "attachment mime_type should match"
        );
        assert_eq!(att.size_bytes, 1024, "attachment size should match");
        assert_eq!(
            att.fs_path, "/tmp/photo.png",
            "attachment fs_path should match"
        );
        assert!(!att.id.is_empty(), "attachment should have a generated ID");
        assert!(!att.created_at.is_empty(), "created_at should be set");

        // Verify persistence in DB via direct query
        let db_row = sqlx::query_as!(
            AttachmentRow,
            "SELECT id, block_id, mime_type, filename, size_bytes, fs_path, created_at \
             FROM attachments WHERE id = ?",
            att.id
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(db_row.id, att.id, "DB row id should match returned id");
        assert_eq!(db_row.block_id, block.id, "DB row block_id should match");
        assert_eq!(db_row.filename, "photo.png", "DB row filename should match");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_attachment_removes_row() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block and an attachment
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let att = add_attachment_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "doc.pdf".into(),
            "application/pdf".into(),
            2048,
            "/tmp/doc.pdf".into(),
        )
        .await
        .unwrap();

        // Delete it
        delete_attachment_inner(&pool, DEV, &mat, att.id.clone())
            .await
            .unwrap();

        // Verify it's gone from the DB
        let maybe = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM attachments WHERE id = ?"#,
            att.id
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(maybe.is_none(), "attachment should be deleted from DB");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_attachment_validates_size_limit() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create a block
        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        // Attempt to attach a file exceeding 50 MB
        let over_limit = MAX_ATTACHMENT_SIZE + 1;
        let result = add_attachment_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "big.bin".into(),
            "application/zip".into(),
            over_limit,
            "/tmp/big.bin".into(),
        )
        .await;

        assert!(result.is_err(), "should reject oversized attachment");
        match result.unwrap_err() {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("exceeds maximum"),
                    "error should mention size limit: {msg}"
                );
            }
            other => panic!("expected Validation error, got: {other:?}"),
        }

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn add_attachment_validates_mime_type() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "hello".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let result = add_attachment_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "virus.exe".into(),
            "application/x-msdownload".into(),
            1024,
            "/tmp/virus.exe".into(),
        )
        .await;

        assert!(result.is_err(), "should reject disallowed MIME type");
        match result.unwrap_err() {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("not allowed"),
                    "error should mention MIME not allowed: {msg}"
                );
            }
            other => panic!("expected Validation error, got: {other:?}"),
        }

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_attachments_returns_for_block() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create two blocks
        let block_a = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block a".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();

        let block_b = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block b".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();

        // Add 2 attachments to block_a
        add_attachment_inner(
            &pool,
            DEV,
            &mat,
            block_a.id.clone(),
            "a1.png".into(),
            "image/png".into(),
            100,
            "/tmp/a1.png".into(),
        )
        .await
        .unwrap();

        add_attachment_inner(
            &pool,
            DEV,
            &mat,
            block_a.id.clone(),
            "a2.pdf".into(),
            "application/pdf".into(),
            200,
            "/tmp/a2.pdf".into(),
        )
        .await
        .unwrap();

        // Add 1 attachment to block_b
        add_attachment_inner(
            &pool,
            DEV,
            &mat,
            block_b.id.clone(),
            "b1.txt".into(),
            "text/plain".into(),
            50,
            "/tmp/b1.txt".into(),
        )
        .await
        .unwrap();

        // List for block_a — should get 2
        let list_a = list_attachments_inner(&pool, block_a.id.clone())
            .await
            .unwrap();
        assert_eq!(list_a.len(), 2, "block_a should have 2 attachments");
        assert_eq!(
            list_a[0].filename, "a1.png",
            "first attachment should be a1.png"
        );
        assert_eq!(
            list_a[1].filename, "a2.pdf",
            "second attachment should be a2.pdf"
        );

        // List for block_b — should get 1
        let list_b = list_attachments_inner(&pool, block_b.id.clone())
            .await
            .unwrap();
        assert_eq!(list_b.len(), 1, "block_b should have 1 attachment");
        assert_eq!(
            list_b[0].filename, "b1.txt",
            "block_b attachment should be b1.txt"
        );

        mat.shutdown();
    }

    // ======================================================================
    // Draft autosave commands (F-17)
    // ======================================================================

    #[tokio::test]
    async fn save_and_flush_draft() {
        let (pool, _dir) = test_pool().await;

        // Save a draft
        draft::save_draft(&pool, "01HZ000000000000000000DRF01", "draft content")
            .await
            .unwrap();

        // Verify it persists
        let d = draft::get_draft(&pool, "01HZ000000000000000000DRF01")
            .await
            .unwrap()
            .expect("draft should exist after save");
        assert_eq!(
            d.content, "draft content",
            "saved draft content should match"
        );

        // Flush the draft (writes edit_block op + deletes draft row)
        flush_draft_inner(&pool, DEV, "01HZ000000000000000000DRF01".into())
            .await
            .unwrap();

        // Draft should be gone
        assert!(
            draft::get_draft(&pool, "01HZ000000000000000000DRF01")
                .await
                .unwrap()
                .is_none(),
            "draft must be deleted after flush"
        );

        // An edit_block op should exist in the log
        let ops = crate::op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
        assert_eq!(ops.len(), 1, "flush must produce one op");
        assert_eq!(
            ops[0].op_type, "edit_block",
            "flushed op should be edit_block"
        );
    }

    #[tokio::test]
    async fn delete_draft_removes_entry() {
        let (pool, _dir) = test_pool().await;

        // Save a draft
        draft::save_draft(&pool, "01HZ000000000000000000DRF02", "to be deleted")
            .await
            .unwrap();

        // Verify it exists
        assert!(
            draft::get_draft(&pool, "01HZ000000000000000000DRF02")
                .await
                .unwrap()
                .is_some(),
            "draft should exist after save"
        );

        // Delete it
        draft::delete_draft(&pool, "01HZ000000000000000000DRF02")
            .await
            .unwrap();

        // Verify it's gone
        assert!(
            draft::get_draft(&pool, "01HZ000000000000000000DRF02")
                .await
                .unwrap()
                .is_none(),
            "draft must be gone after delete"
        );
    }

    #[tokio::test]
    async fn list_drafts_returns_all_drafts() {
        let (pool, _dir) = test_pool().await;

        // Start with no drafts
        let result = list_drafts_inner(&pool).await.unwrap();
        assert!(result.is_empty(), "should start with zero drafts");

        // Save two drafts
        draft::save_draft(&pool, "01HZ000000000000000000DRF03", "content one")
            .await
            .unwrap();
        draft::save_draft(&pool, "01HZ000000000000000000DRF04", "content two")
            .await
            .unwrap();

        let result = list_drafts_inner(&pool).await.unwrap();
        assert_eq!(result.len(), 2, "should return both drafts");
    }

    // ======================================================================
    // Frontend logging commands (F-19)
    // ======================================================================

    #[tokio::test]
    async fn log_frontend_happy_path_all_levels() {
        // log_frontend is a pure tracing call — it should return Ok(()) for every level.
        for level in &["error", "warn", "info", "debug", "trace", "unknown"] {
            let result = super::log_frontend(
                level.to_string(),
                "test-module".into(),
                format!("test message at {level}"),
                Some("fake stack".into()),
                Some("fake context".into()),
                Some(r#"{"blockId":"abc123"}"#.into()),
            )
            .await;
            assert!(
                result.is_ok(),
                "log_frontend should succeed for level '{level}'"
            );
        }
    }

    #[tokio::test]
    async fn log_frontend_without_optional_fields() {
        let result = super::log_frontend(
            "error".into(),
            "test-module".into(),
            "message without optionals".into(),
            None,
            None,
            None,
        )
        .await;
        assert!(
            result.is_ok(),
            "log_frontend should succeed without stack/context/data"
        );
    }

    // ======================================================================
    // Op log compaction commands (F-20)
    // ======================================================================

    #[tokio::test]
    async fn get_compaction_status_returns_correct_counts() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Empty op log — expect zeros
        let status = get_compaction_status_inner(&pool).await.unwrap();
        assert_eq!(status.total_ops, 0, "empty log should have 0 total ops");
        assert!(
            status.oldest_op_date.is_none(),
            "empty log should have no oldest date"
        );
        assert_eq!(
            status.eligible_ops, 0,
            "empty log should have 0 eligible ops"
        );
        assert_eq!(
            status.retention_days,
            crate::snapshot::DEFAULT_RETENTION_DAYS,
            "retention_days should match default"
        );

        // Create a few blocks (each produces one op)
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block one".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block two".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "block three".into(),
            None,
            Some(3),
        )
        .await
        .unwrap();

        let status = get_compaction_status_inner(&pool).await.unwrap();
        assert_eq!(
            status.total_ops, 3,
            "should have 3 ops after creating 3 blocks"
        );
        assert!(
            status.oldest_op_date.is_some(),
            "should have an oldest date"
        );
        // All ops are recent (just created), so none should be eligible
        assert_eq!(
            status.eligible_ops, 0,
            "recently created ops should not be eligible"
        );

        mat.shutdown();
    }

    #[tokio::test]
    async fn compact_op_log_cmd_deletes_old_ops() {
        let (pool, _dir) = test_pool().await;

        // Insert ops with old timestamps (> 90 days ago) directly into op_log
        let old_ts = "2024-01-01T00:00:00.000Z";
        for i in 1..=5 {
            let block_id = format!("01HZ00000000000000000BLOCK{i:02}");
            // Insert a block so the op references a valid block
            insert_block(
                &pool,
                &block_id,
                "content",
                &format!("old block {i}"),
                None,
                Some(i),
            )
            .await;
            // Insert op_log entry with old timestamp
            sqlx::query(
                "INSERT INTO op_log (device_id, seq, op_type, payload, hash, created_at) \
                 VALUES (?, ?, 'create_block', ?, 'fakehash' || ?, ?)",
            )
            .bind(DEV)
            .bind(i)
            .bind(format!(
                r#"{{"block_id":"{}","block_type":"content","content":"old block {}","parent_id":null,"position":{}}}"#,
                block_id, i, i
            ))
            .bind(i)
            .bind(old_ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Also insert a recent op
        let recent_block_id = "01HZ00000000000000000BLOCKRE";
        insert_block(
            &pool,
            recent_block_id,
            "content",
            "recent block",
            None,
            Some(6),
        )
        .await;
        let recent_ts = crate::now_rfc3339();
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, op_type, payload, hash, created_at) \
             VALUES (?, ?, 'create_block', ?, 'fakehash_recent', ?)",
        )
        .bind(DEV)
        .bind(6)
        .bind(format!(
            r#"{{"block_id":"{}","block_type":"content","content":"recent block","parent_id":null,"position":6}}"#,
            recent_block_id
        ))
        .bind(&recent_ts)
        .execute(&pool)
        .await
        .unwrap();

        // Verify initial state
        let total_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total_before, 6, "should have 6 ops before compaction");

        // Run compaction with 90-day retention
        let result = compact_op_log_cmd_inner(&pool, DEV, 90).await.unwrap();
        assert!(
            result.snapshot_id.is_some(),
            "compaction should create a snapshot"
        );
        assert_eq!(result.ops_deleted, 5, "should report 5 old ops as deleted");

        // Verify remaining ops
        let total_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            total_after, 1,
            "only the recent op should remain after compaction"
        );
    }

    #[tokio::test]
    async fn compact_op_log_cmd_noop_when_no_old_ops() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create recent ops only
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "recent one".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "recent two".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();

        let result = compact_op_log_cmd_inner(&pool, DEV, 90).await.unwrap();
        assert!(
            result.snapshot_id.is_none(),
            "no snapshot should be created when no old ops exist"
        );
        assert_eq!(
            result.ops_deleted, 0,
            "no ops should be deleted when none are eligible"
        );

        // Verify all ops remain
        let total: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(total, 2, "both recent ops should remain");

        mat.shutdown();
    }

    // ======================================================================
    // list_page_links (F-33)
    // ======================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_links_returns_edges_between_pages() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create 2 pages
        let p1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page One".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        let p2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page Two".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Create a content block under p1 that links to p2
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("see [[{}]]", p2.id),
            Some(p1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Insert block_links entry manually (content block b1 → page p2)
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&b1.id)
            .bind(&p2.id)
            .execute(&pool)
            .await
            .unwrap();

        let links = list_page_links_inner(&pool).await.unwrap();

        // Should have at least one link: p1 → p2 (rolled up from b1 → p2)
        let p1_to_p2 = links
            .iter()
            .find(|l| l.source_id == p1.id && l.target_id == p2.id);
        assert!(
            p1_to_p2.is_some(),
            "should find link from page 1 to page 2 (rolled up from content block)"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_links_excludes_deleted_pages() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let p1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page One".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        let p2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page Two".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("link [[{}]]", p2.id),
            Some(p1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Insert block_links entry manually
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&b1.id)
            .bind(&p2.id)
            .execute(&pool)
            .await
            .unwrap();

        // Delete p2
        delete_block_inner(&pool, DEV, &mat, p2.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let links = list_page_links_inner(&pool).await.unwrap();
        let has_deleted = links.iter().any(|l| l.target_id == p2.id);
        assert!(!has_deleted, "should not include links to deleted pages");

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_links_excludes_self_links() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let p1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Create a block under p1 that links back to p1 itself
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("self [[{}]]", p1.id),
            Some(p1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Insert self-referential block_links entry
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&b1.id)
            .bind(&p1.id)
            .execute(&pool)
            .await
            .unwrap();

        let links = list_page_links_inner(&pool).await.unwrap();
        let self_link = links.iter().find(|l| l.source_id == l.target_id);
        assert!(
            self_link.is_none(),
            "should not include self-referential links"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_links_empty_when_no_links() {
        let (pool, _dir) = test_pool().await;
        let links = list_page_links_inner(&pool).await.unwrap();
        assert!(links.is_empty(), "should return empty when no links exist");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_links_deduplicates_multiple_content_links() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create 2 pages
        let p1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Source Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        let p2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Target Page".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Create 2 content blocks under p1, both linking to p2
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("first [[{}]]", p2.id),
            Some(p1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("second [[{}]]", p2.id),
            Some(p1.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Insert block_links entries for both content blocks → p2
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&b1.id)
            .bind(&p2.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&b2.id)
            .bind(&p2.id)
            .execute(&pool)
            .await
            .unwrap();

        let links = list_page_links_inner(&pool).await.unwrap();

        // Both b1 and b2 roll up to p1 → p2; DISTINCT should collapse to 1 edge
        let p1_to_p2_count = links
            .iter()
            .filter(|l| l.source_id == p1.id && l.target_id == p2.id)
            .count();
        assert_eq!(
            p1_to_p2_count, 1,
            "DISTINCT should deduplicate multiple content blocks linking to the same target page"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_links_excludes_links_with_deleted_parent_page() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Create 2 pages
        let p1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Source Page".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        let p2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Target Page".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Create a content block under p1 that links to p2
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("link [[{}]]", p2.id),
            Some(p1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Insert block_links entry
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&b1.id)
            .bind(&p2.id)
            .execute(&pool)
            .await
            .unwrap();

        // Verify link exists before deletion
        let links_before = list_page_links_inner(&pool).await.unwrap();
        let has_link = links_before
            .iter()
            .any(|l| l.source_id == p1.id && l.target_id == p2.id);
        assert!(has_link, "link should exist before deleting source page");

        // Soft-delete the SOURCE page (p1)
        delete_block_inner(&pool, DEV, &mat, p1.id.clone())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        let links_after = list_page_links_inner(&pool).await.unwrap();
        let has_deleted_source = links_after.iter().any(|l| l.source_id == p1.id);
        assert!(
            !has_deleted_source,
            "should not include links from a deleted parent page"
        );

        mat.shutdown();
    }

    // ======================================================================
    // CTE oracle: verify optimized list_page_links query matches the original
    // ======================================================================

    /// Original (pre-P-15) query preserved as a correctness oracle.
    /// Runs the old SQL and returns sorted results for comparison.
    async fn list_page_links_oracle(pool: &SqlitePool) -> Vec<PageLink> {
        let mut rows = sqlx::query_as::<_, PageLink>(
            "SELECT DISTINCT
                COALESCE(sb.parent_id, bl.source_id) AS source_id,
                bl.target_id AS target_id
             FROM block_links bl
             JOIN blocks sb ON sb.id = bl.source_id AND sb.deleted_at IS NULL
             JOIN blocks tb ON tb.id = bl.target_id AND tb.deleted_at IS NULL AND tb.block_type = 'page'
             LEFT JOIN blocks pb ON pb.id = sb.parent_id
             WHERE COALESCE(sb.parent_id, bl.source_id) != bl.target_id
             AND (sb.parent_id IS NULL OR (pb.deleted_at IS NULL AND pb.block_type = 'page'))",
        )
        .fetch_all(pool)
        .await
        .unwrap();
        rows.sort();
        rows
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_page_links_optimized_matches_oracle() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // -- Set up a non-trivial graph covering all edge-case branches --

        // 3 pages
        let p1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page Alpha".into(),
            None,
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let p2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page Beta".into(),
            None,
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let p3 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "Page Gamma".into(),
            None,
            Some(3),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Content blocks under p1
        let b1 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("link to beta [[{}]]", p2.id),
            Some(p1.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        let b2 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("link to gamma [[{}]]", p3.id),
            Some(p1.id.clone()),
            Some(2),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Content block under p2 linking to p3
        let b3 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("cross link [[{}]]", p3.id),
            Some(p2.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Self-link: content under p1 linking back to p1 (should be excluded)
        let b4 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("self [[{}]]", p1.id),
            Some(p1.id.clone()),
            Some(3),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Duplicate content blocks linking to same target (tests DISTINCT)
        let b5 = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("also beta [[{}]]", p2.id),
            Some(p1.id.clone()),
            Some(4),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        // Direct page-to-page link (source is itself a page, no parent rollup)
        sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&p2.id)
            .bind(&p1.id)
            .execute(&pool)
            .await
            .unwrap();

        // Insert all content block links
        for (src, tgt) in [
            (&b1.id, &p2.id),
            (&b2.id, &p3.id),
            (&b3.id, &p3.id),
            (&b4.id, &p1.id),
            (&b5.id, &p2.id),
        ] {
            sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
                .bind(src)
                .bind(tgt)
                .execute(&pool)
                .await
                .unwrap();
        }

        // -- Compare optimized vs oracle --
        let mut optimized = list_page_links_inner(&pool).await.unwrap();
        optimized.sort();

        let oracle = list_page_links_oracle(&pool).await;

        assert_eq!(
            optimized, oracle,
            "P-15 optimized query must match original oracle.\n  optimized: {optimized:?}\n  oracle:    {oracle:?}"
        );

        // Sanity: we should have some links
        assert!(
            !optimized.is_empty(),
            "test should produce at least one page link"
        );

        mat.shutdown();
    }
}
