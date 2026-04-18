//! Frontend logging command handlers (F-19).

use crate::error::AppError;

/// Log a frontend message to the backend's daily-rolling log file.
/// Fire-and-forget — the frontend never awaits this.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn log_frontend(
    level: String,
    module: String,
    message: String,
    stack: Option<String>,
    context: Option<String>,
    data: Option<String>,
) -> Result<(), AppError> {
    match level.as_str() {
        "error" => {
            tracing::error!(target: "frontend", module = %module, stack = stack.as_deref().unwrap_or(""), context = context.as_deref().unwrap_or(""), data = data.as_deref().unwrap_or(""), "{message}")
        }
        "warn" => {
            tracing::warn!(target: "frontend", module = %module, stack = stack.as_deref().unwrap_or(""), context = context.as_deref().unwrap_or(""), data = data.as_deref().unwrap_or(""), "{message}")
        }
        "info" => {
            tracing::info!(target: "frontend", module = %module, data = data.as_deref().unwrap_or(""), "{message}")
        }
        "debug" => {
            tracing::debug!(target: "frontend", module = %module, data = data.as_deref().unwrap_or(""), "{message}")
        }
        _ => {
            tracing::info!(target: "frontend", module = %module, data = data.as_deref().unwrap_or(""), "{message}")
        }
    }
    Ok(())
}

/// Return the path to the logs directory.
///
/// Uses [`crate::log_dir_for_app_data`] so the path returned to the
/// frontend ("Open logs folder") is guaranteed to match the directory
/// the tracing-appender writes to — on every platform (BUG-34).
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_log_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    use tauri::Manager;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let log_dir = crate::log_dir_for_app_data(&data_dir);
    Ok(log_dir.to_string_lossy().into_owned())
}
