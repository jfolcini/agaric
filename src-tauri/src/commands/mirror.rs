//! The Markdown mirror's commands (#5363 slice 1): pick a folder, set or clear
//! it, and read the mirror's status. They exist on every target, because the
//! bindings are generated once; on mobile, where the mirror does not run, the
//! status says `supported: false` and setting a folder is refused.

use std::path::Path;

use sqlx::SqlitePool;
use tauri::State;

use super::sanitize_internal_error;
use crate::db::{ReadPool, WritePool};
use crate::mirror::{self, MirrorState, MirrorStatus};
use agaric_core::error::AppError;
use agaric_sync::device::DeviceId;

fn unsupported() -> AppError {
    AppError::validation("not supported on this platform".to_owned())
}

/// The folder the user picks in the system's folder dialog, `None` when they
/// cancel. Stores nothing: [`set_mirror_folder_inner`] does.
///
/// # Errors
///
/// [`AppError::Validation`] on mobile, or for a path that is not UTF-8;
/// [`AppError::Channel`] when the dialog cannot be shown.
pub async fn pick_mirror_folder_inner<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<Option<String>, AppError> {
    #[cfg(mobile)]
    {
        let _ = app;
        Err(unsupported())
    }
    #[cfg(desktop)]
    {
        // GTK and AppKit show a dialog only from the main thread.
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(rfd::FileDialog::new().pick_folder());
        })
        .map_err(|e| AppError::Channel(format!("cannot show the folder dialog: {e}")))?;
        let picked = rx
            .await
            .map_err(|e| AppError::Channel(format!("the folder dialog closed early: {e}")))?;
        picked
            .map(|path| {
                path.into_os_string()
                    .into_string()
                    .map_err(|_| AppError::validation("the folder's path is not UTF-8".to_owned()))
            })
            .transpose()
    }
}

/// Turn the mirror on in `path`, or off with `None`. On, the folder is
/// checked ([`mirror::check_folder`]), marked as this device's and stored,
/// and the next tick writes every page. Off, the setting goes and the files
/// and the marker stay.
///
/// # Errors
///
/// [`AppError::Validation`] on mobile, or naming why the folder is refused or
/// cannot be marked.
pub async fn set_mirror_folder_inner(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    path: Option<String>,
) -> Result<MirrorStatus, AppError> {
    if cfg!(mobile) {
        return Err(unsupported());
    }
    if let Some(folder) = path.as_deref().map(Path::new) {
        mirror::check_folder(folder, device_id, mirror.app_data_dir())?;
        mirror::store::write_marker(folder, device_id).map_err(|e| {
            AppError::validation(format!(
                "cannot mark {} as the mirror: {e}",
                folder.display()
            ))
        })?;
    }
    mirror::store::set_folder(pool, path.as_deref()).await?;
    mirror.restart();
    Ok(mirror.status(path))
}

/// The mirror's folder and what it is doing.
///
/// # Errors
///
/// The folder setting cannot be read.
pub async fn get_mirror_status_inner(
    pool: &SqlitePool,
    mirror: &MirrorState,
) -> Result<MirrorStatus, AppError> {
    let folder = mirror::store::folder(pool).await?;
    Ok(mirror.status(folder))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn pick_mirror_folder(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    pick_mirror_folder_inner(&app)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn set_mirror_folder(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    mirror: State<'_, MirrorState>,
    path: Option<String>,
) -> Result<MirrorStatus, AppError> {
    set_mirror_folder_inner(&pool.0, device_id.as_str(), &mirror, path)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn get_mirror_status(
    pool: State<'_, ReadPool>,
    mirror: State<'_, MirrorState>,
) -> Result<MirrorStatus, AppError> {
    get_mirror_status_inner(&pool.0, &mirror)
        .await
        .map_err(sanitize_internal_error)
}
