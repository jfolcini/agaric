pub mod backlink;
pub mod block_descendants;
pub mod cache;
pub mod commands;
pub mod dag;
pub mod db;
pub mod deeplink;
pub mod device;
pub mod draft;
pub mod error;
pub mod fts;
pub mod gcal_push;
pub mod hash;
pub mod import;
pub mod lifecycle;
pub mod link_metadata;
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
pub mod spaces;
pub mod sql_utils;
pub mod sync_cert;
pub mod sync_daemon;
pub mod sync_events;
pub mod sync_files;
pub mod sync_net;
pub mod sync_protocol;
pub mod sync_scheduler;
pub mod tag_inheritance;
pub mod tag_query;
pub mod ulid;
pub mod word_diff;

/// Return the current UTC time as an RFC 3339 string with millisecond
/// precision and a `Z` suffix (e.g. `2025-01-15T12:34:56.789Z`).
///
/// Every timestamp stored in the database should go through this helper so
/// that lexicographic comparisons (e.g. op-log compaction cutoff) are
/// consistent.  See REVIEW-LATER item #48 for context.
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
#[cfg(test)]
mod sync_integration_tests;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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

#[cfg(not(tarpaulin_include))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use db::{ReadPool, WritePool};
    use device::DeviceId;
    use lifecycle::{AppLifecycle, LifecycleHooks};
    use materializer::{MaterializeTask, Materializer};
    use sync_cert::PersistedCert;
    use tauri::Manager;
    use tauri_specta::{collect_commands, Builder};
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::EnvFilter;

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

    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::create_block,
        commands::edit_block,
        commands::delete_block,
        commands::restore_block,
        commands::purge_block,
        commands::move_block,
        commands::list_blocks,
        commands::get_block,
        commands::batch_resolve,
        commands::add_tag,
        commands::remove_tag,
        commands::get_backlinks,
        commands::get_block_history,
        commands::get_conflicts,
        commands::get_status,
        commands::search_blocks,
        commands::query_by_tags,
        commands::query_by_property,
        commands::list_tags_by_prefix,
        commands::list_tags_for_block,
        commands::set_property,
        commands::set_todo_state,
        commands::set_priority,
        commands::set_due_date,
        commands::set_scheduled_date,
        commands::delete_property,
        commands::get_properties,
        commands::get_batch_properties,
        commands::list_page_history,
        commands::revert_ops,
        commands::undo_page_op,
        commands::redo_page_op,
        commands::compute_edit_diff,
        commands::query_backlinks_filtered,
        commands::list_backlinks_grouped,
        commands::list_unlinked_references,
        commands::list_property_keys,
        commands::create_property_def,
        commands::list_property_defs,
        commands::update_property_def_options,
        commands::delete_property_def,
        // Sync
        commands::list_peer_refs,
        commands::get_peer_ref,
        commands::delete_peer_ref,
        commands::update_peer_name,
        commands::set_peer_address,
        commands::get_device_id,
        // Sync — pairing & session (#275, #278)
        commands::start_pairing,
        commands::confirm_pairing,
        commands::cancel_pairing,
        commands::start_sync,
        commands::cancel_sync,
        // Batch count commands (#604)
        commands::count_agenda_batch,
        commands::count_agenda_batch_by_source,
        commands::count_backlinks_batch,
        // Page aliases (#598)
        commands::set_page_aliases,
        commands::get_page_aliases,
        commands::resolve_page_by_alias,
        // Markdown export (#519)
        commands::export_page_markdown,
        // Agenda projection (#644)
        commands::list_projected_agenda,
        // Undated tasks (FEAT-1)
        commands::list_undated_tasks,
        // Logseq/Markdown import (#660)
        commands::import_markdown,
        // Attachments (F-7)
        commands::add_attachment,
        commands::delete_attachment,
        commands::list_attachments,
        // Graph visualization (F-33)
        commands::list_page_links,
        // Draft autosave (F-17)
        commands::save_draft,
        commands::flush_draft,
        commands::delete_draft,
        commands::list_drafts,
        // Frontend logging (F-19)
        commands::log_frontend,
        commands::get_log_dir,
        // Op log compaction (F-20)
        commands::get_compaction_status,
        commands::compact_op_log_cmd,
        // Point-in-time restore (F-26)
        commands::restore_page_to_op,
        // Bulk trash operations (B-46)
        commands::restore_all_deleted,
        commands::purge_all_deleted,
        // Trash descendant counts (UX-243)
        commands::trash_descendant_counts,
        // Link metadata (UX-165)
        commands::fetch_link_metadata,
        commands::get_link_metadata,
        // Bug report (FEAT-5)
        commands::collect_bug_report_metadata,
        commands::read_logs_for_report,
        // MCP (FEAT-4e) — Settings "Agent access" tab
        commands::get_mcp_status,
        commands::get_mcp_socket_path,
        commands::mcp_set_enabled,
        commands::mcp_disconnect_all,
        // MCP RW (FEAT-4h slice 2)
        commands::get_mcp_rw_status,
        commands::get_mcp_rw_socket_path,
        commands::mcp_rw_set_enabled,
        commands::mcp_rw_disconnect_all,
        // Google Calendar push (FEAT-5e) — Settings "Google Calendar" tab
        commands::get_gcal_status,
        commands::force_gcal_resync,
        commands::disconnect_gcal,
        commands::set_gcal_window_days,
        commands::set_gcal_privacy_mode,
        // Spaces (FEAT-3 Phase 1 + Phase 2)
        commands::list_spaces,
        commands::create_page_in_space,
        // Quick capture (FEAT-12) — desktop global-shortcut entry point
        commands::quick_capture_block,
    ]);

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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        // MAINT-109: cross-platform platform/version/arch/locale/hostname
        // API used by `commands::collect_bug_report_metadata`.  Works on
        // both desktop and mobile, so no cfg gate.
        .plugin(tauri_plugin_os::init())
        // FEAT-5b — OAuth 2.0 PKCE loopback listener for the Agaric →
        // Google Calendar connector (see REVIEW-LATER § FEAT-5). The
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

    // MAINT-16: tauri-plugin-updater is desktop-only and currently not wired up
    // (empty pubkey in `tauri.conf.json`, no frontend code calls the update
    // API). Gate registration behind `not(mobile)` so we don't register an
    // unusable plugin on Android, and keep it out of the desktop build until
    // pubkey signing + a frontend action + `updater:default` capability are
    // added. Tracked TODO in `.github/workflows/release.yml`.
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

            let file_appender = tracing_appender::rolling::daily(&log_dir, "agaric.log");
            let (non_blocking, log_guard) = tracing_appender::non_blocking(file_appender);

            // Preserve any user-provided `RUST_LOG` directives for
            // `agaric` / `frontend` (BUG-40).
            let rust_log = std::env::var("RUST_LOG").unwrap_or_default();
            let directives =
                build_log_directives(&rust_log, &[("agaric", "info"), ("frontend", "info")]);
            let env_filter = EnvFilter::try_new(&directives)
                .unwrap_or_else(|_| EnvFilter::new("agaric=info,frontend=info"));

            tracing_subscriber::registry()
                .with(env_filter)
                .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(non_blocking)
                        .with_ansi(false),
                )
                .init();

            tracing::info!(log_dir = %log_dir.display(), "log directory initialized");

            // M-45: Clean up log files older than 30 days (best-effort,
            // boot-time only).
            cleanup_old_log_files(&log_dir, 30);

            // Keep the non-blocking appender's worker guard alive for the
            // lifetime of the app so buffered writes are never lost.
            app.manage(LogGuard(log_guard));

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

            // Run crash recovery before anything else
            // Recovery needs write access
            let report = tauri::async_runtime::block_on(recovery::recover_at_boot(
                &pools.write,
                &device_id,
            ))?;
            if !report.drafts_recovered.is_empty() {
                tracing::info!(
                    count = report.drafts_recovered.len(),
                    "recovered unflushed drafts"
                );
            }

            // UX-165: Clean up stale link metadata entries (> 30 days old, non-auth).
            match tauri::async_runtime::block_on(
                crate::link_metadata::cleanup_stale(&pools.write, 30),
            ) {
                Ok(deleted) => {
                    if deleted > 0 {
                        tracing::info!(deleted, "cleaned up stale link metadata entries");
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "failed to clean up stale link metadata");
                }
            }

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
            // REVIEW-LATER C-3c — register `app_data_dir` so the
            // `CleanupOrphanedAttachments` background task can locate
            // the `attachments/` subtree.
            //
            // TODO: schedule `cleanup_orphaned_attachments` at boot
            // and/or after compaction. Currently the only entry point
            // is `MaterializeTask::CleanupOrphanedAttachments`, which
            // is not yet enqueued from any production path; the GC
            // function is implemented but dormant until a scheduler
            // hooks it.
            materializer.set_app_data_dir(app_data_dir.clone());

            // M-3: Rebuild FTS index at boot if the table is empty (post-migration 0006).
            let fts_count: i64 = tauri::async_runtime::block_on(
                sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks")
                    .fetch_one(&pools.write),
            )
            .unwrap_or(0);
            if fts_count == 0 {
                // Check if there are any blocks that should be indexed
                let block_count: i64 = tauri::async_runtime::block_on(
                    sqlx::query_scalar(
                        "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
                    )
                    .fetch_one(&pools.write),
                )
                .unwrap_or(0);
                if block_count > 0 {
                    tracing::info!(blocks = block_count, "FTS index empty — scheduling rebuild");
                    if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildFtsIndex) {
                        tracing::warn!(error = %e, "failed to enqueue FTS rebuild at boot");
                    }
                }
            }

            // UX-250: Rebuild `block_tag_refs` at boot if the table is empty
            // but there is content to scan. Migration 0034 creates the table
            // but intentionally does not run a SQL backfill (SQLite lacks the
            // regex support we need). This handles both the first boot after
            // the migration ships and any future wipe-plus-restart path that
            // leaves content blocks in place with no ref rows.
            let btr_count: i64 = tauri::async_runtime::block_on(
                sqlx::query_scalar("SELECT COUNT(*) FROM block_tag_refs")
                    .fetch_one(&pools.write),
            )
            .unwrap_or(0);
            if btr_count == 0 {
                let block_count: i64 = tauri::async_runtime::block_on(
                    sqlx::query_scalar(
                        "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
                    )
                    .fetch_one(&pools.write),
                )
                .unwrap_or(0);
                if block_count > 0 {
                    tracing::info!(
                        blocks = block_count,
                        "block_tag_refs empty (migration 0034 backfill) — scheduling rebuild"
                    );
                    if let Err(e) = materializer
                        .try_enqueue_background(MaterializeTask::RebuildBlockTagRefsCache)
                    {
                        tracing::warn!(error = %e, "failed to enqueue block_tag_refs rebuild at boot");
                    }
                }
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
            )) {
                tracing::error!(error = %e, "failed to bootstrap spaces — aborting boot");
                return Err(Box::new(e));
            }

            // FEAT-1: Rebuild page_id column at boot to ensure consistency.
            if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildPageIds) {
                tracing::warn!(error = %e, "failed to enqueue page_id rebuild at boot");
            }

            // BUG-23: When drafts were recovered before the materializer was
            // created, the targeted FTS / block_links / tags / pages caches
            // are stale for those block_ids. Refresh them now and block until
            // the background queue drains so UI queries after setup never see
            // pre-recovery state.
            if !report.drafts_recovered.is_empty() {
                if let Err(e) = tauri::async_runtime::block_on(
                    recovery::refresh_caches_for_recovered_drafts(
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
            }

            // BUG-22: Spawn the retry-queue sweeper so any per-block tasks
            // persisted by a previous session (or accumulated during this
            // one) get drained on a 60-second cadence. The sweeper uses
            // its own shutdown flag; it dies when this flag is set and
            // re-enqueues rows that have reached their `next_attempt_at`.
            let retry_shutdown = Arc::new(AtomicBool::new(false));
            materializer::retry_queue::spawn_sweeper(
                pools.write.clone(),
                materializer.clone(),
                retry_shutdown.clone(),
            );
            app.manage(RetryQueueSweeperShutdown(retry_shutdown));

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
            if let Some(window) = app.get_webview_window("main") {
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
            } else {
                tracing::warn!(
                    "main webview window not available at setup; app-lifecycle hooks inactive"
                );
            }

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
            // rustls itself fails to build; downgrade that to a
            // managed-state `GcalClientState` with a dummy client so
            // the commands still resolve and surface the error via
            // `last_error` on `get_gcal_status`.
            use gcal_push::connector::{
                spawn_connector, GcalApiAdapter, GcalClient as GcalClientTrait,
            };
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

            // Production API adapter.  If `GcalApi::new` fails (which
            // it effectively cannot in practice), the adapter cannot
            // be built — surface the error and disable push.
            let gcal_client: std::sync::Arc<dyn GcalClientTrait> =
                match gcal_push::api::GcalApi::new() {
                    Ok(api) => std::sync::Arc::new(GcalApiAdapter::new(api)),
                    Err(e) => {
                        tracing::error!(
                            target: "gcal",
                            error = %e,
                            "failed to build GcalApi — push disabled",
                        );
                        // Use the noop emitter as the stand-in for
                        // the client seam — every call returns an
                        // error, which the connector surfaces as a
                        // HardFailure.
                        struct DeadClient;
                        #[async_trait::async_trait]
                        impl GcalClientTrait for DeadClient {
                            async fn create_calendar(
                                &self,
                                _t: &gcal_push::oauth::Token,
                                _n: &str,
                            ) -> Result<String, error::AppError> {
                                Err(error::AppError::Validation(
                                    "gcal.api.unavailable".to_owned(),
                                ))
                            }
                            async fn delete_calendar(
                                &self,
                                _t: &gcal_push::oauth::Token,
                                _c: &str,
                            ) -> Result<(), error::AppError> {
                                Err(error::AppError::Validation(
                                    "gcal.api.unavailable".to_owned(),
                                ))
                            }
                            async fn insert_event(
                                &self,
                                _t: &gcal_push::oauth::Token,
                                _c: &str,
                                _e: &gcal_push::digest::Event,
                            ) -> Result<String, error::AppError> {
                                Err(error::AppError::Validation(
                                    "gcal.api.unavailable".to_owned(),
                                ))
                            }
                            async fn patch_event(
                                &self,
                                _t: &gcal_push::oauth::Token,
                                _c: &str,
                                _e: &str,
                                _ev: &gcal_push::digest::Event,
                            ) -> Result<(), error::AppError> {
                                Err(error::AppError::Validation(
                                    "gcal.api.unavailable".to_owned(),
                                ))
                            }
                            async fn delete_event(
                                &self,
                                _t: &gcal_push::oauth::Token,
                                _c: &str,
                                _e: &str,
                            ) -> Result<(), error::AppError> {
                                Err(error::AppError::Validation(
                                    "gcal.api.unavailable".to_owned(),
                                ))
                            }
                        }
                        std::sync::Arc::new(DeadClient)
                    }
                };

            // Silence the unused-import warning on the
            // `NoopEventEmitter` — the constant is used via
            // `keyring_store::NoopEventEmitter` elsewhere; this
            // closure just prevents a dead_code diagnostic in rare
            // build flavors.
            let _ = NoopEventEmitter;

            // Spawn the connector task.  The handle + state trio are
            // registered on Tauri so the five gcal commands can
            // resolve.
            let pool_for_gcal_connector = pools_write_for_gcal.clone();
            let device_for_gcal_connector = device_id_for_gcal.clone();
            let connector_task = spawn_connector(
                pool_for_gcal_connector,
                gcal_client.clone(),
                gcal_token_store.clone(),
                gcal_emitter.clone(),
                device_for_gcal_connector,
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

            Ok(())
        })
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "failed to run Tauri application");
            std::process::exit(1);
        });
}

/// Remove log files in `dir` matching `agaric.log.YYYY-MM-DD` that are older
/// than `max_age_days`. Best-effort: any I/O or parse errors are silently
/// ignored so a cleanup failure never blocks application startup.
pub fn cleanup_old_log_files(dir: &std::path::Path, max_age_days: u32) {
    let cutoff = chrono::Utc::now().date_naive() - chrono::Duration::days(max_age_days as i64);

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Match files like "agaric.log.2025-01-15"
        let date_str = match name.strip_prefix("agaric.log.") {
            Some(d) if d.len() == 10 => d,
            _ => continue,
        };

        let Ok(file_date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") else {
            continue;
        };

        if file_date < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod specta_tests {
    use tauri_specta::{collect_commands, Builder};

    /// Build the tauri-specta [`Builder`] with every registered command.
    ///
    /// Shared between the export test and (potentially) runtime setup so the
    /// command list stays in sync.
    fn specta_builder() -> Builder {
        Builder::<tauri::Wry>::new().commands(collect_commands![
            crate::commands::create_block,
            crate::commands::edit_block,
            crate::commands::delete_block,
            crate::commands::restore_block,
            crate::commands::purge_block,
            crate::commands::move_block,
            crate::commands::list_blocks,
            crate::commands::get_block,
            crate::commands::batch_resolve,
            crate::commands::add_tag,
            crate::commands::remove_tag,
            crate::commands::get_backlinks,
            crate::commands::get_block_history,
            crate::commands::get_conflicts,
            crate::commands::get_status,
            crate::commands::search_blocks,
            crate::commands::query_by_tags,
            crate::commands::query_by_property,
            crate::commands::list_tags_by_prefix,
            crate::commands::list_tags_for_block,
            crate::commands::set_property,
            crate::commands::set_todo_state,
            crate::commands::set_priority,
            crate::commands::set_due_date,
            crate::commands::set_scheduled_date,
            crate::commands::delete_property,
            crate::commands::get_properties,
            crate::commands::get_batch_properties,
            crate::commands::list_page_history,
            crate::commands::revert_ops,
            crate::commands::undo_page_op,
            crate::commands::redo_page_op,
            crate::commands::compute_edit_diff,
            crate::commands::query_backlinks_filtered,
            crate::commands::list_backlinks_grouped,
            crate::commands::list_unlinked_references,
            crate::commands::list_property_keys,
            crate::commands::create_property_def,
            crate::commands::list_property_defs,
            crate::commands::update_property_def_options,
            crate::commands::delete_property_def,
            // Sync
            crate::commands::list_peer_refs,
            crate::commands::get_peer_ref,
            crate::commands::delete_peer_ref,
            crate::commands::update_peer_name,
            crate::commands::set_peer_address,
            crate::commands::get_device_id,
            // Sync — pairing & session (#275, #278)
            crate::commands::start_pairing,
            crate::commands::confirm_pairing,
            crate::commands::cancel_pairing,
            crate::commands::start_sync,
            crate::commands::cancel_sync,
            // Batch count commands (#604)
            crate::commands::count_agenda_batch,
            crate::commands::count_agenda_batch_by_source,
            crate::commands::count_backlinks_batch,
            // Page aliases (#598)
            crate::commands::set_page_aliases,
            crate::commands::get_page_aliases,
            crate::commands::resolve_page_by_alias,
            // Markdown export (#519)
            crate::commands::export_page_markdown,
            // Agenda projection (#644)
            crate::commands::list_projected_agenda,
            // Undated tasks (FEAT-1)
            crate::commands::list_undated_tasks,
            // Logseq/Markdown import (#660)
            crate::commands::import_markdown,
            // Attachments (F-7)
            crate::commands::add_attachment,
            crate::commands::delete_attachment,
            crate::commands::list_attachments,
            // Graph visualization (F-33)
            crate::commands::list_page_links,
            // Draft autosave (F-17)
            crate::commands::save_draft,
            crate::commands::flush_draft,
            crate::commands::delete_draft,
            crate::commands::list_drafts,
            // Frontend logging (F-19)
            crate::commands::log_frontend,
            crate::commands::get_log_dir,
            // Op log compaction (F-20)
            crate::commands::get_compaction_status,
            crate::commands::compact_op_log_cmd,
            // Point-in-time restore (F-26)
            crate::commands::restore_page_to_op,
            // Bulk trash operations (B-46)
            crate::commands::restore_all_deleted,
            crate::commands::purge_all_deleted,
            // Trash descendant counts (UX-243)
            crate::commands::trash_descendant_counts,
            // Link metadata (UX-165)
            crate::commands::fetch_link_metadata,
            crate::commands::get_link_metadata,
            // Bug report (FEAT-5)
            crate::commands::collect_bug_report_metadata,
            crate::commands::read_logs_for_report,
            // MCP (FEAT-4e) — Settings "Agent access" tab
            crate::commands::get_mcp_status,
            crate::commands::get_mcp_socket_path,
            crate::commands::mcp_set_enabled,
            crate::commands::mcp_disconnect_all,
            // MCP RW (FEAT-4h slice 2)
            crate::commands::get_mcp_rw_status,
            crate::commands::get_mcp_rw_socket_path,
            crate::commands::mcp_rw_set_enabled,
            crate::commands::mcp_rw_disconnect_all,
            // Google Calendar push (FEAT-5e) — Settings "Google Calendar" tab
            crate::commands::get_gcal_status,
            crate::commands::force_gcal_resync,
            crate::commands::disconnect_gcal,
            crate::commands::set_gcal_window_days,
            crate::commands::set_gcal_privacy_mode,
            // Spaces (FEAT-3 Phase 1 + Phase 2)
            crate::commands::list_spaces,
            crate::commands::create_page_in_space,
            // Quick capture (FEAT-12) — desktop global-shortcut entry point
            crate::commands::quick_capture_block,
        ])
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
mod log_retention_tests {
    use super::cleanup_old_log_files;
    use std::fs;

    /// Helper: create a file with the given name inside `dir`.
    fn touch(dir: &std::path::Path, name: &str) {
        fs::write(dir.join(name), b"log data").unwrap();
    }

    #[test]
    fn deletes_files_older_than_30_days() {
        let tmp = tempfile::tempdir().unwrap();
        // 60 days ago — should be deleted
        let old_date = (chrono::Utc::now().date_naive() - chrono::Duration::days(60))
            .format("%Y-%m-%d")
            .to_string();
        let old_name = format!("agaric.log.{old_date}");
        touch(tmp.path(), &old_name);

        cleanup_old_log_files(tmp.path(), 30);
        assert!(
            !tmp.path().join(&old_name).exists(),
            "file older than 30 days should be deleted"
        );
    }

    #[test]
    fn keeps_recent_files() {
        let tmp = tempfile::tempdir().unwrap();
        // 5 days ago — should be kept
        let recent_date = (chrono::Utc::now().date_naive() - chrono::Duration::days(5))
            .format("%Y-%m-%d")
            .to_string();
        let recent_name = format!("agaric.log.{recent_date}");
        touch(tmp.path(), &recent_name);

        cleanup_old_log_files(tmp.path(), 30);
        assert!(
            tmp.path().join(&recent_name).exists(),
            "file younger than 30 days should be kept"
        );
    }

    #[test]
    fn keeps_todays_file() {
        let tmp = tempfile::tempdir().unwrap();
        let today = chrono::Utc::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        let today_name = format!("agaric.log.{today}");
        touch(tmp.path(), &today_name);

        cleanup_old_log_files(tmp.path(), 30);
        assert!(
            tmp.path().join(&today_name).exists(),
            "today's log file should be kept"
        );
    }

    #[test]
    fn ignores_non_matching_filenames() {
        let tmp = tempfile::tempdir().unwrap();
        touch(tmp.path(), "other.log");
        touch(tmp.path(), "agaric.log");
        touch(tmp.path(), "agaric.log.not-a-date");
        touch(tmp.path(), "agaric.log.2025-13-01"); // invalid month

        cleanup_old_log_files(tmp.path(), 30);

        assert!(tmp.path().join("other.log").exists());
        assert!(tmp.path().join("agaric.log").exists());
        assert!(tmp.path().join("agaric.log.not-a-date").exists());
        assert!(tmp.path().join("agaric.log.2025-13-01").exists());
    }

    #[test]
    fn handles_empty_directory() {
        let tmp = tempfile::tempdir().unwrap();
        // Should not panic or error
        cleanup_old_log_files(tmp.path(), 30);
    }

    #[test]
    fn handles_nonexistent_directory() {
        let path = std::path::Path::new("/tmp/agaric-nonexistent-test-dir-42");
        // Should not panic — silently returns
        cleanup_old_log_files(path, 30);
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
