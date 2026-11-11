//! The Markdown mirror's commands (#5363): pick a folder, set or clear it,
//! choose whether outside changes are read back, and read the mirror's
//! status. They exist on every target, because the
//! bindings are generated once; on mobile, where the mirror does not run, the
//! status says `supported: false` and setting a folder is refused.

use std::collections::HashSet;
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

/// Turn the mirror on in `path`, reading files changed outside Agaric back
/// in when `read_back` (ignored while the mirror is already on), or off with
/// `None`. On, the folder is checked
/// ([`mirror::check_folder`]), marked as this device's and stored, after
/// `read_back`, so the first tick already follows it, and the next tick
/// writes every page. Off, the setting goes and the files and the marker
/// stay.
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
    read_back: bool,
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
        // Only when the mirror turns on: while it is on, reading back is
        // turned on by `set_mirror_read_back` alone, which asks first.
        if mirror::store::folder(pool).await?.is_none() {
            mirror::store::set_read_back(pool, read_back).await?;
        }
    }
    mirror::store::set_folder(pool, path.as_deref()).await?;
    mirror.restart();
    get_mirror_status_inner(pool, device_id, mirror).await
}

/// Read files changed outside Agaric back into it, or with `on: false` stop.
/// Turning it on while files changed meanwhile ([`MirrorStatus::pending`],
/// derived again here, not taken from the caller) is refused unless
/// `read_pending` says the user chose to read them in.
///
/// # Errors
///
/// [`AppError::Validation`] when files are pending and `read_pending` is
/// `false`, or when which files changed cannot be told.
pub async fn set_mirror_read_back_inner(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    on: bool,
    read_pending: bool,
) -> Result<MirrorStatus, AppError> {
    if on && !read_pending {
        let changed = match mirror::store::folder(pool).await? {
            Some(folder) => pending(pool, device_id, mirror, Path::new(&folder)).await?,
            None => Vec::new(),
        };
        if !changed.is_empty() {
            return Err(AppError::validation(format!(
                "{} files changed outside Agaric while reading back was off; \
                 choose to read them in to turn it on",
                changed.len()
            )));
        }
    }
    mirror::store::set_read_back(pool, on).await?;
    get_mirror_status_inner(pool, device_id, mirror).await
}

/// [`mirror::read_back::pending`] for the folder at `root`, with this vault's
/// space folders.
async fn pending(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    root: &Path,
) -> Result<Vec<String>, AppError> {
    let spaces: Vec<(String, String)> = super::spaces::list_spaces_inner(pool)
        .await?
        .into_iter()
        .map(|space| (space.id, space.name))
        .collect();
    let folders: HashSet<String> = mirror::paths::space_folders(&spaces)
        .into_values()
        .collect();
    let states = mirror::store::StateDir::new(mirror.app_data_dir());
    mirror::read_back::pending(root, device_id, &states, &folders)
}

/// The mirror's settings and what it is doing. While reading back is off,
/// the files turning it on would read in, none when they cannot be told:
/// [`set_mirror_read_back_inner`] refuses then, with the reason.
///
/// # Errors
///
/// The settings cannot be read.
pub async fn get_mirror_status_inner(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
) -> Result<MirrorStatus, AppError> {
    let settings = mirror::store::settings(pool).await?;
    let changed = match settings.folder.as_deref() {
        Some(folder) if !settings.read_back => pending(pool, device_id, mirror, Path::new(folder))
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(error = %e, "cannot list the mirror's pending files");
                Vec::new()
            }),
        _ => Vec::new(),
    };
    Ok(mirror.status(settings, changed))
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
    read_back: bool,
) -> Result<MirrorStatus, AppError> {
    set_mirror_folder_inner(&pool.0, device_id.as_str(), &mirror, path, read_back)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn set_mirror_read_back(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    mirror: State<'_, MirrorState>,
    on: bool,
    read_pending: bool,
) -> Result<MirrorStatus, AppError> {
    set_mirror_read_back_inner(&pool.0, device_id.as_str(), &mirror, on, read_pending)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn get_mirror_status(
    pool: State<'_, ReadPool>,
    device_id: State<'_, DeviceId>,
    mirror: State<'_, MirrorState>,
) -> Result<MirrorStatus, AppError> {
    get_mirror_status_inner(&pool.0, device_id.as_str(), &mirror)
        .await
        .map_err(sanitize_internal_error)
}
