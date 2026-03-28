pub mod cache;
pub mod commands;
pub mod db;
pub mod device;
pub mod draft;
pub mod error;
pub mod hash;
pub mod materializer;
pub mod op;
pub mod op_log;
pub mod pagination;
pub mod recovery;
pub mod soft_delete;
pub mod ulid;

#[cfg(test)]
mod integration_tests;

use device::DeviceId;
use materializer::Materializer;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Resolve the OS-standard app data directory from tauri.conf.json identifier
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("notes.db");

            // Initialize the pool synchronously during setup (runs migrations)
            let pool = tauri::async_runtime::block_on(db::init_pool(&db_path))?;

            // Read or generate a persistent device UUID (ADR-07)
            let device_id_path = app_data_dir.join("device-id");
            let device_id = device::get_or_create_device_id(&device_id_path)?;

            // Run crash recovery before anything else (ADR-07)
            let report =
                tauri::async_runtime::block_on(recovery::recover_at_boot(&pool, &device_id))?;
            if !report.drafts_recovered.is_empty() {
                eprintln!(
                    "[boot] Recovered {} unflushed drafts",
                    report.drafts_recovered.len()
                );
            }

            // Create materializer (spawns consumer tasks)
            let materializer = Materializer::new(pool.clone());

            // Store all in Tauri managed state
            app.manage(pool);
            app.manage(DeviceId(device_id));
            app.manage(materializer);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_block,
            commands::edit_block,
            commands::delete_block,
            commands::restore_block,
            commands::purge_block,
            commands::list_blocks,
            commands::get_block,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
