// Test bodies are exempt from the 70-code-line ceiling (AGENTS.md "Patterns
// caught in review" item 6); production functions over it carry `#[expect]`
// so the marker expires when the function is split (#4639).
#![cfg_attr(test, allow(clippy::too_many_lines))]
// #3847 — `JNI_OnLoad`, exported from this crate's `cdylib` (`libagaric_lib.so`)
// so the Android JavaVM + Application context are installed before any Rust
// code runs. Must live in the cdylib root crate; see the module docs.
#[cfg(target_os = "android")]
mod android_jni;
#[cfg(target_os = "linux")]
pub mod appimage_integration;
// #3334 — the ONE seam that resolves the app-data directory ("the vault"),
// honouring `AGARIC_DATA_DIR` and refusing to fall back to the real vault under
// `AGARIC_E2E_SANDBOX`. Nothing else may call `app.path().app_data_dir()`.
pub mod app_paths;
pub mod commands;
pub mod dag;
pub mod db;
pub mod deeplink;
// `import` — the query-free markdown→spec parser lives in `agaric-engine`
// (#2621, wave E4-import); consumers reach it via `agaric_engine::import::…`.
// This app-side module hosts only the Tauri-integration seam
// (`ImportProgressSink` + its `tauri::ipc::Channel` impl) which cannot live in
// the framework-free engine crate.
pub mod import;
pub mod lifecycle;
pub mod maintenance;
pub mod materializer;
pub mod mcp;
pub mod recovery;
pub mod recurrence;
// #2621 Sync-D: `snapshot` production moved into `agaric-sync`; `src/snapshot/
// mod.rs` is now a shim that re-exports it and hosts the app-coupled tests.
pub mod snapshot;
pub mod soft_delete;
pub mod spaces;
// #2621 Sync-D: `sync_daemon` production moved into `agaric-sync`; this
// `pub mod` is now a shim (`src/sync_daemon/mod.rs`) re-exporting it and hosting
// the app-coupled tests (`tests.rs`, `snapshot_transfer_tests.rs`).
pub mod sync_daemon;
// #2621 (agaric-sync split): the Tauri-backed sinks (`TauriEventSink`,
// `ChannelEventSink`) live here; `sync_events` (the pure event types +
// `SyncEventSink` trait) moved into `agaric-sync` and is re-exported below.
pub mod sync_event_sinks;
// #2621 Sync-D: `sync_files` / `sync_protocol` production moved into
// `agaric-sync`; each `pub mod` is now a shim re-exporting it and hosting the
// app-coupled tests. (`sync_net` was the third; it went with the old TCP+TLS
// transport in the iroh cutover, #3464.)
pub mod sync_files;
// #4502: the `ApplyHost` impl and the sync half of `StatusInfo`, kept out of
// `materializer/` so that module does not depend on `agaric_sync`.
pub mod sync_host;
pub mod sync_protocol;
pub mod ulid;

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
            // Atomic batch-create for templates: a
            // 10-line journal template that previously fired 10
            // `create_block` IPCs now fires 1, with one IMMEDIATE tx
            // and one op_log scope covering every block + its
            // properties.
            $crate::commands::blocks::crud::create_blocks_batch,
            $crate::commands::blocks::crud::edit_block,
            $crate::commands::blocks::crud::delete_block,
            // Multi-select batch delete: collapses
            // the FE per-row IPC loop (50 IPCs for a 50-row delete)
            // into one IMMEDIATE tx with a single recursive CTE
            // seeded from every root simultaneously.
            $crate::commands::blocks::crud::delete_blocks_by_ids,
            // #81 / Pages multi-select bulk move-to-space:
            // collapses the per-row `set_property(space)` IPC loop into one
            // IMMEDIATE tx with a single op-log seq range.
            $crate::commands::blocks::crud::move_blocks_to_space,
            $crate::commands::blocks::crud::restore_block,
            $crate::commands::blocks::crud::purge_block,
            // TrashView batch restore/purge: collapses
            // the per-row IMMEDIATE-tx loop (50 IPCs for a 50-row purge)
            // into a single tx running the cleanup chain once.
            $crate::commands::blocks::crud::restore_blocks_by_ids,
            $crate::commands::blocks::crud::purge_blocks_by_ids,
            $crate::commands::blocks::move_ops::move_block,
            // #2274 — batched multi-select drag reparent/reorder: collapses the
            // per-root `move_block` IPC loop + full page reload into one
            // IMMEDIATE tx (N MoveBlock ops) returning authoritative positions.
            $crate::commands::blocks::move_ops::move_blocks_batch,
            $crate::commands::blocks::queries::list_blocks,
            $crate::commands::blocks::queries::list_trash,
            $crate::commands::blocks::queries::get_block,
            $crate::commands::blocks::queries::batch_resolve,
            $crate::commands::tags::add_tag,
            // #81 / Pages multi-select bulk add-tag: collapses the
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
            // Phase 1 — partitioned palette search. One FTS scan
            // returns `{ pages, blocks }` instead of the palette firing
            // two parallel `search_blocks` calls per keystroke.
            $crate::commands::queries::search_blocks_partitioned,
            $crate::commands::tags::query_by_tags,
            // #1472 — nested boolean tag expression `(A AND B) OR (NOT C)`
            // over IPC (the flat `query_by_tags` above stays for back-compat).
            $crate::commands::tags::query_by_tag_expr,
            $crate::commands::queries::query_by_property,
            // AND-intersected property + tag query
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
            // #1423 — inherited (derived) tag IDs, paired with
            // list_tags_for_block so the UI can render inherited chips
            // distinctly from directly-applied ones.
            $crate::commands::tags::list_inherited_tags_for_block,
            $crate::commands::properties::set_property,
            $crate::commands::properties::set_todo_state,
            // Multi-select batch set-todo: collapses
            // the per-row IPC loop (50 IPCs for "mark 50 done") into
            // one IMMEDIATE tx with one op_log scope.
            $crate::commands::properties::set_todo_state_batch,
            // Multi-select batch set-property: generalises
            // `set_todo_state_batch` across the four reserved column-backed
            // keys (todo_state / priority / due_date / scheduled_date).
            $crate::commands::properties::set_property_batch,
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
            // #2468: ref-addressed interactive undo — the frontend submits
            // the exact OpRef(s) captured at action time instead of a
            // positional undo_depth, killing the offset-shift race (#2446).
            // undo_page_op / undo_page_group stay registered during the FE
            // migration.
            $crate::commands::history::undo_op,
            $crate::commands::history::undo_ops,
            $crate::commands::history::redo_page_op,
            // Single-IPC undo-group sizing: replaces
            // the FE's growing-window `list_page_history` re-fetch loop
            // after every Ctrl+Z with one recursive-CTE query that
            // walks consecutive same-device + within-window ops.
            $crate::commands::history::find_undo_group,
            // #2190: batched group-undo — reverts an entire
            // consecutive same-device, within-window undo group in one
            // IMMEDIATE tx, replacing the FE's find_undo_group +
            // N × undo_page_op IPC loop (one CTE walk / writer lock per op).
            $crate::commands::history::undo_page_group,
            $crate::commands::history::compute_edit_diff,
            $crate::commands::history::compute_block_vs_current_diff,
            $crate::commands::queries::query_backlinks_filtered,
            $crate::commands::queries::list_backlinks_grouped,
            $crate::commands::queries::list_unlinked_references,
            $crate::commands::properties::list_property_keys,
            $crate::commands::properties::list_property_values,
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
            // #2506 — mDNS-disabled status backfill for the peers/
            // device-management surface (its `sync:mdns_disabled` listener
            // may register after the sync daemon already emitted).
            $crate::commands::sync_cmds::get_mdns_status,
            // #3864 — internet-facing-bind status backfill for the same
            // surface. The endpoint binds before the webview can register a
            // `sync:internet_facing_bind` listener, so this query is how the
            // banner gets on screen at all, not a fallback.
            $crate::commands::sync_cmds::get_bind_exposure_status,
            // #4035 — the OS network-block status as it stands NOW. Not a race
            // fix like the two above: `sync:network_blocked` fires only on a
            // transition, so a pairing dialog reopened during one continuous
            // block gets no event however early it subscribes.
            $crate::commands::sync_cmds::get_os_network_block_status,
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
            // Undated tasks
            $crate::commands::agenda::list_undated_tasks,
            // OS notifications for due / scheduled tasks
            $crate::commands::notifier::notify_task,
            // Logseq/Markdown import (#660)
            $crate::commands::pages::import_markdown,
            // BibTeX / CSL-JSON bibliography import (#1454 tier a)
            $crate::commands::pages::import_bibliography,
            // Attachments (F-7)
            $crate::commands::attachments::add_attachment_with_bytes,
            // NOTE: `read_attachment` is intentionally ABSENT here. It returns a
            // raw-byte `tauri::ipc::Response` (zero JSON encoding, #2654), which
            // does not implement `specta::Type`, so it cannot be a tauri-specta
            // command. It is registered directly on the invoke handler in `run()`.
            $crate::commands::attachments::read_attachment_meta,
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
            // #2110 M3b — ingest frontend-produced OTel spans into the local
            // trace sink (zero egress; no-op when observability is disabled).
            $crate::commands::observability::ingest_otel_spans,
            // #2110 M5 — runtime sampling↔full-tracing toggle (both halves).
            $crate::commands::observability::set_trace_sampling,
            // Op log compaction (F-20)
            $crate::commands::compaction::get_compaction_status,
            $crate::commands::compaction::compact_op_log_cmd,
            // Point-in-time restore (F-26)
            $crate::commands::history::restore_page_to_op,
            // Bulk trash operations (B-46)
            $crate::commands::blocks::crud::restore_all_deleted,
            $crate::commands::blocks::crud::purge_all_deleted,
            // Trash descendant counts
            $crate::commands::blocks::queries::trash_descendant_counts,
            // Trash count badge (ViewDispatcher trash badge) — pushes the count
            // into SQL so the badge is accurate regardless of trash size.
            $crate::commands::blocks::queries::count_trash,
            // First-child-per-parent batch — collapses the
            // TemplatesView N+1 listBlocks(parentId, limit:1) preview loop.
            $crate::commands::blocks::queries::first_child_for_blocks,
            // Get_blocks batch endpoint
            //   • get_blocks(ids) — full BlockRow batch.
            $crate::commands::blocks::queries::get_blocks,
            // Link metadata
            $crate::commands::link_metadata::fetch_link_metadata,
            $crate::commands::link_metadata::get_link_metadata,
            // Bug report
            $crate::commands::bug_report::collect_bug_report_metadata,
            $crate::commands::bug_report::read_logs_for_report,
            // MCP — Settings "Agent access" tab
            $crate::commands::mcp::get_mcp_status,
            $crate::commands::mcp::get_mcp_socket_path,
            $crate::commands::mcp::mcp_set_enabled,
            $crate::commands::mcp::mcp_disconnect_all,
            // MCP activity ring read surface (#695)
            $crate::commands::mcp::get_mcp_recent_activity,
            // MCP RW (slice 2)
            $crate::commands::mcp::get_mcp_rw_status,
            $crate::commands::mcp::get_mcp_rw_socket_path,
            $crate::commands::mcp::mcp_rw_set_enabled,
            $crate::commands::mcp::mcp_rw_disconnect_all,
            // Spaces (Phase 1 + Phase 2 + Phase 6)
            $crate::commands::spaces::list_spaces,
            $crate::commands::spaces::create_page_in_space,
            $crate::commands::spaces::create_space,
            // Quick capture — desktop global-shortcut entry point
            $crate::commands::journal::quick_capture_block,
            // Journal page lookup — database-native date queries
            $crate::commands::journal::get_journal_page_by_date,
            $crate::commands::journal::list_journal_pages_in_range,
            // All-pages-in-space (export / graph) — no-pagination IPC for callers
            // that genuinely need every page in the space
            $crate::commands::pages::list_all_pages_in_space,
            $crate::commands::pages::list_template_page_ids_in_space,
            // Page subtree loader — single SELECT against the `page_id` index;
            // replaces the FE-side recursive `listBlocks` walk
            $crate::commands::pages::load_page_subtree,
            // Paginated page list with metadata columns
            // (last-modified, inbound-link count, child-block count,
            // has-property bitmask) + richer sort taxonomy.
            $crate::commands::pages::list_pages_with_metadata,
            // #1280 — composable advanced query: a FilterExpr boolean tree
            // (AND/OR/NOT across all structural dimensions) compiled to a
            // cursor-paginated page of blocks. Structural-only (no full-text
            // / grouping / aggregation yet).
            $crate::commands::advanced_query::run_advanced_query,
            // Flathub no-self-update requirement (#2974) — lets the
            // frontend boot-time update check skip itself under Flatpak.
            $crate::commands::is_flatpak,
        ]
    };
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

/// #3346 (programme #3351, theme T2): the batch-vs-fold equivalence oracle —
/// drive the same inputs through a bulk command once and through its
/// single-item sibling in a loop, then diff the resulting observable state.
/// Covers the four GENUINELY FORKED bulk paths (`delete_blocks_by_ids_inner`,
/// `restore_blocks_by_ids_inner`, `purge_blocks_by_ids_inner`,
/// `reverse::compute_reverse_batch`); the
/// `scripts/check-bulk-equivalence.mjs` ratchet keeps the inventory honest.
#[cfg(test)]
mod bulk_equivalence;
#[cfg(test)]
mod integration_tests;
/// #3345 (programme #3351, theme T3): the reconciliation oracle — rebuild each
/// covered derived artefact from base tables and diff it against the
/// incrementally-maintained state. Consumed by
/// `materializer::handlers::apply_reproject_proptest` (op-sequence wiring) and
/// by its own attachment-lifecycle property test.
#[cfg(test)]
mod reconciliation_oracle;
// LoroSync end-to-end integration tests live in
// `agaric_sync::sync_protocol::tests` (`loro_sync_e2e_*`).
// #4499 phase 0d: the command suites, the command-integration suites and the
// five `*_app_tests` modules left this crate for the `commands`,
// `command_integration` and `app_tests` binaries under `src-tauri/tests/`.

/// Wrap a boot-time `SELECT COUNT(*)` result so DB errors get a tracing
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
// (it risks the single-transaction invariant).

/// Keeps the tracing-appender non-blocking worker alive for the
/// application lifetime.
///
/// The inner [`tracing_appender::non_blocking::WorkerGuard`] flushes
/// buffered log writes when it is dropped.  Storing it in Tauri's managed
/// state ensures it lives until the app exits, not just until `setup()`
/// Returns. See.
pub struct LogGuard(pub tracing_appender::non_blocking::WorkerGuard);

/// Return the logs directory given the application's data directory.
///
/// The tracing-appender setup in [`run`] must use this helper (rather than
/// deriving the path some other way) so the on-disk log files cannot
/// diverge from the OS-correct app-data location across platforms. See.
///
/// #3246 — the helper exists because TWO paths have to agree on this
/// directory, not one:
///
/// - the WRITE path — `init_logging`, called from [`run`] — which points the
///   rolling file appender at it;
/// - the READ path — `commands::bug_report`, which enumerates `agaric.log*`
///   (and the OTel signal subdirectories) beneath it, both for the
///   recent-error tail in `collect_bug_report_metadata_inner` and for the ZIP
///   bundle in `read_logs_for_report`.
///
/// If those two ever diverge — a different subdirectory name on one side, or
/// one of them resolving the app-data dir without
/// [`crate::app_paths::resolve_app_data_dir`] — nothing errors. The write path
/// keeps logging and the read path keeps finding an empty or absent directory,
/// so every bug report silently ships with NO logs. The failure is invisible
/// where it happens and only surfaces later, as a bug report nobody can act
/// on. `log_dir_write_path_and_bug_report_read_path_agree` pins the pair
/// end-to-end.
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

/// Detect whether this process is running inside a Flatpak sandbox.
///
/// Flatpak's runtime bind-mounts `/.flatpak-info` (an INI file
/// describing the sandboxed app) into every sandboxed process's mount
/// namespace; its mere existence is the cheap, stable "am I sandboxed?"
/// signal (no need to parse the file or round-trip through the
/// `org.freedesktop.portal.Flatpak` D-Bus service for a yes/no check).
///
/// Flathub requires apps NOT to self-update — updates must flow through
/// Flathub's own repo/CI/repo-update mechanism, since a bundled
/// self-updater bypasses Flatpak's sandboxing/permission review and
/// would try to replace files under the read-only `/app` tree. This
/// helper backs two call sites that both need to honor that rule: the
/// `tauri_plugin_updater` registration guard in [`run`] (skips wiring
/// the plugin up at all under Flatpak) and the `is_flatpak` Tauri
/// command (`src-tauri/src/commands/mod.rs`) the frontend boot-time
/// update check consults before firing.
fn running_under_flatpak() -> bool {
    std::path::Path::new("/.flatpak-info").exists()
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

/// Default `EnvFilter` directives every build ships for the stderr + file log
/// layers.
///
/// A constant rather than an inline literal so a test can assert on the exact
/// set the production subscriber is built from.
const BASE_LOG_LAYER_DEFAULTS: &[(&str, &str)] = &[("agaric", "info"), ("frontend", "info")];

/// The `mdns-sd` diagnostic directive, added to the defaults only where the
/// user has no other way to switch it on: see [`MDNS_DEBUG_BY_DEFAULT`].
const MDNS_DIAGNOSTIC_DEFAULT: (&str, &str) = ("mdns_sd", "debug");

/// Whether `mdns_sd=debug` is a **default**, as opposed to something an
/// operator opts into with `RUST_LOG`.
///
/// # Why this is gated at all
///
/// `mdns-sd` logs a lot at `debug`, and not only at startup: `handle_read`,
/// `dns_parser`, and the cache log per *incoming packet*, and on a busy LAN
/// (printers, casts, phones, every `_services._dns-sd._udp` sweep) that is
/// continuous. It flows into the JSON file layer, and `tracing-appender` has no
/// per-file size cap — daily rotation with 14 retained files bounds the file
/// *count*, not the bytes in the current day (#157 sub-item D). An
/// unconditional default therefore charges that to every Agaric install on
/// every platform, forever, to answer a question almost none of them are asking.
///
/// # Why Android, and why not the alternatives
///
/// * Not `cfg(debug_assertions)`. The whole point of the bridge is on-device
///   diagnosis of a **release** build — #3852 was found on a shipped APK on a
///   Pixel 8, and a debug-build gate would have hidden it from the one build
///   that had the bug.
/// * Not a narrower target filter. The diagnostics that matter
///   (`failed to create IPv4 socket`, `failed to join multicast`,
///   `Failed to send unicast …`) and the per-packet chatter are emitted from
///   the *same* module path, `mdns_sd::service_daemon`. `log` records take
///   `module_path!()` as their target, so no target prefix separates signal
///   from volume — the filter cannot express the distinction.
/// * Not a user-facing runtime toggle. A switch the user must find and flip
///   *before* reproducing is a switch that is off during the failure it exists
///   to catch, and 0.9.7 ships no settings surface for it.
///
/// What is left is the platform gate, and it happens to be the honest one:
/// `RUST_LOG` is the toggle everywhere it can be set, and Android is precisely
/// the platform where it cannot. So the default exists exactly where the
/// alternative is nothing, and everywhere else the operator asks for it by name
/// (`RUST_LOG=mdns_sd=debug`), which `build_log_directives` honours.
///
/// `cfg!` rather than `#[cfg]` so both shapes stay compiled and the tests below
/// can assert on the Android shape from a CI runner that is not Android.
const MDNS_DEBUG_BY_DEFAULT: bool = cfg!(target_os = "android");

/// The default directives for the stderr + file log layers on this build.
///
/// Takes the gate as an argument rather than reading [`MDNS_DEBUG_BY_DEFAULT`]
/// so both branches are reachable from a test on any host.
fn log_layer_defaults(mdns_debug: bool) -> Vec<(&'static str, &'static str)> {
    let mut defaults = BASE_LOG_LAYER_DEFAULTS.to_vec();
    if mdns_debug {
        defaults.push(MDNS_DIAGNOSTIC_DEFAULT);
    }
    defaults
}

/// Does the final directive string admit `mdns-sd`'s `log`-facade records at
/// `debug`?
///
/// This is the question [`init_log_bridge`] needs answered: bridging a record
/// that the layers' `EnvFilter` will reject still costs its construction and
/// dispatch, once per packet. Returns `true` for a `debug` or `trace` directive
/// on `mdns_sd` or any of its submodules, whether it came from the defaults or
/// from the operator's `RUST_LOG`.
fn directives_admit_mdns_debug(directives: &str) -> bool {
    directives
        .split(',')
        .map(str::trim)
        .filter_map(|piece| piece.split('[').next().unwrap_or(piece).split_once('='))
        .any(|(target, level)| {
            let target = target.trim();
            (target == "mdns_sd" || target.starts_with("mdns_sd::"))
                && matches!(
                    level.trim().to_ascii_lowercase().as_str(),
                    "debug" | "trace"
                )
        })
}

/// Install the `log` → `tracing` bridge (#3852).
///
/// # This is a bug fix, not a nicety
///
/// Agaric logs through `tracing`. Several of its dependencies do not — most
/// consequentially `mdns-sd`, which is the **only** peer discovery Agaric has
/// and which reports every one of its network-level diagnostics through the
/// `log` facade: `failed to create IPv4 socket`, `Failed to send unicast …`,
/// the interface misses.
///
/// The `log` crate discards every record until some process installs a global
/// logger. Agaric installed none, so all of that was a no-op: the records were
/// emitted and dropped on the floor with no logger, no error, and nothing for
/// an operator to notice. That was one of the three silences that made #3852
/// invisible for three days — the other two being `register()` returning `Ok`
/// for a queued command, and `ServiceDaemon::monitor()` having no call sites.
///
/// `LogTracer::init` fixes the first half by installing a logger that forwards
/// into `tracing`; the `mdns_sd` directive in [`init_logging`] fixes the second
/// half by letting the forwarded records past the subscriber's filter — by
/// default on Android, and on request (`RUST_LOG=mdns_sd=debug`) everywhere
/// else. See [`MDNS_DEBUG_BY_DEFAULT`] for why that split.
///
/// # Why the failure is swallowed
///
/// `LogTracer::init` fails only when a global logger is *already* installed —
/// which means records already reach somewhere, and re-installing is neither
/// possible nor needed. A boot that cannot install a logging bridge is not a
/// boot worth aborting.
///
/// # Why the bridge is capped, and why the cap follows the filter
///
/// `LogTracer::init()` installs with the maximal filter, which drives
/// `log::max_level()` to `Trace`: from then on every `log::trace!` in every
/// dependency is *constructed* and dispatched into `tracing`, only to be
/// dropped by the per-layer `EnvFilter`. `log::max_level()` is the only cheap
/// gate there is — it is what lets the `log` macros short-circuit before a
/// record is built — so it should never sit above what the layers will accept.
///
/// Hence `max_level`: `Debug` when the log layers admit `mdns_sd` at debug (the
/// records this bridge exists for), `Info` otherwise. On a desktop build, where
/// `mdns_sd=debug` is no longer a default (see [`MDNS_DEBUG_BY_DEFAULT`]),
/// `Info` means mdns-sd's per-packet `debug!` calls short-circuit inside the
/// macro instead of being formatted once per packet and then thrown away by the
/// filter. An operator's `RUST_LOG=mdns_sd=debug` raises both together.
fn init_log_bridge(max_level: tracing_log::log::LevelFilter) {
    if let Err(e) = tracing_log::LogTracer::builder()
        .with_max_level(max_level)
        .init()
    {
        // No `tracing::warn!` — the subscriber does not exist yet at this point
        // in boot, so a `tracing` event here would itself be dropped, which
        // would be a small re-run of the bug this function fixes.
        eprintln!("log→tracing bridge not installed (a global logger already exists): {e}");
    }
}

/// Boot-phase 1 — install the tracing-appender file/stderr subscriber and
/// Keep the non-blocking worker guard alive in managed state (#635).
///
/// Must run with the OS-correct `app_data_dir` so the on-disk log files and
/// the "Open logs folder" action resolve to the same path on every platform.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
fn init_logging<R: tauri::Runtime>(app: &tauri::App<R>, app_data_dir: &std::path::Path) {
    use tauri::Manager;
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::Layer;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    // Preserve any user-provided `RUST_LOG` directives for
    // `agaric` / `frontend`. The log layers (stderr + file) default to `info`.
    // `EnvFilter` is not `Clone`, so build the directive string once and mint a
    // fresh filter per layer (each layer now carries its OWN filter — see the
    // registry composition below — instead of one global filter).
    //
    // #3852 adds `mdns_sd` at `debug`, and PR #4034 scoped it to the platform
    // that has no other way to ask for it. `mdns-sd` is the only discovery
    // Agaric has, it reports through the `log` facade (hence `init_log_bridge`
    // below), and every diagnostic that distinguishes "the LAN is quiet" from
    // "this device cannot open a multicast socket" — `failed to create IPv4
    // socket`, `Failed to send unicast …`, the interface misses — is emitted at
    // `debug`. On Android, where #3852 was found on a release build, there is no
    // practical way for a user to set `RUST_LOG`, so a default that hides those
    // lines hides them on the one platform that needs them. Everywhere else
    // `RUST_LOG=mdns_sd=debug` is available and the default is not paid for.
    // `MDNS_DEBUG_BY_DEFAULT` carries the full argument, including why the other
    // three ways of scoping it were rejected.
    //
    // The cost where it IS on, stated plainly because the M2b note below is
    // about exactly this: a `debug` directive on ANY target raises the
    // registry's global max level to DEBUG, so `debug!` callsites elsewhere in
    // `agaric` start evaluating their (per-layer, rejecting) filter instead of
    // being skipped at the callsite. That is the same level the OTel layer
    // already asks for whenever observability is enabled. An operator who wants
    // the quieter shape can set `RUST_LOG=mdns_sd=warn`, which
    // `build_log_directives` honours — a user directive for a target always
    // wins over the default.
    let defaults = log_layer_defaults(MDNS_DEBUG_BY_DEFAULT);
    let rust_log = std::env::var("RUST_LOG").unwrap_or_default();
    let directives = build_log_directives(&rust_log, &defaults);

    // #3852 — install the `log` → `tracing` bridge, so that records emitted
    // through the `log` facade by dependencies are not silently discarded. See
    // `init_log_bridge` for why this is a bug fix and not a nicety, and why its
    // ceiling tracks the filter built just above rather than being a constant.
    init_log_bridge(if directives_admit_mdns_debug(&directives) {
        tracing_log::log::LevelFilter::Debug
    } else {
        tracing_log::log::LevelFilter::Info
    });

    // Initialize tracing-appender using the OS-correct
    // `app_data_dir` so the on-disk log files resolve to the same path
    // on every platform (Linux, macOS, Windows, Android).
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

    // The fallback is the same defaults with the user's `RUST_LOG` dropped —
    // derived, not a hand-copied literal, so it cannot drift away from the
    // defaults above the way a duplicated string would.
    let make_log_filter = || {
        EnvFilter::try_new(&directives)
            .unwrap_or_else(|_| EnvFilter::new(build_log_directives("", &defaults)))
    };

    // #2110 M3 — the OTel trace layer captures at `debug` (default), so the
    // dispatch-time `ipc::request::run` span (Tauri `tracing` feature; target
    // `agaric_lib::…`, debug level) is recorded and carries the frontend
    // `traceparent` parent into the async command future. RUST_LOG still
    // overrides. This is a SEPARATE, more permissive filter from the log layers'
    // `info`, and it is attached only when the OTel layers exist (below) so it
    // never raises the registry's max level — and thus never makes debug spans
    // (e.g. the op-hash spans) evaluate — when observability is off.
    let otel_directives =
        build_log_directives(&rust_log, &[("agaric", "debug"), ("frontend", "info")]);
    let otel_filter = EnvFilter::try_new(&otel_directives)
        .unwrap_or_else(|_| EnvFilter::new("agaric=debug,frontend=info"));

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

    // #2110 M1a/M1b — OpenTelemetry traces + span-correlated logs to LOCAL
    // FILES only (zero egress), gated OFF by default (AGARIC_OTEL unset).
    // `obs.layers` is a `Vec<Box<dyn Layer<Registry>>>` (the trace bridge plus,
    // when its sink built, the logs bridge); an empty `Vec` is a no-op on the
    // registry, so when observability is disabled the subscriber chain is
    // byte-identical to before.
    let obs_config = agaric_observability::ObservabilityConfig::from_env();
    // #2878 — wire the materializer's process-global counter readers into the
    // observability crate so its M6 observable counters can surface them without
    // that leaf crate depending up on the materializer.
    let obs = agaric_observability::init(
        &log_dir,
        &obs_config,
        agaric_observability::MaterializerCounters {
            sql_only_fallback: materializer::sql_only_fallback_count,
            descendant_fanout_dropped: materializer::descendant_fanout_dropped_count,
        },
    );
    let obs_guard = obs.guard;
    let obs_enabled = !obs.layers.is_empty();

    // The OTel layers are `Box<dyn Layer<Registry>>`, so they must be added
    // directly onto the bare `Registry` (each implements `Layer` only for that
    // exact subscriber type, not for an already-`Layered` one). A `Vec` of them
    // is itself one `Layer<Registry>`; it carries its own `debug` filter and is
    // added first. The stderr + file layers each carry their own `info` filter.
    // `Option::then` attaches the OTel layers (with the debug filter) ONLY when
    // they exist — when disabled this is `None`, a no-op that leaves the
    // registry's max level at `info` so debug callsites stay free (M2b).
    let otel_layers = obs_enabled.then(|| obs.layers.with_filter(otel_filter));
    tracing_subscriber::registry()
        .with(otel_layers)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(make_log_filter()),
        )
        .with(file_layer.map(|f| f.with_filter(make_log_filter())))
        // NOT `.init()`. `SubscriberInitExt::init` sets the global default
        // subscriber and then installs `LogTracer` a second time, at the
        // registry's own max level — and it `expect()`s on the result. Since
        // `init_log_bridge` above has already installed the bridge (with the
        // capped level that is the entire point of that function), that second
        // install always returns `SetLoggerError`, so `.init()` panicked on
        // every boot (#4034). `try_init` sets the global default FIRST and only
        // then attempts the bridge, so an `Err` here means exactly one thing:
        // the subscriber is live and the bridge we deliberately installed
        // ourselves is still the one in place.
        .try_init()
        .ok();

    // #2110 M1a/M1b — announce only when telemetry is actually enabled; stay
    // silent (no new log line) when off so the existing logging output is
    // unchanged.
    if obs_enabled {
        tracing::info!(
            traces_dir = %log_dir.join("traces").display(),
            otel_logs_dir = %log_dir.join("otel-logs").display(),
            sampling_ratio = obs_config.sampling_ratio,
            "OpenTelemetry traces + logs enabled"
        );
    }

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
    // Continuously rather than boot-only. The previous boot
    // sweep (`cleanup_old_log_files`) was removed along with its
    // tests.

    // Keep the non-blocking appender's worker guard alive for the
    // lifetime of the app so buffered writes are never lost. #635:
    // only present when the file appender was built; on the
    // stderr-only degrade path there is nothing to flush.
    if let Some(log_guard) = log_guard {
        app.manage(LogGuard(log_guard));
    }

    // #2110 M1a — keep the OTel trace pipeline alive for the app lifetime so
    // spans flush + the provider shuts down cleanly on exit (mirrors LogGuard).
    // Only present when traces were enabled and the file exporter was built.
    if let Some(obs_guard) = obs_guard {
        app.manage(obs_guard);
    }

    // #2110 M3b — manage the frontend-span ingestor so `ingest_otel_spans`'s
    // `State` resolves. Built with the SAME enabled flag as the trace pipeline:
    // when observability is off it holds no sink and `ingest` is a no-op, so the
    // command stays a zero-cost local-file write that never leaves the machine.
    app.manage(agaric_observability::build_frontend_ingestor(
        &log_dir,
        obs_enabled,
    ));
}

/// Boot-phase 3 — open the read/write SQLite pools and resolve the persistent
/// device UUID + sync TLS certificate.
///
/// Returns the owned `(pools, device_id, endpoint_secret)` triple; the caller
/// threads these (by reference, via cheap `Arc` clones) through the rest of
/// boot and finally moves the originals into managed state.
#[allow(clippy::type_complexity)]
fn init_persistence(
    db_path: &std::path::Path,
    app_data_dir: &std::path::Path,
) -> Result<(db::DbPools, String, agaric_sync::transport::SecretKey), Box<dyn std::error::Error>> {
    // Initialize separated read/write pools
    let pools = tauri::async_runtime::block_on(db::init_pools(db_path))?;

    // Read or generate a persistent device UUID
    let device_id_path = app_data_dir.join("device-id");
    let device_id = agaric_sync::device::get_or_create_device_id(&device_id_path)?;

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        platform = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        device_id = %device_id,
        "app started"
    );

    // The self-signed TLS certificate this used to load is gone with the transport that
    // needed it (#3464). Nothing reads it any more: the QUIC handshake authenticates the
    // peer's ed25519 key, so there is no CN to check and no hash to pin. The file itself
    // is left on disk rather than deleted — removing a key file is not something a
    // version bump should do silently, and the PR that retires `sync_net` is where that
    // decision belongs.

    // This device's iroh identity (#78, plan #3464). Loaded rather than generated: it
    // is what `peer_refs.endpoint_id` pins, so a key that changed at boot would make
    // every paired peer stop recognising this device.
    //
    // Its own file rather than another field in the cert, because the cert is deleted
    // by the PR that retires `sync_net` and an identity must not outlive its file.
    let endpoint_key_path = app_data_dir.join("sync-endpoint.key");
    let endpoint_secret =
        agaric_sync::transport::get_or_create_endpoint_secret(&endpoint_key_path)?;
    tracing::info!(endpoint_id = %endpoint_secret.public(), "sync endpoint identity loaded");

    Ok((pools, device_id, endpoint_secret))
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
) -> (
    agaric_sync::foreground::LifecycleHooks,
    materializer::Materializer,
    std::sync::Arc<agaric_engine::loro::shared::LoroState>,
) {
    use agaric_sync::foreground::LifecycleHooks;
    use materializer::Materializer;

    // #2249: construct the process-wide Loro engine state FIRST and hand
    // it to the materializer as a constructor argument. Engine state
    // therefore exists before the materializer can apply its first op —
    // and before recovery replay (which receives the materializer) — by
    // construction, replacing the old hand-sequenced
    // `shared::init()`-before-recovery comment. The same `Arc` is
    // registered as Tauri managed state later in setup for the
    // `RunEvent::Exit` snapshot save.
    let loro_state = std::sync::Arc::new(agaric_engine::loro::shared::LoroState::new());

    // Create materializer — bg cache rebuilds read from read pool, write to write pool (P-8)
    //
    // Wire up the app-lifecycle hooks so the metrics-
    // snapshot task stops emitting debug-level log lines while
    // the app is backgrounded on mobile. The same hooks are
    // later passed into the sync daemon below so its periodic
    // resync tick short-circuits when backgrounded.
    let lifecycle = LifecycleHooks::new();
    let materializer = Materializer::with_read_pool_and_lifecycle(
        pools.write.clone(),
        pools.read.clone(),
        lifecycle.clone(),
        std::sync::Arc::clone(&loro_state),
    );
    // C-3c — register `app_data_dir` so the
    // `CleanupOrphanedAttachments` background task can locate
    // the `attachments/` subtree.
    //
    // `MaterializeTask::CleanupOrphanedAttachments` is the only entry point,
    // and it is enqueued from three live production sites — so without this
    // dir the sweep is what silently stops running, not merely a dormant
    // function:
    //   * boot (`try_enqueue_background` in the setup path below),
    //   * the 24 h `cleanup_orphaned_attachments_tick` maintenance job,
    //   * after any `compact_op_log_cmd` that actually purged ops
    //     (`commands::compaction`).
    // The routine sweep is also what makes #3706 an ordinary outcome rather
    // than a race: a deleted attachment's bytes are normally already
    // reclaimed by the time an undo arrives.
    materializer.set_app_data_dir(app_data_dir.to_path_buf());

    (lifecycle, materializer, loro_state)
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

    // Boot ordering: the per-space `LoroEngine` registry MUST be
    // populated before the materializer dispatches its first op.
    // Recovery (`recover_at_boot` below) replays unmaterialised ops
    // through the materializer, so any op it replays would race a
    // deferred rehydrate and land in an empty engine. #2249: the state
    // itself was constructed BEFORE the materializer (a
    // `Materializer::with_read_pool_and_lifecycle` constructor
    // argument, see `build_materializer`), so "engine state exists
    // pre-recovery" holds by construction; only the epoch load +
    // rehydrate below still run synchronously (via `block_on`) before
    // recovery. The boot-latency cost is one `loro_doc_state` table
    // scan — single-digit ms at typical workspace scales. The periodic
    // flush task is spawned separately (it's a long-running background
    // task; blocking on it would pin boot).
    let loro_state = materializer.loro_state();
    // #792: install the persisted peer-id epoch BEFORE any engine is
    // constructed (rehydrate below + every lazy `for_space`). A vault
    // that went through a snapshot RESET carries a bumped epoch in
    // `app_settings`; deriving the Loro PeerID from it keeps this
    // device off its retired pre-reset peer id, whose (peer, counter)
    // ranges peers still hold. Absent row == epoch 0 == the legacy
    // mapping, so never-reset vaults are byte-for-byte unaffected.
    {
        // #2023: `load_peer_epoch` now distinguishes "row absent" (epoch
        // 0, the legitimate never-reset state) from a genuine read
        // FAILURE. A read failure is propagated (after a bounded retry)
        // rather than coerced to 0 — boot fails CLOSED instead of
        // minting every engine under this device's retired pre-reset
        // PeerID and re-forking the (peer, counter) space (#792). A
        // transient single blip is absorbed by the retry inside
        // `load_peer_epoch`; a persistent DB read failure here is
        // correctly boot-fatal (the same DB is unusable for recovery
        // and rehydrate immediately below regardless).
        let peer_epoch = tauri::async_runtime::block_on(
            agaric_engine::loro::peer_epoch::load_peer_epoch(&pools.write),
        )?;
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
        let n = tauri::async_runtime::block_on(agaric_engine::loro::snapshot::rehydrate_registry(
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

    // Phase 1: seed the two default spaces (Personal + Work) and
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
/// (link-metadata GC, FTS / `block_tag_refs` gating) is created first, then
/// `RebuildPageIds` / `CleanupOrphanedAttachments` are enqueued, then caches
/// for recovered drafts are refreshed synchronously.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
fn spawn_boot_maintenance(
    pools: &db::DbPools,
    materializer: &materializer::Materializer,
    report: &recovery::RecoveryReport,
) {
    use materializer::MaterializeTask;

    // startup-latency-backend Phase 1: move the best-effort boot
    // items off the synchronous critical path. These don't gate
    // any user IPC — link-metadata GC is purely cleanup and the
    // FTS / `block_tag_refs` gating is a one-shot "schedule the
    // rebuild if the table is empty" check (the rebuild itself
    // is already a background materializer task). Releasing the
    // foreground queue earlier means the first user action (a
    // `list_blocks` for the journal) doesn't compete with these
    // maintenance reads.
    //
    // #3282: this spawn used to carry a fourth item, the one-shot
    // personal→work page migration, which had to run after
    // `bootstrap_spaces`. That migration is deleted, so the ordering
    // constraint it imposed on this spawn is gone with it — nothing
    // here depends on `bootstrap_spaces` any more.
    {
        let write_pool = pools.write.clone();
        let materializer_handle = materializer.clone();
        tauri::async_runtime::spawn(async move {
            // Clean up stale link metadata entries (>30 days, non-auth).
            match agaric_store::link_metadata::cleanup_stale(&write_pool, 30).await {
                Ok(deleted) => {
                    if deleted > 0 {
                        tracing::info!(deleted, "cleaned up stale link metadata entries");
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "failed to clean up stale link metadata");
                }
            }

            // Rebuild FTS index if the table is empty (post-migration 0006).
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

            // Rebuild `block_tag_refs` if the table is empty
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
        });
    }

    // Rebuild page_id column at boot to ensure consistency.
    if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildPageIds) {
        tracing::warn!(error = %e, "failed to enqueue page_id rebuild at boot");
    }

    // Enqueue the orphan-attachment GC at boot. The
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

    // When drafts were recovered before the materializer was
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
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
fn spawn_background_tasks(
    pools: &db::DbPools,
    device_id: &str,
    materializer: &materializer::Materializer,
    lifecycle: &agaric_sync::foreground::LifecycleHooks,
) {
    // Spawn the retry-queue sweeper so any per-block tasks
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

    // Spawn the orphan-drafts sweeper. Drafts whose
    // Parent block has been *soft-deleted* survive the FK
    // (which references the row, not its `deleted_at` column),
    // so without this periodic sweep they would accumulate and
    // surface as phantom drafts in the UI on next boot. The
    // task runs once at boot and then every hour for the
    // process lifetime; cancellation is via the managed
    // shutdown flag, mirroring the retry-queue sweeper above.
    // #703: flag never set; sweeper observes constant `false`.
    let orphan_drafts_shutdown = Arc::new(AtomicBool::new(false));
    agaric_engine::draft::spawn_orphan_drafts_sweeper(
        pools.write.clone(),
        agaric_engine::draft::ORPHAN_DRAFTS_SWEEP_INTERVAL,
        orphan_drafts_shutdown,
        // #2621 (wave E2): `draft` is tauri-free, so the app injects Tauri's
        // runtime spawner (mirrors `agaric_engine::loro::snapshot::spawn_periodic_snapshot`).
        |fut| {
            tauri::async_runtime::spawn(fut);
        },
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
    // #2249: the maintenance predicate + job read engine state through
    // clones of the materializer's Arc (no process global).
    let loro_state_for_pred = Arc::clone(materializer.loro_state());
    let loro_state_for_snapshot_job = Arc::clone(materializer.loro_state());
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
                loro_state_for_pred.registry.dirty_count() > 0
            }),
            run: Box::new(move || {
                let pool = loro_snapshot_write_pool.clone();
                let state = Arc::clone(&loro_state_for_snapshot_job);
                Box::pin(async move { maintenance::loro_snapshot_if_dirty(&pool, &state).await })
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
    // Parity flush task (which hosted the snapshot save
    // on its tick) was deleted — that regression left
    // `loro_doc_state` permanently empty while the apply cursor
    // kept advancing, so on boot the engine could not be rebuilt
    // and every edit/move failed "block not found". Persists each
    // engine's snapshot every SNAPSHOT_INTERVAL_SECS so the next
    // boot rehydrates without a full op-log replay; cancellation
    // is via the managed flag, mirroring the sweepers above.
    // #703: flag never set; snapshot task observes constant `false`.
    let snapshot_shutdown = Arc::new(AtomicBool::new(false));
    agaric_engine::loro::snapshot::spawn_periodic_snapshot(
        pools.write.clone(),
        snapshot_shutdown,
        agaric_engine::loro::snapshot::SNAPSHOT_INTERVAL_SECS,
        Arc::clone(materializer.loro_state()),
        // `agaric-engine` stays tauri-free (#2621, wave E1): the app injects the
        // Tauri async runtime as the executor here.
        |fut| {
            tauri::async_runtime::spawn(fut);
        },
    );
}

/// Boot-phase 12 — move every still-owned shared piece into Tauri managed
/// state and install the window-focus → lifecycle listener.
///
/// This consumes `pools`, `device_id`, `materializer`, and
/// `scheduler` by value: it is the single point where the originals are
/// moved, which is why every prior phase took them by reference (cloning the
/// cheap `Arc`s it needed). The returned `cancel_flag` is shared with the
/// `SyncDaemon` spawned immediately afterwards (#528).
fn register_managed_state<R: tauri::Runtime>(
    app: &tauri::App<R>,
    pools: db::DbPools,
    device_id: String,
    materializer: materializer::Materializer,
    scheduler: Arc<agaric_sync::sync_scheduler::SyncScheduler>,
    lifecycle: &agaric_sync::foreground::LifecycleHooks,
) -> Arc<AtomicBool> {
    use agaric_sync::device::DeviceId;
    use db::{ReadPool, WriteCtx, WritePool};
    use lifecycle::AppLifecycle;
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
    // -A — extension-state guard registry for
    // in-flight search IPCs. See `cancellation.rs`.
    app.manage(agaric_store::cancellation::CancellationRegistry::new());
    app.manage(device_id);
    app.manage(materializer);

    // Sync state (#275, #278)
    app.manage(commands::PairingState(std::sync::Mutex::new(None)));
    app.manage(scheduler);

    // Sync cancel flag (#528) — registered before daemon spawns so
    // cancel_sync can always resolve managed state.
    let cancel_flag = Arc::new(AtomicBool::new(false));
    app.manage(SyncCancelFlag(cancel_flag.clone()));

    // / #704: register the lifecycle hooks in managed state so
    // future commands (e.g. a "sync now" action) can share the same
    // wake notifier, and install a window-event listener that flips
    // `is_foreground` on genuine background transitions.
    //
    // #704: `WindowEvent::Focused(false)` fires both on mere focus-loss
    // (the app is still on-screen — another window is on top) and as a
    // side effect of a real minimize/hide. We must NOT treat plain
    // focus-loss as backgrounded, or maintenance jobs gated on
    // `!is_foreground` would fire while the user is still looking at the
    // window and the periodic sync tick would starve. So on focus-loss
    // we query the window (`is_visible()` / `is_minimized()`) and let
    // the pure `agaric_sync::foreground::derive_app_state` decide the regime. The
    // mobile-only `Suspended` / `Resumed` events are unambiguous OS
    // background/foreground transitions and are mapped directly.
    app.manage(AppLifecycle(lifecycle.clone()));
    match app.get_webview_window("main") {
        Some(window) => {
            let lifecycle_for_listener = lifecycle.clone();
            let window_for_query = window.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Focused(focused) => {
                    // Query live window state so a minimize/hide that
                    // arrives as `Focused(false)` is distinguished from a
                    // mere focus change. `is_visible` / `is_minimized`
                    // can fail on some platforms; default to the
                    // focus-implies-foreground reading on error.
                    //
                    // #704: on Linux/GTK the `focus-out` and
                    // `window-state-event` (ICONIFIED) signals have no
                    // guaranteed relative order, so a minimize MAY briefly
                    // read `minimized=false` here and be classified as
                    // foreground. This is benign and self-correcting: the
                    // only effect is that backgrounded-only maintenance does
                    // not engage for that transient window (the conservative
                    // direction — we never falsely background while the user
                    // is looking), and the next window event reclassifies.
                    // Mobile backgrounding does not rely on this path — it
                    // uses the unambiguous `Suspended` event below.
                    let visible = window_for_query.is_visible().unwrap_or(true);
                    let minimized = window_for_query.is_minimized().unwrap_or(false);
                    let state = agaric_sync::foreground::derive_app_state(
                        agaric_sync::foreground::WindowStateFlags {
                            focused: *focused,
                            visible,
                            minimized,
                            os_suspended: false,
                        },
                    );
                    tracing::info!(
                        focused = *focused,
                        visible,
                        minimized,
                        ?state,
                        "window focus changed — derived app lifecycle state"
                    );
                    lifecycle_for_listener.apply_state(state);
                }
                #[cfg(mobile)]
                tauri::WindowEvent::Suspended => {
                    tracing::info!("app suspended by OS — backgrounding");
                    lifecycle_for_listener.mark_backgrounded();
                }
                #[cfg(mobile)]
                tauri::WindowEvent::Resumed => {
                    tracing::info!("app resumed by OS — foregrounding");
                    lifecycle_for_listener.mark_foreground();
                }
                _ => {}
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

/// Inputs the [`SyncDaemon`](agaric_sync::sync_daemon::SyncDaemon) needs, gathered into a
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
    scheduler: Arc<agaric_sync::sync_scheduler::SyncScheduler>,
    endpoint_secret: agaric_sync::transport::SecretKey,
    sink: Arc<dyn agaric_sync::sync_events::SyncEventSink>,
    app_handle: tauri::AppHandle,
    lifecycle: agaric_sync::foreground::LifecycleHooks,
    cancel_flag: Arc<AtomicBool>,
}

/// Hostnames that every device reports, and so identify none of them (#4298
/// review).
///
/// Compared against the hostname case-folded and with a trailing
/// `.localdomain` removed, so `LOCALHOST` and `localhost.localdomain` are the
/// same non-name as `localhost`.
///
/// - `localhost` is what **stock Android** reports. Verified by booting the
///   `android-34` emulator system image: `uname -a` reads
///   `Linux localhost 6.1.23-android14-4-…`, and `uname -n` is exactly the
///   value `tauri_plugin_os::hostname()` returns — it calls
///   `gethostname::gethostname()`, which on every unix is
///   `rustix::system::uname().nodename()`. Android's user-facing device name
///   lives in `Settings.Global.device_name` instead, which this API cannot
///   reach. `localhost` is also the stock value on a Linux box whose hostname
///   was never set.
/// - `(none)` is the Linux kernel's own compiled-in default and what stands on
///   any boot where userspace never overwrites it. The Android 14 GKI kernel
///   shipped in that image is built with `CONFIG_DEFAULT_HOSTNAME="(none)"`
///   (read from the kernel's embedded `IKCFG_ST` config blob).
const NON_IDENTIFYING_HOSTNAMES: [&str; 2] = ["localhost", "(none)"];

/// The OS hostname, if it actually names *this particular* device (#4298).
///
/// # Why a non-name must become *no* name rather than a name
///
/// `device_name` is a display precedence — the user's override, then the name
/// the peer advertised, then the peer's truncated id — and each level only
/// gets its turn when the one above it is absent. A hostname that every device
/// shares is therefore worse than none: it occupies the middle level on every
/// Android peer at once, so a device list holding two phones renders two rows
/// both reading `localhost`, where before #4298 it rendered two distinct hex
/// ids. Returning `None` here keeps the truncated id — the one field on the
/// row that is unique per device — as what the user reads, which is exactly
/// the pre-#4298 behaviour, so the feature can only ever add information.
///
/// Filtering at the boot refresh rather than at the display keeps the useless
/// value out of the system entirely: it is never stored in `app_settings`,
/// never put on the wire, and never persisted into a peer's
/// `remote_device_name` on the far side — so no consumer, present or future,
/// has to know about it, and no peer is left holding a stale `localhost` that
/// a later fix would have to go back and clear.
///
/// The comparison is ASCII-case-insensitive because hostnames are
/// (RFC 1035 §2.3.3), and it strips one trailing `.localdomain` because that
/// is the suffix AOSP's historical `hostname localhost` / `domainname
/// localdomain` pairing produces and the stock value on several Linux
/// distributions. The suffix is stripped for the *comparison only* — a real
/// host that genuinely lives in that domain (`pixel-8.localdomain`) is
/// returned verbatim, because the part before the dot does name a device.
fn identifying_hostname(hostname: &str) -> Option<&str> {
    let trimmed = hostname.trim();
    if trimmed.is_empty() {
        return None;
    }
    let folded = trimmed.to_ascii_lowercase();
    let bare = folded
        .strip_suffix(".localdomain")
        .unwrap_or(folded.as_str());
    if NON_IDENTIFYING_HOSTNAMES.contains(&bare) {
        return None;
    }
    Some(trimmed)
}

/// Publish this device's own name — its OS hostname — into `app_settings`, so
/// the sync layer can advertise it to peers in `HeadExchange` (#4298).
///
/// # Why the app crate writes it and the sync crate reads it back off the pool
///
/// `tauri_plugin_os::hostname()` is the only cross-platform hostname source
/// this app has, and it lives behind a Tauri plugin. `agaric-sync` must not
/// gain a `tauri` dependency for one string, so the value travels through the
/// database the two already share — the same seam the pending-pairing marker
/// uses (`peer_refs::set_local_device_name` / `get_local_device_name`).
///
/// # Why every boot, and why best-effort
///
/// A hostname is user-editable and does change; pinning it at first run would
/// leave every renamed device advertising a stale name with nothing to ever
/// correct it. Re-reading it each launch costs one UPSERT and makes a rename
/// propagate on the next sync.
///
/// It is spawned rather than awaited, and swallows its failure: the name is a
/// display nicety, not a precondition for syncing. Losing the race with the
/// first outbound session — the daemon spawns immediately after this — costs
/// that one session's advertisement, and the peer keeps whatever name it
/// already had until the next dial. Blocking boot on it would be the wrong
/// trade in the other direction.
///
/// # Why a hostname can be rejected outright
///
/// A hostname that names no particular device — empty, or one of
/// [`NON_IDENTIFYING_HOSTNAMES`] — is written as nothing at all, and
/// [`identifying_hostname`] is what decides. Stock Android reports `localhost`
/// for every device, so storing it would make this feature *remove*
/// information from a device list holding two phones rather than add it. With
/// nothing stored, `get_local_device_name` returns `None`, no name reaches the
/// wire, and every consumer falls through to the peer's truncated id — the
/// behaviour that shipped before #4298.
fn spawn_local_device_name_refresh(pool: sqlx::SqlitePool) {
    tauri::async_runtime::spawn(async move {
        let raw = tauri_plugin_os::hostname();
        let Some(hostname) = identifying_hostname(&raw) else {
            tracing::debug!(
                "the OS reported no device-identifying hostname; advertising no device name (#4298)"
            );
            return;
        };
        match agaric_store::peer_refs::set_local_device_name(&pool, hostname).await {
            Ok(()) => tracing::debug!(
                // A hostname frequently embeds a real name (a person's given
                // name, a work laptop's asset tag); this codebase otherwise
                // logs discriminants and ids, not payloads, so log the
                // length only — enough to tell whether an unusually
                // long/short name is being clamped downstream, without
                // writing the name itself into the log.
                device_name_len = hostname.chars().count(),
                "published this device's own name for peers to display (#4298)"
            ),
            Err(e) => tracing::warn!(
                error = %e,
                "could not publish this device's own name; peers will keep rendering \
                 this device by whatever name they already have (#4298)"
            ),
        }
    });
}

/// Boot-phase 13 — install the rustls CryptoProvider and spawn the
/// [`SyncDaemon`](agaric_sync::sync_daemon::SyncDaemon).
///
/// `start_if_peers_exist` keeps the daemon dormant until a device is
/// Paired; lifecycle threading short-circuits the resync tick while
/// backgrounded.
fn wire_sync_daemon(w: SyncDaemonWiring) {
    use tauri::Manager;

    // Install rustls CryptoProvider before any TLS usage (#sync)
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Spawn SyncDaemon (#382, #383, #278)
    //
    // Use `start_if_peers_exist` so the daemon enters
    // dormant mode when no peers are paired. mDNS announce/browse
    // and the QUIC endpoint are deferred until the user pairs a
    // device. The dormant waiter wakes on `scheduler.notify_change`
    // (called by `confirm_pairing`) and on a periodic poll.
    //
    // `_with_lifecycle` threads the foreground flag +
    // wake notify into the daemon loop so its periodic resync
    // tick short-circuits while the app is backgrounded.
    tauri::async_runtime::spawn(async move {
        match agaric_sync::sync_daemon::SyncDaemon::start_if_peers_exist_with_lifecycle(
            agaric_sync::sync_daemon::SyncDaemonContext {
                pool: w.pool,
                device_id: w.device_id,
                // #2621 (agaric-sync inversion): erase the concrete coordinator
                // to `Arc<dyn ApplyHost>` at the app→sync boundary so the daemon
                // context never names `Materializer`.
                materializer: Arc::new(w.materializer),
                scheduler: w.scheduler,
                endpoint_secret: w.endpoint_secret,
                event_sink: w.sink,
                cancel: w.cancel_flag,
                lifecycle: w.lifecycle,
            },
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
/// Slice 2 — the RO surface binds the reader pool (plus the
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
/// /4h: each server is opt-in via its marker file; absent the marker
/// the spawn helper logs and returns immediately. The reader/writer pool +
/// Materializer + device_id are passed in as cheap clones (slice 2).
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

    // MCP read-only server. Opt-in via the `mcp-ro-enabled`
    // Marker file in `app_data_dir` (wires the UI toggle).
    // When the marker is absent, `spawn_mcp_ro_task` logs and returns
    // immediately. When present, it binds the default socket and
    // spawns the serve loop. A second Agaric instance detects the
    // existing socket and logs a warning without crashing.
    //
    // The cloned `AppHandle` is used to build the activity
    // emitter so completed tool calls surface on the `mcp:activity`
    // Tauri event bus.
    //
    // The reader pool + materializer + device_id let the
    // `ReadOnlyTools` registry dispatch the v1 nine-tool surface
    // without allocating new resources. `journal_for_date` is the
    // only tool that writes; it reuses the same materializer /
    // device_id the frontend uses so the op-log origin stays
    // consistent.
    //
    // `McpLifecycle` is shared managed state so the
    // Settings UI commands (`get_mcp_status`, `mcp_disconnect_all`,
    // `mcp_set_enabled`) can observe the connection counter and
    // fire the disconnect signal.
    let mcp_lifecycle = std::sync::Arc::new(mcp::McpLifecycle::new());
    app.manage(mcp_lifecycle.clone());
    // Gate that serialises rapid `mcp_set_enabled` toggles
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

    // Slice 2 — parallel MCP **read-write** server. Opt-in
    // via the `mcp-rw-enabled` marker file (independent of RO).
    // A second `McpLifecycle` is allocated so the RO and RW
    // servers track their own connection counts and disconnect
    // signals; the `McpRwLifecycle` newtype wrapper keeps Tauri's
    // managed-state resolver from colliding on the shared type.
    let mcp_rw_lifecycle_inner = std::sync::Arc::new(mcp::McpLifecycle::new());
    let mcp_rw_lifecycle = mcp::McpRwLifecycle(mcp_rw_lifecycle_inner.clone());
    app.manage(mcp_rw_lifecycle.clone());
    // RW counterpart to McpToggleGate. RO and RW each hold
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

/// #2972 / #2919 — show a BLOCKING native OS error dialog for a boot-fatal
/// failure, independent of the webview (which may not exist yet at these
/// failure points).
///
/// Used at the two boot-fatal exit points in [`run`]: a failed Tauri build
/// (`.build(...)`) and a failed `setup` orchestration (corrupt SQLite page,
/// failed `sqlx::migrate!` run — e.g. a `MigrateError::VersionMissing` after a
/// downgrade — or a failed engine reprojection). Both previously called
/// `exit(1)` after only a `tracing::error!` line, so the user double-clicked
/// the icon and NOTHING appeared. This surfaces the error before we exit.
///
/// Best-effort and non-fatal: it ignores the dialog result and returns. It is a
/// no-op under `cfg(test)` and on headless hosts (CI / `AGARIC_HEADLESS`, or —
/// on Linux — no `DISPLAY`/`WAYLAND_DISPLAY`) so unit tests and CI never block
/// on an un-dismissable window with no display to render it. On Android/iOS
/// (#3072) `rfd` has no backend, so mobile logs the error and relies on the
/// platform to surface the crash instead of opening a native dialog.
fn show_fatal_error_dialog(title: &str, body: &str) {
    // Never pop a real window from the test binary.
    #[cfg(test)]
    {
        let _ = (title, body);
    }
    // Mobile: `rfd` 0.17 has no Android/iOS backend (#3072). The platform (crash
    // reporter / system UI) surfaces a boot-fatal exit, so we only log here.
    #[cfg(all(not(test), any(target_os = "android", target_os = "ios")))]
    {
        tracing::error!(dialog_title = %title, "fatal error (mobile: platform surfaces it, no native dialog)");
        let _ = (title, body);
    }
    #[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]
    {
        // On Linux a GTK dialog needs a display server; treat its absence as
        // headless so we don't hang/fail trying to open one. Other platforms
        // always have a windowing system available to a running GUI app.
        let no_display = {
            #[cfg(target_os = "linux")]
            {
                std::env::var_os("DISPLAY").is_none()
                    && std::env::var_os("WAYLAND_DISPLAY").is_none()
            }
            #[cfg(not(target_os = "linux"))]
            {
                false
            }
        };
        // `CI` is set by every major CI provider; `AGARIC_HEADLESS` is our
        // explicit manual override for automated / no-GUI runs.
        let headless = std::env::var_os("CI").is_some()
            || std::env::var_os("AGARIC_HEADLESS").is_some()
            || no_display;
        if headless {
            tracing::warn!(dialog_title = %title, "headless host: skipping fatal-error dialog");
            return;
        }
        rfd::MessageDialog::new()
            .set_level(rfd::MessageLevel::Error)
            .set_title(title)
            .set_description(body)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    }
}

// #2123: the src-tauri/fuzz crate compiles this lib as a path dependency under
// `--cfg fuzzing` to reach the byte-level parsers (`agaric_sync::snapshot::decode_snapshot`,
// `deeplink::parse_deep_link`). `run()` is the tauri app entry; its
// `generate_context!` ACL codegen is both irrelevant to fuzzing pure parsers and
// fragile under the nightly + sanitizer fuzz build, so exclude the whole GUI
// builder from the fuzz build. Only `main.rs` (not compiled by the fuzz crate's
// path dependency) calls `run()`.
#[cfg(not(fuzzing))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
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

    // Tracing-appender setup moved into the Tauri `setup()` hook so
    // it can use `app.path().app_data_dir()` (OS-correct location on every
    // platform) instead of a hard-coded Linux XDG path. The panic hook is
    // installed here early — it uses the global tracing subscriber and is
    // a no-op until the subscriber is installed in `setup()`.

    // / #634: Install a custom panic hook so panics are captured in the
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

    // Tauri-plugin-single-instance MUST be the first plugin
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
    // On Linux + Windows, OS deep-link activations spawn a
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
                // Forward the second instance's argv to the
                // deep-link plugin running inside the primary instance.
                // The plugin filters args by the configured schemes
                // (`agaric` only, per `tauri.conf.json`) so non-deep-link
                // CLI args are silently ignored.
                app.deep_link().handle_cli_arguments(args.into_iter());
            }));
    }

    tauri_builder = tauri_builder
        // Cross-platform deep-link routing for `agaric://` URLs.
        // Required on desktop AND Android (Android OAuth via Custom-Tabs
        // + PKCE + App-Link callback is the unblocker). See
        // `src-tauri/src/deeplink/mod.rs` for the URL → typed-event
        // router; `register_deeplink_handlers` is wired from the setup
        // hook below.  No `#[cfg(desktop)]` gate on purpose.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        // Cross-platform platform/version/arch/locale/hostname
        // API used by `commands::collect_bug_report_metadata`.  Works on
        // both desktop and mobile, so no cfg gate.
        .plugin(tauri_plugin_os::init())
        // Native OS notifications for due / scheduled tasks.
        // The `notify_task` command (commands::notifier::notify_task)
        // fires a notification through this plugin.  Cross-platform
        // (desktop + mobile), so no `#[cfg(desktop)]` gate.  Part of the
        // Tauri plugin coupled stack per AGENTS.md §"Coupled Dependency
        // Updates" — move in lockstep with the other tauri-plugin-* crates.
        .plugin(tauri_plugin_notification::init());

    // Remember window size / position / monitor / maximized
    // state across launches.  Operates entirely Rust-side (no frontend
    // permission needed).  Desktop-only — Android/iOS handle window
    // state via the OS task lifecycle, so the plugin is gated behind
    // `#[cfg(desktop)]`.
    #[cfg(desktop)]
    {
        tauri_builder = tauri_builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }

    // Register `tauri-plugin-global-shortcut` so the JS API can
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

    // Launch-on-login support. Wired up to the Settings →
    // General → "Launch on login" toggle (frontend reads/writes via
    // `@tauri-apps/plugin-autostart`'s `isEnabled` / `enable` /
    // `disable` IPC).  The `MacosLauncher::LaunchAgent` variant tells
    // the plugin to register the autostart entry as a `~/Library/
    // LaunchAgents/<bundle-id>.plist` rather than the legacy AppleScript
    // approach (matches upstream's recommended default).  The
    // `--silent` arg is passed to the relaunched process so future
    // Notifier / sync-daemon code can detect a "started at
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
    //
    // Flathub-packaged builds get an ADDITIONAL runtime guard on top of
    // `not(mobile)`: Flathub requires apps NOT to self-update (updates
    // must flow through Flathub's own repo/CI review, not a bundled
    // updater phoning home to GitHub Releases and rewriting files under
    // the read-only `/app` tree). The Flatpak manifest
    // (`packaging/flathub/io.github.jfolcini.Agaric.yml`) repackages the
    // same compiled `.deb` used by the AppImage/deb build rather than
    // recompiling in-sandbox, so this can't be a build-time `cfg` flag —
    // it has to be a runtime check. `running_under_flatpak()` detects the
    // sandbox via `/.flatpak-info` (present in every Flatpak-sandboxed
    // process); when it's set, skip registering the plugin entirely so
    // there is no self-updater surface at all inside the sandbox.
    #[cfg(not(mobile))]
    {
        if !running_under_flatpak() {
            tauri_builder = tauri_builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
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

            // #2919 / #2972 — run the boot orchestration inside a fallible block
            // so ANY failure (corrupt SQLite page, failed `sqlx::migrate!` run —
            // e.g. `MigrateError::VersionMissing` after a downgrade — or a failed
            // engine reprojection) surfaces to the user in a native dialog rather
            // than a silent `exit(1)`. We handle the error here (dialog + exit)
            // instead of returning it so the same failure does NOT also bubble to
            // the `.build().unwrap_or_else` handler and pop a second dialog.
            let boot_result: Result<(), Box<dyn std::error::Error>> = (|| {
                // #3334 — resolve the app data directory through the single
                // `app_paths` seam: normally the OS-standard directory derived
                // from the `tauri.conf.json` identifier, but `AGARIC_DATA_DIR`
                // relocates it and `AGARIC_E2E_SANDBOX` makes that relocation
                // MANDATORY. A sandboxed harness whose override went missing
                // fails here — loudly, in the boot dialog — rather than
                // quietly opening the user's real vault.
                let app_data_dir = crate::app_paths::resolve_app_data_dir(app)?;
                std::fs::create_dir_all(&app_data_dir)?;
                let db_path = app_data_dir.join("notes.db");

                // Tracing-appender setup using the OS-correct
                // `app_data_dir`; keeps the worker guard alive in managed state.
                init_logging(app, &app_data_dir);

                // AppImage first-run desktop self-integration (Linux).
                // No-op unless `$APPIMAGE` is set (only inside a running AppImage),
                // so deb/rpm, `cargo tauri dev`, and non-Linux are all excluded.
                #[cfg(target_os = "linux")]
                appimage_integration::integrate_appimage_if_running();

                // Install the deep-link router as early as possible
                // so launch-time `agaric://…` URLs are routed once the rest of
                // setup completes.  The frontend `useDeepLinkRouter` hook
                // additionally calls `getCurrent()` on mount to backfill any
                // event the listener missed before it was registered.
                deeplink::register_deeplink_handlers(app.handle());

                // Open the read/write pools and resolve device-id + sync cert.
                let (pools, device_id, endpoint_secret) =
                    init_persistence(&db_path, &app_data_dir)?;

                // C-2b: build the materializer BEFORE recovery so the boot-time
                // op-log replay can drive ApplyOp tasks through the foreground queue.
                let (lifecycle, materializer, loro_state) =
                    build_materializer(&pools, &app_data_dir);
                // #2249: expose engine state to the Tauri state graph — the
                // `RunEvent::Exit` handler resolves it via `try_state` for the
                // shutdown snapshot save.
                app.manage(std::sync::Arc::clone(&loro_state));

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
                spawn_boot_maintenance(&pools, &materializer, &report);

                // Long-running background tasks: sweepers, maintenance daemon,
                // periodic Loro snapshot.
                spawn_background_tasks(&pools, &device_id, &materializer, &lifecycle);

                // Create scheduler wrapped in Arc for sharing with the SyncDaemon
                let scheduler =
                    std::sync::Arc::new(agaric_sync::sync_scheduler::SyncScheduler::new());

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
                    endpoint_secret,
                    sink: std::sync::Arc::new(sync_event_sinks::TauriEventSink(
                        app.handle().clone(),
                    )),
                    app_handle: app.handle().clone(),
                    lifecycle: lifecycle.clone(),
                    // `cancel_flag` is filled in below from the value
                    // `register_managed_state` allocates + registers, so the
                    // daemon and `cancel_sync` share the same flag (#528).
                    cancel_flag: Arc::new(AtomicBool::new(false)),
                };

                // Slice 2 — clone the pools + materializer +
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
                    materializer,
                    scheduler,
                    &lifecycle,
                );

                // #2506: register the mDNS-status managed state BEFORE the daemon
                // spawns below, so `TauriEventSink::on_sync_event` can always
                // find it via `try_state` the moment mDNS init runs (which can
                // happen almost immediately if peers already exist —
                // `start_if_peers_exist_with_lifecycle` skips dormant mode).
                // `get_mdns_status` resolves this state for a frontend that
                // mounts after that first emission.
                app.manage(agaric_sync::sync_events::MdnsStatusState(
                    std::sync::Mutex::new(agaric_sync::sync_events::MdnsStatus::default()),
                ));

                // #3864: same deal for the internet-facing-bind status, and the
                // ordering matters more here — the endpoint binds within the
                // first moments of `daemon_loop`, so this must be managed
                // before the daemon spawns or the one emission of
                // `SyncEvent::InternetFacingBind` lands nowhere and
                // `get_bind_exposure_status` reports a clean device that isn't.
                app.manage(agaric_sync::sync_events::BindExposureStatusState(
                    std::sync::Mutex::new(agaric_sync::sync_events::BindExposureStatus::default()),
                ));

                // #2696 — sweep orphaned `snapshot-recv-*.tmp` files left in
                // `app_data_dir` by a previous process that died mid-receive
                // (SIGKILL / OOM / power-loss, where `SnapshotTempFile::Drop`
                // never ran). Safe to delete unconditionally here because it
                // runs BEFORE `wire_sync_daemon` below starts accepting inbound
                // connections, so no snapshot receive can be in flight yet.
                agaric_sync::sync_daemon::sweep_orphaned_snapshot_temps(&app_data_dir);

                // #4298 — publish this device's hostname before the daemon
                // spawns, so the first session that reaches `HeadExchange` has
                // a name to advertise and the peer stops rendering this device
                // as a truncated UUID.
                spawn_local_device_name_refresh(daemon_wiring.pool.clone());

                // Install rustls + spawn the SyncDaemon (#382/#383/#278).
                let daemon_wiring = SyncDaemonWiring {
                    cancel_flag,
                    ..daemon_wiring
                };
                wire_sync_daemon(daemon_wiring);

                // / 4h — MCP read-only + read-write servers.
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
            })();

            if let Err(e) = boot_result {
                tracing::error!(error = %e, "fatal error during application setup");
                // #2919 — a downgrade / failed update, a corrupt vault database,
                // or a failed reprojection reaches here. Show it, then exit.
                show_fatal_error_dialog(
                    "Agaric failed to start",
                    &format!(
                        "Agaric could not open your vault and had to close.\n\n{e}\n\n\
                         This can happen after a failed or downgraded update, where an \
                         older version cannot open a vault that a newer one upgraded, \
                         or if the vault database is damaged. A pre-migration backup of \
                         the database is kept next to it when possible, so your data \
                         should be recoverable.\n\n\
                         Details are in the log files under your app data directory \
                         (the \"logs\" folder, agaric.log)."
                    ),
                );
                std::process::exit(1);
            }

            Ok(())
        })
        // #2110 M3 — wrap the tauri-specta invoke handler to extract a W3C
        // `traceparent` header (set by the frontend `invoke` shim) and re-parent
        // this request's span onto the frontend trace. Tauri's `tracing` feature
        // makes the async command future run under an `ipc::request::run` span
        // created *here*, synchronously, while `ipc.frontend` is entered — so it
        // (and every command + subsystem `#[instrument]` span beneath it) becomes
        // a child of the frontend interaction. No `traceparent` (the default, and
        // whenever observability is off) ⇒ the inner handler runs unwrapped and
        // the command starts a fresh root trace, exactly as before.
        .invoke_handler({
            let specta_invoke_handler = builder.invoke_handler();
            // #2654 — `read_attachment` returns a raw-byte `tauri::ipc::Response`
            // (see its doc comment) which cannot be a tauri-specta command, so it
            // lives on its own generated handler and is routed here by command
            // name. Every other command flows through the tauri-specta handler.
            let raw_bytes_invoke_handler: Box<
                dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync,
            > = Box::new(tauri::generate_handler![
                crate::commands::attachments::read_attachment
            ]);
            move |invoke| {
                use tracing_opentelemetry::OpenTelemetrySpanExt as _;
                // #2110 M6 — time each IPC command dispatch and record it to the
                // `agaric.ipc.duration` histogram, attributed by the command
                // NAME (an opaque compile-time identifier, never user data).
                //
                // #2282 — gate the timing on the process-global IPC-metrics flag
                // (set in `agaric_observability::init` only when the meter is
                // installed). When observability is OFF (the default) this skips
                // BOTH per-invoke `String` allocations — the command-name clone
                // here and the `KeyValue` inside `record_ipc_duration` — so the
                // wrapper costs one relaxed atomic load on the hot path. When on,
                // the command name is captured BEFORE dispatch (which consumes
                // `invoke`). The trace re-parenting below is independent of this
                // gate and still runs whenever a `traceparent` is present.
                let ipc_timing = agaric_observability::ipc_metrics_enabled().then(|| {
                    (
                        invoke.message.command().to_owned(),
                        std::time::Instant::now(),
                    )
                });
                // Route raw-byte commands to their dedicated handler; the command
                // name is an opaque compile-time identifier (never user data).
                let is_raw_bytes = invoke.message.command() == "read_attachment";
                let dispatch = |invoke| {
                    if is_raw_bytes {
                        raw_bytes_invoke_handler(invoke)
                    } else {
                        specta_invoke_handler(invoke)
                    }
                };
                let response =
                    match agaric_observability::extract_trace_context(invoke.message.headers()) {
                        Some(parent_cx) => {
                            let span = tracing::info_span!("ipc.frontend");
                            let _ = span.set_parent(parent_cx);
                            let _enter = span.enter();
                            dispatch(invoke)
                        }
                        None => dispatch(invoke),
                    };
                if let Some((cmd, started)) = ipc_timing {
                    agaric_observability::record_ipc_duration(
                        started.elapsed().as_secs_f64() * 1000.0,
                        &cmd,
                    );
                }
                response
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            tracing::error!(error = %e, "failed to build Tauri application");
            // #2972 — surface the failure in a native dialog instead of exiting
            // with no visible window. Setup-closure failures exit inside the
            // `setup` handler (see its own dialog above), so reaching here means
            // a Tauri-internal build failure.
            show_fatal_error_dialog(
                "Agaric failed to start",
                &format!(
                    "Agaric could not start and had to close.\n\n{e}\n\n\
                     This can happen after a failed or downgraded update, where an \
                     older version cannot open a vault upgraded by a newer one. \
                     Your data has not been modified.\n\n\
                     Details are in the log files under your app data directory \
                     (the \"logs\" folder, agaric.log)."
                ),
            );
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
                    app_handle
                        .try_state::<std::sync::Arc<agaric_engine::loro::shared::LoroState>>()
                        .map(|s| std::sync::Arc::clone(&s)),
                    app_handle.try_state::<WritePool>(),
                ) {
                    let saved = tauri::async_runtime::block_on(
                        agaric_engine::loro::snapshot::save_all_engines(&pool.0, &state.registry),
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

/// #3852 — the `log` → `tracing` bridge, and the filter that lets the bridged
/// records through.
#[cfg(test)]
mod log_bridge_tests {
    use super::{
        build_log_directives, directives_admit_mdns_debug, init_log_bridge, log_layer_defaults,
    };

    /// Until a global `log` logger exists, `log::max_level()` is `Off` and
    /// EVERY `log::debug!` in every dependency short-circuits inside the macro
    /// — the record is never even constructed. That is the state Agaric shipped
    /// in, and it is why `mdns-sd`'s socket/send diagnostics were unreachable
    /// no matter what filter was configured.
    ///
    /// nextest runs each test in its own process, so the pre-init reading below
    /// is the real boot-time state and not another test's leftovers.
    #[test]
    fn init_log_bridge_makes_log_crate_records_reachable() {
        use tracing_log::log::LevelFilter;

        let before = tracing_log::log::max_level();
        init_log_bridge(LevelFilter::Debug);
        let after = tracing_log::log::max_level();

        assert!(
            after >= LevelFilter::Debug,
            "after init_log_bridge, `mdns_sd`'s `log::debug!` records must at least be \
             constructed and offered to `tracing`; max_level was {before:?} before and \
             {after:?} after"
        );
        assert_eq!(
            after,
            LevelFilter::Debug,
            "the bridge must honour the ceiling it is given: `LogTracer::init()` would set \
             Trace, making every dependency's `log::trace!` record be constructed and \
             dispatched into `tracing` only for the layers' EnvFilter to drop it. max_level \
             was {before:?} before and {after:?} after"
        );
    }

    /// Boot ordering: `init_log_bridge` runs BEFORE the subscriber is installed,
    /// so by the time the registry goes in, a global `log` logger already exists.
    /// `SubscriberInitExt::init` `expect()`s on installing its own bridge on top
    /// of that, so it panicked before the first window ever appeared — every
    /// launch, every platform. This asserts the surviving half: the subscriber
    /// must end up installed, and the second bridge install must be a tolerated
    /// `Err` rather than an abort.
    ///
    /// nextest runs each test in its own process, so this is a real boot
    /// sequence and not a fight with another test's globals.
    #[test]
    fn installing_the_subscriber_after_the_bridge_does_not_abort_boot() {
        use tracing_subscriber::layer::SubscriberExt;
        use tracing_subscriber::util::SubscriberInitExt;

        init_log_bridge(tracing_log::log::LevelFilter::Info);

        let result = tracing_subscriber::registry()
            .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
            .try_init();

        assert!(
            result.is_err(),
            "guard on the premise: with the bridge already installed, the subscriber's own \
             `LogTracer` install must fail — if this ever passes, the `.ok()` in `init_logging` \
             is swallowing something else"
        );
        assert!(
            tracing::dispatcher::has_been_set(),
            "`try_init` sets the global default BEFORE attempting the bridge, so a boot that \
             tolerates the bridge error must still come up with a live subscriber; without one, \
             every `tracing` event in the process is dropped"
        );
    }

    /// The bridge alone is not enough: a forwarded record still has to pass the
    /// subscriber's `EnvFilter`. With only `agaric` / `frontend` directives,
    /// every `mdns_sd` event is rejected for having no matching directive, so
    /// bridging them would change nothing observable. This is the shape Android
    /// boots with, asserted from any host because the gate is a parameter.
    #[test]
    fn the_android_default_log_filter_admits_mdns_sd_at_debug() {
        let directives = build_log_directives("", &log_layer_defaults(true));
        assert!(
            directives.contains("mdns_sd=debug"),
            "on the platform with no RUST_LOG, the default directives must admit mdns-sd's \
             debug diagnostics (socket-create and send failures are all emitted at debug), \
             got: {directives}"
        );
        assert!(
            tracing_subscriber::EnvFilter::try_new(&directives).is_ok(),
            "the default directive string must parse as an EnvFilter, got: {directives}"
        );
        assert!(
            directives_admit_mdns_debug(&directives),
            "the bridge ceiling is derived from this string; it must read the directive it \
             just built, got: {directives}"
        );
    }

    /// The scoping this whole gate exists for (PR #4034 note 5): off Android,
    /// `mdns_sd=debug` is NOT a default, so it does not stream into a JSON log
    /// file that has no per-file size cap (#157 sub-item D) on every desktop
    /// install that never asked for it.
    ///
    /// Asserted through the constant the production path actually reads, so a
    /// widened `cfg!` — say back to an unconditional `true` — reddens here on
    /// every non-Android CI runner rather than shipping quietly.
    #[test]
    #[cfg(not(target_os = "android"))]
    fn mdns_debug_is_not_a_default_off_android() {
        use super::MDNS_DEBUG_BY_DEFAULT;

        // Asserted through the directive string rather than on the constant
        // directly: `assert!(!MDNS_DEBUG_BY_DEFAULT)` is a constant assertion
        // clippy rejects, and this form checks the thing that actually ships —
        // what the production subscriber is handed.
        let directives = build_log_directives("", &log_layer_defaults(MDNS_DEBUG_BY_DEFAULT));
        assert!(
            !directives.contains("mdns_sd"),
            "no mdns-sd directive may be shipped by default off Android, got: {directives}"
        );
        assert!(
            !directives_admit_mdns_debug(&directives),
            "and the log bridge must therefore stay below Debug, so mdns-sd's per-packet \
             `log::debug!` calls short-circuit instead of being built and dropped, \
             got: {directives}"
        );
    }

    /// The default being off must not put the diagnostics out of reach: on
    /// every platform that has an environment, asking for them by name still
    /// works, and the bridge ceiling rises with the filter.
    #[test]
    fn an_operator_can_still_opt_in_off_android() {
        let directives = build_log_directives("mdns_sd=debug", &log_layer_defaults(false));
        assert!(
            directives.contains("mdns_sd=debug"),
            "RUST_LOG=mdns_sd=debug must survive into the layer filter, got: {directives}"
        );
        assert!(
            directives_admit_mdns_debug(&directives),
            "and must raise the log bridge's ceiling, or the records it asks for are \
             short-circuited before they are built, got: {directives}"
        );
    }

    /// Submodule directives count too — `log` records take `module_path!()` as
    /// their target, so an operator naming `mdns_sd::service_daemon` is asking
    /// for exactly the records the bridge carries.
    #[test]
    fn a_submodule_directive_raises_the_bridge_ceiling() {
        assert!(
            directives_admit_mdns_debug("agaric=info,mdns_sd::service_daemon=debug"),
            "a submodule directive must be recognised"
        );
        assert!(
            !directives_admit_mdns_debug("agaric=debug,frontend=info,mdns_sd_helper=debug"),
            "a target that merely starts with the same letters must not"
        );
        assert!(
            !directives_admit_mdns_debug("mdns_sd=warn"),
            "a directive that rejects debug must not raise the ceiling"
        );
    }

    /// An operator who finds mDNS debug noisy must be able to turn it down, and
    /// the existing "user directive wins" rule is what makes the Android
    /// default safe to ship. Falsifying this would mean `RUST_LOG` could not
    /// quiet it.
    #[test]
    fn a_user_rust_log_directive_still_overrides_the_mdns_default() {
        let directives = build_log_directives("mdns_sd=warn", &log_layer_defaults(true));
        assert!(
            directives.contains("mdns_sd=warn"),
            "the operator's directive must be preserved, got: {directives}"
        );
        assert!(
            !directives.contains("mdns_sd=debug"),
            "the default must NOT be appended alongside the operator's, got: {directives}"
        );
    }
}

/// #4080 Tier 1 — the boot path itself, not the pieces it is made of.
///
/// `init_logging` is reachable only from Tauri's setup hook, so until this
/// module existed the whole sequence — bridge install, appender build, registry
/// composition, subscriber install — ran for the first time on a user's
/// machine. 0.9.7 shipped a build that aborted there on every launch, on every
/// platform, with the entire Rust suite green and four release jobs reporting
/// success. The tests above cover the halves in isolation; this one runs the
/// sequence.
#[cfg(test)]
mod local_device_name_tests {
    use super::identifying_hostname;

    /// The motivating device for #4298 is a Pixel 8, and stock Android never
    /// gives the kernel a hostname that names the phone.
    ///
    /// Established by booting the `android-34` emulator system image and
    /// reading the value the plugin's source path actually returns:
    /// `tauri_plugin_os::hostname()` → `gethostname::gethostname()` →
    /// `rustix::system::uname().nodename()`, i.e. the UTS nodename that
    /// `uname -n` prints. On that image `uname -a` reads
    /// `Linux localhost 6.1.23-android14-4-…`. The Android device name a user
    /// would recognise lives in `Settings.Global.device_name`
    /// (`sdk_gphone64_x86_64` there) and is not the nodename.
    ///
    /// So every Android peer would advertise the identical string
    /// `"localhost"`. Advertising nothing instead lets each of them fall back
    /// to its own truncated id, which is the one thing on the row that is
    /// distinct per device.
    #[test]
    fn android_localhost_hostname_advertises_no_device_name_4298() {
        assert_eq!(
            identifying_hostname("localhost"),
            None,
            "`localhost` is what stock Android reports for EVERY device;              advertising it would make two Android peers render as two              identical rows"
        );
    }

    /// The same non-name in the spellings the OS actually produces.
    ///
    /// `(none)` is the Linux kernel's own default — the Android 14 GKI kernel
    /// in the `android-34` image is built with
    /// `CONFIG_DEFAULT_HOSTNAME="(none)"` (read out of the kernel's embedded
    /// `IKCFG_ST` config blob), which is the value left standing on any boot
    /// where userspace does not overwrite it.
    ///
    /// `.localdomain` is the historical AOSP pairing (`hostname localhost` +
    /// `domainname localdomain`) and the stock value on more than one Linux
    /// distribution.
    #[test]
    fn non_identifying_hostname_variants_advertise_nothing_4298() {
        for raw in [
            "",
            "   ",
            "\t\n",
            "LOCALHOST",
            "LocalHost",
            "localhost.localdomain",
            "LocalHost.LocalDomain",
            "  localhost  ",
            "(none)",
            "(NONE)",
        ] {
            assert_eq!(
                identifying_hostname(raw),
                None,
                "{raw:?} names no particular device and must not be advertised"
            );
        }
    }

    /// The other half of the contract: a hostname that DOES name a device is
    /// still advertised, or #4298 would have shipped a feature that never
    /// fires.
    #[test]
    fn a_real_hostname_is_still_advertised_4298() {
        assert_eq!(
            identifying_hostname("javier-thinkpad"),
            Some("javier-thinkpad")
        );
        assert_eq!(identifying_hostname("  Pixel 8  "), Some("Pixel 8"));
        assert_eq!(
            identifying_hostname("MacBook-Pro.local"),
            Some("MacBook-Pro.local")
        );
    }

    /// `.localdomain` is stripped only to *recognise* a non-name; it must not
    /// swallow a real host that happens to sit in that domain, and a name that
    /// merely contains the substring is untouched.
    #[test]
    fn localdomain_suffix_does_not_discard_a_real_hostname_4298() {
        assert_eq!(
            identifying_hostname("pixel-8.localdomain"),
            Some("pixel-8.localdomain"),
            "the suffix is stripped for the comparison only; a real host in              that domain keeps the name the OS reports"
        );
        assert_eq!(
            identifying_hostname("localhost-upstairs"),
            Some("localhost-upstairs"),
            "a device genuinely named this is not the stock value"
        );
        assert_eq!(identifying_hostname("not-localhost"), Some("not-localhost"));
    }
}

#[cfg(test)]
mod boot_path_tests {
    /// Drives the real `init_logging` against a mock app and a throwaway
    /// app-data dir. Pre-#4079 this call aborted the process with
    /// `SetLoggerError`, so the assertions below are almost incidental — the
    /// load-bearing claim is that the call returns at all.
    ///
    /// nextest runs each test in its own process, so this is a real boot from
    /// clean globals and not a fight with another test's logger.
    #[test]
    fn init_logging_completes_the_real_boot_sequence() {
        let app = tauri::test::mock_app();
        let dir = tempfile::tempdir().expect("throwaway app-data dir");

        // Pre-#4079 this panicked instead of returning.
        super::init_logging(&app, dir.path());

        assert!(
            tracing::dispatcher::has_been_set(),
            "boot must leave a live global subscriber behind; without one every `tracing` \
             event in the process is dropped and the app runs blind"
        );
        assert!(
            super::log_dir_for_app_data(dir.path()).is_dir(),
            "boot must create the log directory beneath the app-data dir it was handed, or \
             `agaric.log` and the bug-report bundle both resolve to a path that does not exist"
        );
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
// Log_dir_for_app_data helper tests
// ===========================================================================
//
// This helper is used by the tracing-appender setup in `run()` (and by
// `src/commands/bug_report.rs` when locating logs for a bug report). These
// tests pin down the invariant: it MUST resolve to "<app_data_dir>/logs"
// regardless of platform. Before this was fixed, `run()` hard-coded a Linux
// XDG path instead of using Tauri's OS-correct resolver, so the on-disk log
// location drifted from the app-data directory on macOS / Windows.

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

        // Root bypasses DAC permission checks (CAP_DAC_OVERRIDE), so on a
        // uid-0 runner (container/sandbox) the 0o500 parent is still
        // writable and the unwritable-dir premise doesn't hold. Probe the
        // actual effect instead of assuming it: if this write succeeds,
        // skip rather than fail on an environment artifact.
        if std::fs::write(parent.join(".dac-probe"), b"x").is_ok() {
            eprintln!(
                "skipping unwritable_log_dir_degrades_without_panic: \
                 0o500 parent is still writable (running as root?)"
            );
            return;
        }

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

    /// #3246 — the log-dir divergence guard, re-pointed at the pair that
    /// still exists.
    ///
    /// `log_dir_for_app_data` is a single source of truth precisely because
    /// two independent paths have to land on the same directory: `init_logging`
    /// WRITES the rolling log file beneath it, and `commands::bug_report` READS
    /// that file back out of it. The original version of this test guarded the
    /// pair `run()` / `get_log_dir`. #3240 deleted `get_log_dir`, and what was
    /// left asserted `<app_data>/logs` a second time — a restatement of
    /// `log_dir_for_app_data_appends_logs_subdir`, not a guard.
    ///
    /// Asserting that both callers invoke the same helper would be vacuous:
    /// textually, they already do. What can actually drift is everything the
    /// two sides own SEPARATELY — the appender's rotation + `filename_prefix`
    /// on the write side (which yields `agaric.log.YYYY-MM-DD`; #4127 fixed
    /// the read side, which used to look for a plain `agaric.log` FIRST and
    /// only reached the real name through a "fallback" branch) against the
    /// filenames `recent_errors_from_log_dir` looks for, and either side
    /// deriving its app-data directory by a different route. So this test
    /// drives the real
    /// write path and then the real read path over the SAME app-data
    /// directory, and asserts the second one finds what the first one wrote.
    ///
    /// The failure mode it exists to catch is silent: no error anywhere, just
    /// bug reports that ship with no logs in them.
    ///
    /// `init_logging` installs the process-global subscriber, so this test
    /// needs a clean process — which nextest, the arbiter here, gives every
    /// test. The precondition is asserted rather than assumed so a
    /// shared-process runner fails with the reason instead of a mystery.
    #[test]
    fn log_dir_write_path_and_bug_report_read_path_agree() {
        assert!(
            !tracing::dispatcher::has_been_set(),
            "this test needs a clean process: it installs the global subscriber via the real \
             `init_logging`, and a subscriber set by an earlier test in the same process would \
             swallow the probe line and make the assertions below meaningless"
        );

        let app = tauri::test::mock_app();
        let app_data = TempDir::new().expect("app-data dir");
        let device_id = "logdir-contract-device";

        // WRITE path: the real boot sequence, pointed at `app_data`. It picks
        // the directory, the filename, and the rotation scheme.
        super::init_logging(&app, app_data.path());
        tracing::error!("bug-report log-dir contract probe");

        // READ path: the real bug-report entry point, handed the SAME app-data
        // directory and left to locate the logs on its own.
        let read_back = || {
            crate::commands::collect_bug_report_metadata_inner(
                app_data.path(),
                device_id.to_owned(),
                None,
                &[],
            )
            .expect("bug-report metadata collection must succeed")
            .recent_errors
        };

        // The non-blocking appender hands the line to a worker thread, so poll
        // for it instead of guessing a sleep duration. Measured: the very first
        // `read_back()` already sees the line (whole test < 0.1s), so 5s is
        // ~60x headroom and also caps what a genuine regression costs.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut found = read_back();
        while found.is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
            found = read_back();
        }

        assert!(
            !found.is_empty(),
            "the bug-report read path found no ERROR lines under {} even though the real \
             `init_logging` write path had just logged one there — the two paths have diverged \
             and every bug report from this build ships with empty logs",
            app_data.path().display()
        );

        // Negative control: the read path is genuinely resolving the directory
        // from the app-data dir it was handed, not finding logs regardless.
        let unrelated = TempDir::new().expect("unrelated app-data dir");
        let from_elsewhere = crate::commands::collect_bug_report_metadata_inner(
            unrelated.path(),
            device_id.to_owned(),
            None,
            &[],
        )
        .expect("bug-report metadata collection must succeed")
        .recent_errors;
        assert!(
            from_elsewhere.is_empty(),
            "a different app-data dir must yield no log lines, otherwise the positive assertion \
             above proves nothing about which directory was read; got {from_elsewhere:?}"
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

// Unit test for the boot-count error-logging helper.
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
