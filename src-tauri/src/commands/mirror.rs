//! The Markdown mirror's commands (#5363): pick a folder, set or clear it,
//! choose whether outside changes are read back and whether attachments are
//! copied in, and read the mirror's status. They exist on every target, because the
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
/// in when `read_back`, or off with `None`. While the mirror is already on,
/// `read_back` is ignored and reading back stays as it is set, except that a
/// folder other than the one mirrored, like one the mirror turns on in,
/// turns it off when it holds files changed since the mirror last wrote
/// there ([`MirrorStatus::pending`]), which turning reading back on then
/// asks about. On, the folder is checked
/// ([`mirror::check_folder`]), marked as this device's and stored, after
/// `read_back`, so the first tick already follows it, and the next tick
/// writes every page. Off, the setting goes and the files and the marker
/// stay. The folder chosen again while it holds nothing but its marker
/// starts fresh ([`MirrorState::start_fresh`]), and so does one chosen again
/// while the vault is older than it ([`MirrorState::is_behind`]), which
/// turns reading back off when it holds any file, each then no page's. Either way a pause a restore left
/// ([`mirror::store::RESTORED_KEY`]) ends.
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
    }
    let stored = mirror::store::folder(pool).await?;
    let chosen_again = path.is_some() && stored == path;
    // The way out of the pause on an emptied folder, or on one the vault is
    // older than: the user says this is the folder, so every page is written
    // there, with no state, which leaves every file the vault lacks no page's.
    let fresh = chosen_again
        && path
            .as_deref()
            .map(Path::new)
            .is_some_and(|folder| mirror::is_emptied(folder) || mirror.is_behind());
    if let (Some(folder), false) = (path.as_deref(), chosen_again && !fresh) {
        // `read_back` is taken only when the mirror turns on: while it is
        // on, reading back is turned on by `set_mirror_read_back` alone,
        // which asks first. A folder changed while the mirror was not
        // there, one starting fresh that holds files, or one whose changes
        // cannot be told, is mirrored with reading back off, so the user is
        // shown those files and asked before any is read in.
        let asked = match stored {
            Some(_) => mirror::store::settings(pool).await?.read_back,
            None => read_back,
        };
        let read_back = asked
            && pending(pool, device_id, mirror, Path::new(folder), fresh)
                .await
                .is_ok_and(|changed| changed.is_empty());
        mirror::store::set_read_back(pool, read_back).await?;
    }
    mirror::store::set_folder(pool, path.as_deref()).await?;
    mirror::store::clear_restored(pool).await?;
    if fresh {
        mirror.start_fresh();
    } else {
        mirror.restart();
    }
    get_mirror_status_inner(pool, device_id, mirror).await
}

/// Read files changed outside Agaric back into it, or with `on: false` stop.
/// Turning it on is refused while any file changed meanwhile
/// ([`MirrorStatus::pending`], derived again here) is not among `confirmed`,
/// the files the user was shown and chose to read in: a file that changed
/// after the list was shown is never read in unseen. A plain turn-on
/// confirms none. It is also how the user answers a mirror that stopped
/// reading back because many files changed at once
/// ([`MirrorState::hold_mass_change`]): the files confirmed are then read in.
///
/// # Errors
///
/// [`AppError::Validation`] when a pending file is not confirmed, or when
/// which files changed cannot be told.
pub async fn set_mirror_read_back_inner(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    on: bool,
    confirmed: &[String],
) -> Result<MirrorStatus, AppError> {
    if on {
        let changed = match mirror::store::folder(pool).await? {
            Some(folder) => pending(pool, device_id, mirror, Path::new(&folder), false).await?,
            None => Vec::new(),
        };
        let unseen = changed
            .iter()
            .filter(|path| !confirmed.contains(path))
            .count();
        if unseen > 0 {
            return Err(AppError::validation(format!(
                "{unseen} files changed outside Agaric while reading back was off \
                 and have not been shown; choose to read them in to turn it on"
            )));
        }
    }
    mirror::store::set_read_back(pool, on).await?;
    mirror.confirm_read_back(confirmed);
    get_mirror_status_inner(pool, device_id, mirror).await
}

/// Copy the attachments pages link into the mirror's folder, or with
/// `on: false` stop ([`mirror::assets`]). The next tick runs a full pass that
/// writes or removes the copies and rewrites the links.
///
/// # Errors
///
/// The setting cannot be stored.
pub async fn set_mirror_copy_files_inner(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    on: bool,
) -> Result<MirrorStatus, AppError> {
    mirror::store::set_copy_files(pool, on).await?;
    get_mirror_status_inner(pool, device_id, mirror).await
}

/// Ask before reading in many files changed outside Agaric at once, or with
/// `on: false` read them in unasked, as a workflow that renames notes many
/// files link to wants ([`MirrorState::hold_mass_change`]). Off, a hold
/// already shown ends at once.
///
/// # Errors
///
/// The setting cannot be stored.
pub async fn set_mirror_ask_mass_change_inner(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    on: bool,
) -> Result<MirrorStatus, AppError> {
    mirror::store::set_ask_mass_change(pool, on).await?;
    if !on {
        mirror.confirm_read_back(&[]);
    }
    get_mirror_status_inner(pool, device_id, mirror).await
}

/// Mirror `space_id`, or with `mirrored: false` stop: the space's pages are
/// no longer written, its unchanged files are removed and its changed files
/// stay, listed, and nothing in its folder is read. Every space is mirrored
/// until it is turned off here, a new one included.
///
/// # Errors
///
/// [`AppError::Validation`] when `space_id` names no space; the settings
/// cannot be read or written.
pub async fn set_mirror_space_inner(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    space_id: &str,
    mirrored: bool,
) -> Result<MirrorStatus, AppError> {
    let space_id = space_id.to_ascii_uppercase();
    let known = super::spaces::list_spaces_inner(pool)
        .await?
        .into_iter()
        .any(|space| space.id == space_id);
    if !known {
        return Err(AppError::validation(format!("no space {space_id}")));
    }
    let mut unmirrored = mirror::store::settings(pool).await?.unmirrored;
    unmirrored.retain(|id| *id != space_id);
    if !mirrored {
        unmirrored.push(space_id);
    }
    mirror::store::set_unmirrored(pool, &unmirrored).await?;
    mirror.restart();
    get_mirror_status_inner(pool, device_id, mirror).await
}

/// [`mirror::read_back::pending`] for the folder at `root`, with this vault's
/// space folders, and none of its states when they go with a `fresh` start,
/// asked for or due ([`MirrorState::start_fresh`]): every file there is then
/// no page's.
async fn pending(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    root: &Path,
    fresh: bool,
) -> Result<Vec<String>, AppError> {
    let spaces: Vec<(String, String)> = super::spaces::list_spaces_inner(pool)
        .await?
        .into_iter()
        .map(|space| (space.id, space.name))
        .collect();
    let unmirrored = mirror::store::settings(pool).await?.unmirrored;
    let folders: HashSet<String> = mirror::paths::space_folders(&spaces)
        .into_iter()
        .filter(|(space, _)| !unmirrored.contains(space))
        .map(|(_, folder)| folder)
        .collect();
    let mut states = mirror::store::StateDir::new(mirror.app_data_dir());
    if !fresh && !mirror.start_fresh_due() {
        states
            .bind(&root.to_string_lossy())
            .map_err(|e| AppError::validation(format!("cannot tell which files changed: {e}")))?;
    }
    mirror::read_back::pending(root, device_id, &states, &folders)
}

/// The mirror's settings and what it is doing. While reading back is off or
/// waits for the user ([`MirrorState::hold_mass_change`]), the files turning
/// it on would read in, none when they cannot be told:
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
        Some(folder) if !settings.read_back || mirror.read_back_held() => {
            pending(pool, device_id, mirror, Path::new(folder), false)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!(error = %e, "cannot list the mirror's pending files");
                    Vec::new()
                })
        }
        _ => Vec::new(),
    };
    Ok(mirror.status(settings, changed))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn pick_mirror_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, AppError> {
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
    confirmed: Vec<String>,
) -> Result<MirrorStatus, AppError> {
    set_mirror_read_back_inner(&pool.0, device_id.as_str(), &mirror, on, &confirmed)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn set_mirror_copy_files(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    mirror: State<'_, MirrorState>,
    on: bool,
) -> Result<MirrorStatus, AppError> {
    set_mirror_copy_files_inner(&pool.0, device_id.as_str(), &mirror, on)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn set_mirror_ask_mass_change(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    mirror: State<'_, MirrorState>,
    on: bool,
) -> Result<MirrorStatus, AppError> {
    set_mirror_ask_mass_change_inner(&pool.0, device_id.as_str(), &mirror, on)
        .await
        .map_err(sanitize_internal_error)
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn set_mirror_space(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    mirror: State<'_, MirrorState>,
    space_id: String,
    mirrored: bool,
) -> Result<MirrorStatus, AppError> {
    set_mirror_space_inner(&pool.0, device_id.as_str(), &mirror, &space_id, mirrored)
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
