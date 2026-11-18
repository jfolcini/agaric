//! The commands behind the Settings › Data snapshot row (#6554): when the
//! last daily snapshot was taken, opening the folder that holds it, and
//! restoring one at the next launch (#6744). Opening the folder has no test:
//! it starts the system's file manager.

use std::path::Path;

use super::sanitize_internal_error;
use crate::db::daily_snapshot::DailySnapshot;
use crate::db::{VAULT_DB_FILE, daily_snapshot, snapshot_restore};
use agaric_core::error::AppError;

/// The daily snapshots a restore can take, newest first.
///
/// # Errors
///
/// The vault's folder or a snapshot's metadata could not be read.
pub fn list_daily_snapshots_inner(app_data_dir: &Path) -> Result<Vec<DailySnapshot>, AppError> {
    daily_snapshot::list_daily_snapshots(&app_data_dir.join(VAULT_DB_FILE))
}

/// Replace the vault with the snapshot taken on `day` (`YYYY-MM-DD`) when
/// the app next starts ([`snapshot_restore`]).
///
/// # Errors
///
/// [`AppError::Validation`] when `day` is not a date; [`AppError::NotFound`]
/// when that day has no snapshot.
pub fn request_snapshot_restore_inner(app_data_dir: &Path, day: &str) -> Result<(), AppError> {
    let day = day
        .parse()
        .map_err(|_| AppError::validation(format!("{day:?} is not a snapshot's day")))?;
    snapshot_restore::request_restore(&app_data_dir.join(VAULT_DB_FILE), day)
}

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
pub fn get_last_snapshot_ms<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<i64>, AppError> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    daily_snapshot::last_daily_snapshot_ms(&app_data_dir.join(VAULT_DB_FILE))
        .map_err(sanitize_internal_error)
}

/// Tauri command: open the vault's folder in the system's file manager.
/// Delegates to [`open_data_folder_inner`].
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub fn open_data_folder<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), AppError> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    open_data_folder_inner(&app_data_dir).map_err(sanitize_internal_error)
}

/// Tauri command: the daily snapshots, newest first. Delegates to
/// [`list_daily_snapshots_inner`].
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub fn list_daily_snapshots<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<DailySnapshot>, AppError> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    list_daily_snapshots_inner(&app_data_dir).map_err(sanitize_internal_error)
}

/// Tauri command: restore the snapshot taken on `day` at the next launch.
/// Delegates to [`request_snapshot_restore_inner`].
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub fn request_snapshot_restore<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    day: String,
) -> Result<(), AppError> {
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    request_snapshot_restore_inner(&app_data_dir, &day).map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    /// An app data folder whose vault has snapshots for 1 and 2 March 2026.
    async fn data_dir_with_two_snapshots() -> TempDir {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join(VAULT_DB_FILE);
        init_pool(&db_path).await.unwrap().close().await;
        for day in ["2026-03-01", "2026-03-02"] {
            let taken = daily_snapshot::take_daily_snapshot(&db_path, day.parse().unwrap()).await;
            assert!(taken.unwrap(), "{day}");
        }
        dir
    }

    fn set_written(file: &Path, ms: u64) {
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms);
        let file = std::fs::File::options().write(true).open(file).unwrap();
        file.set_modified(at).unwrap();
    }

    #[tokio::test]
    async fn the_snapshots_are_listed_newest_day_first_with_when_each_was_written() {
        let dir = data_dir_with_two_snapshots().await;
        set_written(&dir.path().join("notes.db.daily-2026-03-01"), 9_000);
        set_written(&dir.path().join("notes.db.daily-2026-03-02"), 5_000);

        let listed = list_daily_snapshots_inner(dir.path()).unwrap();

        let snapshot = |day: &str, taken_ms| DailySnapshot {
            day: day.to_owned(),
            taken_ms,
        };
        assert_eq!(
            listed,
            [snapshot("2026-03-02", 5_000), snapshot("2026-03-01", 9_000)]
        );
    }

    #[tokio::test]
    async fn a_restore_request_names_the_snapshot_for_the_next_launch() {
        let dir = data_dir_with_two_snapshots().await;
        request_snapshot_restore_inner(dir.path(), "2026-03-01").unwrap();
        let marker = std::fs::read_to_string(dir.path().join("notes.db.restore-pending")).unwrap();
        assert!(marker.starts_with("2026-03-01 "), "{marker:?}");
    }

    #[tokio::test]
    async fn a_restore_request_is_refused_for_what_is_no_day_or_has_no_snapshot() {
        let dir = data_dir_with_two_snapshots().await;

        let not_a_day = request_snapshot_restore_inner(dir.path(), "../notes.db");
        assert!(
            matches!(not_a_day, Err(AppError::Validation { .. })),
            "{not_a_day:?}"
        );
        let no_snapshot = request_snapshot_restore_inner(dir.path(), "2026-03-03");
        assert!(
            matches!(no_snapshot, Err(AppError::NotFound(_))),
            "{no_snapshot:?}"
        );
        assert!(!dir.path().join("notes.db.restore-pending").exists());
    }
}
