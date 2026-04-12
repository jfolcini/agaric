pub mod backlink;
pub mod cache;
pub mod commands;
pub mod dag;
pub mod db;
pub mod device;
pub mod draft;
pub mod error;
pub mod fts;
pub mod hash;
pub mod import;
pub mod materializer;
mod materializer_handlers;
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

#[cfg(not(tarpaulin_include))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use db::{ReadPool, WritePool};
    use device::DeviceId;
    use materializer::{MaterializeTask, Materializer};
    use sync_cert::PersistedCert;
    use tauri::Manager;
    use tauri_specta::{collect_commands, Builder};
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::EnvFilter;

    // Determine log directory: ~/.local/share/com.agaric.app/logs on Linux,
    // falling back to the OS temp dir when $HOME is not set (e.g. Android).
    let log_dir = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".local/share/com.agaric.app/logs"))
        .unwrap_or_else(|_| std::env::temp_dir().join("agaric-logs"));
    let _ = std::fs::create_dir_all(&log_dir);

    let file_appender = tracing_appender::rolling::daily(&log_dir, "agaric.log");
    let (non_blocking, _log_guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = EnvFilter::from_default_env()
        .add_directive("agaric=info".parse().unwrap())
        .add_directive("frontend=info".parse().unwrap());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false),
        )
        .init();

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

    // M-45: Clean up log files older than 30 days (best-effort, boot-time only).
    cleanup_old_log_files(&log_dir, 30);

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
    ]);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Resolve the OS-standard app data directory from tauri.conf.json identifier
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("notes.db");

            // Initialize separated read/write pools
            let pools = tauri::async_runtime::block_on(db::init_pools(&db_path))?;

            // Read or generate a persistent device UUID
            let device_id_path = app_data_dir.join("device-id");
            let device_id = device::get_or_create_device_id(&device_id_path)?;

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

            // Create materializer — bg cache rebuilds read from read pool, write to write pool (P-8)
            let materializer = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());

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

            // P-16: Populate projected agenda cache at boot so the first query
            // hits the cache rather than falling back to on-the-fly computation.
            if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildProjectedAgendaCache) {
                tracing::warn!(error = %e, "failed to enqueue projected agenda cache rebuild at boot");
            }

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

            // Install rustls CryptoProvider before any TLS usage (#sync)
            let _ = rustls::crypto::ring::default_provider().install_default();

            // Spawn SyncDaemon (#382, #383, #278)
            tauri::async_runtime::spawn(async move {
                match sync_daemon::SyncDaemon::start(
                    daemon_pool,
                    daemon_device_id,
                    daemon_materializer,
                    daemon_scheduler,
                    daemon_cert,
                    daemon_sink,
                    cancel_flag,
                )
                .await
                {
                    Ok(daemon) => {
                        tracing::info!("SyncDaemon started successfully");
                        daemon_app_handle.manage(daemon);
                    }
                    Err(e) => tracing::error!("Failed to start SyncDaemon: {e}"),
                }
            });

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

    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();

        // Match files like "agaric.log.2025-01-15"
        let date_str = match name.strip_prefix("agaric.log.") {
            Some(d) if d.len() == 10 => d,
            _ => continue,
        };

        let file_date = match chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
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
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number),
                &tmp,
            )
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
                .map(|l| l.trim_end())
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
            .export(
                specta_typescript::Typescript::default()
                    .bigint(specta_typescript::BigIntExportBehavior::Number),
                out_path,
            )
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
