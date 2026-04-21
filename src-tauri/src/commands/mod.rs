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

use crate::db::ReadPool;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::now_rfc3339;
use crate::op::{is_reserved_property_key, DeletePropertyPayload, OpPayload, UndoResult};
use crate::op_log;
use crate::pagination::{self, BlockRow, HistoryEntry, PageResponse};
use crate::pairing::PairingSession;
use crate::ulid::BlockId;

// Domain sub-modules
mod agenda;
mod attachments;
mod blocks;
mod bug_report;
mod compaction;
mod drafts;
mod gcal;
mod history;
mod journal;
mod link_metadata;
mod logging;
mod mcp;
mod pages;
mod properties;
mod queries;
mod sync_cmds;
mod tags;

// Tauri command handlers and testable _inner functions — explicitly re-exported.
pub use agenda::{
    count_agenda_batch, count_agenda_batch_by_source, count_agenda_batch_by_source_inner,
    count_agenda_batch_inner, list_projected_agenda, list_projected_agenda_inner,
    list_undated_tasks, list_undated_tasks_inner,
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
    restore_block_inner, trash_descendant_counts, trash_descendant_counts_inner,
};
pub use bug_report::{
    collect_bug_report_metadata, collect_bug_report_metadata_inner, read_logs_for_report,
    read_logs_for_report_inner, BugReport, LogFileEntry,
};
pub use compaction::{
    compact_op_log_cmd, compact_op_log_cmd_inner, get_compaction_status,
    get_compaction_status_inner, CompactionResult, CompactionStatus, PageLink, RestoreToOpResult,
};
pub use drafts::{
    delete_draft, flush_draft, flush_draft_inner, list_drafts, list_drafts_inner, save_draft,
};
pub use gcal::{
    disconnect_gcal, disconnect_gcal_inner, force_gcal_resync, force_gcal_resync_inner,
    get_gcal_status, get_gcal_status_inner, set_gcal_privacy_mode, set_gcal_privacy_mode_inner,
    set_gcal_window_days, set_gcal_window_days_inner, GcalClientState, GcalEventEmitterState,
    GcalStatus, GcalTokenStoreState, LeaseHolder,
};
pub use history::{
    apply_reverse_in_tx, compute_edit_diff, compute_edit_diff_inner, list_page_history,
    list_page_history_inner, redo_page_op, redo_page_op_inner, restore_page_to_op,
    restore_page_to_op_inner, revert_ops, revert_ops_inner, undo_page_op, undo_page_op_inner,
};
pub use journal::{journal_for_date_inner, navigate_journal_inner, today_journal_inner};
pub use link_metadata::{
    fetch_link_metadata, fetch_link_metadata_inner, get_link_metadata, get_link_metadata_inner,
};
pub use logging::{get_log_dir, log_frontend};
pub use mcp::{
    get_mcp_socket_path, get_mcp_socket_path_inner, get_mcp_status, get_mcp_status_inner,
    mcp_disconnect_all, mcp_disconnect_all_inner, mcp_set_enabled, mcp_set_enabled_inner,
    McpStatus,
};
pub use pages::{
    export_page_markdown, export_page_markdown_inner, get_page_aliases, get_page_aliases_inner,
    get_page_inner, import_markdown, import_markdown_inner, list_page_links, list_page_links_inner,
    list_pages_inner, resolve_page_by_alias, resolve_page_by_alias_inner, set_page_aliases,
    set_page_aliases_inner, PageSubtreeResponse, MCP_PAGE_LIMIT_CAP,
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
    list_tags_for_block_inner, list_tags_inner, query_by_tags, query_by_tags_inner, remove_tag,
    remove_tag_inner,
};

// specta-generated type-export fns required by `collect_commands![]` in lib.rs.
// These are created by the `#[specta::specta]` proc macro on each Tauri command handler.
#[doc(hidden)]
pub use agenda::{
    __specta__fn__count_agenda_batch, __specta__fn__count_agenda_batch_by_source,
    __specta__fn__list_projected_agenda, __specta__fn__list_undated_tasks,
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
    __specta__fn__trash_descendant_counts,
};
#[doc(hidden)]
pub use bug_report::{
    __specta__fn__collect_bug_report_metadata, __specta__fn__read_logs_for_report,
};
#[doc(hidden)]
pub use compaction::{__specta__fn__compact_op_log_cmd, __specta__fn__get_compaction_status};
#[doc(hidden)]
pub use drafts::{
    __specta__fn__delete_draft, __specta__fn__flush_draft, __specta__fn__list_drafts,
    __specta__fn__save_draft,
};
#[doc(hidden)]
pub use gcal::{
    __specta__fn__disconnect_gcal, __specta__fn__force_gcal_resync,
    __specta__fn__get_gcal_status, __specta__fn__set_gcal_privacy_mode,
    __specta__fn__set_gcal_window_days,
};
#[doc(hidden)]
pub use history::{
    __specta__fn__compute_edit_diff, __specta__fn__list_page_history, __specta__fn__redo_page_op,
    __specta__fn__restore_page_to_op, __specta__fn__revert_ops, __specta__fn__undo_page_op,
};
#[doc(hidden)]
pub use link_metadata::{__specta__fn__fetch_link_metadata, __specta__fn__get_link_metadata};
#[doc(hidden)]
pub use logging::{__specta__fn__get_log_dir, __specta__fn__log_frontend};
#[doc(hidden)]
pub use mcp::{
    __specta__fn__get_mcp_socket_path, __specta__fn__get_mcp_status,
    __specta__fn__mcp_disconnect_all, __specta__fn__mcp_set_enabled,
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
    __cmd__list_undated_tasks,
};
#[doc(hidden)]
pub use attachments::{__cmd__add_attachment, __cmd__delete_attachment, __cmd__list_attachments};
#[doc(hidden)]
pub use blocks::{
    __cmd__batch_resolve, __cmd__create_block, __cmd__delete_block, __cmd__edit_block,
    __cmd__get_block, __cmd__list_blocks, __cmd__move_block, __cmd__purge_all_deleted,
    __cmd__purge_block, __cmd__restore_all_deleted, __cmd__restore_block,
    __cmd__trash_descendant_counts,
};
#[doc(hidden)]
pub use bug_report::{__cmd__collect_bug_report_metadata, __cmd__read_logs_for_report};
#[doc(hidden)]
pub use compaction::{__cmd__compact_op_log_cmd, __cmd__get_compaction_status};
#[doc(hidden)]
pub use drafts::{__cmd__delete_draft, __cmd__flush_draft, __cmd__list_drafts, __cmd__save_draft};
#[doc(hidden)]
pub use gcal::{
    __cmd__disconnect_gcal, __cmd__force_gcal_resync, __cmd__get_gcal_status,
    __cmd__set_gcal_privacy_mode, __cmd__set_gcal_window_days,
};
#[doc(hidden)]
pub use history::{
    __cmd__compute_edit_diff, __cmd__list_page_history, __cmd__redo_page_op,
    __cmd__restore_page_to_op, __cmd__revert_ops, __cmd__undo_page_op,
};
#[doc(hidden)]
pub use link_metadata::{__cmd__fetch_link_metadata, __cmd__get_link_metadata};
#[doc(hidden)]
pub use logging::{__cmd__get_log_dir, __cmd__log_frontend};
#[doc(hidden)]
pub use mcp::{
    __cmd__get_mcp_socket_path, __cmd__get_mcp_status, __cmd__mcp_disconnect_all,
    __cmd__mcp_set_enabled,
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
        // Match-arms with explicit `sqlx::query!` per column — preserves
        // compile-time SQL validation. Reserved keys are a closed set
        // (see `is_reserved_property_key`) so the match is exhaustive.
        match key.as_str() {
            "todo_state" => {
                sqlx::query!("UPDATE blocks SET todo_state = NULL WHERE id = ?", block_id)
                    .execute(&mut *tx)
                    .await?;
            }
            "priority" => {
                sqlx::query!("UPDATE blocks SET priority = NULL WHERE id = ?", block_id)
                    .execute(&mut *tx)
                    .await?;
            }
            "due_date" => {
                sqlx::query!("UPDATE blocks SET due_date = NULL WHERE id = ?", block_id)
                    .execute(&mut *tx)
                    .await?;
            }
            "scheduled_date" => {
                sqlx::query!(
                    "UPDATE blocks SET scheduled_date = NULL WHERE id = ?",
                    block_id
                )
                .execute(&mut *tx)
                .await?;
            }
            _ => unreachable!(
                "is_reserved_property_key('{key}') returned true for an unrecognised key"
            ),
        }
    } else {
        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(&block_id)
            .bind(&key)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    // 5. Dispatch background cache tasks (fire-and-forget)
    materializer.dispatch_background_or_warn(&op_record);

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
    page_id: Option<String>,
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
            page_id: self.page_id.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

/// Sanitize internal error details before returning to the frontend.
///
/// Applied to every Tauri command wrapper — read and write alike — whose
/// inner function can surface a SQL, I/O, JSON, channel, or snapshot error.
/// The `AppError::Database` / `Migration` / `Io` / `Json` / `Channel` /
/// `Snapshot` variants are collapsed to a generic
/// `AppError::InvalidOperation("an internal error occurred")`, and the
/// original error is logged backend-side via `tracing::warn!` so it remains
/// available for debugging without being serialized to the UI.
///
/// User-facing variants (`NotFound`, `Validation`, `InvalidOperation`,
/// `NonReversible`, `Ulid`) pass through unchanged — they already carry
/// messages suitable for rendering in the frontend.
///
/// Agaric's threat model is benign (single-user, local-first, no remote
/// peers), so this sanitization exists purely for UX consistency and to
/// keep raw SQL fragments or filesystem paths out of toast notifications
/// — not as a security boundary.
#[cfg(not(tarpaulin_include))]
pub(crate) fn sanitize_internal_error(err: AppError) -> AppError {
    match &err {
        AppError::Database(_)
        | AppError::Migration(_)
        | AppError::Io(_)
        | AppError::Json(_)
        | AppError::Channel(_)
        | AppError::Snapshot(_) => {
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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
