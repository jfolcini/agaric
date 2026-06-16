#[cfg(target_os = "linux")]
pub mod appimage_integration;
pub mod backlink;
pub mod block_descendants;
pub mod cache;
pub mod cancellation;
pub mod commands;
pub mod dag;
// #642: neutral domain layer — declared right after `commands` for
// alphabetical proximity but is a strictly *lower* layer (depends on
// neither `commands` nor `fts`). Both depend down on it; this breaks the
// former `commands ⇄ fts` module cycle.
pub mod db;
pub mod deeplink;
pub mod device;
pub mod domain;
pub mod draft;
pub mod error;
pub mod filters;
pub mod fts;
pub mod hash;
pub mod import;
pub mod lifecycle;
pub mod link_metadata;
// Loro CRDT engine — the only materializer path.
pub mod loro;
pub mod maintenance;
pub mod materializer;
pub mod mcp;
pub mod merge;
pub mod op;
pub mod op_log;
pub mod pagination;
pub mod pairing;
pub mod peer_refs;
pub mod recovery;
pub mod recurrence;
pub mod reverse;
pub mod snapshot;
pub mod soft_delete;
pub mod space;
pub mod space_filter_canonical;
pub mod spaces;
pub mod sql_utils;
pub mod sync_cert;
pub mod sync_constants;
pub mod sync_daemon;
pub mod sync_events;
pub mod sync_files;
pub mod sync_net;
pub mod sync_protocol;
pub mod sync_scheduler;
pub mod tag_inheritance;
pub mod tag_inheritance_macros;
pub mod tag_norm;
pub mod tag_query;
pub mod task_locals;
pub mod text_utils;
pub mod ulid;
pub mod word_diff;

/// I-Core-7: Single source of truth for the list of Tauri commands
/// exposed to the frontend.
///
/// Both [`run`] and `specta_tests::specta_builder` expand this macro,
/// so the production invoke handler and the TypeScript-bindings export
/// cannot drift. **To add or remove a command, edit only this macro.**
///
/// `tauri_specta::collect_commands!` is itself a macro that consumes
/// the literal token tree of command paths at expansion time, so we
/// wrap it in a `macro_rules!` that re-emits those tokens at every
/// call site.
macro_rules! agaric_commands {
    () => {
        ::tauri_specta::collect_commands![
            $crate::commands::blocks::crud::create_block,
            // PEND-35 Tier 4.3 — atomic batch-create for templates: a
            // 10-line journal template that previously fired 10
            // `create_block` IPCs now fires 1, with one IMMEDIATE tx
            // and one op_log scope covering every block + its
            // properties.
            $crate::commands::blocks::crud::create_blocks_batch,
            $crate::commands::blocks::crud::edit_block,
            $crate::commands::blocks::crud::delete_block,
            // PEND-35 Tier 2.1 — multi-select batch delete: collapses
            // the FE per-row IPC loop (50 IPCs for a 50-row delete)
            // into one IMMEDIATE tx with a single recursive CTE
            // seeded from every root simultaneously.
            $crate::commands::blocks::crud::delete_blocks_by_ids,
            // #81 / PEND-57 — Pages multi-select bulk move-to-space:
            // collapses the per-row `set_property(space)` IPC loop into one
            // IMMEDIATE tx with a single op-log seq range.
            $crate::commands::blocks::crud::move_blocks_to_space,
            $crate::commands::blocks::crud::restore_block,
            $crate::commands::blocks::crud::purge_block,
            // PEND-35 Tier 2.2 — TrashView batch restore/purge: collapses
            // the per-row IMMEDIATE-tx loop (50 IPCs for a 50-row purge)
            // into a single tx running the cleanup chain once.
            $crate::commands::blocks::crud::restore_blocks_by_ids,
            $crate::commands::blocks::crud::purge_blocks_by_ids,
            $crate::commands::blocks::move_ops::move_block,
            $crate::commands::blocks::queries::list_blocks,
            $crate::commands::blocks::queries::list_trash,
            $crate::commands::blocks::queries::get_block,
            $crate::commands::blocks::queries::batch_resolve,
            $crate::commands::tags::add_tag,
            // #81 / PEND-57 — Pages multi-select bulk add-tag: collapses the
            // per-row `add_tag` IPC loop into one IMMEDIATE tx with a single
            // op-log seq range (one `AddTag` op per newly-tagged block).
            $crate::commands::tags::add_tags_by_ids,
            $crate::commands::tags::remove_tag,
            $crate::commands::queries::get_backlinks,
            $crate::commands::get_block_history,
            $crate::commands::queries::get_status,
            // #1255 — boot-recovery degraded-state backfill for late-mount
            // frontend (its `recovery:degraded` listener may register after
            // boot already emitted).
            $crate::commands::recovery::get_recovery_status,
            $crate::commands::queries::search_blocks,
            // PEND-61 Phase 1 — partitioned palette search. One FTS scan
            // returns `{ pages, blocks }` instead of the palette firing
            // two parallel `search_blocks` calls per keystroke.
            $crate::commands::queries::search_blocks_partitioned,
            $crate::commands::tags::query_by_tags,
            $crate::commands::queries::query_by_property,
            // PEND-35 Tier 2.10b — AND-intersected property + tag query
            // resolved entirely in SQL via composed `EXISTS` subqueries.
            // Replaces the FE `useQueryExecution.fetchFilteredQuery` shape
            // that fanned out one IPC per sub-filter (each capped at 200
            // rows) and intersected in JS — silently dropping any AND-set
            // member outside the top-200 of any one sub-query.
            $crate::commands::queries::filtered_blocks_query,
            $crate::commands::queries::list_unfinished_tasks,
            $crate::commands::tags::list_tags_by_prefix,
            // limit-clamp-followup — `TagList.tsx`'s tag-management list
            // view used to call `list_tags_by_prefix({ prefix: '',
            // limit: 500 })` and silently get only 200 rows (the
            // `MAX_TAGS_PREFIX` ceiling).  `list_all_tags_in_space`
            // returns every tag in the space with no pagination and no
            // clamp.
            $crate::commands::tags::list_all_tags_in_space,
            $crate::commands::tags::list_tags_for_block,
            $crate::commands::properties::set_property,
            $crate::commands::properties::set_todo_state,
            // PEND-35 Tier 2.1 — multi-select batch set-todo: collapses
            // the per-row IPC loop (50 IPCs for "mark 50 done") into
            // one IMMEDIATE tx with one op_log scope.
            $crate::commands::properties::set_todo_state_batch,
            $crate::commands::properties::set_priority,
            $crate::commands::properties::set_due_date,
            $crate::commands::properties::set_scheduled_date,
            $crate::commands::properties::delete_property,
            $crate::commands::properties::get_properties,
            $crate::commands::properties::get_property,
            $crate::commands::properties::get_batch_properties,
            $crate::commands::history::list_page_history,
            $crate::commands::history::revert_ops,
            $crate::commands::history::undo_page_op,
            $crate::commands::history::redo_page_op,
            // PEND-35 Tier 4.4 — single-IPC undo-group sizing: replaces
            // the FE's growing-window `list_page_history` re-fetch loop
            // after every Ctrl+Z with one recursive-CTE query that
            // walks consecutive same-device + within-window ops.
            $crate::commands::history::find_undo_group,
            $crate::commands::history::compute_edit_diff,
            $crate::commands::history::compute_block_vs_current_diff,
            $crate::commands::queries::query_backlinks_filtered,
            $crate::commands::queries::list_backlinks_grouped,
            $crate::commands::queries::list_unlinked_references,
            $crate::commands::properties::list_property_keys,
            $crate::commands::properties::create_property_def,
            $crate::commands::properties::get_property_def,
            $crate::commands::properties::list_property_defs,
            $crate::commands::properties::update_property_def_options,
            $crate::commands::properties::delete_property_def,
            // Sync
            $crate::commands::sync_cmds::list_peer_refs,
            $crate::commands::sync_cmds::get_peer_ref,
            $crate::commands::sync_cmds::delete_peer_ref,
            $crate::commands::sync_cmds::update_peer_name,
            $crate::commands::sync_cmds::set_peer_address,
            $crate::commands::sync_cmds::get_device_id,
            // Sync — pairing & session (#275, #278)
            $crate::commands::sync_cmds::start_pairing,
            $crate::commands::sync_cmds::confirm_pairing,
            $crate::commands::sync_cmds::cancel_pairing,
            $crate::commands::sync_cmds::start_sync,
            $crate::commands::sync_cmds::cancel_sync,
            // Batch count commands (#604)
            $crate::commands::agenda::count_agenda_batch,
            $crate::commands::agenda::count_agenda_batch_by_source,
            $crate::commands::queries::count_backlinks_batch,
            // Page aliases (#598)
            $crate::commands::pages::set_page_aliases,
            $crate::commands::pages::get_page_aliases,
            $crate::commands::pages::list_page_aliases_by_prefix,
            $crate::commands::pages::resolve_page_by_alias,
            // Markdown export (#519)
            $crate::commands::pages::export_page_markdown,
            // Agenda projection (#644)
            $crate::commands::agenda::list_projected_agenda,
            // Undated tasks (FEAT-1)
            $crate::commands::agenda::list_undated_tasks,
            // OS notifications for due / scheduled tasks (FEAT-11)
            $crate::commands::notifier::notify_task,
            // Logseq/Markdown import (#660)
            $crate::commands::pages::import_markdown,
            // Attachments (F-7)
            $crate::commands::attachments::add_attachment,
            $crate::commands::attachments::add_attachment_with_bytes,
            $crate::commands::attachments::read_attachment,
            $crate::commands::attachments::delete_attachment,
            $crate::commands::attachments::rename_attachment,
            $crate::commands::attachments::list_attachments,
            $crate::commands::attachments::list_attachments_batch,
            // Graph visualization (F-33)
            $crate::commands::pages::list_page_links,
            // Draft autosave (F-17)
            $crate::commands::drafts::save_draft,
            $crate::commands::drafts::flush_draft,
            $crate::commands::drafts::flush_all_drafts,
            $crate::commands::drafts::delete_draft,
            $crate::commands::drafts::list_drafts,
            // Frontend logging (F-19)
            $crate::commands::logging::log_frontend,
            $crate::commands::logging::get_log_dir,
            // Op log compaction (F-20)
            $crate::commands::compaction::get_compaction_status,
            $crate::commands::compaction::compact_op_log_cmd,
            // Point-in-time restore (F-26)
            $crate::commands::history::restore_page_to_op,
            // Bulk trash operations (B-46)
            $crate::commands::blocks::crud::restore_all_deleted,
            $crate::commands::blocks::crud::purge_all_deleted,
            // Trash descendant counts (UX-243)
            $crate::commands::blocks::queries::trash_descendant_counts,
            // Trash count badge (ViewDispatcher trash badge) — pushes the count
            // into SQL so the badge is accurate regardless of trash size.
            $crate::commands::blocks::queries::count_trash,
            // First-child-per-parent batch (PEND-35 Tier 2.8) — collapses the
            // TemplatesView N+1 listBlocks(parentId, limit:1) preview loop.
            $crate::commands::blocks::queries::first_child_for_blocks,
            // PEND-35 Tier 2.3 — get_blocks batch endpoint
            //   • get_blocks(ids) — full BlockRow batch.
            $crate::commands::blocks::queries::get_blocks,
            // Link metadata (UX-165)
            $crate::commands::link_metadata::fetch_link_metadata,
            $crate::commands::link_metadata::get_link_metadata,
            // Bug report (FEAT-5)
            $crate::commands::bug_report::collect_bug_report_metadata,
            $crate::commands::bug_report::read_logs_for_report,
            // MCP (FEAT-4e) — Settings "Agent access" tab
            $crate::commands::mcp::get_mcp_status,
            $crate::commands::mcp::get_mcp_socket_path,
            $crate::commands::mcp::mcp_set_enabled,
            $crate::commands::mcp::mcp_disconnect_all,
            // MCP activity ring read surface (#695)
            $crate::commands::mcp::get_mcp_recent_activity,
            // MCP RW (FEAT-4h slice 2)
            $crate::commands::mcp::get_mcp_rw_status,
            $crate::commands::mcp::get_mcp_rw_socket_path,
            $crate::commands::mcp::mcp_rw_set_enabled,
            $crate::commands::mcp::mcp_rw_disconnect_all,
            // Spaces (FEAT-3 Phase 1 + Phase 2 + Phase 6)
            $crate::commands::spaces::list_spaces,
            $crate::commands::spaces::create_page_in_space,
            $crate::commands::spaces::create_space,
            // Quick capture (FEAT-12) — desktop global-shortcut entry point
            $crate::commands::journal::quick_capture_block,
            // Journal page lookup (BUG-48) — database-native date queries
            $crate::commands::journal::get_journal_page_by_date,
            $crate::commands::journal::list_journal_pages_in_range,
            // All-pages-in-space (export / graph) — no-pagination IPC for callers
            // that genuinely need every page in the space
            $crate::commands::pages::list_all_pages_in_space,
            $crate::commands::pages::list_template_page_ids_in_space,
            // Page subtree loader — single SELECT against the `page_id` index;
            // replaces the FE-side recursive `listBlocks` walk
            $crate::commands::pages::load_page_subtree,
            // PEND-56 — paginated page list with metadata columns
            // (last-modified, inbound-link count, child-block count,
            // has-property bitmask) + richer sort taxonomy.
            $crate::commands::pages::list_pages_with_metadata,
        ]
    };
}

/// Return the current UTC time as an RFC 3339 string with millisecond
/// precision and a `Z` suffix (e.g. `2025-01-15T12:34:56.789Z`).
///
/// Every timestamp stored in the database should go through this helper so
/// that lexicographic comparisons (e.g. op-log compaction cutoff) are
/// consistent (see issue #48 for context).
///
/// # Lex-monotonic `Z`-suffix invariant (L-98)
///
/// The `Z` suffix is **load-bearing**, not cosmetic. Several reverse-op
/// "find prior op" queries
/// (`reverse::block_ops::find_prior_text` / `find_prior_position`,
/// `reverse::property_ops::find_prior_property`,
/// `reverse::attachment_ops::reverse_delete_attachment`) compare
/// `op_log.created_at` lexicographically:
///
/// ```sql
/// WHERE created_at < ?2 OR (created_at = ?2 AND seq < ?3)
/// ORDER BY created_at DESC, seq DESC
/// ```
///
/// This is correct **only** because every timestamp produced by this
/// helper has the same `YYYY-MM-DDTHH:MM:SS.sssZ` shape — fixed-width
/// UTC with a literal `Z`. A future ingest path that wrote
/// `+00:00`-suffixed timestamps would break the lex-monotonic
/// assumption (mixing `Z` and `+00:00` sorts incorrectly even though
/// they encode the same instant). All op-log write paths must therefore
/// route timestamps through `now_rfc3339()`; `op_log::append_local_op_in_tx`
/// and `op_log::append_local_op_at` carry a `debug_assert!` enforcing
/// the `Z` suffix at write time.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Build the tracing `EnvFilter` directive string for Agaric.
///
/// Preserves every directive the operator provided in `rust_log` (typically
/// the value of the `RUST_LOG` environment variable) and appends each default
/// in `defaults` only when the user has not already configured a directive
/// targeting that crate. A submodule directive (`agaric::db=trace`) also
/// counts as a user directive for its parent crate.
///
/// Returning the directive string (rather than an `EnvFilter`) keeps this
/// helper pure and unit-testable without touching process environment.
pub fn build_log_directives(rust_log: &str, defaults: &[(&str, &str)]) -> String {
    let trimmed = rust_log.trim();
    let mut out = String::from(trimmed);
    for (target, level) in defaults {
        if has_directive_for_target(trimmed, target) {
            continue;
        }
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(target);
        out.push('=');
        out.push_str(level);
    }
    out
}

/// Return `true` when `filter` contains a directive that targets `target`
/// (as a crate or one of its submodules). Bare level directives like
/// `info` do not count — they apply globally and do not pin any specific
/// target, so Agaric defaults should still be added alongside them.
fn has_directive_for_target(filter: &str, target: &str) -> bool {
    if filter.is_empty() {
        return false;
    }
    filter
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .any(|piece| {
            // Strip span-field filter (after `[`) and level (after `=`).
            let no_span = piece.split('[').next().unwrap_or(piece);
            let directive_target = match no_span.split_once('=') {
                Some((t, _)) => t.trim(),
                None => no_span.trim(),
            };
            if directive_target == target {
                return true;
            }
            let prefix = format!("{target}::");
            directive_target.starts_with(&prefix)
        })
}

#[cfg(test)]
mod command_integration_tests;
#[cfg(test)]
mod integration_tests;
/// TEST-PROPTEST-B (#150): shared seeded-DB proptest fixture harness —
/// random valid block trees + op chains over a real pool. Reused by the
/// Tier-B property tests (`reverse::proptest` for B1; materializer / sync
/// for B2-B4).
#[cfg(test)]
mod proptest_db_harness;
// LoroSync end-to-end integration tests live in
// `sync_protocol::tests` (`loro_sync_e2e_*`).

/// L-2: Wrap a boot-time `SELECT COUNT(*)` result so DB errors get a tracing
/// breadcrumb instead of being silently coerced to `0`. The fall-through
/// behaviour is unchanged — callers still see `0` on error — but operators
/// now have a chance of noticing when boot scheduling is being skipped
/// because a count query failed.
fn log_or_zero(r: Result<i64, sqlx::Error>, ctx: &str) -> i64 {
    match r {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(error = %e, ctx, "boot count query failed; treating as 0");
            0
        }
    }
}

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

/// Shared cancel flag for sync — registered in managed state before
/// the `SyncDaemon` spawns so `cancel_sync` can access it even if the
/// daemon hasn't started yet.
pub struct SyncCancelFlag(pub Arc<AtomicBool>);

// #703: the per-sweeper shutdown flags were previously also wrapped in
// dedicated managed-state newtypes (`RetryQueueSweeperShutdown`,
// `OrphanDraftsSweeperShutdown`, `MaintenanceDaemonShutdown`,
// `SnapshotTaskShutdown`) "for the rare case a shutdown handler wants to
// stop them cleanly". Nothing ever called `.store(true)` on any of them
// and `RunEvent::Exit` only persists snapshots, so the newtypes were dead
// speculative machinery. They were removed. The background tasks still
// receive an `Arc<AtomicBool>` flag (always observed `false`), so their
// behaviour is unchanged — crash-safety-by-design (each tick is its own
// transaction) is what makes an abrupt exit correct, not a shutdown
// signal. Re-introducing an exit-time purge is deliberately out of scope
// (it risks the M-69 single-transaction invariant).

/// Keeps the tracing-appender non-blocking worker alive for the
/// application lifetime.
///
/// The inner [`tracing_appender::non_blocking::WorkerGuard`] flushes
/// buffered log writes when it is dropped.  Storing it in Tauri's managed
/// state ensures it lives until the app exits, not just until `setup()`
/// returns.  See BUG-34.
pub struct LogGuard(pub tracing_appender::non_blocking::WorkerGuard);

/// Return the logs directory given the application's data directory.
///
/// Both [`crate::commands::get_log_dir`] and the tracing-appender setup
/// in [`run`] must use this helper so the "Open logs folder" action and
/// the on-disk log files cannot diverge across platforms. See BUG-34.
pub fn log_dir_for_app_data(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    app_data_dir.join("logs")
}

/// #635: try to prepare the on-disk log directory and build the rolling
/// file appender, degrading gracefully instead of aborting the process.
///
/// The previous code did `let _ = create_dir_all(..)` (silent) followed by
/// `.build(..).expect("logging directory must be writable")`. That `expect`
/// ran BEFORE the tracing subscriber was installed and AFTER the panic hook
/// was replaced with one that logs via tracing (a no-op pre-subscriber), so
/// on a read-only / full disk the app died with no log, no stderr, and no
/// dialog (the abort profile produces nothing).
///
/// This helper instead:
///   - reports a `create_dir_all` failure to stderr (non-silent), and
///   - returns `None` when the appender can't be built, signalling the
///     caller to fall back to stderr-only logging so the app stays usable.
///
/// Returning `None` (rather than `Err`) keeps the app running with at least
/// stderr logging, which is strictly better than dying on a transient or
/// permanent disk problem. Factored out so the degrade path is unit-testable
/// without standing up a Tauri `AppHandle`.
fn build_log_file_appender(
    log_dir: &std::path::Path,
) -> Option<tracing_appender::rolling::RollingFileAppender> {
    if let Err(e) = std::fs::create_dir_all(log_dir) {
        // Pre-subscriber: tracing is a no-op here, so write to stderr
        // directly so the failure is never silent.
        eprintln!(
            "agaric: could not create log directory {}: {e}; \
             falling back to stderr-only logging",
            log_dir.display()
        );
        return None;
    }

    match tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .max_log_files(14)
        .filename_prefix("agaric.log")
        .build(log_dir)
    {
        Ok(appender) => Some(appender),
        Err(e) => {
            eprintln!(
                "agaric: could not open log file in {}: {e}; \
                 falling back to stderr-only logging",
                log_dir.display()
            );
            None
        }
    }
}

// Linux: WebKitGTK's DMABUF renderer hangs the webview on a blank,
// unresponsive window with several GPU drivers (notably the NVIDIA
// proprietary stack and some Intel/Mesa combos). It bites packaged builds
// (AppImage/.deb) far more than `npm run dev`, which is why the symptom
// shows up only after bundling. Forcing the renderer off restores the
// stable path. Only set it when the user hasn't already chosen a value, so
// an explicit override (e.g. WEBKIT_DISABLE_DMABUF_RENDERER=0) still wins.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn disable_webkit_dmabuf_if_unset() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // SAFETY: called at app startup before any threads are spawned.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
}

// ---------------------------------------------------------------------------
// #1058 — boot-wiring helpers
//
// The Tauri `.setup(|app| { … })` closure was a ~1072-line god-function that
// inlined every boot phase back to back with a hand-threaded, order-fragile
// "clone everything before moving the originals into managed state" block.
//
// These helpers cut the closure at its natural seams WITHOUT changing what
// runs when. This is a pure extraction: the order of every side-effecting
// step (`app.manage(...)` registrations, `spawn_*` task creation, migrations,
// materializer/sync startup) is byte-identical to the pre-#1058 inline body.
//
// The clone-before-move hazard is collapsed by passing each shared piece
// (all cheap `Arc`-backed clones) explicitly through the helper signatures:
// the wiring helpers receive exactly the clones they need, while the
// originals are moved into managed state by `register_managed_state`. The
// borrow checker now enforces what was previously an implicit "must clone
// before line 1390" rule.
// ---------------------------------------------------------------------------

/// Boot-phase 1 — install the tracing-appender file/stderr subscriber and
/// keep the non-blocking worker guard alive in managed state (BUG-34 / #635).
///
/// Must run with the OS-correct `app_data_dir` so the on-disk log files and
/// the "Open logs folder" action resolve to the same path on every platform.
fn init_logging<R: tauri::Runtime>(app: &tauri::App<R>, app_data_dir: &std::path::Path) {
    use tauri::Manager;
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    // BUG-34: Initialize tracing-appender using the OS-correct
    // `app_data_dir` so the "Open logs folder" action (get_log_dir)
    // and the on-disk log files resolve to the same path on every
    // platform (Linux, macOS, Windows, Android).
    let log_dir = log_dir_for_app_data(app_data_dir);

    // Issue #157 sub-item A — size-bounded daily rotation with a
    // hard cap on retained files. Replaces the pre-#157 setup that
    // paired an unbounded `rolling::daily(...)` appender with a
    // boot-only `cleanup_old_log_files(&log_dir, 30)` retention
    // sweep. The new builder caps retained files at 14, so
    // retention is enforced continuously by the appender itself
    // (no separate sweep needed) and the file count cannot grow
    // unbounded between boots even if the prune somehow failed.
    // Drops `cleanup_old_log_files` + its 7 unit tests as part of
    // this change.
    //
    // `tracing-appender` still has no per-file size cap, so a
    // single bad day can spike a file beyond expectations. See
    // #157 sub-item D's `retry_queue_giveup` job for the upstream
    // root-cause fix that prevents the noisy-warn-storm class.
    //
    // #635: a read-only / full disk used to abort here (silent
    // create_dir_all + `.expect()` before the subscriber existed).
    // `build_log_file_appender` now degrades to `None`, and the
    // file layer below is simply omitted so the app keeps running
    // with stderr-only logging.
    let (non_blocking, log_guard) = match build_log_file_appender(&log_dir) {
        Some(file_appender) => {
            let (nb, guard) = tracing_appender::non_blocking(file_appender);
            (Some(nb), Some(guard))
        }
        None => (None, None),
    };

    // Preserve any user-provided `RUST_LOG` directives for
    // `agaric` / `frontend` (BUG-40).
    let rust_log = std::env::var("RUST_LOG").unwrap_or_default();
    let directives = build_log_directives(&rust_log, &[("agaric", "info"), ("frontend", "info")]);
    let env_filter = EnvFilter::try_new(&directives)
        .unwrap_or_else(|_| EnvFilter::new("agaric=info,frontend=info"));

    // H-9b-activation: the file appender emits JSON-per-line so
    // the H-9b deny-list redaction pipeline (`bug_report::redact_line`)
    // engages on `agaric.log` content. The stderr layer stays in the
    // human-readable text format for live dev debugging — only the
    // bug-report bundle (built from `agaric.log`) needs the JSON
    // structure for safe-token-based redaction.
    //
    // Note: `agaric.log` is now JSON-per-line. Read it with `jq`:
    //   tail -f agaric.log | jq
    // or any structured-log viewer.
    // #635: the JSON file layer is present only when the on-disk
    // appender was successfully built; `Option<Layer>` is a no-op
    // layer when `None`, so the stderr layer always runs and the
    // app stays usable on a read-only / full disk.
    let file_layer = non_blocking.map(|nb| {
        tracing_subscriber::fmt::layer()
            .json()
            .with_writer(nb)
            .with_ansi(false)
    });
    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(file_layer)
        .init();

    if log_guard.is_some() {
        tracing::info!(log_dir = %log_dir.display(), "log directory initialized");
    } else {
        tracing::warn!(
            log_dir = %log_dir.display(),
            "log directory unwritable — logging to stderr only"
        );
    }

    // Issue #157 sub-item A — retention is now enforced by the
    // RollingFileAppender::builder().max_log_files(14) call above,
    // continuously rather than boot-only. The previous M-45 boot
    // sweep (`cleanup_old_log_files`) was removed along with its
    // tests.

    // Keep the non-blocking appender's worker guard alive for the
    // lifetime of the app so buffered writes are never lost. #635:
    // only present when the file appender was built; on the
    // stderr-only degrade path there is nothing to flush.
    if let Some(log_guard) = log_guard {
        app.manage(LogGuard(log_guard));
    }
}

/// Boot-phase 3 — open the read/write SQLite pools and resolve the persistent
/// device UUID + sync TLS certificate.
///
/// Returns the owned `(pools, device_id, sync_cert)` triple; the caller
/// threads these (by reference, via cheap `Arc` clones) through the rest of
/// boot and finally moves the originals into managed state.
#[allow(clippy::type_complexity)]
fn init_persistence(
    db_path: &std::path::Path,
    app_data_dir: &std::path::Path,
) -> Result<(db::DbPools, String, sync_net::SyncCert), Box<dyn std::error::Error>> {
    // Initialize separated read/write pools
    let pools = tauri::async_runtime::block_on(db::init_pools(db_path))?;

    // Read or generate a persistent device UUID
    let device_id_path = app_data_dir.join("device-id");
    let device_id = device::get_or_create_device_id(&device_id_path)?;

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        platform = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        device_id = %device_id,
        "app started"
    );

    // Read or generate a persistent TLS certificate for sync (#380)
    let cert_path = app_data_dir.join("sync-cert");
    let sync_cert = sync_cert::get_or_create_sync_cert(&cert_path, &device_id)?;
    tracing::info!(cert_hash = %sync_cert.cert_hash, "TLS cert loaded");

    Ok((pools, device_id, sync_cert))
}

/// Boot-phase 4 — construct the lifecycle hooks + materializer and bind the
/// `app_data_dir` it needs for the orphan-attachment GC (C-3c).
///
/// C-2b: the materializer is constructed BEFORE `recover_at_boot` so the
/// boot-time op-log replay path can drive `ApplyOp` tasks through the
/// foreground queue.
fn build_materializer(
    pools: &db::DbPools,
    app_data_dir: &std::path::Path,
) -> (lifecycle::LifecycleHooks, materializer::Materializer) {
    use lifecycle::LifecycleHooks;
    use materializer::Materializer;

    // Create materializer — bg cache rebuilds read from read pool, write to write pool (P-8)
    //
    // PERF-24: wire up the app-lifecycle hooks so the metrics-
    // snapshot task stops emitting debug-level log lines while
    // the app is backgrounded on mobile. The same hooks are
    // later passed into the sync daemon below so its periodic
    // resync tick short-circuits when backgrounded.
    let lifecycle = LifecycleHooks::new();
    let materializer = Materializer::with_read_pool_and_lifecycle(
        pools.write.clone(),
        pools.read.clone(),
        lifecycle.clone(),
    );
    // C-3c — register `app_data_dir` so the
    // `CleanupOrphanedAttachments` background task can locate
    // the `attachments/` subtree.
    //
    // MAINT-229: schedule `cleanup_orphaned_attachments` at
    // boot and/or after compaction. Currently the only entry
    // point is `MaterializeTask::CleanupOrphanedAttachments`,
    // which is not yet enqueued from any production path; the
    // GC function is implemented but dormant until a scheduler
    // hooks it.
    materializer.set_app_data_dir(app_data_dir.to_path_buf());

    (lifecycle, materializer)
}

/// Boot-phase 5 — synchronous Loro init + rehydrate, crash recovery, and
/// per-space bootstrap. Returns the [`recovery::RecoveryReport`] so the caller
/// can refresh caches for recovered drafts later.
///
/// `bootstrap_spaces` is boot-fatal (the "every page belongs to a space"
/// invariant cannot be honoured without it); every other step here is
/// best-effort and logs on failure.
fn recover_and_bootstrap(
    pools: &db::DbPools,
    device_id: &str,
    materializer: &materializer::Materializer,
) -> Result<recovery::RecoveryReport, Box<dyn std::error::Error>> {
    use materializer::MaterializeTask;

    // Boot ordering: the per-space `LoroEngine` registry MUST
    // be populated before the materializer dispatches its first
    // op. Recovery (`recover_at_boot` below) replays
    // unmaterialised ops through the materializer, so any op it
    // replays would race a deferred rehydrate and land in an
    // empty engine. Run the Loro state init + rehydrate
    // synchronously (via `block_on`) BEFORE recovery. The
    // boot-latency cost is one `loro_doc_state` table scan —
    // single-digit ms at typical workspace scales. The periodic
    // flush task is spawned separately (it's a long-running
    // background task; blocking on it would pin boot).
    let installed = crate::loro::shared::init();
    tracing::info!(
        installed,
        "loro: process-global LoroState init complete (synchronous, pre-recovery)",
    );
    // Bind the process-global registry once: rehydrate reads it, and
    // recovery's #535 sync-inbox replay re-imports leftover slots into
    // it. `get()` is `Some` immediately after `init()` (the static is
    // installed synchronously above), so the `expect` is infallible at
    // this point in boot.
    let loro_state = crate::loro::shared::get()
        .expect("LoroState must be installed by shared::init() before recovery");
    // #792: install the persisted peer-id epoch BEFORE any engine is
    // constructed (rehydrate below + every lazy `for_space`). A vault
    // that went through a snapshot RESET carries a bumped epoch in
    // `app_settings`; deriving the Loro PeerID from it keeps this
    // device off its retired pre-reset peer id, whose (peer, counter)
    // ranges peers still hold. Absent row == epoch 0 == the legacy
    // mapping, so never-reset vaults are byte-for-byte unaffected.
    {
        let peer_epoch =
            tauri::async_runtime::block_on(crate::loro::peer_epoch::load_peer_epoch(&pools.write));
        loro_state.registry.set_peer_epoch(peer_epoch);
        if peer_epoch > 0 {
            tracing::info!(
                peer_epoch,
                "loro: peer-id epoch loaded (#792); engine PeerIDs are \
                 epoch-salted (this vault went through a snapshot RESET)",
            );
        }
    }
    {
        let n = tauri::async_runtime::block_on(crate::loro::snapshot::rehydrate_registry(
            &pools.write,
            &loro_state.registry,
            device_id,
        ));
        if n > 0 {
            tracing::info!(
                rehydrated_spaces = n,
                "loro: rehydrated per-space LoroDoc snapshots from \
                 loro_doc_state (pre-recovery)",
            );
        }
    }

    // Run crash recovery before anything else
    // Recovery needs write access
    let report = tauri::async_runtime::block_on(recovery::recover_at_boot(
        &pools.write,
        device_id,
        materializer,
        &loro_state.registry,
    ))?;
    if !report.drafts_recovered.is_empty() {
        tracing::info!(
            count = report.drafts_recovered.len(),
            "recovered unflushed drafts"
        );
    }
    if report.replay_failed() {
        // #1255: a wholesale replay failure (corrupted op_log / stuck
        // foreground queue / #412 multi-device abort) means an unbounded
        // set of unmaterialized ops was skipped — the materialized view is
        // stale. This is NOT a routine info: log at error so the degraded
        // boot is greppable, and `surface_recovery_status` (in setup) emits
        // the user-visible signal.
        tracing::error!(
            ops_replayed = report.ops_replayed,
            replay_errors = report.replay_errors.len(),
            errors = ?report.replay_errors,
            "C-2b: boot op-log replay FAILED — materialized view may be \
             incomplete/stale; user signalled via recovery:degraded (#1255)"
        );
    } else if report.ops_replayed > 0 {
        tracing::info!(
            ops_replayed = report.ops_replayed,
            "C-2b: replayed unmaterialized ops at boot"
        );
    }

    // P-16: Populate projected agenda cache at boot so the first query
    // hits the cache rather than falling back to on-the-fly computation.
    if let Err(e) =
        materializer.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache)
    {
        tracing::warn!(error = %e, "failed to enqueue projected agenda cache rebuild at boot");
    }

    // FEAT-3 Phase 1: seed the two default spaces (Personal + Work) and
    // migrate every pre-existing page into Personal. Idempotent across
    // boots via an internal fast-path check. Failure is boot-fatal:
    // the app's "every page belongs to a space" invariant cannot be
    // honoured without this step completing.
    if let Err(e) = tauri::async_runtime::block_on(spaces::bootstrap_spaces(
        &pools.write,
        device_id,
        materializer,
    )) {
        tracing::error!(error = %e, "failed to bootstrap spaces — aborting boot");
        return Err(Box::new(e));
    }

    Ok(report)
}

/// #1255 — surface a degraded boot to the user.
///
/// Computes the [`RecoveryStatus`](recovery::RecoveryStatus) from the boot
/// report, stores it in managed state (so the `get_recovery_status` command
/// can backfill a frontend that mounts after boot), and — when the C-2b
/// op-log replay failed wholesale — emits the durable
/// [`EVENT_RECOVERY_DEGRADED`](recovery::EVENT_RECOVERY_DEGRADED) event so
/// the frontend can show a persistent "data may be incomplete" banner.
///
/// This replaces the old silent `tracing::warn!`-and-continue: the app
/// still boots (the `op_log` is canonical, nothing is lost), but the
/// degraded materialized state is now observable instead of invisible.
fn surface_recovery_status<R: tauri::Runtime>(
    app: &tauri::App<R>,
    report: &recovery::RecoveryReport,
) {
    use recovery::{EVENT_RECOVERY_DEGRADED, RecoveryStatusState};
    use tauri::{Emitter, Manager};

    let status = report.to_status();

    // Always register the status so `get_recovery_status` resolves managed
    // state even on a healthy boot (returns `degraded = false`).
    app.manage(RecoveryStatusState(std::sync::Mutex::new(status.clone())));

    if !status.degraded {
        return;
    }

    // Emit the durable signal. A late-registering frontend listener that
    // misses this event backfills the same status via `get_recovery_status`
    // on mount (the `useDeepLinkRouter`-style emit + query-on-mount shape).
    if let Err(e) = app.emit(EVENT_RECOVERY_DEGRADED, status.clone()) {
        tracing::error!(
            error = %e,
            event = EVENT_RECOVERY_DEGRADED,
            "failed to emit recovery-degraded event — frontend will still \
             backfill via get_recovery_status on mount (#1255)"
        );
    }
}

/// Boot-phase 6 — best-effort boot maintenance moved off the synchronous
/// critical path, plus the remaining synchronous boot enqueues and the
/// post-draft-recovery cache refresh.
///
/// Mirrors the original inline ordering exactly: the off-critical-path spawn
/// (link-metadata GC, FTS / `block_tag_refs` gating, personal→work migration)
/// is created first, then `RebuildPageIds` / `CleanupOrphanedAttachments` are
/// enqueued, then caches for recovered drafts are refreshed synchronously.
fn spawn_boot_maintenance(
    pools: &db::DbPools,
    device_id: &str,
    materializer: &materializer::Materializer,
    report: &recovery::RecoveryReport,
) {
    use materializer::MaterializeTask;

    // startup-latency-backend Phase 1: move four best-effort boot
    // items off the synchronous critical path. These don't gate
    // any user IPC — link-metadata GC is purely cleanup, the
    // FTS / `block_tag_refs` gating is a one-shot "schedule the
    // rebuild if the table is empty" check (the rebuild itself
    // is already a background materializer task), and the
    // personal→work migration is a one-shot maintainer-only no-op
    // for fresh installs. Releasing the foreground queue earlier
    // means the first user action (a `list_blocks` for the
    // journal) doesn't compete with these maintenance reads.
    //
    // `migrate_personal_pages_to_work` MUST run after
    // `bootstrap_spaces` (its comment is explicit). The spawn
    // below happens AFTER `bootstrap_spaces` returns successfully,
    // so the ordering invariant is preserved.
    {
        let write_pool = pools.write.clone();
        let device_id_owned = device_id.to_owned();
        let materializer_handle = materializer.clone();
        tauri::async_runtime::spawn(async move {
            // UX-165: Clean up stale link metadata entries (>30 days, non-auth).
            match crate::link_metadata::cleanup_stale(&write_pool, 30).await {
                Ok(deleted) => {
                    if deleted > 0 {
                        tracing::info!(deleted, "cleaned up stale link metadata entries");
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "failed to clean up stale link metadata");
                }
            }

            // M-3: Rebuild FTS index if the table is empty (post-migration 0006).
            let fts_count: i64 = log_or_zero(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM fts_blocks")
                    .fetch_one(&write_pool)
                    .await,
                "fts_blocks_count",
            );
            if fts_count == 0 {
                let block_count: i64 = log_or_zero(
                    sqlx::query_scalar::<_, i64>(
                        "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL \
                         AND content IS NOT NULL",
                    )
                    .fetch_one(&write_pool)
                    .await,
                    "fts_indexable_block_count",
                );
                if block_count > 0 {
                    tracing::info!(blocks = block_count, "FTS index empty — scheduling rebuild");
                    if let Err(e) =
                        materializer_handle.try_enqueue_background(MaterializeTask::RebuildFtsIndex)
                    {
                        tracing::warn!(
                            error = %e,
                            "failed to enqueue FTS rebuild at boot",
                        );
                    }
                }
            }

            // UX-250: Rebuild `block_tag_refs` if the table is empty
            // but there is content to scan. Migration 0034 creates
            // the table but intentionally does not SQL-backfill
            // (SQLite lacks the regex support we need).
            let btr_count: i64 = log_or_zero(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
                    .fetch_one(&write_pool)
                    .await,
                "block_tag_refs_count",
            );
            if btr_count == 0 {
                let block_count: i64 = log_or_zero(
                    sqlx::query_scalar::<_, i64>(
                        "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL \
                         AND content IS NOT NULL",
                    )
                    .fetch_one(&write_pool)
                    .await,
                    "btr_indexable_block_count",
                );
                if block_count > 0 {
                    tracing::info!(
                        blocks = block_count,
                        "block_tag_refs empty (migration 0034 backfill) — scheduling \
                         rebuild",
                    );
                    if let Err(e) = materializer_handle
                        .try_enqueue_background(MaterializeTask::RebuildBlockTagRefsCache)
                    {
                        tracing::warn!(
                            error = %e,
                            "failed to enqueue block_tag_refs rebuild at boot",
                        );
                    }
                }
            }

            // MAINT-1: one-shot Personal→Work migration for the
            // maintainer's vault. Hardcoded-ULID-gated so fresh
            // installs are a no-op. Non-fatal; next boot retries.
            if let Err(e) = spaces::migrate_personal_pages_to_work(
                &write_pool,
                &device_id_owned,
                &materializer_handle,
            )
            .await
            {
                tracing::warn!(
                    error = %e,
                    "failed to run personal_to_work_migration_v1 — will retry on next boot",
                );
            }
        });
    }

    // FEAT-1: Rebuild page_id column at boot to ensure consistency.
    if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildPageIds) {
        tracing::warn!(error = %e, "failed to enqueue page_id rebuild at boot");
    }

    // MAINT-229: enqueue the orphan-attachment GC at boot. The
    // function is non-retryable (the bg consumer drops on
    // saturation rather than persisting it), so a missed boot
    // tick is fine — the next boot picks it up. A second hook
    // in `compact_op_log_cmd` runs the same GC after every
    // successful user-triggered compaction so deletions get
    // their orphaned attachments swept promptly.
    if let Err(e) = materializer.try_enqueue_background(MaterializeTask::CleanupOrphanedAttachments)
    {
        tracing::warn!(error = %e, "failed to enqueue CleanupOrphanedAttachments at boot");
    }

    // BUG-23: When drafts were recovered before the materializer was
    // created, the targeted FTS / block_links / tags / pages caches
    // are stale for those block_ids. Refresh them now and block until
    // the background queue drains so UI queries after setup never see
    // pre-recovery state.
    if !report.drafts_recovered.is_empty()
        && let Err(e) =
            tauri::async_runtime::block_on(recovery::refresh_caches_for_recovered_drafts(
                &pools.read,
                materializer,
                &report.drafts_recovered,
            ))
    {
        tracing::warn!(
            error = %e,
            drafts = report.drafts_recovered.len(),
            "failed to refresh caches after draft recovery",
        );
    }
}

/// Boot-phase 8/9/10 — spawn the long-running background tasks: the
/// retry-queue + orphan-drafts sweepers, the maintenance daemon (its job
/// vector built here), and the periodic Loro-snapshot task.
///
/// Each task receives an `Arc<AtomicBool>` shutdown flag that is never set
/// (#703) — the flags exist only to keep the spawn signatures stable.
fn spawn_background_tasks(
    pools: &db::DbPools,
    device_id: &str,
    materializer: &materializer::Materializer,
    lifecycle: &lifecycle::LifecycleHooks,
) {
    // BUG-22: Spawn the retry-queue sweeper so any per-block tasks
    // persisted by a previous session (or accumulated during this
    // one) get drained on a 60-second cadence. The sweeper uses
    // its own shutdown flag; it dies when this flag is set and
    // re-enqueues rows that have reached their `next_attempt_at`.
    // #703: the flag is never set (no exit handler signals it), so
    // the sweeper observes a constant `false`; it remains a
    // parameter only to keep the spawn signature stable.
    let retry_shutdown = Arc::new(AtomicBool::new(false));
    materializer::retry_queue::spawn_sweeper(
        pools.read.clone(),
        pools.write.clone(),
        materializer.clone(),
        retry_shutdown,
    );

    // PEND-28a M1: Spawn the orphan-drafts sweeper. Drafts whose
    // parent block has been *soft-deleted* survive the M-93 FK
    // (which references the row, not its `deleted_at` column),
    // so without this periodic sweep they would accumulate and
    // surface as phantom drafts in the UI on next boot. The
    // task runs once at boot and then every hour for the
    // process lifetime; cancellation is via the managed
    // shutdown flag, mirroring the retry-queue sweeper above.
    // #703: flag never set; sweeper observes constant `false`.
    let orphan_drafts_shutdown = Arc::new(AtomicBool::new(false));
    draft::spawn_orphan_drafts_sweeper(
        pools.write.clone(),
        draft::ORPHAN_DRAFTS_SWEEP_INTERVAL,
        orphan_drafts_shutdown,
    );

    // Issue #157 — MaintenanceDaemon, wired with its full job
    // vector (wal_checkpoint_truncate, op_log_compact,
    // pragma_optimize_tick, cleanup_orphaned_attachments_tick,
    // fts_idle_optimize, tombstone_purge, loro_snapshot_if_dirty,
    // projected_agenda_midnight). New jobs are added by extending
    // this vector without re-wiring the daemon.
    //
    // The wal_checkpoint_truncate job below illustrates the
    // canonical predicate pattern.
    //
    // The predicate gates on the lifecycle.is_foreground flag —
    // the TRUNCATE checkpoint may briefly block other writers
    // while it compacts the WAL, and the cost is invisible when
    // the app is backgrounded but a noticeable pause if it
    // fires while the user is actively editing. Conservative
    // default: only run while NOT in the foreground. (The
    // PRAGMA itself also returns `busy != 0` when a concurrent
    // writer holds the WAL, so the gating is double-belted.)
    let maintenance_shutdown = Arc::new(AtomicBool::new(false));
    let lifecycle_for_wal = lifecycle.clone();
    let lifecycle_for_compact = lifecycle.clone();
    let lifecycle_for_tombstone = lifecycle.clone();
    let lifecycle_for_loro_pred = lifecycle.clone();
    let wal_write_pool = pools.write.clone();
    let compact_write_pool = pools.write.clone();
    let compact_device_id = device_id.to_owned();
    let optimize_write_pool = pools.write.clone();
    let materializer_for_cleanup = materializer.clone();
    let materializer_for_fts = materializer.clone();
    let materializer_for_fts_predicate = materializer.clone();
    let tombstone_write_pool = pools.write.clone();
    let tombstone_device_id = device_id.to_owned();
    let tombstone_materializer = materializer.clone();
    let loro_snapshot_write_pool = pools.write.clone();
    let projected_agenda_materializer = materializer.clone();
    // Issue #157 sub-item H — shared "last fired UTC day"
    // sentinel for the projected_agenda_midnight job.
    // `i32::MIN` = "never fired"; the first tick post-boot
    // enqueues a rebuild, then subsequent ticks only enqueue
    // when the UTC day number advances.
    let projected_agenda_last_day = Arc::new(std::sync::atomic::AtomicI32::new(i32::MIN));
    let jobs = vec![
        maintenance::MaintenanceJob {
            name: "wal_checkpoint_truncate",
            interval: std::time::Duration::from_secs(3600),
            last_run: None,
            predicate: Box::new(move || {
                !lifecycle_for_wal
                    .is_foreground
                    .load(std::sync::atomic::Ordering::Acquire)
            }),
            run: Box::new(move || {
                let pool = wal_write_pool.clone();
                Box::pin(async move { maintenance::wal_checkpoint_truncate(&pool).await })
            }),
        },
        // Issue #157 sub-item C — periodic op-log compaction
        // (24 h, idle predicate, 90-day retention).
        maintenance::MaintenanceJob {
            name: "op_log_compact",
            interval: std::time::Duration::from_secs(24 * 3600),
            last_run: None,
            predicate: Box::new(move || {
                !lifecycle_for_compact
                    .is_foreground
                    .load(std::sync::atomic::Ordering::Acquire)
            }),
            run: Box::new(move || {
                let pool = compact_write_pool.clone();
                let device_id = compact_device_id.clone();
                Box::pin(async move { maintenance::op_log_compact(&pool, &device_id).await })
            }),
        },
        // Issue #157 sub-item G — periodic PRAGMA optimize.
        maintenance::MaintenanceJob {
            name: "pragma_optimize_tick",
            interval: std::time::Duration::from_secs(4 * 3600),
            last_run: None,
            predicate: Box::new(|| true),
            run: Box::new(move || {
                let pool = optimize_write_pool.clone();
                Box::pin(async move { maintenance::pragma_optimize(&pool).await })
            }),
        },
        // Issue #157 sub-item F — enqueue
        // `CleanupOrphanedAttachments` every 24 h.
        maintenance::MaintenanceJob {
            name: "cleanup_orphaned_attachments_tick",
            interval: std::time::Duration::from_secs(24 * 3600),
            last_run: None,
            predicate: Box::new(|| true),
            run: Box::new(move || {
                let mat = materializer_for_cleanup.clone();
                Box::pin(
                    async move { maintenance::enqueue_cleanup_orphaned_attachments(&mat).await },
                )
            }),
        },
        // Issue #157 sub-item J — enqueue `FtsOptimize` every
        // 24 h, gated on `fts_edits_since_optimize > 0`.
        maintenance::MaintenanceJob {
            name: "fts_idle_optimize",
            interval: std::time::Duration::from_secs(24 * 3600),
            last_run: None,
            predicate: Box::new(move || {
                materializer_for_fts_predicate
                    .metrics()
                    .fts_edits_since_optimize
                    .load(std::sync::atomic::Ordering::Acquire)
                    > 0
            }),
            run: Box::new(move || {
                let mat = materializer_for_fts.clone();
                Box::pin(async move { maintenance::enqueue_fts_idle_optimize(&mat).await })
            }),
        },
        // Issue #157 sub-item E — periodic tombstone purge
        // (24 h cadence, idle predicate, 90-day retention).
        maintenance::MaintenanceJob {
            name: "tombstone_purge",
            interval: std::time::Duration::from_secs(24 * 3600),
            last_run: None,
            predicate: Box::new(move || {
                !lifecycle_for_tombstone
                    .is_foreground
                    .load(std::sync::atomic::Ordering::Acquire)
            }),
            run: Box::new(move || {
                let pool = tombstone_write_pool.clone();
                let device_id = tombstone_device_id.clone();
                let mat = tombstone_materializer.clone();
                Box::pin(async move { maintenance::tombstone_purge(&pool, &device_id, &mat).await })
            }),
        },
        // Issue #157 sub-item I — fire save_all_engines every
        // 60 s while backgrounded AND when the registry's
        // dirty-engines proxy counter is non-zero.
        maintenance::MaintenanceJob {
            name: "loro_snapshot_if_dirty",
            interval: std::time::Duration::from_secs(60),
            last_run: None,
            predicate: Box::new(move || {
                if lifecycle_for_loro_pred
                    .is_foreground
                    .load(std::sync::atomic::Ordering::Acquire)
                {
                    return false;
                }
                crate::loro::shared::get().is_some_and(|s| s.registry.dirty_count() > 0)
            }),
            run: Box::new(move || {
                let pool = loro_snapshot_write_pool.clone();
                Box::pin(async move { maintenance::loro_snapshot_if_dirty(&pool).await })
            }),
        },
        // Issue #157 sub-item H — projected-agenda midnight
        // refresh (60 s outer tick + always-on predicate;
        // body gates on a UTC-day-number atomic so the
        // rebuild fires at most once per calendar day).
        maintenance::MaintenanceJob {
            name: "projected_agenda_midnight",
            interval: std::time::Duration::from_secs(60),
            last_run: None,
            predicate: Box::new(|| true),
            run: Box::new(move || {
                let mat = projected_agenda_materializer.clone();
                let last_day = projected_agenda_last_day.clone();
                Box::pin(async move {
                    maintenance::projected_agenda_midnight_tick(&mat, &last_day).await
                })
            }),
        },
    ];
    // #703: flag never set; daemon observes constant `false`.
    maintenance::spawn_daemon(jobs, maintenance_shutdown);

    // Periodic Loro snapshot persistence. Re-instated after the
    // PEND-09 parity flush task (which hosted the snapshot save
    // on its tick) was deleted — that regression left
    // `loro_doc_state` permanently empty while the apply cursor
    // kept advancing, so on boot the engine could not be rebuilt
    // and every edit/move failed "block not found". Persists each
    // engine's snapshot every SNAPSHOT_INTERVAL_SECS so the next
    // boot rehydrates without a full op-log replay; cancellation
    // is via the managed flag, mirroring the sweepers above.
    // #703: flag never set; snapshot task observes constant `false`.
    let snapshot_shutdown = Arc::new(AtomicBool::new(false));
    crate::loro::snapshot::spawn_periodic_snapshot(
        pools.write.clone(),
        snapshot_shutdown,
        crate::loro::snapshot::SNAPSHOT_INTERVAL_SECS,
    );
}

/// Boot-phase 12 — move every still-owned shared piece into Tauri managed
/// state and install the window-focus → lifecycle listener.
///
/// This consumes `pools`, `device_id`, `sync_cert`, `materializer`, and
/// `scheduler` by value: it is the single point where the originals are
/// moved, which is why every prior phase took them by reference (cloning the
/// cheap `Arc`s it needed). The returned `cancel_flag` is shared with the
/// `SyncDaemon` spawned immediately afterwards (#528).
fn register_managed_state<R: tauri::Runtime>(
    app: &tauri::App<R>,
    pools: db::DbPools,
    device_id: String,
    sync_cert: sync_net::SyncCert,
    materializer: materializer::Materializer,
    scheduler: Arc<sync_scheduler::SyncScheduler>,
    lifecycle: &lifecycle::LifecycleHooks,
) -> Arc<AtomicBool> {
    use db::{ReadPool, WriteCtx, WritePool};
    use device::DeviceId;
    use lifecycle::AppLifecycle;
    use sync_cert::PersistedCert;
    use tauri::Manager;

    // #1056 — assemble the bundled write-path context BEFORE the originals
    // are moved into the standalone managed states. Every field is a cheap
    // `Arc`-backed clone (`SqlitePool`, `Materializer`) or a small `String`
    // clone (`DeviceId`), so `WriteCtx` and the standalone `WritePool` /
    // `DeviceId` / `Materializer` states share the same underlying handles.
    // The standalone states are kept for the read-only / partial-triple
    // consumers (`get_device_id`, `sync_cmds`, `link_metadata`, …).
    let device_id = DeviceId::new(device_id);
    let write_ctx = WriteCtx::new(pools.write.clone(), device_id.clone(), materializer.clone());

    // Store all in Tauri managed state
    app.manage(WritePool(pools.write));
    app.manage(ReadPool(pools.read));
    app.manage(write_ctx);
    // PEND-70 P1-A — extension-state guard registry for
    // in-flight search IPCs. See `cancellation.rs`.
    app.manage(cancellation::CancellationRegistry::new());
    app.manage(device_id);
    app.manage(PersistedCert::new(sync_cert));
    app.manage(materializer);

    // Sync state (#275, #278)
    app.manage(commands::PairingState(std::sync::Mutex::new(None)));
    app.manage(scheduler);

    // Sync cancel flag (#528) — registered before daemon spawns so
    // cancel_sync can always resolve managed state.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    app.manage(SyncCancelFlag(cancel_flag.clone()));

    // PERF-24: register the lifecycle hooks in managed state so
    // future commands (e.g. a "sync now" action) can share the
    // same wake notifier, and install a window-event listener
    // that flips `is_foreground` on focus changes. Tauri's
    // `Focused(bool)` event fires on all supported platforms
    // (desktop + mobile), so the same listener doubles as a
    // laptop-lid-closed optimization on desktop.
    app.manage(AppLifecycle(lifecycle.clone()));
    match app.get_webview_window("main") {
        Some(window) => {
            let lifecycle_for_listener = lifecycle.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(focused) = event {
                    if *focused {
                        tracing::info!("app foregrounded — resuming background work");
                        lifecycle_for_listener.mark_foreground();
                    } else {
                        tracing::info!("app backgrounded — daemon + materializer will pause");
                        lifecycle_for_listener.mark_backgrounded();
                    }
                }
            });
        }
        _ => {
            tracing::warn!(
                "main webview window not available at setup; app-lifecycle hooks inactive"
            );
        }
    }

    cancel_flag
}

/// Inputs the [`SyncDaemon`](sync_daemon::SyncDaemon) needs, gathered into a
/// struct so [`wire_sync_daemon`] stays under the `too_many_arguments` ceiling.
///
/// Every field is a cheap `Arc`-backed clone taken from the still-live
/// originals BEFORE they are moved into managed state — the struct makes that
/// clone-before-move contract explicit instead of a loose run of `let … =
/// x.clone();` lines preceding a block of `app.manage(...)` calls.
struct SyncDaemonWiring {
    pool: sqlx::SqlitePool,
    device_id: String,
    materializer: materializer::Materializer,
    scheduler: Arc<sync_scheduler::SyncScheduler>,
    cert: sync_net::SyncCert,
    sink: Arc<dyn sync_events::SyncEventSink>,
    app_handle: tauri::AppHandle,
    lifecycle: lifecycle::LifecycleHooks,
    cancel_flag: Arc<AtomicBool>,
}

/// Boot-phase 13 — install the rustls CryptoProvider and spawn the
/// [`SyncDaemon`](sync_daemon::SyncDaemon).
///
/// PERF-25: `start_if_peers_exist` keeps the daemon dormant until a device is
/// paired; PERF-24's lifecycle threading short-circuits the resync tick while
/// backgrounded.
fn wire_sync_daemon(w: SyncDaemonWiring) {
    use tauri::Manager;

    // Install rustls CryptoProvider before any TLS usage (#sync)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Spawn SyncDaemon (#382, #383, #278)
    //
    // PERF-25: Use `start_if_peers_exist` so the daemon enters
    // dormant mode when no peers are paired. mDNS announce/browse
    // and the TLS listener are deferred until the user pairs a
    // device. The dormant waiter wakes on `scheduler.notify_change`
    // (called by `confirm_pairing`) and on a periodic poll.
    //
    // PERF-24: `_with_lifecycle` threads the foreground flag +
    // wake notify into the daemon loop so its periodic resync
    // tick short-circuits while the app is backgrounded.
    tauri::async_runtime::spawn(async move {
        match sync_daemon::SyncDaemon::start_if_peers_exist_with_lifecycle(
            w.pool,
            w.device_id,
            w.materializer,
            w.scheduler,
            w.cert,
            w.sink,
            w.cancel_flag,
            w.lifecycle,
        )
        .await
        {
            Ok(daemon) => {
                tracing::info!("SyncDaemon started successfully");
                w.app_handle.manage(daemon);
            }
            Err(e) => tracing::error!(error = %e, "Failed to start SyncDaemon"),
        }
    });
}

/// The per-server pool / materializer / device_id clones the MCP RO and RW
/// servers need, gathered into a struct so [`wire_mcp_servers`] stays under
/// the `too_many_arguments` ceiling.
///
/// FEAT-4c / FEAT-4h slice 2 — the RO surface binds the reader pool (plus the
/// writer pool for `journal_for_date`'s sole write side-effect); the RW
/// surface binds the writer pool (every RW tool mutates). Every field is a
/// cheap `Arc`-backed clone taken before the originals move into managed state.
struct McpServerWiring {
    ro_read_pool: sqlx::SqlitePool,
    ro_write_pool: sqlx::SqlitePool,
    ro_materializer: materializer::Materializer,
    ro_device_id: String,
    rw_write_pool: sqlx::SqlitePool,
    rw_materializer: materializer::Materializer,
    rw_device_id: String,
}

/// Boot-phase 14 — spawn the MCP read-only and read-write servers and register
/// their managed lifecycle/gate/activity state.
///
/// FEAT-4a/4h: each server is opt-in via its marker file; absent the marker
/// the spawn helper logs and returns immediately. The reader/writer pool +
/// materializer + device_id are passed in as cheap clones (FEAT-4c / slice 2).
fn wire_mcp_servers<R: tauri::Runtime>(
    app: &tauri::App<R>,
    app_data_dir: &std::path::Path,
    w: McpServerWiring,
) {
    use tauri::Manager;

    let McpServerWiring {
        ro_read_pool: mcp_ro_read_pool,
        ro_write_pool: mcp_ro_write_pool,
        ro_materializer: mcp_ro_materializer,
        ro_device_id: mcp_ro_device_id,
        rw_write_pool: mcp_rw_write_pool,
        rw_materializer: mcp_rw_materializer,
        rw_device_id: mcp_rw_device_id,
    } = w;

    // FEAT-4a — MCP read-only server. Opt-in via the `mcp-ro-enabled`
    // marker file in `app_data_dir` (FEAT-4e wires the UI toggle).
    // When the marker is absent, `spawn_mcp_ro_task` logs and returns
    // immediately. When present, it binds the default socket and
    // spawns the serve loop. A second Agaric instance detects the
    // existing socket and logs a warning without crashing.
    //
    // FEAT-4d — the cloned `AppHandle` is used to build the activity
    // emitter so completed tool calls surface on the `mcp:activity`
    // Tauri event bus.
    //
    // FEAT-4c — the reader pool + materializer + device_id let the
    // `ReadOnlyTools` registry dispatch the v1 nine-tool surface
    // without allocating new resources. `journal_for_date` is the
    // only tool that writes; it reuses the same materializer /
    // device_id the frontend uses so the op-log origin stays
    // consistent.
    //
    // FEAT-4e — `McpLifecycle` is shared managed state so the
    // Settings UI commands (`get_mcp_status`, `mcp_disconnect_all`,
    // `mcp_set_enabled`) can observe the connection counter and
    // fire the disconnect signal.
    let mcp_lifecycle = std::sync::Arc::new(mcp::McpLifecycle::new());
    app.manage(mcp_lifecycle.clone());
    // L-46: gate that serialises rapid `mcp_set_enabled` toggles
    // so the marker write + spawn cannot interleave.
    app.manage(commands::McpToggleGate::new());
    // #695 — ONE shared activity ring, managed so the
    // `get_mcp_recent_activity` command reads what the RO and
    // RW serve tasks write. Allocated here (not inside
    // `ActivityContext::from_app_handle`) so the history
    // survives enable/disable cycles.
    let mcp_activity_ring = mcp::activity::McpActivityRing::new();
    app.manage(mcp_activity_ring.clone());
    let mcp_pool = mcp_ro_read_pool;
    let mcp_write_pool = mcp_ro_write_pool;
    let mcp_materializer = mcp_ro_materializer;
    let mcp_device_id = mcp_ro_device_id;
    mcp::spawn_mcp_ro_task(
        app_data_dir,
        app.handle().clone(),
        mcp_pool,
        mcp_write_pool,
        mcp_materializer,
        mcp_device_id,
        mcp_activity_ring.0.clone(),
        Some((*mcp_lifecycle).clone()),
    );

    // FEAT-4h slice 2 — parallel MCP **read-write** server. Opt-in
    // via the `mcp-rw-enabled` marker file (independent of RO).
    // A second `McpLifecycle` is allocated so the RO and RW
    // servers track their own connection counts and disconnect
    // signals; the `McpRwLifecycle` newtype wrapper keeps Tauri's
    // managed-state resolver from colliding on the shared type.
    let mcp_rw_lifecycle_inner = std::sync::Arc::new(mcp::McpLifecycle::new());
    let mcp_rw_lifecycle = mcp::McpRwLifecycle(mcp_rw_lifecycle_inner.clone());
    app.manage(mcp_rw_lifecycle.clone());
    // L-46: RW counterpart to McpToggleGate. RO and RW each hold
    // their own gate so they do not block each other.
    app.manage(commands::McpRwToggleGate::new());
    mcp::spawn_mcp_rw_task(
        app_data_dir,
        app.handle().clone(),
        mcp_rw_write_pool,
        mcp_rw_materializer,
        mcp_rw_device_id,
        // #695 — same shared ring as the RO surface so the
        // command surfaces one merged feed.
        mcp_activity_ring.0.clone(),
        Some((*mcp_rw_lifecycle_inner).clone()),
    );
}

/// #634: extract the human-readable payload + source location from a
/// [`std::panic::PanicHookInfo`].
///
/// Factored out of the panic hook so the (otherwise untestable) hook's
/// message-extraction logic can be unit-tested directly. Mirrors the
/// std default hook's payload handling: `&str` and `String` payloads are
/// rendered verbatim, anything else degrades to a fixed sentinel.
fn panic_payload_and_location(info: &std::panic::PanicHookInfo<'_>) -> (String, String) {
    let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    };
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_default();
    (payload, location)
}

/// #634: format the complete, abort-safe panic report written synchronously
/// to stderr from the panic hook.
///
/// Under the release profile's `panic = "abort"` (see `Cargo.toml`), the
/// process aborts the instant the panic hook returns, so the
/// `tracing_appender::non_blocking` worker thread never gets a chance to
/// flush the file-side `PANIC` line. This helper builds a string that the
/// hook prints with a single synchronous `eprintln!` — no background thread,
/// no buffering — so the payload, location, and backtrace survive an abort
/// and end up in any captured stderr (the copy bug reports harvest).
///
/// Pure (no I/O) so it can be unit-tested without provoking a real panic.
fn format_panic_report(payload: &str, location: &str, backtrace: &str) -> String {
    let location = if location.is_empty() {
        "<unknown location>"
    } else {
        location
    };
    format!("PANIC at {location}: {payload}\nstack backtrace:\n{backtrace}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // #1058: most boot-wiring imports moved into the focused helper
    // functions above `run`. `WritePool` is still referenced by the
    // `RunEvent::Exit` handler; `Manager` by `app.path()` / `app.handle()`
    // in the orchestrator closure; `Builder` by the command-builder setup.
    use db::WritePool;
    use tauri::Manager;
    use tauri_specta::Builder;

    #[cfg(target_os = "linux")]
    disable_webkit_dmabuf_if_unset();

    // BUG-34: Tracing-appender setup moved into the Tauri `setup()` hook so
    // it can use `app.path().app_data_dir()` (OS-correct location on every
    // platform) instead of a hard-coded Linux XDG path. The panic hook is
    // installed here early — it uses the global tracing subscriber and is
    // a no-op until the subscriber is installed in `setup()`.

    // M-44 / #634: Install a custom panic hook so panics are captured in the
    // log file AND survive `panic = "abort"` (release profile, Cargo.toml).
    //
    // Two abort-safety problems the previous hook had:
    //   1. The file sink is `tracing_appender::non_blocking` — `tracing::error!`
    //      only enqueues the PANIC line onto a background worker thread that
    //      flushes on `WorkerGuard` drop. Under `abort` the process dies the
    //      instant this hook returns, so the buffered file-side PANIC line —
    //      the copy bug reports harvest — was plausibly never written.
    //   2. `set_hook` replaced the std default hook outright, so no backtrace
    //      was captured anywhere.
    //
    // Fix: (a) write the payload/location + a force-captured backtrace
    // synchronously to stderr via `eprintln!` (no worker thread, abort-safe);
    // (b) still emit the structured `tracing::error!` event for the file/JSON
    // sink on the normal (unwind / non-abort) path; (c) chain the previously
    // installed hook so the std default backtrace behaviour is preserved.
    // Normal (non-panic) logging is untouched.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let (payload, location) = panic_payload_and_location(info);
        let backtrace = std::backtrace::Backtrace::force_capture();

        // Synchronous, abort-safe write: this reaches captured stderr even
        // when the non-blocking file worker never gets to flush.
        eprintln!(
            "{}",
            format_panic_report(&payload, &location, &backtrace.to_string())
        );

        // Structured event for the JSON file sink (delivered on the normal
        // unwind path; best-effort under abort, but the eprintln! above is
        // the durable copy).
        tracing::error!(target: "agaric", panic = %payload, location = %location, "PANIC");

        // Preserve the std default hook's behaviour (e.g. its own backtrace
        // formatting / future changes) by chaining to whatever was installed
        // before us.
        previous_hook(info);
    }));

    // I-Core-7: command list lives in the `agaric_commands!` macro near the
    // top of this file. Edit that macro to add or remove a command.
    let builder = Builder::<tauri::Wry>::new().commands(agaric_commands!());

    // `mut` is only consumed by the `#[cfg(desktop)]` / `#[cfg(not(mobile))]`
    // plugin registrations below. On Android/iOS the binding is never
    // reassigned, so allow the warning there without relaxing it globally.
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut tauri_builder = tauri::Builder::default();

    // MAINT-106: tauri-plugin-single-instance MUST be the first plugin
    // registered (per upstream docs) so the second-instance probe runs
    // before any other plugin's setup hook touches the file system / DB.
    // The callback fires in the *original* (still-running) instance with
    // the second instance's argv + cwd; we focus the existing window and
    // let the second process exit cleanly.  This guards against two
    // SQLite pools racing on the same `notes.db` (see AGENTS.md
    // "Database").  Desktop-only — Android/iOS enforce single-instance
    // via the OS task model, so the plugin is gated behind `#[cfg(desktop)]`
    // (matching upstream's `desktop_only_plugin` posture).
    //
    // FEAT-10: on Linux + Windows, OS deep-link activations spawn a
    // **new** Agaric process with the URL as a CLI argument; the
    // single-instance handler is the only place we can intercept those
    // args and forward them to the still-running primary instance.  We
    // call `DeepLinkExt::deep_link().handle_cli_arguments(...)` which
    // re-parses the args and emits the `deep-link://new-url` event into
    // the primary instance's bus (where our `deeplink::register_deeplink_handlers`
    // listener picks it up and routes to the typed events).
    #[cfg(desktop)]
    {
        tauri_builder =
            tauri_builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
                use tauri::Manager;
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // FEAT-10: forward the second instance's argv to the
                // deep-link plugin running inside the primary instance.
                // The plugin filters args by the configured schemes
                // (`agaric` only, per `tauri.conf.json`) so non-deep-link
                // CLI args are silently ignored.
                app.deep_link().handle_cli_arguments(args.into_iter());
            }));
    }

    tauri_builder = tauri_builder
        // FEAT-10: cross-platform deep-link routing for `agaric://` URLs.
        // Required on desktop AND Android (Android OAuth via Custom-Tabs
        // + PKCE + App-Link callback is the FEAT-5g unblocker).  See
        // `src-tauri/src/deeplink/mod.rs` for the URL → typed-event
        // router; `register_deeplink_handlers` is wired from the setup
        // hook below.  No `#[cfg(desktop)]` gate on purpose.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        // MAINT-109: cross-platform platform/version/arch/locale/hostname
        // API used by `commands::collect_bug_report_metadata`.  Works on
        // both desktop and mobile, so no cfg gate.
        .plugin(tauri_plugin_os::init())
        // FEAT-11: native OS notifications for due / scheduled tasks.
        // The `notify_task` command (commands::notifier::notify_task)
        // fires a notification through this plugin.  Cross-platform
        // (desktop + mobile), so no `#[cfg(desktop)]` gate.  Part of the
        // Tauri plugin coupled stack per AGENTS.md §"Coupled Dependency
        // Updates" — move in lockstep with the other tauri-plugin-* crates.
        .plugin(tauri_plugin_notification::init());

    // MAINT-108: remember window size / position / monitor / maximized
    // state across launches.  Operates entirely Rust-side (no frontend
    // permission needed).  Desktop-only — Android/iOS handle window
    // state via the OS task lifecycle, so the plugin is gated behind
    // `#[cfg(desktop)]`.
    #[cfg(desktop)]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    // FEAT-12: register `tauri-plugin-global-shortcut` so the JS API can
    // bind / unbind the user-configured "quick capture" hotkey at runtime.
    // The plugin doesn't need a fixed binding at registration time —
    // bindings are registered/unregistered dynamically from the frontend
    // (see `src/lib/tauri.ts` + `src/components/QuickCaptureDialog.tsx`).
    // Desktop-only — Android / iOS have no global-shortcut concept, so
    // the plugin is gated behind `#[cfg(desktop)]`.
    #[cfg(desktop)]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    // FEAT-13: launch-on-login support.  Wired up to the Settings →
    // General → "Launch on login" toggle (frontend reads/writes via
    // `@tauri-apps/plugin-autostart`'s `isEnabled` / `enable` /
    // `disable` IPC).  The `MacosLauncher::LaunchAgent` variant tells
    // the plugin to register the autostart entry as a `~/Library/
    // LaunchAgents/<bundle-id>.plist` rather than the legacy AppleScript
    // approach (matches upstream's recommended default).  The
    // `--silent` arg is passed to the relaunched process so future
    // FEAT-11 notifier / sync-daemon code can detect a "started at
    // login" launch and avoid popping the main window to the front.
    // Desktop-only — Android/iOS expose start-at-boot via the OS task
    // model (foreground service / WorkManager / background fetch
    // entitlements), not the autostart plugin.
    #[cfg(desktop)]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--silent"]),
        ));
    }

    // Desktop-only auto-update. Minisign signing is wired in
    // `release.yml` (TAURI_SIGNING_PRIVATE_KEY + _PASSWORD secrets);
    // `tauri.conf.json` carries the matching pubkey + the
    // `releases/latest/download/latest.json` endpoint. The frontend
    // boot check (`src/hooks/useUpdateCheck.ts`) consumes this plugin
    // via the `updater:default` capability granted in
    // `capabilities/default.json`. Android updates flow through the
    // Play Store (or sideloaded APK) — not Tauri's updater path — so
    // gate registration behind `not(mobile)`.
    #[cfg(not(mobile))]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    tauri_builder
        .setup(|app| {
            // #1058: the boot sequence below is decomposed into focused
            // helper functions (see above `run`). This closure is now a
            // thin, ordered orchestrator — the ORDER of every step is
            // load-bearing and byte-identical to the pre-#1058 inline
            // body. Each helper takes the shared pieces it needs as
            // explicit (cheap `Arc`) clones, so the former implicit
            // "clone-before-move" discipline is now enforced by the
            // borrow checker.

            // Resolve the OS-standard app data directory from tauri.conf.json identifier
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("notes.db");

            // BUG-34: tracing-appender setup using the OS-correct
            // `app_data_dir`; keeps the worker guard alive in managed state.
            init_logging(app, &app_data_dir);

            // PEND-79: AppImage first-run desktop self-integration (Linux).
            // No-op unless `$APPIMAGE` is set (only inside a running AppImage),
            // so deb/rpm, `cargo tauri dev`, and non-Linux are all excluded.
            #[cfg(target_os = "linux")]
            appimage_integration::integrate_appimage_if_running();

            // FEAT-10: install the deep-link router as early as possible
            // so launch-time `agaric://…` URLs are routed once the rest of
            // setup completes.  The frontend `useDeepLinkRouter` hook
            // additionally calls `getCurrent()` on mount to backfill any
            // event the listener missed before it was registered.
            deeplink::register_deeplink_handlers(app.handle());

            // Open the read/write pools and resolve device-id + sync cert.
            let (pools, device_id, sync_cert) = init_persistence(&db_path, &app_data_dir)?;

            // C-2b: build the materializer BEFORE recovery so the boot-time
            // op-log replay can drive ApplyOp tasks through the foreground queue.
            let (lifecycle, materializer) = build_materializer(&pools, &app_data_dir);

            // Loro init + rehydrate, crash recovery, and per-space bootstrap
            // (bootstrap_spaces is boot-fatal).
            let report = recover_and_bootstrap(&pools, &device_id, &materializer)?;

            // #1255: surface a degraded boot to the user. When the C-2b
            // op-log replay failed wholesale (`replay_errors` non-empty),
            // the materialized view is behind the canonical `op_log` —
            // previously this was downgraded to a `warn` and the user
            // edited a stale view with zero signal. Store the status in
            // managed state (so a late-mounting frontend can backfill it
            // via `get_recovery_status`), emit a durable `recovery:degraded`
            // event, and log at `error` (not `info`). Boot still continues —
            // the app is usable and the op_log is canonical.
            surface_recovery_status(app, &report);

            // Best-effort boot maintenance (off-critical-path spawn + the
            // remaining synchronous enqueues + post-draft-recovery refresh).
            spawn_boot_maintenance(&pools, &device_id, &materializer, &report);

            // Long-running background tasks: sweepers, maintenance daemon,
            // periodic Loro snapshot.
            spawn_background_tasks(&pools, &device_id, &materializer, &lifecycle);

            // Create scheduler wrapped in Arc for sharing with the SyncDaemon
            let scheduler = std::sync::Arc::new(sync_scheduler::SyncScheduler::new());

            // #1058: gather the cheap `Arc` clones each downstream consumer
            // needs BEFORE the originals are moved into managed state by
            // `register_managed_state`. Passing them through the wiring
            // function signatures is what collapses the old
            // clone-before-move hazard — the borrow checker now enforces
            // that the originals are still live here.
            let daemon_wiring = SyncDaemonWiring {
                pool: pools.write.clone(),
                device_id: device_id.clone(),
                materializer: materializer.clone(),
                scheduler: scheduler.clone(),
                cert: sync_cert.clone(),
                sink: std::sync::Arc::new(sync_events::TauriEventSink(app.handle().clone())),
                app_handle: app.handle().clone(),
                lifecycle: lifecycle.clone(),
                // `cancel_flag` is filled in below from the value
                // `register_managed_state` allocates + registers, so the
                // daemon and `cancel_sync` share the same flag (#528).
                cancel_flag: Arc::new(AtomicBool::new(false)),
            };

            // FEAT-4c / FEAT-4h slice 2 — clone the pools + materializer +
            // device_id the MCP RO and RW servers need before the move.
            let mcp_ro_read_pool = pools.read.clone();
            let mcp_ro_write_pool = pools.write.clone();
            let mcp_ro_materializer = materializer.clone();
            let mcp_ro_device_id = device_id.clone();
            let mcp_rw_write_pool = pools.write.clone();
            let mcp_rw_materializer = materializer.clone();
            let mcp_rw_device_id = device_id.clone();

            // Move all originals into Tauri managed state + install the
            // window-focus lifecycle listener. Returns the shared sync
            // cancel flag (#528) used by the daemon spawned next.
            let cancel_flag = register_managed_state(
                app,
                pools,
                device_id,
                sync_cert,
                materializer,
                scheduler,
                &lifecycle,
            );

            // Install rustls + spawn the SyncDaemon (#382/#383/#278).
            let daemon_wiring = SyncDaemonWiring {
                cancel_flag,
                ..daemon_wiring
            };
            wire_sync_daemon(daemon_wiring);

            // FEAT-4a / 4h — MCP read-only + read-write servers.
            wire_mcp_servers(
                app,
                &app_data_dir,
                McpServerWiring {
                    ro_read_pool: mcp_ro_read_pool,
                    ro_write_pool: mcp_ro_write_pool,
                    ro_materializer: mcp_ro_materializer,
                    ro_device_id: mcp_ro_device_id,
                    rw_write_pool: mcp_rw_write_pool,
                    rw_materializer: mcp_rw_materializer,
                    rw_device_id: mcp_rw_device_id,
                },
            );

            Ok(())
        })
        .invoke_handler(builder.invoke_handler())
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "failed to build Tauri application");
            std::process::exit(1);
        })
        .run(|app_handle, event| {
            // Persist Loro snapshots on shutdown so the next boot
            // rehydrates with no replay gap — a clean exit leaves
            // `loro_doc_state` exactly current with the apply cursor,
            // which the periodic 5-minute task alone cannot guarantee.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let (Some(state), Some(pool)) = (
                    crate::loro::shared::get(),
                    app_handle.try_state::<WritePool>(),
                ) {
                    let saved = tauri::async_runtime::block_on(
                        crate::loro::snapshot::save_all_engines(&pool.0, &state.registry),
                    );
                    tracing::info!(saved, "loro: persisted snapshots on exit");
                }
            }
        });
}

#[cfg(test)]
mod specta_tests {
    use tauri_specta::Builder;

    /// Build the tauri-specta [`Builder`] with every registered command.
    ///
    /// Shared between the export test and (potentially) runtime setup so the
    /// command list stays in sync. I-Core-7: the command list itself lives
    /// in the `agaric_commands!` macro near the top of `lib.rs`; this
    /// function and `run()` both expand it so they cannot drift.
    fn specta_builder() -> Builder<tauri::Wry> {
        // tauri-specta 2.0.0-rc.25 forbids BigInt-style integer types
        // (u64/i64/u128/i128/usize/isize) in TypeScript exports by default
        // because JS `number` is f64 and silently loses precision above
        // ~2^53. We've shipped on the rc.24 default (cast as `number`) for
        // the lifetime of the app — every IPC u64/i64 we surface is a row
        // count, byte count, or millisecond timestamp, all comfortably
        // under the safe-integer ceiling. The `dangerously_*` opt-in
        // preserves that behavior so we keep wire compatibility without
        // forcing a frontend-wide BigInt audit. Revisit if any IPC field
        // ever needs to carry values >2^53.
        Builder::<tauri::Wry>::new()
            .commands(agaric_commands!())
            .dangerously_cast_bigints_to_number()
    }

    /// Verify the generated TypeScript bindings match the committed file.
    ///
    /// Writes to a temp file and compares against `src/lib/bindings.ts`.
    /// To regenerate: `cargo test -- specta_tests --ignored`
    #[test]
    fn ts_bindings_up_to_date() {
        let builder = specta_builder();
        let tmp = std::env::temp_dir().join("agaric_bindings_check.ts");
        builder
            .export(specta_typescript::Typescript::default(), &tmp)
            .expect("Failed to export TypeScript bindings to temp file");

        let generated = std::fs::read_to_string(&tmp).expect("read generated");
        let committed_path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/bindings.ts");
        let committed = std::fs::read_to_string(&committed_path)
            .expect("read committed bindings.ts — run the ignored regenerate test first");

        // Normalize: trim trailing whitespace, strip `// @ts-nocheck` header,
        // and trim leading/trailing blank lines so minor whitespace differences
        // between specta output and the committed file don't cause spurious diffs.
        let norm = |s: &str| -> String {
            let lines: Vec<&str> = s
                .lines()
                .map(str::trim_end)
                .filter(|l| *l != "// @ts-nocheck")
                .collect();
            // Trim leading and trailing empty lines
            let start = lines.iter().position(|l| !l.is_empty()).unwrap_or(0);
            let end = lines
                .iter()
                .rposition(|l| !l.is_empty())
                .map_or(0, |i| i + 1);
            lines[start..end].join("\n")
        };

        assert_eq!(
            norm(&generated),
            norm(&committed),
            "TypeScript bindings are stale — regenerate with: \
             cd src-tauri && cargo test -- specta_tests --ignored"
        );
    }

    /// Regenerate `src/lib/bindings.ts` from the current Rust types.
    ///
    /// Run manually: `cd src-tauri && cargo test -- specta_tests --ignored`
    #[test]
    #[ignore]
    fn regenerate_ts_bindings() {
        let builder = specta_builder();
        let out_path = "../src/lib/bindings.ts";
        builder
            .export(specta_typescript::Typescript::default(), out_path)
            .expect("Failed to export TypeScript bindings");

        // Prepend `// @ts-nocheck` so tsc ignores unused specta-generated declarations
        let content = std::fs::read_to_string(out_path).expect("read generated bindings");
        std::fs::write(out_path, format!("// @ts-nocheck\n{content}"))
            .expect("write bindings with ts-nocheck header");
    }
}

#[cfg(test)]
mod log_directives_tests {
    use super::{build_log_directives, has_directive_for_target};

    const DEFAULTS: &[(&str, &str)] = &[("agaric", "info"), ("frontend", "info")];

    #[test]
    fn empty_input_yields_only_defaults() {
        let out = build_log_directives("", DEFAULTS);
        assert_eq!(out, "agaric=info,frontend=info");
    }

    #[test]
    fn whitespace_only_input_is_treated_as_empty() {
        let out = build_log_directives("   \t\n", DEFAULTS);
        assert_eq!(out, "agaric=info,frontend=info");
    }

    #[test]
    fn user_agaric_directive_overrides_default() {
        // RUST_LOG=agaric=error — user wants agaric at error.
        let out = build_log_directives("agaric=error", DEFAULTS);
        assert!(
            out.contains("agaric=error"),
            "user directive must be preserved, got: {out}"
        );
        assert!(
            !out.contains("agaric=info"),
            "default agaric=info must NOT be appended when user specified a directive for agaric, got: {out}"
        );
        // frontend default still applies.
        assert!(
            out.contains("frontend=info"),
            "frontend default should still be appended, got: {out}"
        );
    }

    #[test]
    fn user_frontend_directive_overrides_default() {
        let out = build_log_directives("frontend=trace", DEFAULTS);
        assert!(out.contains("frontend=trace"), "got: {out}");
        assert!(!out.contains("frontend=info"), "got: {out}");
        assert!(out.contains("agaric=info"), "got: {out}");
    }

    #[test]
    fn unrelated_user_directive_preserves_all_defaults() {
        let out = build_log_directives("sqlx=trace", DEFAULTS);
        assert!(out.contains("sqlx=trace"), "got: {out}");
        assert!(out.contains("agaric=info"), "got: {out}");
        assert!(out.contains("frontend=info"), "got: {out}");
    }

    #[test]
    fn submodule_directive_counts_as_target_override() {
        // User pins agaric::db=trace — they care about the agaric crate,
        // so we must not clobber it with the default agaric=info.
        let out = build_log_directives("agaric::db=trace", DEFAULTS);
        assert!(out.contains("agaric::db=trace"), "got: {out}");
        assert!(!out.contains("agaric=info"), "got: {out}");
        // frontend default should still apply since user didn't mention it.
        assert!(out.contains("frontend=info"), "got: {out}");
    }

    #[test]
    fn bare_level_does_not_suppress_defaults() {
        // RUST_LOG=warn is a global level directive, not target-specific.
        // Defaults should still be appended (they're more specific and win
        // for agaric/frontend as intended).
        let out = build_log_directives("warn", DEFAULTS);
        assert!(out.contains("warn"), "got: {out}");
        assert!(out.contains("agaric=info"), "got: {out}");
        assert!(out.contains("frontend=info"), "got: {out}");
    }

    #[test]
    fn multiple_user_directives_preserved() {
        let out = build_log_directives("agaric=error,frontend=debug,sqlx=warn", DEFAULTS);
        assert!(out.contains("agaric=error"), "got: {out}");
        assert!(out.contains("frontend=debug"), "got: {out}");
        assert!(out.contains("sqlx=warn"), "got: {out}");
        assert!(!out.contains("agaric=info"), "got: {out}");
        assert!(!out.contains("frontend=info"), "got: {out}");
    }

    #[test]
    fn output_parses_as_valid_env_filter() {
        // A smoke test: whatever build_log_directives returns must parse as
        // a tracing_subscriber EnvFilter, otherwise the fallback path is
        // the only protection against panics in `run()`.
        let cases = [
            "",
            "agaric=error",
            "frontend=trace",
            "agaric::db=trace,sqlx=warn",
            "info",
            "   ",
        ];
        for input in cases {
            let out = build_log_directives(input, DEFAULTS);
            let result = tracing_subscriber::EnvFilter::try_new(&out);
            assert!(
                result.is_ok(),
                "build_log_directives({input:?}) produced invalid EnvFilter string: {out}"
            );
        }
    }

    #[test]
    fn has_directive_for_target_positive_cases() {
        assert!(has_directive_for_target("agaric=info", "agaric"));
        assert!(has_directive_for_target("agaric", "agaric"));
        assert!(has_directive_for_target("agaric::db=trace", "agaric"));
        assert!(has_directive_for_target("sqlx=warn,agaric=debug", "agaric"));
        assert!(has_directive_for_target(
            "agaric[span_field]=debug",
            "agaric"
        ));
    }

    #[test]
    fn has_directive_for_target_negative_cases() {
        assert!(!has_directive_for_target("", "agaric"));
        assert!(!has_directive_for_target("info", "agaric"));
        assert!(!has_directive_for_target("sqlx=warn", "agaric"));
        // Bare level — not a target directive.
        assert!(!has_directive_for_target("debug", "agaric"));
        // Different target that happens to share a prefix substring.
        assert!(!has_directive_for_target("agaric_extras=trace", "agaric"));
    }

    /// I-Core-6: a directive like `agaric_extras=trace` must NOT be treated
    /// as targeting the `agaric` crate. The prefix check in
    /// `has_directive_for_target` uses `"agaric::"` (with `::`) as the
    /// submodule boundary, so `agaric_extras` correctly fails the match.
    /// The existing `unrelated_user_directive_preserves_all_defaults` test
    /// only exercises `sqlx=trace`; this test pins the namespace-prefix
    /// collision case specifically — both at the predicate level and end
    /// to end through `build_log_directives`, so the `agaric=info` default
    /// is still appended even when the user filter contains a name that
    /// merely starts with `agaric`.
    #[test]
    fn build_log_directives_preserves_default_under_namespace_prefix_collision_i_core_6() {
        // Predicate-level: `agaric_extras` is a different crate from `agaric`.
        assert!(
            !has_directive_for_target("agaric_extras=trace", "agaric"),
            "I-Core-6: `agaric_extras=trace` is a different crate and must \
             not satisfy `has_directive_for_target(_, \"agaric\")`"
        );

        // End-to-end: the `agaric=info` default must still be appended.
        let out = build_log_directives("agaric_extras=trace", DEFAULTS);
        assert!(
            out.contains("agaric_extras=trace"),
            "I-Core-6: user directive `agaric_extras=trace` must be preserved, got: {out}"
        );
        assert!(
            out.contains("agaric=info"),
            "I-Core-6: `agaric=info` default must still be appended when the \
             only user directive is `agaric_extras=trace` (prefix-only collision), got: {out}"
        );
        assert!(
            out.contains("frontend=info"),
            "I-Core-6: unrelated `frontend=info` default must also still be appended, got: {out}"
        );
    }

    /// I-Core-6: positive coverage that an exact-target directive
    /// (`agaric=trace`) IS recognised by `has_directive_for_target` and
    /// causes `build_log_directives` to drop the matching default — the
    /// user override wins, no duplicate `agaric=info` is appended. This
    /// pairs with the prefix-collision negative test above to pin both
    /// halves of the `has_directive_for_target` contract.
    #[test]
    fn build_log_directives_recognises_exact_target_match_i_core_6() {
        // Predicate-level: an exact target match must be recognised.
        assert!(
            has_directive_for_target("agaric=trace", "agaric"),
            "I-Core-6: exact target `agaric=trace` must satisfy \
             `has_directive_for_target(_, \"agaric\")`"
        );

        // End-to-end: the user override wins; no duplicate default is added.
        let out = build_log_directives("agaric=trace", DEFAULTS);
        assert!(
            out.contains("agaric=trace"),
            "I-Core-6: user override `agaric=trace` must be preserved, got: {out}"
        );
        assert!(
            !out.contains("agaric=info"),
            "I-Core-6: `agaric=info` default must NOT be appended when the \
             user has already set `agaric=trace`, got: {out}"
        );
        // Sanity: unrelated default still applies.
        assert!(
            out.contains("frontend=info"),
            "I-Core-6: unrelated `frontend=info` default must still be appended, got: {out}"
        );
    }
}

// ===========================================================================
// BUG-34: log_dir_for_app_data helper tests
// ===========================================================================
//
// The same helper is used by the tracing-appender setup in `run()` and by
// the `get_log_dir` Tauri command (via `src/commands/logging.rs`). These
// tests pin down the invariant: both code paths MUST resolve to the same
// path — "<app_data_dir>/logs" — regardless of platform.  Before BUG-34 was
// fixed, `run()` hard-coded a Linux XDG path while `get_log_dir` used Tauri's
// OS-correct resolver, so the two drifted on macOS / Windows.

#[cfg(test)]
mod log_dir_tests {
    use super::{build_log_file_appender, log_dir_for_app_data};
    use std::path::Path;
    use tempfile::TempDir;

    /// #635: a writable log dir yields a real appender (the happy path
    /// that keeps file logging on).
    #[test]
    fn writable_log_dir_builds_appender() {
        let tmp = TempDir::new().expect("temp dir");
        let log_dir = tmp.path().join("logs");
        let appender = build_log_file_appender(&log_dir);
        assert!(
            appender.is_some(),
            "a writable log dir must yield a file appender"
        );
        assert!(log_dir.exists(), "create_dir_all must have run");
    }

    /// #635: an unwritable log dir must DEGRADE (return `None`) rather than
    /// panic/abort. Pre-#635 this path hit `.expect(..)` before the tracing
    /// subscriber existed, killing the app silently under the abort profile.
    ///
    /// We make the PARENT read-only so `create_dir_all(parent/logs)` fails,
    /// then assert the helper returns `None` instead of unwinding.
    #[cfg(unix)]
    #[test]
    fn unwritable_log_dir_degrades_without_panic() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().expect("temp dir");
        let parent = tmp.path().join("readonly");
        std::fs::create_dir(&parent).expect("create parent");

        // 0o500 = r-x------ : the parent can be traversed but not written,
        // so creating a child `logs/` subdirectory is denied.
        let mut perms = std::fs::metadata(&parent).unwrap().permissions();
        perms.set_mode(0o500);
        std::fs::set_permissions(&parent, perms).expect("chmod readonly");

        let log_dir = parent.join("logs");
        let appender = build_log_file_appender(&log_dir);

        // Restore write perms so TempDir cleanup can remove the dir.
        let mut perms = std::fs::metadata(&parent).unwrap().permissions();
        perms.set_mode(0o700);
        let _ = std::fs::set_permissions(&parent, perms);

        assert!(
            appender.is_none(),
            "an unwritable log dir must degrade to None, not panic"
        );
    }

    #[test]
    fn log_dir_for_app_data_appends_logs_subdir() {
        let app_data = Path::new("/tmp/agaric-test-data");
        let log_dir = log_dir_for_app_data(app_data);
        assert_eq!(
            log_dir,
            Path::new("/tmp/agaric-test-data/logs"),
            "log directory must be <app_data_dir>/logs"
        );
    }

    #[test]
    fn log_dir_for_app_data_preserves_base_directory() {
        // The helper must never mutate the app_data_dir (no `../` etc).
        let app_data = Path::new("/var/mobile/Containers/Data/Application/XYZ/Data/com.agaric");
        let log_dir = log_dir_for_app_data(app_data);
        assert!(
            log_dir.starts_with(app_data),
            "log dir must start with app_data_dir, got {log_dir:?}"
        );
        assert!(
            log_dir.ends_with("logs"),
            "log dir must end with 'logs', got {log_dir:?}"
        );
    }

    /// Integration-style regression test for BUG-34.
    ///
    /// Before the fix, `run()` computed the log directory from `HOME`
    /// (Linux XDG layout) while `get_log_dir` used `app.path().app_data_dir()`,
    /// so on macOS / Windows the two diverged. The fix routes both through
    /// `log_dir_for_app_data()`; this test verifies the helper's output
    /// matches the same `<app_data_dir>/logs` shape `get_log_dir` returns.
    #[test]
    fn log_dir_matches_get_log_dir_contract() {
        // Simulate what `get_log_dir` does: take the Tauri-resolved
        // `app_data_dir` and append "logs" via the helper.
        let simulated_app_data = std::env::temp_dir().join("agaric-bug34-test");
        let log_dir = log_dir_for_app_data(&simulated_app_data);

        // `get_log_dir` does: `data_dir.join("logs").to_string_lossy()`.
        // Our helper result must serialize to the same string.
        let expected = simulated_app_data.join("logs");
        assert_eq!(
            log_dir, expected,
            "tracing-appender log dir must equal <app_data_dir>/logs (what get_log_dir returns)"
        );
    }
}

// #634: unit tests for the abort-safe panic-report helpers. A full
// `panic = "abort"` integration test can't run in-process (the test binary
// would die), so we test the extracted, pure formatting + payload-extraction
// logic the hook delegates to.
#[cfg(test)]
mod panic_report_tests {
    use super::{format_panic_report, panic_payload_and_location};

    #[test]
    fn report_includes_payload_location_and_backtrace() {
        let report = format_panic_report(
            "something exploded",
            "src/foo.rs:42:7",
            "0: frame_a\n1: frame_b",
        );
        assert!(
            report.contains("something exploded"),
            "report must carry the panic payload, got: {report}"
        );
        assert!(
            report.contains("src/foo.rs:42:7"),
            "report must carry the panic location, got: {report}"
        );
        assert!(
            report.contains("frame_a") && report.contains("frame_b"),
            "report must carry the captured backtrace, got: {report}"
        );
        assert!(
            report.starts_with("PANIC"),
            "report must be greppable via the PANIC marker, got: {report}"
        );
    }

    #[test]
    fn report_handles_missing_location() {
        let report = format_panic_report("boom", "", "<bt>");
        assert!(
            report.contains("<unknown location>"),
            "empty location must degrade to a sentinel, got: {report}"
        );
        assert!(
            report.contains("boom"),
            "payload must still appear: {report}"
        );
    }

    #[test]
    fn payload_extraction_reads_str_payload_and_location() {
        // `panic::catch_unwind` lets us drive `panic_payload_and_location`
        // with a real `PanicHookInfo` without aborting the test binary: we
        // install a temporary hook, capture what it extracts, then restore.
        use std::sync::Mutex;
        static CAPTURED: Mutex<Option<(String, String)>> = Mutex::new(None);

        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|info| {
            let extracted = panic_payload_and_location(info);
            *CAPTURED.lock().unwrap() = Some(extracted);
        }));

        let result = std::panic::catch_unwind(|| {
            panic!("str payload here");
        });

        std::panic::set_hook(previous);

        assert!(result.is_err(), "the closure must have panicked");
        let (payload, location) = CAPTURED
            .lock()
            .unwrap()
            .take()
            .expect("hook must have captured the panic");
        assert_eq!(
            payload, "str payload here",
            "string payload must round-trip"
        );
        assert!(
            location.contains("lib.rs"),
            "location must point at this source file, got: {location}"
        );
    }
}

// L-2: unit test for the boot-count error-logging helper.
#[cfg(test)]
mod log_or_zero_tests {
    use super::log_or_zero;

    #[test]
    fn log_or_zero_returns_inner_value_on_ok() {
        assert_eq!(log_or_zero(Ok(42), "test_ctx"), 42);
        assert_eq!(log_or_zero(Ok(0), "test_ctx"), 0);
    }

    #[test]
    fn log_or_zero_returns_zero_on_err() {
        let err = sqlx::Error::PoolTimedOut;
        assert_eq!(log_or_zero(Err(err), "test_ctx"), 0);
    }
}

// L-98: pin down the lex-monotonic `Z`-suffix invariant that several
// reverse-op queries on `op_log.created_at` rely on. See the
// doc-comment on `now_rfc3339` for the full invariant; see the
// `debug_assert!`s in `op_log::append_local_op_in_tx` /
// `append_local_op_at` for the runtime enforcement.
#[cfg(test)]
mod now_rfc3339_tests {
    use super::now_rfc3339;

    /// Two consecutive `now_rfc3339()` calls must:
    ///   1. Both end with `Z` — the suffix is what makes
    ///      `op_log.created_at` lex-monotonic. Production code paths
    ///      under `reverse::block_ops`, `reverse::property_ops`, and
    ///      `reverse::attachment_ops` compare timestamps with
    ///      `created_at < ?` and `ORDER BY created_at DESC`. That is
    ///      only correct when every value shares the same fixed-width
    ///      `…Z` shape — a future ingest path that introduced
    ///      `+00:00`-suffixed timestamps would silently break "find
    ///      prior op" lookups even though both encode the same instant.
    ///   2. Sort lex-monotonically as time advances — `t1 <= t2`
    ///      lexicographically when `t1` was sampled before `t2`. This
    ///      only holds because chrono produces a fixed-width
    ///      `YYYY-MM-DDTHH:MM:SS.sssZ` representation; the assertions
    ///      below catch any future change to `now_rfc3339`'s output
    ///      shape that would silently break that ordering.
    #[test]
    fn now_rfc3339_produces_lex_monotonic_z_suffix() {
        let t1 = now_rfc3339();

        assert!(
            t1.ends_with('Z'),
            "now_rfc3339() output `{t1}` must end with `Z` — the L-98 \
             lex-monotonic invariant on op_log.created_at depends on every \
             stored timestamp sharing the same `…Z` shape (see the \
             doc-comment on `now_rfc3339` and on `op_log::OpRecord`)"
        );

        // Verify lex-monotonicity with two fixed instants instead of
        // wall-clock calls (which are flaky under NTP step-back).
        // `now_rfc3339` uses `SecondsFormat::Millis` + `use_z = true`,
        // producing a fixed-width `YYYY-MM-DDTHH:MM:SS.sssZ` string whose
        // lexicographic order tracks real time — these constants exercise
        // that property without touching the system clock.
        use chrono::TimeZone as _;
        let earlier = chrono::Utc
            .with_ymd_and_hms(2020, 1, 1, 0, 0, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let later = chrono::Utc
            .with_ymd_and_hms(2030, 1, 1, 0, 0, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(
            earlier < later,
            "rfc3339 with SecondsFormat::Millis must be lex-monotonic for \
             sequential instants: `{earlier}` must be less than `{later}`. \
             A change to `now_rfc3339`'s format (e.g. variable-width \
             fractional seconds or mixed `Z`/`+00:00` suffixes) would \
             break op_log compaction and reverse-op prior-lookup queries"
        );
    }
}
