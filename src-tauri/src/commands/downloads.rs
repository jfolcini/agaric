//! Saving a file the frontend built (an export ZIP, a page's Markdown, an
//! attachment) into the user's Downloads folder.
//!
//! The webview's own download does this everywhere except macOS and Android.
//! WKWebView cancels a download navigation unless the app registered a download
//! handler, and this app registers none (#6652). Whether this command saves on
//! a real Mac is not something CI can show; the check is on #6514. The Android
//! WebView handles no `blob:` download either, and there the folder is reached
//! through `MediaStore` ([`super::file_save`], #6546; the check is on #6513).
//!
//! Not tested: the removal of a partly written file. No write here can be
//! made to fail after its create succeeded.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};

use agaric_core::base64_bytes::Base64Bytes;
use agaric_core::error::AppError;
use tauri::Manager as _;

use super::file_save::{FileSaveState, save_through};
use super::sanitize_internal_error;

/// Write `bytes` to a new file in `dir` named `file_name`, or `name (1).ext`,
/// `name (2).ext`, … when that name is taken: an existing file is never
/// overwritten. Returns the path written. A failed write removes its partial
/// file.
///
/// # Errors
///
/// [`AppError::Validation`] when `file_name` is not a bare file name;
/// [`AppError::Io`] when the file cannot be created or written.
pub fn save_to_downloads_inner(
    dir: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, AppError> {
    require_bare_file_name(file_name)?;
    let (stem, extension) = match file_name.rfind('.') {
        Some(dot) if dot > 0 => file_name.split_at(dot),
        _ => (file_name, ""),
    };
    let mut attempt = 0_u32;
    let (path, mut file) = loop {
        let candidate = if attempt == 0 {
            dir.join(file_name)
        } else {
            dir.join(format!("{stem} ({attempt}){extension}"))
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => attempt += 1,
            Err(e) => return Err(AppError::Io(e)),
        }
    };
    if let Err(e) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        if let Err(cleanup) = fs::remove_file(&path) {
            tracing::warn!(error = %cleanup, "could not remove a partly written download");
        }
        return Err(AppError::Io(e));
    }
    Ok(path)
}

/// Refuses a `file_name` that is empty or more than one path component.
pub(crate) fn require_bare_file_name(file_name: &str) -> Result<(), AppError> {
    let mut components = Path::new(file_name).components();
    let bare = matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(name)), None) if name == file_name
    );
    if bare {
        Ok(())
    } else {
        Err(AppError::validation(format!(
            "not a file name: {file_name:?}"
        )))
    }
}

/// Tauri command: save `bytes` as `file_name` in the user's Downloads folder,
/// and return the name the file has there, which differs when `file_name` was
/// taken. Delegates to [`save_to_downloads_inner`], or on Android, where the
/// folder is reached only through `MediaStore`, to
/// [`save_through`] (#6546).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn save_to_downloads<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    android: tauri::State<'_, FileSaveState>,
    file_name: String,
    bytes: Base64Bytes,
) -> Result<String, AppError> {
    let saved = async {
        let path_error = |e: tauri::Error| AppError::Io(std::io::Error::other(e.to_string()));
        if let Some(saver) = android.saver() {
            let staging_dir = app.path().app_cache_dir().map_err(path_error)?;
            return save_through(saver, &staging_dir, &file_name, &bytes).await;
        }
        let dir = app.path().download_dir().map_err(path_error)?;
        let path = tokio::task::spawn_blocking(move || {
            save_to_downloads_inner(&dir, &file_name, &bytes.0)
        })
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
        Ok(path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned())
    };
    saved.await.map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn writes_the_bytes_under_the_name_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let path = save_to_downloads_inner(dir.path(), "Notes.md", b"# Notes\n").unwrap();
        assert_eq!(path, dir.path().join("Notes.md"));
        assert_eq!(fs::read(&path).unwrap(), b"# Notes\n");
    }

    #[test]
    fn a_taken_name_gets_a_number_and_the_existing_file_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("export.tar.zip"), b"first").unwrap();
        fs::write(dir.path().join("export.tar (1).zip"), b"second").unwrap();

        let path = save_to_downloads_inner(dir.path(), "export.tar.zip", b"third").unwrap();

        assert_eq!(path, dir.path().join("export.tar (2).zip"));
        assert_eq!(fs::read(&path).unwrap(), b"third");
        assert_eq!(
            fs::read(dir.path().join("export.tar.zip")).unwrap(),
            b"first"
        );
        assert_eq!(
            names(dir.path()),
            ["export.tar (1).zip", "export.tar (2).zip", "export.tar.zip"]
        );
    }

    #[test]
    fn a_name_without_an_extension_or_with_only_a_leading_dot_is_numbered_at_its_end() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["README", ".profile"] {
            fs::write(dir.path().join(name), b"taken").unwrap();
            save_to_downloads_inner(dir.path(), name, b"new").unwrap();
        }
        assert_eq!(
            names(dir.path()),
            [".profile", ".profile (1)", "README", "README (1)"]
        );
    }

    #[test]
    fn a_name_that_is_a_path_is_refused_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join("inside");
        fs::create_dir(&inside).unwrap();
        for name in ["", ".", "..", "../escaped.md", "sub/file.md", "/abs.md"] {
            let err = save_to_downloads_inner(&inside, name, b"x").unwrap_err();
            assert!(
                matches!(err, AppError::Validation { .. }),
                "{name:?} gave {err:?}"
            );
        }
        assert_eq!(names(dir.path()), ["inside"]);
        assert_eq!(names(&inside), Vec::<String>::new());
    }

    #[test]
    fn a_folder_that_is_missing_is_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = save_to_downloads_inner(&dir.path().join("gone"), "a.md", b"x").unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "{err:?}");
    }
}
