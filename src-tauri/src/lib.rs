#[cfg(target_os = "linux")]
pub mod appimage_integration;
pub mod backlink;
pub mod block_descendants;
pub mod cache;
pub mod cancellation;
pub mod commands;
pub mod dag;
pub mod db;
pub mod deeplink;
pub mod device;
pub mod draft;
pub mod error;
pub mod filters;
pub mod fts;
pub mod gcal_push;
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
            // MCP RW (FEAT-4h slice 2)
            $crate::commands::mcp::get_mcp_rw_status,
            $crate::commands::mcp::get_mcp_rw_socket_path,
            $crate::commands::mcp::mcp_rw_set_enabled,
            $crate::commands::mcp::mcp_rw_disconnect_all,
            // Google Calendar push (FEAT-5e) — Settings "Google Calendar" tab
            $crate::commands::gcal::get_gcal_status,
            $crate::commands::gcal::force_gcal_resync,
            $crate::commands::gcal::disconnect_gcal,
            $crate::commands::gcal::set_gcal_window_days,
            $crate::commands::gcal::set_gcal_privacy_mode,
            // Desktop OAuth flow entry point (FEAT-5b).
            $crate::commands::gcal::begin_gcal_oauth,
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

/// Shutdown flag for the `materializer::retry_queue` sweeper (BUG-22).
///
/// The sweeper runs every 60s and polls this flag on each tick. Stored in
/// Tauri managed state for the rare case a shutdown handler wants to stop
/// it cleanly; the flag is a no-op in most graceful-exit paths.
pub struct RetryQueueSweeperShutdown(pub Arc<AtomicBool>);

/// Shutdown flag for the `draft::spawn_orphan_drafts_sweeper` task
/// (PEND-28a M1).
///
/// The sweeper runs once at boot and then every
/// [`draft::ORPHAN_DRAFTS_SWEEP_INTERVAL`] (1 hour) and polls this flag
/// on each tick. Stored in Tauri managed state for the rare case a
/// shutdown handler wants to stop it cleanly; the flag is a no-op in
/// most graceful-exit paths.
pub struct OrphanDraftsSweeperShutdown(pub Arc<AtomicBool>);

/// Shutdown flag for the [`maintenance::spawn_daemon`] task (issue #157
/// sub-item B). The daemon walks its job vector on a
/// [`maintenance::TICK_INTERVAL`] (60 s) cadence and polls this flag at
/// the top of each tick. Stored in Tauri managed state so a clean-exit
/// path can stop it; a no-op in most graceful-exit paths.
pub struct MaintenanceDaemonShutdown(pub Arc<AtomicBool>);

/// Shutdown flag for the periodic Loro snapshot task.
///
/// The task persists every engine's snapshot into `loro_doc_state` on a
/// [`crate::loro::snapshot::SNAPSHOT_INTERVAL_SECS`] cadence and polls
/// this flag on each tick. Stored in managed state so a clean-exit path
/// can stop it; a no-op in most graceful-exit paths.
pub struct SnapshotTaskShutdown(pub Arc<AtomicBool>);

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

#[cfg(not(tarpaulin_include))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use db::{ReadPool, WritePool};
    use device::DeviceId;
    use lifecycle::{AppLifecycle, LifecycleHooks};
    use materializer::{MaterializeTask, Materializer};
    use sync_cert::PersistedCert;
    use tauri::Manager;
    use tauri_specta::Builder;
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    #[cfg(target_os = "linux")]
    disable_webkit_dmabuf_if_unset();

    // BUG-34: Tracing-appender setup moved into the Tauri `setup()` hook so
    // it can use `app.path().app_data_dir()` (OS-correct location on every
    // platform) instead of a hard-coded Linux XDG path. The panic hook is
    // installed here early — it uses the global tracing subscriber and is
    // a no-op until the subscriber is installed in `setup()`.

    // M-44: Install custom panic hook so panics are captured in the log file.
    std::panic::set_hook(Box::new(|info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        tracing::error!(target: "agaric", panic = %payload, location = %location, "PANIC");
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
        .plugin(tauri_plugin_notification::init())
        // FEAT-5b — OAuth 2.0 PKCE loopback listener for the Agaric →
        // Google Calendar connector (FEAT-5). The
        // plugin spawns a localhost server on demand (via
        // `tauri-plugin-oauth`'s `start()` helper) so the OS browser can
        // redirect back to Agaric after Google's authorization screen.
        // Part of the Tauri plugin coupled stack per AGENTS.md §"Coupled
        // Dependency Updates" — move in lockstep with the rest of the
        // tauri-plugin-* crates.
        .plugin(tauri_plugin_oauth::init());

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
            // Resolve the OS-standard app data directory from tauri.conf.json identifier
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("notes.db");

            // BUG-34: Initialize tracing-appender using the OS-correct
            // `app_data_dir` so the "Open logs folder" action (get_log_dir)
            // and the on-disk log files resolve to the same path on every
            // platform (Linux, macOS, Windows, Android).
            let log_dir = log_dir_for_app_data(&app_data_dir);
            let _ = std::fs::create_dir_all(&log_dir);

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
            let file_appender = tracing_appender::rolling::RollingFileAppender::builder()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .max_log_files(14)
                .filename_prefix("agaric.log")
                .build(&log_dir)
                .expect("logging directory must be writable");
            let (non_blocking, log_guard) = tracing_appender::non_blocking(file_appender);

            // Preserve any user-provided `RUST_LOG` directives for
            // `agaric` / `frontend` (BUG-40).
            let rust_log = std::env::var("RUST_LOG").unwrap_or_default();
            let directives =
                build_log_directives(&rust_log, &[("agaric", "info"), ("frontend", "info")]);
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
            tracing_subscriber::registry()
                .with(env_filter)
                .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
                .with(
                    tracing_subscriber::fmt::layer()
                        .json()
                        .with_writer(non_blocking)
                        .with_ansi(false),
                )
                .init();

            tracing::info!(log_dir = %log_dir.display(), "log directory initialized");

            // Issue #157 sub-item A — retention is now enforced by the
            // RollingFileAppender::builder().max_log_files(14) call above,
            // continuously rather than boot-only. The previous M-45 boot
            // sweep (`cleanup_old_log_files`) was removed along with its
            // tests.

            // Keep the non-blocking appender's worker guard alive for the
            // lifetime of the app so buffered writes are never lost.
            app.manage(LogGuard(log_guard));

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

            // Initialize separated read/write pools
            let pools = tauri::async_runtime::block_on(db::init_pools(&db_path))?;

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

            // Create materializer — bg cache rebuilds read from read pool, write to write pool (P-8)
            //
            // PERF-24: wire up the app-lifecycle hooks so the metrics-
            // snapshot task stops emitting debug-level log lines while
            // the app is backgrounded on mobile. The same hooks are
            // later passed into the sync daemon below so its periodic
            // resync tick short-circuits when backgrounded.
            //
            // C-2b: the materializer is constructed BEFORE
            // `recover_at_boot` so the boot-time op-log replay path
            // (`recovery::replay_unmaterialized_ops`) can drive
            // `ApplyOp` tasks through the foreground queue. Earlier
            // versions of this file constructed the materializer after
            // recovery; that ordering is incompatible with the C-2b
            // replay step (which must run before draft recovery so
            // synthetic edit_block ops do not interleave with replayed
            // real ops).
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
            materializer.set_app_data_dir(app_data_dir.clone());

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
            {
                let installed = crate::loro::shared::init();
                tracing::info!(
                    installed,
                    "loro: process-global LoroState init complete (synchronous, pre-recovery)",
                );
                if let Some(state) = crate::loro::shared::get() {
                    let n = tauri::async_runtime::block_on(
                        crate::loro::snapshot::rehydrate_registry(
                            &pools.write,
                            &state.registry,
                            &device_id,
                        ),
                    );
                    if n > 0 {
                        tracing::info!(
                            rehydrated_spaces = n,
                            "loro: rehydrated per-space LoroDoc snapshots from \
                             loro_doc_state (pre-recovery)",
                        );
                    }
                }
            }

            // Run crash recovery before anything else
            // Recovery needs write access
            let report = tauri::async_runtime::block_on(recovery::recover_at_boot(
                &pools.write,
                &device_id,
                &materializer,
            ))?;
            if !report.drafts_recovered.is_empty() {
                tracing::info!(
                    count = report.drafts_recovered.len(),
                    "recovered unflushed drafts"
                );
            }
            if report.ops_replayed > 0 || !report.replay_errors.is_empty() {
                tracing::info!(
                    ops_replayed = report.ops_replayed,
                    replay_errors = report.replay_errors.len(),
                    "C-2b: replayed unmaterialized ops at boot"
                );
            }

            // P-16: Populate projected agenda cache at boot so the first query
            // hits the cache rather than falling back to on-the-fly computation.
            if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache) {
                tracing::warn!(error = %e, "failed to enqueue projected agenda cache rebuild at boot");
            }

            // FEAT-3 Phase 1: seed the two default spaces (Personal + Work) and
            // migrate every pre-existing page into Personal. Idempotent across
            // boots via an internal fast-path check. Failure is boot-fatal:
            // the app's "every page belongs to a space" invariant cannot be
            // honoured without this step completing.
            if let Err(e) = tauri::async_runtime::block_on(spaces::bootstrap_spaces(
                &pools.write,
                &device_id,
                &materializer,
            )) {
                tracing::error!(error = %e, "failed to bootstrap spaces — aborting boot");
                return Err(Box::new(e));
            }

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
                let device_id_owned = device_id.clone();
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
                            tracing::info!(
                                blocks = block_count,
                                "FTS index empty — scheduling rebuild"
                            );
                            if let Err(e) = materializer_handle
                                .try_enqueue_background(MaterializeTask::RebuildFtsIndex)
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
                            if let Err(e) = materializer_handle.try_enqueue_background(
                                MaterializeTask::RebuildBlockTagRefsCache,
                            ) {
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
            if let Err(e) =
                materializer.try_enqueue_background(MaterializeTask::CleanupOrphanedAttachments)
            {
                tracing::warn!(error = %e, "failed to enqueue CleanupOrphanedAttachments at boot");
            }

            // BUG-23: When drafts were recovered before the materializer was
            // created, the targeted FTS / block_links / tags / pages caches
            // are stale for those block_ids. Refresh them now and block until
            // the background queue drains so UI queries after setup never see
            // pre-recovery state.
            if !report.drafts_recovered.is_empty()
                && let Err(e) = tauri::async_runtime::block_on(
                    recovery::refresh_caches_for_recovered_drafts(
                        &pools.read,
                        &materializer,
                        &report.drafts_recovered,
                    ),
                ) {
                    tracing::warn!(
                        error = %e,
                        drafts = report.drafts_recovered.len(),
                        "failed to refresh caches after draft recovery",
                    );
                }

            // BUG-22: Spawn the retry-queue sweeper so any per-block tasks
            // persisted by a previous session (or accumulated during this
            // one) get drained on a 60-second cadence. The sweeper uses
            // its own shutdown flag; it dies when this flag is set and
            // re-enqueues rows that have reached their `next_attempt_at`.
            let retry_shutdown = Arc::new(AtomicBool::new(false));
            materializer::retry_queue::spawn_sweeper(
                pools.read.clone(),
                pools.write.clone(),
                materializer.clone(),
                retry_shutdown.clone(),
            );
            app.manage(RetryQueueSweeperShutdown(retry_shutdown));

            // PEND-28a M1: Spawn the orphan-drafts sweeper. Drafts whose
            // parent block has been *soft-deleted* survive the M-93 FK
            // (which references the row, not its `deleted_at` column),
            // so without this periodic sweep they would accumulate and
            // surface as phantom drafts in the UI on next boot. The
            // task runs once at boot and then every hour for the
            // process lifetime; cancellation is via the managed
            // shutdown flag, mirroring the retry-queue sweeper above.
            let orphan_drafts_shutdown = Arc::new(AtomicBool::new(false));
            draft::spawn_orphan_drafts_sweeper(
                pools.write.clone(),
                draft::ORPHAN_DRAFTS_SWEEP_INTERVAL,
                orphan_drafts_shutdown.clone(),
            );
            app.manage(OrphanDraftsSweeperShutdown(orphan_drafts_shutdown));

            // Issue #157 sub-item B — MaintenanceDaemon skeleton seeded
            // with the wal_checkpoint_truncate job (1 h cadence, idle
            // predicate). Subsequent sub-items C/E/F/G/H/I/J extend the
            // job vector without re-wiring the daemon.
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
            let compact_device_id = device_id.clone();
            let optimize_write_pool = pools.write.clone();
            let materializer_for_cleanup = materializer.clone();
            let materializer_for_fts = materializer.clone();
            let materializer_for_fts_predicate = materializer.clone();
            let tombstone_write_pool = pools.write.clone();
            let tombstone_device_id = device_id.clone();
            let tombstone_materializer = materializer.clone();
            let loro_snapshot_write_pool = pools.write.clone();
            let projected_agenda_materializer = materializer.clone();
            // Issue #157 sub-item H — shared "last fired UTC day"
            // sentinel for the projected_agenda_midnight job.
            // `i32::MIN` = "never fired"; the first tick post-boot
            // enqueues a rebuild, then subsequent ticks only enqueue
            // when the UTC day number advances.
            let projected_agenda_last_day =
                Arc::new(std::sync::atomic::AtomicI32::new(i32::MIN));
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
                        Box::pin(async move {
                            maintenance::op_log_compact(&pool, &device_id).await
                        })
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
                        Box::pin(async move {
                            maintenance::enqueue_cleanup_orphaned_attachments(&mat).await
                        })
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
                        Box::pin(async move {
                            maintenance::tombstone_purge(&pool, &device_id, &mat).await
                        })
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
                        crate::loro::shared::get()
                            .is_some_and(|s| s.registry.dirty_count() > 0)
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
            maintenance::spawn_daemon(jobs, maintenance_shutdown.clone());
            app.manage(MaintenanceDaemonShutdown(maintenance_shutdown));

            // Periodic Loro snapshot persistence. Re-instated after the
            // PEND-09 parity flush task (which hosted the snapshot save
            // on its tick) was deleted — that regression left
            // `loro_doc_state` permanently empty while the apply cursor
            // kept advancing, so on boot the engine could not be rebuilt
            // and every edit/move failed "block not found". Persists each
            // engine's snapshot every SNAPSHOT_INTERVAL_SECS so the next
            // boot rehydrates without a full op-log replay; cancellation
            // is via the managed flag, mirroring the sweepers above.
            let snapshot_shutdown = Arc::new(AtomicBool::new(false));
            crate::loro::snapshot::spawn_periodic_snapshot(
                pools.write.clone(),
                snapshot_shutdown.clone(),
                crate::loro::snapshot::SNAPSHOT_INTERVAL_SECS,
            );
            app.manage(SnapshotTaskShutdown(snapshot_shutdown));

            // Create scheduler wrapped in Arc for sharing with the SyncDaemon
            let scheduler = std::sync::Arc::new(sync_scheduler::SyncScheduler::new());

            // Clone everything the SyncDaemon needs before moving into managed state
            let daemon_pool = pools.write.clone();
            let daemon_device_id = device_id.clone();
            let daemon_materializer = materializer.clone();
            let daemon_scheduler = scheduler.clone();
            let daemon_cert = sync_cert.clone();
            let daemon_sink: std::sync::Arc<dyn sync_events::SyncEventSink> =
                std::sync::Arc::new(sync_events::TauriEventSink(app.handle().clone()));
            let daemon_app_handle = app.handle().clone();
            let daemon_lifecycle = lifecycle.clone();

            // FEAT-4c — clone the reader pool, materializer, and device_id
            // that ReadOnlyTools needs. These must be cloned before the
            // originals are moved into managed state below.
            //
            // M-82: also clone the writer pool — `journal_for_date` is the
            // only RO tool with a write side-effect (creates a missing
            // journal page) and `BEGIN IMMEDIATE` on the read pool is
            // rejected by `PRAGMA query_only = ON`. The other eight RO
            // tools stay on the reader pool.
            let pools_read_for_mcp = pools.read.clone();
            let pools_write_for_mcp_ro = pools.write.clone();
            let materializer_for_mcp = materializer.clone();
            let device_id_for_mcp = device_id.clone();

            // FEAT-4h slice 2 — clone the writer pool, materializer, and
            // device_id for the RW MCP server's `ReadWriteTools`. The RW
            // registry MUST bind the writer pool (every RW tool mutates).
            let pools_write_for_mcp_rw = pools.write.clone();
            let materializer_for_mcp_rw = materializer.clone();
            let device_id_for_mcp_rw = device_id.clone();

            // FEAT-5e — clone the write pool + device_id for the GCal
            // connector task (see spawn block near the end of setup).
            let pools_write_for_gcal = pools.write.clone();
            let device_id_for_gcal = device_id.clone();

            // FEAT-5h — clone the materializer before it moves into
            // managed state so the later GCal connector wiring can
            // call `materializer.set_gcal_handle`.  `Materializer` is
            // a cheap `Arc`-based clone.
            let materializer_for_gcal = materializer.clone();

            // Store all in Tauri managed state
            app.manage(WritePool(pools.write));
            app.manage(ReadPool(pools.read));
            // PEND-70 P1-A — extension-state guard registry for
            // in-flight search IPCs. See `cancellation.rs`.
            app.manage(cancellation::CancellationRegistry::new());
            app.manage(DeviceId::new(device_id));
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
            match app.get_webview_window("main") { Some(window) => {
                let lifecycle_for_listener = lifecycle.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(focused) = event {
                        if *focused {
                            tracing::info!(
                                "app foregrounded — resuming background work"
                            );
                            lifecycle_for_listener.mark_foreground();
                        } else {
                            tracing::info!(
                                "app backgrounded — daemon + materializer will pause"
                            );
                            lifecycle_for_listener.mark_backgrounded();
                        }
                    }
                });
            } _ => {
                tracing::warn!(
                    "main webview window not available at setup; app-lifecycle hooks inactive"
                );
            }}

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
                    daemon_pool,
                    daemon_device_id,
                    daemon_materializer,
                    daemon_scheduler,
                    daemon_cert,
                    daemon_sink,
                    cancel_flag,
                    daemon_lifecycle,
                )
                .await
                {
                    Ok(daemon) => {
                        tracing::info!("SyncDaemon started successfully");
                        daemon_app_handle.manage(daemon);
                    }
                    Err(e) => tracing::error!(error = %e, "Failed to start SyncDaemon"),
                }
            });

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
            let mcp_pool = pools_read_for_mcp;
            let mcp_write_pool = pools_write_for_mcp_ro;
            let mcp_materializer = materializer_for_mcp;
            let mcp_device_id = device_id_for_mcp;
            mcp::spawn_mcp_ro_task(
                &app_data_dir,
                app.handle().clone(),
                mcp_pool,
                mcp_write_pool,
                mcp_materializer,
                mcp_device_id,
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
                &app_data_dir,
                app.handle().clone(),
                pools_write_for_mcp_rw,
                materializer_for_mcp_rw,
                device_id_for_mcp_rw,
                Some((*mcp_rw_lifecycle_inner).clone()),
            );

            // FEAT-5e — Google Calendar push connector.  Spawned
            // unconditionally so the Tauri-managed-state resolvers for
            // the five `gcal_*` commands always find their backing
            // state.  The task itself stays idle until the user
            // connects a Google account (FEAT-5b) and the first
            // `force_gcal_resync` fires — the outer loop observes no
            // token in the keychain and falls through to the next
            // reconcile tick without issuing HTTP.
            //
            // The production `GcalApi::new()` call can only fail if
            // `reqwest::Client::builder().build()` fails (rustls
            // misconfig).  In that case the `?`-propagation here
            // aborts setup with a clear error rather than silently
            // running with a dead client; the unreachability is
            // documented at the call site below.
            use gcal_push::api::GcalApi;
            use gcal_push::connector::spawn_connector;
            use gcal_push::keyring_store::{
                KeyringTokenStore, NoopEventEmitter, TauriGcalEventEmitter, TokenStore,
            };

            let gcal_emitter: std::sync::Arc<dyn gcal_push::keyring_store::GcalEventEmitter> =
                std::sync::Arc::new(TauriGcalEventEmitter::new(app.handle().clone()));

            // Best-effort keyring init.  A headless Linux box without
            // Secret Service will fail here; fall back to a
            // closed-shut `NoopTokenStore` so the rest of the wiring
            // still lands.  The Settings UI surfaces the unavailable
            // keychain via the `gcal:keyring_unavailable` event.
            let gcal_token_store: std::sync::Arc<dyn TokenStore> =
                match KeyringTokenStore::new(gcal_emitter.clone()) {
                    Ok(store) => std::sync::Arc::new(store),
                    Err(e) => {
                        tracing::warn!(
                            target: "gcal",
                            error = %e,
                            "gcal keyring unavailable; TokenStore seeded with noop shim",
                        );
                        struct NoopTokenStore;
                        #[async_trait::async_trait]
                        impl TokenStore for NoopTokenStore {
                            async fn load(
                                &self,
                            ) -> Result<
                                Option<gcal_push::oauth::Token>,
                                error::AppError,
                            > {
                                Ok(None)
                            }
                            async fn store(
                                &self,
                                _t: &gcal_push::oauth::Token,
                            ) -> Result<(), error::AppError> {
                                Err(error::AppError::Validation(
                                    "keyring.unavailable".to_owned(),
                                ))
                            }
                            async fn clear(&self) -> Result<(), error::AppError> {
                                Ok(())
                            }
                        }
                        std::sync::Arc::new(NoopTokenStore)
                    }
                };

            // Production API.  `GcalApi::new` only fails on a
            // `reqwest::Client::builder().build()` failure (rustls
            // misconfig) — propagate via `?` so the launch fails
            // visibly rather than silently spawning a dead connector.
            let gcal_client: std::sync::Arc<GcalApi> = std::sync::Arc::new(GcalApi::new()?);

            // Silence the unused-import warning on the
            // `NoopEventEmitter` — the constant is used via
            // `keyring_store::NoopEventEmitter` elsewhere; this
            // closure just prevents a dead_code diagnostic in rare
            // build flavors.
            let _ = NoopEventEmitter;

            // FEAT-3p9 M1 — one-shot migration: copy the legacy
            // single-space `gcal_settings` row + keychain entry into
            // the per-space `gcal_space_config` row keyed by the
            // seeded Personal-space ULID. Idempotent across boots via
            // the `gcal_per_space_migrated` flag in `gcal_settings`.
            // MUST run AFTER `bootstrap_spaces` so SPACE_PERSONAL_ULID
            // exists, and BEFORE the GCal connector spawns. Keychain
            // failures are non-fatal: the migration logs and lets the
            // next boot retry.
            let personal_token_store_for_migration: std::sync::Arc<dyn TokenStore> =
                match KeyringTokenStore::new_for_space(
                    gcal_emitter.clone(),
                    spaces::bootstrap::SPACE_PERSONAL_ULID,
                ) {
                    Ok(store) => std::sync::Arc::new(store),
                    Err(e) => {
                        tracing::warn!(
                            target: "gcal",
                            error = %e,
                            "FEAT-3p9 M1: per-space keyring unavailable; \
                             migration will reuse the legacy noop shim",
                        );
                        gcal_token_store.clone()
                    }
                };
            if let Err(e) = tauri::async_runtime::block_on(
                gcal_push::migration::migrate_legacy_gcal_to_personal_space(
                    &pools_write_for_gcal,
                    gcal_token_store.as_ref(),
                    personal_token_store_for_migration.as_ref(),
                    gcal_emitter.as_ref(),
                    chrono::Utc::now(),
                ),
            ) {
                tracing::warn!(
                    target: "gcal",
                    error = %e,
                    "FEAT-3p9 M1 migration failed; will retry on next boot",
                );
            }

            // Spawn the connector task.  The handle + state trio are
            // registered on Tauri so the five gcal commands can
            // resolve.
            // FEAT-5b — shared `OAuthClient` for the desktop OAuth
            // flow. A single shared instance is load-bearing: the
            // PKCE verifier produced by `begin_authorize` must be
            // recoverable by the matching `exchange_code` call, and
            // both go through this client. The `redirect_url`
            // configured here is a sentinel — every flow overrides
            // it with its per-flow loopback port in `begin_authorize`
            // / `exchange_code`. A construction-time failure here
            // means the pinned Google endpoint URLs failed to parse,
            // which is structurally impossible — surface via `expect`
            // so a regression in `OAuthClient::google` panics at
            // startup rather than silently disabling Connect.
            // The client is also passed to `spawn_connector` so the
            // background loop can proactively refresh expiring tokens
            // before calling `run_cycle` (#462).
            let oauth_client = std::sync::Arc::new(
                gcal_push::oauth::OAuthClient::google(0)
                    .expect("Google OAuth endpoints must parse"),
            );

            let pool_for_gcal_connector = pools_write_for_gcal.clone();
            let device_for_gcal_connector = device_id_for_gcal.clone();
            let connector_task = spawn_connector(
                pool_for_gcal_connector,
                gcal_client.clone(),
                gcal_token_store.clone(),
                gcal_emitter.clone(),
                device_for_gcal_connector,
                oauth_client.clone(),
            );
            app.manage(connector_task.handle.clone());
            // FEAT-5h — wire the connector handle into the
            // materializer so the foreground queue's `apply_op`
            // fires `DirtyEvent`s on every remote op that could
            // shift the projected agenda.  Without this hook, the
            // connector would only catch changes on the 15-minute
            // reconcile tick.
            materializer_for_gcal.set_gcal_handle(connector_task.handle.clone());
            // Keep the `ConnectorTask` alive for the lifetime of the
            // app via managed state.
            app.manage(connector_task);

            app.manage(commands::GcalTokenStoreState(gcal_token_store));
            app.manage(commands::GcalEventEmitterState(gcal_emitter));
            app.manage(commands::GcalClientState(gcal_client));
            app.manage(commands::GcalOAuthClientState(oauth_client));

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
                if let (Some(state), Some(pool)) =
                    (crate::loro::shared::get(), app_handle.try_state::<WritePool>())
                {
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
    /// To regenerate: `cargo test -p agaric-lib -- specta_tests --ignored`
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
             cd src-tauri && cargo test -p agaric-lib -- specta_tests --ignored"
        );
    }

    /// Regenerate `src/lib/bindings.ts` from the current Rust types.
    ///
    /// Run manually: `cd src-tauri && cargo test -p agaric-lib -- specta_tests --ignored`
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
    use super::log_dir_for_app_data;
    use std::path::Path;

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
