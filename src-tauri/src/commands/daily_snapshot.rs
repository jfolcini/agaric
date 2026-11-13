//! The commands behind the Settings › Data snapshot row (#6554): when the
//! last daily snapshot was taken, and opening the folder that holds it.
//! Opening the folder has no test: it starts the system's file manager.

use std::path::Path;

use super::sanitize_internal_error;
use crate::db::{VAULT_DB_FILE, daily_snapshot};
use agaric_core::error::AppError;

/// Open the vault's folder, which holds the daily snapshots, in the system's
/// file manager.
///
/// # Errors
///
/// [`AppError::Validation`] on mobile, where the folder is private to the
/// app; [`AppError::Channel`] when the file manager cannot be started.
pub fn open_data_folder_inner(app_data_dir: &Path) -> Result<(), AppError> {
    #[cfg(mobile)]
    {
        let _ = app_data_dir;
        Err(AppError::validation(
            "not supported on this platform".to_owned(),
        ))
    }
    #[cfg(desktop)]
    {
        tauri_plugin_opener::open_path(app_data_dir, None::<&str>)
            .map_err(|e| AppError::Channel(format!("cannot open the data folder: {e}")))
    }
}

/// Tauri command: when the newest daily snapshot was taken, in Unix
/// milliseconds; `null` before the first one. Delegates to
/// [`daily_snapshot::last_daily_snapshot_ms`].
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub fn get_last_snapshot_ms(app: tauri::AppHandle) -> Result<Option<i64>, AppError> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    daily_snapshot::last_daily_snapshot_ms(&app_data_dir.join(VAULT_DB_FILE))
        .map_err(sanitize_internal_error)
}

/// Tauri command: open the vault's folder in the system's file manager.
/// Delegates to [`open_data_folder_inner`].
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub fn open_data_folder(app: tauri::AppHandle) -> Result<(), AppError> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    open_data_folder_inner(&app_data_dir).map_err(sanitize_internal_error)
}
