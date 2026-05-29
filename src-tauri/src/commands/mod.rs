//! Tauri command handlers for the Agaric app.
//!
//! Each command writes to both the op_log AND the blocks table directly.
//! The materializer is used only for background cache work (tags, pages,
//! agenda, block_links) via `dispatch_background()`. This avoids race
//! conditions and double-writes.
//!
//! All commands return `Result<T, AppError>` — `AppError` already implements
//! `Serialize` for Tauri 2 command error propagation.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;

use crate::db::{CommandTx, ReadPool};
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::now_rfc3339;
use crate::op::{is_reserved_property_key, DeletePropertyPayload, OpPayload, UndoResult};
use crate::op_log;
use crate::pagination::{self, BlockRow, HistoryEntry, PageResponse};
use crate::pairing::PairingSession;
use crate::ulid::BlockId;

// Domain sub-modules
pub(crate) mod agenda;
pub(crate) mod attachments;
pub(crate) mod blocks;
pub(crate) mod bug_report;
pub(crate) mod compaction;
pub(crate) mod drafts;
pub(crate) mod gcal;
pub(crate) mod history;
pub(crate) mod journal;
pub(crate) mod link_metadata;
pub(crate) mod logging;
pub(crate) mod mcp;
pub(crate) mod pages;
pub(crate) mod properties;
pub(crate) mod queries;
pub(crate) mod spaces;
pub(crate) mod sync_cmds;
pub(crate) mod tags;

// Tauri command handlers and testable _inner functions — explicitly re-exported.
pub use agenda::{
    count_agenda_batch, count_agenda_batch_by_source, count_agenda_batch_by_source_inner,
    count_agenda_batch_inner, list_projected_agenda, list_projected_agenda_inner,
    list_undated_tasks, list_undated_tasks_inner,
};
// MAINT-164: `_on_the_fly` exposed for date-clock-pinned regression tests.
// Tests bypass the cache (which itself reads `chrono::Local::now()` and
// produces today-anchored rows that drift over time) and call this path
// directly with a fixed `today`. Production callers use
// `list_projected_agenda_inner` (above) — they do not need `_on_the_fly`,
// so this re-export is gated on `#[cfg(test)]`.
#[cfg(test)]
pub(crate) use agenda::list_projected_agenda_on_the_fly;
pub use attachments::{
    add_attachment, add_attachment_inner, add_attachment_with_bytes,
    add_attachment_with_bytes_inner, delete_attachment, delete_attachment_inner, list_attachments,
    list_attachments_batch, list_attachments_batch_inner, list_attachments_inner, read_attachment,
    read_attachment_inner,
};
pub use blocks::{
    batch_resolve, batch_resolve_inner, count_trash, count_trash_inner, create_block,
    create_block_inner, create_block_inner_with_space, create_blocks_batch,
    create_blocks_batch_inner, delete_block, delete_block_inner, delete_blocks_by_ids,
    delete_blocks_by_ids_inner, edit_block, edit_block_inner, first_child_for_blocks,
    first_child_for_blocks_inner, get_active_block_inner, get_block, get_block_inner, get_blocks,
    get_blocks_inner, list_blocks, list_blocks_inner, list_trash, list_trash_inner, move_block,
    move_block_inner, move_blocks_to_space, move_blocks_to_space_inner, purge_all_deleted,
    purge_all_deleted_inner, purge_block, purge_block_inner, purge_blocks_by_ids,
    purge_blocks_by_ids_inner, restore_all_deleted, restore_all_deleted_inner, restore_block,
    restore_block_inner, restore_blocks_by_ids, restore_blocks_by_ids_inner,
    trash_descendant_counts, trash_descendant_counts_inner, CreateBlockSpec,
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
    delete_draft, flush_all_drafts, flush_all_drafts_inner, flush_draft, flush_draft_inner,
    list_drafts, list_drafts_inner, save_draft, FlushAllDraftsResult,
};
pub use gcal::{
    begin_gcal_oauth, begin_gcal_oauth_inner, disconnect_gcal, disconnect_gcal_inner,
    force_gcal_resync, force_gcal_resync_inner, get_gcal_status, get_gcal_status_inner,
    set_gcal_privacy_mode, set_gcal_privacy_mode_inner, set_gcal_window_days,
    set_gcal_window_days_inner, BeginOauthOutcome, GcalClientState, GcalEventEmitterState,
    GcalOAuthClientState, GcalStatus, GcalTokenStoreState, LeaseHolder,
};
pub use history::{
    apply_reverse_in_tx, compute_block_vs_current_diff, compute_block_vs_current_diff_inner,
    compute_edit_diff, compute_edit_diff_inner, find_undo_group, find_undo_group_inner,
    list_page_history, list_page_history_inner, redo_page_op, redo_page_op_inner,
    restore_page_to_op, restore_page_to_op_inner, revert_ops, revert_ops_inner, undo_page_op,
    undo_page_op_inner,
};
pub use journal::{
    get_journal_page_by_date, get_journal_page_by_date_inner, journal_for_date_inner,
    list_journal_pages_in_range, list_journal_pages_in_range_inner, navigate_journal_inner,
    quick_capture_block, quick_capture_block_inner, today_journal_inner,
};
pub use link_metadata::{
    fetch_link_metadata, fetch_link_metadata_inner, get_link_metadata, get_link_metadata_inner,
};
pub use logging::{get_log_dir, log_frontend};
pub use mcp::{
    get_mcp_rw_socket_path, get_mcp_rw_socket_path_inner, get_mcp_rw_status,
    get_mcp_rw_status_inner, get_mcp_socket_path, get_mcp_socket_path_inner, get_mcp_status,
    get_mcp_status_inner, mcp_disconnect_all, mcp_disconnect_all_inner, mcp_rw_disconnect_all,
    mcp_rw_disconnect_all_inner, mcp_rw_set_enabled, mcp_rw_set_enabled_inner, mcp_set_enabled,
    mcp_set_enabled_inner, McpRwStatus, McpRwToggleGate, McpStatus, McpToggleGate,
};
pub use pages::{
    export_page_markdown, export_page_markdown_inner, get_page_aliases, get_page_aliases_inner,
    get_page_inner, get_page_unscoped_inner, import_markdown, import_markdown_inner,
    list_all_pages_in_space, list_all_pages_in_space_inner, list_page_aliases_by_prefix,
    list_page_aliases_by_prefix_inner, list_page_links, list_page_links_inner, list_pages_inner,
    list_template_page_ids_in_space, list_template_page_ids_in_space_inner, load_page_subtree,
    load_page_subtree_inner, resolve_page_by_alias, resolve_page_by_alias_inner, set_page_aliases,
    set_page_aliases_inner, PageHeading, PageSubtreeResponse, MCP_PAGE_LIMIT_CAP,
};
pub use properties::{
    create_property_def, create_property_def_inner, delete_property, delete_property_def,
    delete_property_def_inner, delete_property_inner, get_batch_properties,
    get_batch_properties_inner, get_properties, get_properties_inner, get_property,
    get_property_def, get_property_def_inner, get_property_inner, list_property_defs,
    list_property_defs_inner, list_property_keys, list_property_keys_inner, set_due_date,
    set_due_date_inner, set_priority, set_priority_inner, set_property, set_property_inner,
    set_scheduled_date, set_scheduled_date_inner, set_todo_state, set_todo_state_batch,
    set_todo_state_batch_inner, set_todo_state_inner, update_property_def_options,
    update_property_def_options_inner,
};
pub use queries::{
    count_backlinks_batch, count_backlinks_batch_inner, filtered_blocks_query,
    filtered_blocks_query_inner, get_backlinks, get_backlinks_inner, get_status, get_status_inner,
    list_backlinks_grouped, list_backlinks_grouped_inner, list_unfinished_tasks,
    list_unfinished_tasks_inner, list_unlinked_references, list_unlinked_references_inner,
    query_backlinks_filtered, query_backlinks_filtered_inner, query_by_property,
    query_by_property_inner, search_blocks, search_blocks_inner, DateFilter, DateOp, MatchOffset,
    NamedDateRange, PropertyFilter, SearchBlockRow, SearchFilter, SearchPropertyFilter,
    TagFilterExpr,
};
pub use spaces::{
    create_page_in_space, create_page_in_space_inner, create_space, create_space_inner,
    list_spaces, list_spaces_inner, SpaceRow,
};
pub use sync_cmds::{
    cancel_pairing, cancel_pairing_inner, cancel_sync, cancel_sync_inner, confirm_pairing,
    confirm_pairing_inner, delete_peer_ref, delete_peer_ref_inner, get_device_id,
    get_device_id_inner, get_peer_ref, get_peer_ref_inner, list_peer_refs, list_peer_refs_inner,
    set_peer_address, set_peer_address_inner, start_pairing, start_pairing_inner, start_sync,
    start_sync_inner, update_peer_name, update_peer_name_inner,
};
pub use tags::{
    add_tag, add_tag_inner, add_tags_by_ids, add_tags_by_ids_inner, list_all_tags_in_space,
    list_all_tags_in_space_inner, list_tags_by_prefix, list_tags_by_prefix_inner,
    list_tags_for_block, list_tags_for_block_inner, list_tags_inner, query_by_tags,
    query_by_tags_inner, remove_tag, remove_tag_inner,
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
    __specta__fn__list_attachments_batch,
};
#[doc(hidden)]
pub use blocks::{
    __specta__fn__batch_resolve, __specta__fn__count_trash, __specta__fn__create_block,
    __specta__fn__create_blocks_batch, __specta__fn__delete_block,
    __specta__fn__delete_blocks_by_ids, __specta__fn__edit_block,
    __specta__fn__first_child_for_blocks, __specta__fn__get_block, __specta__fn__get_blocks,
    __specta__fn__list_blocks, __specta__fn__move_block, __specta__fn__move_blocks_to_space,
    __specta__fn__purge_all_deleted, __specta__fn__purge_block, __specta__fn__purge_blocks_by_ids,
    __specta__fn__restore_all_deleted, __specta__fn__restore_block,
    __specta__fn__restore_blocks_by_ids, __specta__fn__trash_descendant_counts,
};
#[doc(hidden)]
pub use bug_report::{
    __specta__fn__collect_bug_report_metadata, __specta__fn__read_logs_for_report,
};
#[doc(hidden)]
pub use compaction::{__specta__fn__compact_op_log_cmd, __specta__fn__get_compaction_status};
#[doc(hidden)]
pub use drafts::{
    __specta__fn__delete_draft, __specta__fn__flush_all_drafts, __specta__fn__flush_draft,
    __specta__fn__list_drafts, __specta__fn__save_draft,
};
#[doc(hidden)]
pub use gcal::{
    __specta__fn__begin_gcal_oauth, __specta__fn__disconnect_gcal, __specta__fn__force_gcal_resync,
    __specta__fn__get_gcal_status, __specta__fn__set_gcal_privacy_mode,
    __specta__fn__set_gcal_window_days,
};
#[doc(hidden)]
pub use history::{
    __specta__fn__compute_block_vs_current_diff, __specta__fn__compute_edit_diff,
    __specta__fn__find_undo_group, __specta__fn__list_page_history, __specta__fn__redo_page_op,
    __specta__fn__restore_page_to_op, __specta__fn__revert_ops, __specta__fn__undo_page_op,
};
#[doc(hidden)]
pub use journal::{
    __specta__fn__get_journal_page_by_date, __specta__fn__list_journal_pages_in_range,
    __specta__fn__quick_capture_block,
};
#[doc(hidden)]
pub use link_metadata::{__specta__fn__fetch_link_metadata, __specta__fn__get_link_metadata};
#[doc(hidden)]
pub use logging::{__specta__fn__get_log_dir, __specta__fn__log_frontend};
#[doc(hidden)]
pub use mcp::{
    __specta__fn__get_mcp_rw_socket_path, __specta__fn__get_mcp_rw_status,
    __specta__fn__get_mcp_socket_path, __specta__fn__get_mcp_status,
    __specta__fn__mcp_disconnect_all, __specta__fn__mcp_rw_disconnect_all,
    __specta__fn__mcp_rw_set_enabled, __specta__fn__mcp_set_enabled,
};
#[doc(hidden)]
pub use pages::{
    __specta__fn__export_page_markdown, __specta__fn__get_page_aliases,
    __specta__fn__import_markdown, __specta__fn__list_all_pages_in_space,
    __specta__fn__list_page_aliases_by_prefix, __specta__fn__list_page_links,
    __specta__fn__list_template_page_ids_in_space, __specta__fn__load_page_subtree,
    __specta__fn__resolve_page_by_alias, __specta__fn__set_page_aliases,
};
#[doc(hidden)]
pub use properties::{
    __specta__fn__create_property_def, __specta__fn__delete_property,
    __specta__fn__delete_property_def, __specta__fn__get_batch_properties,
    __specta__fn__get_properties, __specta__fn__get_property, __specta__fn__get_property_def,
    __specta__fn__list_property_defs, __specta__fn__list_property_keys, __specta__fn__set_due_date,
    __specta__fn__set_priority, __specta__fn__set_property, __specta__fn__set_scheduled_date,
    __specta__fn__set_todo_state, __specta__fn__set_todo_state_batch,
    __specta__fn__update_property_def_options,
};
#[doc(hidden)]
pub use queries::{
    __specta__fn__count_backlinks_batch, __specta__fn__filtered_blocks_query,
    __specta__fn__get_backlinks, __specta__fn__get_status, __specta__fn__list_backlinks_grouped,
    __specta__fn__list_unfinished_tasks, __specta__fn__list_unlinked_references,
    __specta__fn__query_backlinks_filtered, __specta__fn__query_by_property,
    __specta__fn__search_blocks,
};
#[doc(hidden)]
pub use spaces::{
    __specta__fn__create_page_in_space, __specta__fn__create_space, __specta__fn__list_spaces,
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
    __specta__fn__add_tag, __specta__fn__add_tags_by_ids, __specta__fn__list_all_tags_in_space,
    __specta__fn__list_tags_by_prefix, __specta__fn__list_tags_for_block,
    __specta__fn__query_by_tags, __specta__fn__remove_tag,
};

// Tauri `__cmd__` wrappers generated by `#[tauri::command]` on each handler.
#[doc(hidden)]
pub use agenda::{
    __cmd__count_agenda_batch, __cmd__count_agenda_batch_by_source, __cmd__list_projected_agenda,
    __cmd__list_undated_tasks,
};
#[doc(hidden)]
pub use attachments::{
    __cmd__add_attachment, __cmd__delete_attachment, __cmd__list_attachments,
    __cmd__list_attachments_batch,
};
#[doc(hidden)]
pub use blocks::{
    __cmd__batch_resolve, __cmd__count_trash, __cmd__create_block, __cmd__create_blocks_batch,
    __cmd__delete_block, __cmd__delete_blocks_by_ids, __cmd__edit_block,
    __cmd__first_child_for_blocks, __cmd__get_block, __cmd__get_blocks, __cmd__list_blocks,
    __cmd__move_block, __cmd__move_blocks_to_space, __cmd__purge_all_deleted, __cmd__purge_block,
    __cmd__purge_blocks_by_ids, __cmd__restore_all_deleted, __cmd__restore_block,
    __cmd__restore_blocks_by_ids, __cmd__trash_descendant_counts,
};
#[doc(hidden)]
pub use bug_report::{__cmd__collect_bug_report_metadata, __cmd__read_logs_for_report};
#[doc(hidden)]
pub use compaction::{__cmd__compact_op_log_cmd, __cmd__get_compaction_status};
#[doc(hidden)]
pub use drafts::{
    __cmd__delete_draft, __cmd__flush_all_drafts, __cmd__flush_draft, __cmd__list_drafts,
    __cmd__save_draft,
};
#[doc(hidden)]
pub use gcal::{
    __cmd__begin_gcal_oauth, __cmd__disconnect_gcal, __cmd__force_gcal_resync,
    __cmd__get_gcal_status, __cmd__set_gcal_privacy_mode, __cmd__set_gcal_window_days,
};
#[doc(hidden)]
pub use history::{
    __cmd__compute_block_vs_current_diff, __cmd__compute_edit_diff, __cmd__find_undo_group,
    __cmd__list_page_history, __cmd__redo_page_op, __cmd__restore_page_to_op, __cmd__revert_ops,
    __cmd__undo_page_op,
};
#[doc(hidden)]
pub use journal::{
    __cmd__get_journal_page_by_date, __cmd__list_journal_pages_in_range, __cmd__quick_capture_block,
};
#[doc(hidden)]
pub use link_metadata::{__cmd__fetch_link_metadata, __cmd__get_link_metadata};
#[doc(hidden)]
pub use logging::{__cmd__get_log_dir, __cmd__log_frontend};
#[doc(hidden)]
pub use mcp::{
    __cmd__get_mcp_rw_socket_path, __cmd__get_mcp_rw_status, __cmd__get_mcp_socket_path,
    __cmd__get_mcp_status, __cmd__mcp_disconnect_all, __cmd__mcp_rw_disconnect_all,
    __cmd__mcp_rw_set_enabled, __cmd__mcp_set_enabled,
};
#[doc(hidden)]
pub use pages::{
    __cmd__export_page_markdown, __cmd__get_page_aliases, __cmd__import_markdown,
    __cmd__list_all_pages_in_space, __cmd__list_page_aliases_by_prefix, __cmd__list_page_links,
    __cmd__list_template_page_ids_in_space, __cmd__load_page_subtree, __cmd__resolve_page_by_alias,
    __cmd__set_page_aliases,
};
#[doc(hidden)]
pub use properties::{
    __cmd__create_property_def, __cmd__delete_property, __cmd__delete_property_def,
    __cmd__get_batch_properties, __cmd__get_properties, __cmd__get_property,
    __cmd__get_property_def, __cmd__list_property_defs, __cmd__list_property_keys,
    __cmd__set_due_date, __cmd__set_priority, __cmd__set_property, __cmd__set_scheduled_date,
    __cmd__set_todo_state, __cmd__set_todo_state_batch, __cmd__update_property_def_options,
};
#[doc(hidden)]
pub use queries::{
    __cmd__count_backlinks_batch, __cmd__filtered_blocks_query, __cmd__get_backlinks,
    __cmd__get_status, __cmd__list_backlinks_grouped, __cmd__list_unfinished_tasks,
    __cmd__list_unlinked_references, __cmd__query_backlinks_filtered, __cmd__query_by_property,
    __cmd__search_blocks,
};
#[doc(hidden)]
pub use spaces::{__cmd__create_page_in_space, __cmd__create_space, __cmd__list_spaces};
#[doc(hidden)]
pub use sync_cmds::{
    __cmd__cancel_pairing, __cmd__cancel_sync, __cmd__confirm_pairing, __cmd__delete_peer_ref,
    __cmd__get_device_id, __cmd__get_peer_ref, __cmd__list_peer_refs, __cmd__set_peer_address,
    __cmd__start_pairing, __cmd__start_sync, __cmd__update_peer_name,
};
#[doc(hidden)]
pub use tags::{
    __cmd__add_tag, __cmd__add_tags_by_ids, __cmd__list_all_tags_in_space,
    __cmd__list_tags_by_prefix, __cmd__list_tags_for_block, __cmd__query_by_tags,
    __cmd__remove_tag,
};

// pub(crate) helpers used by other crate modules (e.g. recurrence.rs)
pub(crate) use blocks::{create_block_in_tx, delete_property_in_tx, set_property_in_tx};
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

/// Validate that `s` parses as a calendar-valid `YYYY-MM-DD` date.
///
/// I-CommandsCRUD-6: previously did only structural validation (month
/// 01–12, day 01–31) and explicitly accepted impossible combinations
/// (Feb 30, Apr 31), relying on downstream callers to handle them. The
/// agenda path (`list_projected_agenda_inner`) re-parsed via
/// `NaiveDate::parse_from_str` and rejected with a different error
/// shape — inconsistent failure for the same input depending on which
/// command consumed it.
///
/// Now uses `NaiveDate::parse_from_str` directly so impossible dates
/// are rejected at the boundary with a single canonical error message.
/// The agenda re-parse becomes redundant and can be removed in a
/// follow-up; this change keeps the validator's return type stable so
/// existing callers don't need updating.
///
/// MAINT-163: chrono's `%Y-%m-%d` accepts non-zero-padded forms like
/// `2025-1-1` and 2-digit years like `25-1-1`. Pre-validate the strict
/// shape (`\d{4}-\d{2}-\d{2}`) before delegating calendar validity to
/// chrono — otherwise these slip through and downstream callers get
/// surprising "valid" dates that the canonical date format invariant
/// rejects.
pub(crate) fn validate_date_format(s: &str) -> Result<(), AppError> {
    let bytes = s.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !shape_ok {
        return Err(AppError::Validation(format!(
            "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
        )));
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| {
            AppError::Validation(format!(
                "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
            ))
        })
}

/// A date range for agenda queries. Both fields must be in `YYYY-MM-DD` format.
#[derive(Debug, Clone, serde::Deserialize, Serialize, Type)]
pub struct DateRange {
    pub start: String,
    pub end: String,
}

/// Bundled agenda filter for the [`list_blocks`] Tauri command.
///
/// Exists purely to keep `list_blocks`'s argument count under the
/// `tauri-specta` 10-arg limit after FEAT-3 Phase 2 added `space_id`.
/// The three sub-fields were previously top-level parameters and are
/// still threaded into `list_blocks_inner` as individual parameters —
/// the bundling is a transport-layer concern. `None` means "no agenda
/// filter applies" (the common case), and each sub-field remains
/// optional inside the struct so callers can still specify a single
/// date without the range, etc.
///
/// Serde `rename_all = "camelCase"` matches the Tauri command-arg
/// convention (camelCase keys on the IPC boundary), so the hand-written
/// TS wrapper in `src/lib/tauri.ts` can pass `{ dateRange, source, date }`
/// without an extra translation layer.
#[derive(Debug, Clone, serde::Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgendaQuery {
    /// Single-date agenda lookup (`YYYY-MM-DD`).
    pub date: Option<String>,
    /// Date-range agenda lookup (inclusive on both ends).
    pub date_range: Option<DateRange>,
    /// Optional source filter (`due_date` / `scheduled_date`).
    pub source: Option<String>,
}

/// Bundled extra filters for the [`query_by_property`] Tauri command.
///
/// Exists purely to keep `query_by_property`'s argument count under
/// the `tauri-specta` 10-arg limit. PEND-35 Tier 1.5 added
/// `exclude_parent_id` / `content_non_empty` (pushing this command
/// to 9 IPC args incl. `pool`); PEND-35 Tier 3.4 adds another three
/// (`block_type`, `value_text_in`, `value_date_range`). Bundling all
/// five into one struct keeps the IPC arg count at 8.
///
/// The five sub-fields are still threaded into
/// `query_by_property_inner` as individual parameters — bundling is a
/// transport-layer concern. `None` means "no extra filter applies"
/// (the common case); each sub-field remains optional inside the
/// struct so callers can specify just one. The hand-written TS
/// wrapper in `src/lib/tauri.ts` keeps the flat public API and
/// marshals into this struct only at the IPC boundary, mirroring the
/// [`AgendaQuery`] precedent on `list_blocks`.
///
/// Serde `rename_all = "camelCase"` matches the Tauri command-arg
/// convention.
#[derive(Debug, Clone, Default, serde::Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtraQueryFilters {
    /// PEND-35 Tier 1.5 — exclude rows whose `parent_id` matches.
    /// `IS NOT` semantics so NULL parents are kept.
    pub exclude_parent_id: Option<String>,
    /// PEND-35 Tier 1.5 — drop rows whose content is NULL, empty, or
    /// whitespace-only (matches FE `!b.content?.trim()`).
    pub content_non_empty: Option<bool>,
    /// PEND-35 Tier 3.4 — push `block_type = ?` into SQL.
    pub block_type: Option<String>,
    /// PEND-35 Tier 3.4 — push `value_text IN (...)` into SQL via
    /// `json_each`. Mutually exclusive with `value_text` on
    /// `query_by_property`.
    pub value_text_in: Option<Vec<String>>,
    /// PEND-35 Tier 3.4 — push `value_date >= from AND value_date < to`
    /// into SQL (half-open `[from, to)` range).
    pub value_date_range: Option<(String, String)>,
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
    /// PEND-14: native boolean property storage. SQLite represents booleans
    /// as INTEGER (0/1, with a CHECK constraint allowing only NULL/0/1).
    pub value_bool: Option<i64>,
}

/// Input bundle for the `set_property` Tauri command — collects all
/// possible typed values into a single struct so the IPC handler stays
/// under specta's 10-positional-argument limit (PEND-14 added a 5th
/// `value_bool` slot which would have made the flat signature exceed
/// the cap). Exactly one field should be `Some` for non-reserved keys
/// (the inner validator enforces this); reserved-key clears may pass
/// all-None.
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize, Type)]
pub struct SetPropertyArgs {
    #[serde(default)]
    pub value_text: Option<String>,
    #[serde(default)]
    pub value_num: Option<f64>,
    #[serde(default)]
    pub value_date: Option<String>,
    #[serde(default)]
    pub value_ref: Option<String>,
    /// PEND-14: native boolean property value (`true` / `false`).
    #[serde(default)]
    pub value_bool: Option<bool>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, sqlx::FromRow, specta::Type)]
pub struct AttachmentRow {
    pub id: crate::ulid::BlockId,
    pub block_id: crate::ulid::BlockId,
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
///
/// M-34: the QR payload + [`PairingInfo`] both carry only the passphrase.
/// mDNS owns discovery + address resolution end-to-end; there is no
/// scan-bootstrap path that would need a `host`/`port` here.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PairingInfo {
    pub passphrase: String,
    pub qr_svg: String,
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
    id: crate::ulid::BlockId,
    title: Option<String>,
    block_type: String,
    deleted: Option<bool>,
}

/// List op-log history entries for a specific block, with cursor pagination.
///
/// PEND-35 Tier 1.3 — `op_type_filter` is pushed into SQL so the FE no
/// longer drops rows post-pagination. Mirrors `list_page_history_inner`.
pub async fn get_block_history_inner(
    pool: &SqlitePool,
    block_id: String,
    op_type_filter: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_block_history(pool, &block_id, op_type_filter.as_deref(), &page).await
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
    // 1. Begin IMMEDIATE transaction (MAINT-112: CommandTx couples
    //    commit + post-commit dispatch so a failed commit never leaks
    //    an op_record to the materializer).
    let mut tx = CommandTx::begin_immediate(pool, "delete_property_core").await?;

    // 2. Validate block exists and is not deleted (TOCTOU-safe)
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // FEAT-5i — snapshot pre-mutation block dates so the post-commit
    // `notify_gcal_for_op` call can compute `old_affected_dates`.
    let gcal_snapshot = if materializer.is_gcal_hook_active() {
        Some(crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &block_id).await?)
    } else {
        None
    };

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
                    .execute(&mut **tx)
                    .await?;
            }
            "priority" => {
                sqlx::query!("UPDATE blocks SET priority = NULL WHERE id = ?", block_id)
                    .execute(&mut **tx)
                    .await?;
            }
            "due_date" => {
                sqlx::query!("UPDATE blocks SET due_date = NULL WHERE id = ?", block_id)
                    .execute(&mut **tx)
                    .await?;
            }
            "scheduled_date" => {
                sqlx::query!(
                    "UPDATE blocks SET scheduled_date = NULL WHERE id = ?",
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            // L-57: defensive error path for the case where a future
            // reserved key is added to `is_reserved_property_key`
            // without a matching column-routing arm here. Today this
            // is unreachable (the gate is locked at exactly the four
            // matched keys), but converting the panic to a structured
            // `AppError::InvalidOperation` means a forgotten lockstep
            // update produces a clean command error rather than
            // crashing the worker. `InvalidOperation` is in
            // `sanitize_internal_error`'s pass-through set so the
            // diagnostic survives to the frontend.
            _ => {
                return Err(AppError::InvalidOperation(format!(
                    "unknown reserved property: {key}"
                )));
            }
        }
    } else {
        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(&block_id)
            .bind(&key)
            .execute(&mut **tx)
            .await?;
    }

    // 5. Dispatch background cache tasks after commit (fire-and-forget).
    //    PEND-25 L9: wrap in `Arc` once so the dispatch queue and the
    //    post-commit `notify_gcal_for_op` borrow share the record by
    //    refcount rather than deep-cloning the owned `String` payloads.
    let op_record = Arc::new(op_record);
    tx.enqueue_background(Arc::clone(&op_record));
    tx.commit_and_dispatch(materializer).await?;

    // FEAT-5i — notify GCal connector post-commit.
    if let Some(snapshot) = gcal_snapshot {
        materializer.notify_gcal_for_op(&op_record, &snapshot);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Property-definition CRUD (#548-#550, #557)
// ---------------------------------------------------------------------------

/// Internal row type for the batch properties query (sqlx-compatible).
#[derive(Debug, sqlx::FromRow)]
struct BatchPropertyRow {
    block_id: crate::ulid::BlockId,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<i64>,
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
    /// Extract the core [`crate::pagination::ActiveBlockRow`] fields
    /// (used when building [`crate::pagination::ActiveProjectedAgendaEntry`]
    /// values). The SQL that produced this row filters
    /// `deleted_at IS NULL` (see
    /// `commands/agenda.rs::list_projected_agenda_on_the_fly`), so the
    /// active claim is sound.
    fn to_active_block_row(&self) -> crate::pagination::ActiveBlockRow {
        crate::pagination::ActiveBlockRow {
            id: crate::ulid::ActiveBlockId::from_trusted_active(&self.id),
            block_type: self.block_type.clone(),
            content: self.content.clone(),
            parent_id: self
                .parent_id
                .as_deref()
                .map(crate::ulid::BlockId::from_trusted),
            position: self.position,
            deleted_at: self.deleted_at.clone(),
            todo_state: self.todo_state.clone(),
            priority: self.priority.clone(),
            due_date: self.due_date.clone(),
            scheduled_date: self.scheduled_date.clone(),
            page_id: self
                .page_id
                .as_deref()
                .map(crate::ulid::BlockId::from_trusted),
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
/// `NonReversible`, `Ulid`, `Conflict`, `PoolTimedOut`) pass through
/// unchanged — they already carry messages suitable for rendering in
/// the frontend.  Issue #106 added `Conflict` / `PoolTimedOut` to the
/// pass-through list: both are call-site-recoverable signals (unique
/// violation, writer busy) that the frontend can surface as targeted
/// toasts rather than the generic "an internal error occurred" string.
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
    op_type_filter: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    get_block_history_inner(&pool.0, block_id, op_type_filter, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Public under `#[cfg(test)]` so the sibling integration test modules
// (`crate::integration_tests`, `crate::command_integration_tests::*`,
// `crate::mcp::tools_ro::tests`) can reach into `tests::common` for the
// shared helpers (`assign_all_to_test_space`, `TEST_SPACE_ID`, etc.).
// Stays gated by `#[cfg(test)]` so production builds never see it.
#[cfg(test)]
pub mod tests;
