mod db;
mod device;
mod draft;
mod error;
mod hash;
mod materializer;
mod op;
mod op_log;
mod recovery;
mod ulid;

use device::DeviceId;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

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

            // Store in Tauri managed state — commands access via State<SqlitePool>
            app.manage(pool);

            // Read or generate a persistent device UUID (ADR-07)
            let device_id_path = app_data_dir.join("device-id");
            let device_id = device::get_or_create_device_id(&device_id_path)?;
            app.manage(DeviceId(device_id));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
