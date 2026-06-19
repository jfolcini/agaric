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
use crate::op::{DeletePropertyPayload, OpPayload, UndoResult, is_reserved_property_key};
use crate::op_log;
use crate::pagination::{self, BlockRow, HistoryEntry, PageResponse};
use crate::pairing::PairingSession;
use crate::ulid::BlockId;

// Domain sub-modules
pub(crate) mod advanced_query;
pub(crate) mod agenda;
pub(crate) mod attachments;
pub(crate) mod block_cleanup;
pub(crate) mod blocks;
pub(crate) mod bug_report;
pub(crate) mod compaction;
pub(crate) mod drafts;
pub(crate) mod history;
pub(crate) mod journal;
pub(crate) mod link_metadata;
pub(crate) mod logging;
pub(crate) mod mcp;
pub(crate) mod notifier;
pub(crate) mod pages;
pub(crate) mod properties;
pub(crate) mod queries;
pub(crate) mod recovery;
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
    read_attachment_inner, rename_attachment, rename_attachment_inner,
};
pub use blocks::{
    CreateBlockSpec, batch_resolve, batch_resolve_inner, count_trash, count_trash_inner,
    create_block, create_block_inner, create_block_inner_with_space, create_blocks_batch,
    create_blocks_batch_inner, delete_block, delete_block_inner, delete_blocks_by_ids,
    delete_blocks_by_ids_inner, edit_block, edit_block_inner, first_child_for_blocks,
    first_child_for_blocks_inner, get_active_block_inner, get_block, get_block_inner, get_blocks,
    get_blocks_inner, list_blocks, list_blocks_inner, list_trash, list_trash_inner, move_block,
    move_block_inner, move_blocks_to_space, move_blocks_to_space_inner, purge_all_deleted,
    purge_all_deleted_inner, purge_block, purge_block_inner, purge_blocks_by_ids,
    purge_blocks_by_ids_inner, restore_all_deleted, restore_all_deleted_inner, restore_block,
    restore_block_inner, restore_blocks_by_ids, restore_blocks_by_ids_inner,
    trash_descendant_counts, trash_descendant_counts_inner,
};
pub use bug_report::{
    BugReport, LogFileEntry, collect_bug_report_metadata, collect_bug_report_metadata_inner,
    read_logs_for_report, read_logs_for_report_inner,
};
pub use compaction::{
    CompactionResult, CompactionStatus, PageLink, RestoreToOpResult, compact_op_log_cmd,
    compact_op_log_cmd_inner, get_compaction_status, get_compaction_status_inner,
};
pub use drafts::{
    FlushAllDraftsResult, delete_draft, flush_all_drafts, flush_all_drafts_inner, flush_draft,
    flush_draft_inner, list_drafts, list_drafts_inner, save_draft,
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
    McpRwStatus, McpRwToggleGate, McpStatus, McpToggleGate, get_mcp_rw_socket_path,
    get_mcp_rw_socket_path_inner, get_mcp_rw_status, get_mcp_rw_status_inner, get_mcp_socket_path,
    get_mcp_socket_path_inner, get_mcp_status, get_mcp_status_inner, mcp_disconnect_all,
    mcp_disconnect_all_inner, mcp_rw_disconnect_all, mcp_rw_disconnect_all_inner,
    mcp_rw_set_enabled, mcp_rw_set_enabled_inner, mcp_set_enabled, mcp_set_enabled_inner,
};
pub use pages::{
    MCP_PAGE_LIMIT_CAP, PageHeading, PageSubtreeResponse, export_page_markdown,
    export_page_markdown_inner, get_page_aliases, get_page_aliases_inner, get_page_inner,
    get_page_unscoped_inner, import_markdown, import_markdown_inner, import_markdown_with_progress,
    list_all_pages_in_space, list_all_pages_in_space_inner, list_page_aliases_by_prefix,
    list_page_aliases_by_prefix_inner, list_page_links, list_page_links_inner,
    list_page_links_inner_split, list_pages_inner, list_template_page_ids_in_space,
    list_template_page_ids_in_space_inner, load_page_subtree, load_page_subtree_inner,
    resolve_page_by_alias, resolve_page_by_alias_inner, set_page_aliases, set_page_aliases_inner,
};
pub use properties::{
    create_property_def, create_property_def_inner, delete_property, delete_property_def,
    delete_property_def_inner, delete_property_inner, get_batch_properties,
    get_batch_properties_inner, get_properties, get_properties_inner, get_property,
    get_property_def, get_property_def_inner, get_property_inner, list_property_defs,
    list_property_defs_inner, list_property_keys, list_property_keys_inner, list_property_values,
    list_property_values_inner, set_due_date, set_due_date_inner, set_priority, set_priority_inner,
    set_property, set_property_inner, set_scheduled_date, set_scheduled_date_inner, set_todo_state,
    set_todo_state_batch, set_todo_state_batch_inner, set_todo_state_inner,
    update_property_def_options, update_property_def_options_inner,
};
pub use queries::{
    DateFilter, DateOp, MatchOffset, NamedDateRange, PropertyFilter, SearchBlockRow, SearchFilter,
    SearchPropertyFilter, TagFilterExpr, count_backlinks_batch, count_backlinks_batch_inner,
    filtered_blocks_query, filtered_blocks_query_inner, get_backlinks, get_backlinks_inner,
    get_status, get_status_inner, list_backlinks_grouped, list_backlinks_grouped_inner,
    list_unfinished_tasks, list_unfinished_tasks_inner, list_unlinked_references,
    list_unlinked_references_inner, query_backlinks_filtered, query_backlinks_filtered_inner,
    query_by_property, query_by_property_inner, search_blocks, search_blocks_inner,
};
pub use recovery::get_recovery_status;
pub use spaces::{
    McpSpaceRow, SpaceRow, create_page_in_space, create_page_in_space_inner, create_space,
    create_space_inner, list_spaces, list_spaces_inner, list_spaces_registry_inner,
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
    list_all_tags_in_space_inner, list_inherited_tags_for_block,
    list_inherited_tags_for_block_inner, list_tags_by_prefix, list_tags_by_prefix_inner,
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
    __specta__fn__list_property_defs, __specta__fn__list_property_keys,
    __specta__fn__list_property_values, __specta__fn__set_due_date, __specta__fn__set_priority,
    __specta__fn__set_property, __specta__fn__set_scheduled_date, __specta__fn__set_todo_state,
    __specta__fn__set_todo_state_batch, __specta__fn__update_property_def_options,
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
pub use recovery::__specta__fn__get_recovery_status;
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
    __specta__fn__list_inherited_tags_for_block, __specta__fn__list_tags_by_prefix,
    __specta__fn__list_tags_for_block, __specta__fn__query_by_tags, __specta__fn__remove_tag,
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
    __cmd__list_property_values, __cmd__set_due_date, __cmd__set_priority, __cmd__set_property,
    __cmd__set_scheduled_date, __cmd__set_todo_state, __cmd__set_todo_state_batch,
    __cmd__update_property_def_options,
};
#[doc(hidden)]
pub use queries::{
    __cmd__count_backlinks_batch, __cmd__filtered_blocks_query, __cmd__get_backlinks,
    __cmd__get_status, __cmd__list_backlinks_grouped, __cmd__list_unfinished_tasks,
    __cmd__list_unlinked_references, __cmd__query_backlinks_filtered, __cmd__query_by_property,
    __cmd__search_blocks,
};
#[doc(hidden)]
pub use recovery::__cmd__get_recovery_status;
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
    __cmd__list_inherited_tags_for_block, __cmd__list_tags_by_prefix, __cmd__list_tags_for_block,
    __cmd__query_by_tags, __cmd__remove_tag,
};

// pub(crate) helpers used by other crate modules (e.g. recurrence.rs)
// #882: `create_block_in_tx` / `set_property_in_tx` moved to the neutral
// `crate::domain::block_ops` layer (removing the residual
// `recurrence → commands` / `spaces → commands` upward edges). Re-export
// keeps `crate::commands::{create_block_in_tx, set_property_in_tx}` and the
// ~20 command-internal callers (journal/pages/spaces/properties, via the
// `super::*` glob) churn-free. `delete_property_in_tx` still lives in
// `commands::blocks`.
pub(crate) use crate::domain::block_ops::{create_block_in_tx, set_property_in_tx};
pub(crate) use blocks::delete_property_in_tx;
// #642: `is_valid_iso_date` (+ its delegate `validate_date_format`) moved to
// the neutral `crate::domain::block_ops` layer. Re-export keeps the
// `crate::commands::is_valid_iso_date` / `crate::commands::validate_date_format`
// paths and every unqualified command-internal caller (via the `super::*`
// glob) churn-free; `recurrence` now imports `is_valid_iso_date` directly
// from `crate::domain::block_ops`.
pub(crate) use crate::domain::block_ops::{is_valid_iso_date, validate_date_format};

// #882: `MAX_CONTENT_LENGTH` / `MAX_BLOCK_DEPTH` moved alongside
// `create_block_in_tx` into `crate::domain::block_ops`. Re-export keeps
// `crate::commands::MAX_CONTENT_LENGTH` (MCP #699, tests) and every
// glob-internal caller (`move_ops.rs`, `drafts.rs`) resolving unchanged.
pub(crate) use crate::domain::block_ops::{MAX_BLOCK_DEPTH, MAX_CONTENT_LENGTH};

/// Upper bound on how many block ids a single `*_by_ids` / batch command
/// will accept. Resolving in one `json_each(?1)` membership query under a
/// single `BEGIN IMMEDIATE` transaction means the whole batch holds the
/// writer lock for its duration; a runaway caller (or a malicious MCP tool)
/// could otherwise hold the writer lock for an unbounded interval while
/// writing thousands of op_log rows. 1000 covers every realistic UI
/// multi-select gesture (TrashView caps its own table to a few hundred rows;
/// the page editor's multi-select fans the same way). Callers exceeding the
/// cap should chunk client-side — the FE wrappers in `src/lib/tauri.ts`
/// deliberately pass the input through unchanged so the backend's cap is the
/// single authority.
///
/// This is the single source of truth for the limit across the whole
/// `*_by_ids` / batch family (`restore_blocks_by_ids_inner`,
/// `set_todo_state_batch_inner`, `delete_blocks_by_ids_inner`,
/// `get_blocks_inner`, `add_tags_by_ids_inner`, `create_blocks_batch_inner`,
/// `move_blocks_to_space_inner`, and any future `*_by_ids` siblings) so the
/// limit is not silently inconsistent across the family. Most sites enforce
/// it via [`ensure_batch_within_cap`].
pub(crate) const MAX_BATCH_BLOCK_IDS: usize = 1000;

/// Reject an over-cap batch with the canonical
/// `"{subject} length {len} exceeds maximum {MAX_BATCH_BLOCK_IDS}"`
/// [`AppError::Validation`] message, sharing the [`MAX_BATCH_BLOCK_IDS`]
/// guard across the `*_by_ids` / batch family.
///
/// `subject` is the noun used in the message (e.g. `"block_ids"`, `"ids"`,
/// `"specs"`) so each call site keeps its existing, verbatim error text.
/// Callers still perform their own empty-list check separately; this helper
/// only covers the upper-bound branch.
pub(crate) fn ensure_batch_within_cap(subject: &str, len: usize) -> Result<(), AppError> {
    if len > MAX_BATCH_BLOCK_IDS {
        return Err(AppError::Validation(format!(
            "{subject} length {len} exceeds maximum {MAX_BATCH_BLOCK_IDS}"
        )));
    }
    Ok(())
}

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

// #642: `validate_date_format` moved to `crate::domain::block_ops` (pure;
// `AppError` + `chrono` only) and is re-exported above so the unqualified
// command-internal callers (agenda / journal / blocks::queries) keep
// resolving it via the `super::*` glob unchanged.

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
    /// #738 sub-2 — push `b.todo_state NOT IN (...)` into SQL so the
    /// DuePanel's overdue query can exclude completed (`DONE`) tasks at
    /// the database layer instead of post-filtering a capped page. NULL
    /// `todo_state` rows are retained (only the listed states are
    /// dropped). `None` / empty preserves the unfiltered behaviour.
    pub exclude_todo_states: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct DeleteResponse {
    pub block_id: String,
    pub deleted_at: i64,
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
    /// Epoch-ms (attachments.created_at is INTEGER since migration 0081).
    pub created_at: i64,
    /// blake3 hex digest of the file bytes (#1453 Phase 1). Same scheme as the
    /// file-sync layer (`sync_files.rs`), so it matches the sync offer's hash.
    ///
    /// `None` for rows attached before migration 0093, or whose file was
    /// missing on disk when the boot-time backfill ran. Persisted only — the
    /// dedup / skip-transfer / mutation-safety USES of it are follow-ups.
    #[serde(default)]
    pub content_hash: Option<String>,
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
///
/// #663 — takes a [`BlockId`] (not a raw `String`) so the ULID is
/// normalised to canonical uppercase before it reaches SQL, matching every
/// other `BlockId`-typed sibling command. A lowercase id from a caller used
/// to miss the (uppercase) `op_log.block_id` rows and return an empty
/// history silently.
pub async fn get_block_history_inner(
    pool: &SqlitePool,
    block_id: BlockId,
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

    // 2. Validate block exists and is not deleted (TOCTOU-safe).
    //    #1627: authoritative activeness gate now that the redundant
    //    pre-tx `verify_active` round-trip on the pool has been dropped
    //    from the command wrappers. Fetch `deleted_at` (no WHERE filter)
    //    so this one read reproduces `verify_active`'s EXACT distinct
    //    NotFound vs soft-deleted errors.
    let row = sqlx::query!(r#"SELECT deleted_at FROM blocks WHERE id = ?"#, block_id)
        .fetch_optional(&mut **tx)
        .await?;
    let row =
        row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}' does not exist")))?;
    if row.deleted_at.is_some() {
        return Err(AppError::Validation(format!(
            "block '{block_id}' has been soft-deleted"
        )));
    }

    // 3. Append DeleteProperty op
    let del_payload = DeletePropertyPayload {
        block_id: BlockId::from_trusted(&block_id),
        key: key.clone(),
    };
    let op_record = op_log::append_local_op_in_tx(
        &mut tx,
        device_id,
        OpPayload::DeleteProperty(del_payload.clone()),
        crate::db::now_ms(),
    )
    .await?;

    // 4. #1257 PR-3: route the clear/delete through the SAME engine-apply +
    // projection the boot-replay / sync `ApplyOp` path uses, IN this CommandTx,
    // INSTEAD of the inline reserved-column / `space` fan-out / `block_properties`
    // DELETE branches. `apply_delete_property_via_loro` resolves the block's
    // space, removes the key from the per-space Loro engine (sync guard, dropped
    // before any `.await`), then `project_delete_property_to_sql` runs the
    // IDENTICAL per-key SQL (reserved → column NULL; `space` → the `space_id`
    // page-group clear; non-reserved → `DELETE FROM block_properties`). We do NOT
    // call `apply_op_tx` / `advance_apply_cursor`: the apply cursor stays put on
    // the LOCAL path so boot replay re-applies idempotently (the safety net —
    // #1257). If the engine can't be resolved (space unresolvable / engine
    // uninitialised — e.g. a test without `install_for_test`), the helper FALLS
    // BACK to `apply_delete_property_sql_only`, which runs the SAME projection —
    // so the clear is never skipped and we never crash.
    crate::materializer::apply_delete_property_via_loro(&mut tx, device_id, &del_payload).await?;

    // 5. Dispatch background cache tasks after commit (fire-and-forget).
    tx.enqueue_background(Arc::new(op_record));
    tx.commit_and_dispatch(materializer).await?;

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
    /// Epoch-ms (blocks.deleted_at is INTEGER since migration 0080).
    deleted_at: Option<i64>,
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
            deleted_at: self.deleted_at,
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
pub(crate) fn sanitize_internal_error(err: AppError) -> AppError {
    match &err {
        AppError::Database(_)
        | AppError::Migration(_)
        | AppError::Io(_)
        | AppError::Json(_)
        | AppError::Channel(_)
        | AppError::Internal(_)
        | AppError::Snapshot(_) => {
            tracing::warn!(error = %err, "internal error suppressed during sanitization");
            AppError::InvalidOperation("an internal error occurred".into())
        }
        _ => err,
    }
}

/// Tauri command: list op-log history for a block. Delegates to [`get_block_history_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_block_history(
    pool: State<'_, ReadPool>,
    block_id: String,
    op_type_filter: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    // #663 — normalise the IPC-boundary `String` to a canonical-case
    // `BlockId` before it reaches SQL. The command signature stays `String`
    // so the generated TS bindings are unchanged.
    get_block_history_inner(
        &pool.0,
        BlockId::from(block_id),
        op_type_filter,
        cursor,
        limit,
    )
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
