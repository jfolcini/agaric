pub mod backlink_query;
pub mod cache;
pub mod commands;
pub mod dag;
pub mod db;
pub mod device;
pub mod draft;
pub mod error;
pub mod fts;
pub mod hash;
pub mod materializer;
pub mod merge;
pub mod op;
pub mod op_log;
pub mod pagination;
pub mod pairing;
pub mod peer_refs;
pub mod recovery;
pub mod reverse;
pub mod snapshot;
pub mod soft_delete;
pub mod sync_cert;
pub mod sync_daemon;
pub mod sync_events;
pub mod sync_net;
pub mod sync_protocol;
pub mod sync_scheduler;
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
            crate::commands::get_device_id,
            // Sync — pairing & session (#275, #278)
            crate::commands::start_pairing,
            crate::commands::confirm_pairing,
            crate::commands::cancel_pairing,
            crate::commands::start_sync,
            crate::commands::cancel_sync,
            // Batch count commands (#604)
            crate::commands::count_agenda_batch,
            crate::commands::count_backlinks_batch,
            // Page aliases (#598)
            crate::commands::set_page_aliases,
            crate::commands::get_page_aliases,
            crate::commands::resolve_page_by_alias,
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
    use materializer::Materializer;
    use sync_cert::PersistedCert;
    use tauri::Manager;
    use tauri_specta::{collect_commands, Builder};
    use tracing_subscriber::EnvFilter;

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("agaric=info".parse().unwrap()),
        )
        .init();

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
        commands::get_device_id,
        // Sync — pairing & session (#275, #278)
        commands::start_pairing,
        commands::confirm_pairing,
        commands::cancel_pairing,
        commands::start_sync,
        commands::cancel_sync,
        // Batch count commands (#604)
        commands::count_agenda_batch,
        commands::count_backlinks_batch,
        // Page aliases (#598)
        commands::set_page_aliases,
        commands::get_page_aliases,
        commands::resolve_page_by_alias,
    ]);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Resolve the OS-standard app data directory from tauri.conf.json identifier
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("notes.db");

            // Initialize separated read/write pools (ADR-04: pool separation)
            let pools = tauri::async_runtime::block_on(db::init_pools(&db_path))?;

            // Read or generate a persistent device UUID (ADR-07)
            let device_id_path = app_data_dir.join("device-id");
            let device_id = device::get_or_create_device_id(&device_id_path)?;

            // Read or generate a persistent TLS certificate for sync (#380)
            let cert_path = app_data_dir.join("sync-cert");
            let sync_cert = sync_cert::get_or_create_sync_cert(&cert_path, &device_id)?;
            tracing::info!(cert_hash = %sync_cert.cert_hash, "TLS cert loaded");

            // Run crash recovery before anything else (ADR-07)
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

            // Create materializer (spawns consumer tasks) — uses write pool for cache rebuilds
            let materializer = Materializer::new(pools.write.clone());

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
