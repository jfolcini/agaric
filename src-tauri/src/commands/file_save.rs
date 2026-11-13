//! Android's one way to save a file where the user can reach it (#6546).
//!
//! The Android WebView handles no `blob:` download, so every export, the
//! bug-report ZIP, *Save as Markdown file* and a tapped attachment hand their
//! bytes to [`save_file_to_downloads`] instead. It stages them in the app's
//! cache directory and has `FileSavePlugin.kt` copy the staged file into the
//! shared Downloads collection (`MediaStore.Downloads`), which needs no
//! permission from Android 10 on and is what the Files app shows.
//!
//! The bytes are staged in a file because a mobile plugin's arguments are one
//! JSON string: an export sent that way would be held three times over in the
//! JVM. Desktop saves through the webview's own download and never calls this.
//!
//! Tests run on the host against a [`FileSaver`] fake. The Kotlin plugin has no
//! test harness in this repo: CI's `android-build` compiles it, and what it
//! writes is checked on a phone (#6513).

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use tauri::{Manager, Runtime, State};

use agaric_core::base64_bytes::Base64Bytes;
use agaric_core::error::AppError;

use super::sanitize_internal_error;

/// Why the OS did not take the file: its own message, kept for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveError(pub String);

pub type SaverFuture<'a> = Pin<Box<dyn Future<Output = Result<String, SaveError>> + Send + 'a>>;

/// The OS's shared Downloads collection, behind a trait so the command is
/// tested against a fake.
pub trait FileSaver: Send + Sync {
    /// Copies the file at `staged` into Downloads as `file_name` and returns
    /// the name it has there: the OS renames a file whose name is taken.
    fn save<'a>(
        &'a self,
        staged: &'a Path,
        file_name: &'a str,
        mime_type: &'a str,
    ) -> SaverFuture<'a>;
}

/// What saves files in this process; `None` on every build but Android, and on
/// Android when the plugin failed to load.
pub struct FileSaveState {
    saver: Option<Arc<dyn FileSaver>>,
}

/// Registers the saver and manages [`FileSaveState`] on every build, so the
/// command always finds its state. A plugin that fails to load is logged and
/// leaves the saver unset; it never fails app start.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("file-save")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let saver = android::register(&api);
            #[cfg(not(target_os = "android"))]
            let saver = {
                let _ = api;
                None
            };
            app.manage(FileSaveState { saver });
            Ok(())
        })
        .build()
}

/// Saves `bytes` to the phone's Downloads folder as `file_name` and returns the
/// name the file has there. Android only: every other build refuses.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn save_file_to_downloads<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, FileSaveState>,
    file_name: String,
    mime_type: String,
    bytes: Base64Bytes,
) -> Result<String, AppError> {
    let staging_dir = app
        .path()
        .app_cache_dir()
        .map_err(|err| AppError::Io(std::io::Error::other(err.to_string())))?;
    save_file_to_downloads_inner(
        state.saver.as_deref(),
        &staging_dir,
        &file_name,
        &mime_type,
        &bytes,
    )
    .await
    .map_err(sanitize_internal_error)
}

pub async fn save_file_to_downloads_inner(
    saver: Option<&dyn FileSaver>,
    staging_dir: &Path,
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<String, AppError> {
    let saver = saver.ok_or_else(|| {
        AppError::InvalidOperation("saving to Downloads is available on Android only".into())
    })?;
    if file_name.trim().is_empty() {
        return Err(AppError::validation("a saved file needs a name".into()));
    }
    tokio::fs::create_dir_all(staging_dir).await?;
    let staged = staging_dir.join(format!("save-{}", ulid::Ulid::generate()));
    let saved = match tokio::fs::write(&staged, bytes).await {
        Ok(()) => saver
            .save(&staged, file_name, mime_type)
            .await
            .map_err(|err| AppError::Io(std::io::Error::other(err.0))),
        Err(err) => Err(err.into()),
    };
    // The staged copy is the app's own; the user's file is the one in Downloads.
    if let Err(err) = tokio::fs::remove_file(&staged).await {
        tracing::warn!(error = %err, "a staged file was left in the cache directory");
    }
    saved
}

/// What `FileSavePlugin.kt` reads from `saveToDownloads`.
#[cfg(any(test, target_os = "android"))]
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs<'a> {
    path: &'a str,
    file_name: &'a str,
    mime_type: &'a str,
}

/// What `FileSavePlugin.kt` resolves `saveToDownloads` with.
#[cfg(any(test, target_os = "android"))]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveReply {
    file_name: String,
}

#[cfg(target_os = "android")]
mod android {
    use std::path::Path;
    use std::sync::Arc;

    use tauri::Runtime;
    use tauri::plugin::{PluginApi, PluginHandle};

    use super::{FileSaver, SaveArgs, SaveError, SaveReply, SaverFuture};

    struct AndroidSaver<R: Runtime>(PluginHandle<R>);

    /// Loads `com.agaric.app.FileSavePlugin`. Its constructor does nothing, so
    /// the only failure is a missing class; that is logged, and every save
    /// then fails with an error toast.
    pub(super) fn register<R: Runtime, C: serde::de::DeserializeOwned>(
        api: &PluginApi<R, C>,
    ) -> Option<Arc<dyn FileSaver>> {
        match api.register_android_plugin("com.agaric.app", "FileSavePlugin") {
            Ok(handle) => Some(Arc::new(AndroidSaver(handle))),
            Err(err) => {
                tracing::error!(error = %err, "the file-save plugin did not load; nothing can be saved");
                None
            }
        }
    }

    impl<R: Runtime> FileSaver for AndroidSaver<R> {
        fn save<'a>(
            &'a self,
            staged: &'a Path,
            file_name: &'a str,
            mime_type: &'a str,
        ) -> SaverFuture<'a> {
            Box::pin(async move {
                let path = staged.to_string_lossy();
                self.0
                    .run_mobile_plugin_async::<SaveReply>(
                        "saveToDownloads",
                        SaveArgs {
                            path: &path,
                            file_name,
                            mime_type,
                        },
                    )
                    .await
                    .map(|reply| reply.file_name)
                    .map_err(|err| SaveError(err.to_string()))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use super::*;

    /// One call to the saver, with the staged file's bytes as they were when
    /// it ran.
    struct Saved {
        staged: PathBuf,
        file_name: String,
        mime_type: String,
        bytes: Vec<u8>,
    }

    #[derive(Default)]
    struct FakeSaver {
        /// `None` saves under the name it was given.
        result: Option<Result<String, SaveError>>,
        saved: Mutex<Vec<Saved>>,
    }

    impl FileSaver for FakeSaver {
        fn save<'a>(
            &'a self,
            staged: &'a Path,
            file_name: &'a str,
            mime_type: &'a str,
        ) -> SaverFuture<'a> {
            self.saved.lock().unwrap().push(Saved {
                staged: staged.to_owned(),
                file_name: file_name.to_owned(),
                mime_type: mime_type.to_owned(),
                bytes: std::fs::read(staged).unwrap(),
            });
            let result = self
                .result
                .clone()
                .unwrap_or_else(|| Ok(file_name.to_owned()));
            Box::pin(async move { result })
        }
    }

    fn staged_files(dir: &Path) -> usize {
        std::fs::read_dir(dir).unwrap().count()
    }

    #[tokio::test]
    async fn hands_the_saver_the_bytes_and_returns_the_name_the_os_gave() {
        let dir = tempfile::tempdir().unwrap();
        let saver = FakeSaver {
            result: Some(Ok("export (1).zip".into())),
            ..FakeSaver::default()
        };

        let name = save_file_to_downloads_inner(
            Some(&saver),
            dir.path(),
            "export.zip",
            "application/zip",
            b"PK\x03\x04",
        )
        .await
        .unwrap();

        assert_eq!(name, "export (1).zip");
        let saved = saver.saved.lock().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].staged.parent(), Some(dir.path()));
        assert_eq!(saved[0].file_name, "export.zip");
        assert_eq!(saved[0].mime_type, "application/zip");
        assert_eq!(saved[0].bytes, b"PK\x03\x04");
    }

    #[tokio::test]
    async fn leaves_no_staged_file_after_a_save() {
        let dir = tempfile::tempdir().unwrap();
        save_file_to_downloads_inner(
            Some(&FakeSaver::default()),
            dir.path(),
            "a.md",
            "text/markdown",
            b"hi",
        )
        .await
        .unwrap();
        assert_eq!(staged_files(dir.path()), 0);
    }

    #[tokio::test]
    async fn a_save_the_os_refuses_is_an_error_and_leaves_no_staged_file() {
        let dir = tempfile::tempdir().unwrap();
        let saver = FakeSaver {
            result: Some(Err(SaveError("no space left".into()))),
            ..FakeSaver::default()
        };

        let err = save_file_to_downloads_inner(Some(&saver), dir.path(), "a.zip", "", b"x")
            .await
            .unwrap_err();

        assert!(matches!(err, AppError::Io(_)), "{err:?}");
        assert!(err.to_string().contains("no space left"), "{err}");
        assert_eq!(staged_files(dir.path()), 0);
    }

    #[tokio::test]
    async fn creates_the_staging_directory() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("cache");
        save_file_to_downloads_inner(Some(&FakeSaver::default()), &staging, "a.md", "", b"hi")
            .await
            .unwrap();
        assert_eq!(staged_files(&staging), 0);
    }

    #[tokio::test]
    async fn refuses_a_blank_name_before_staging_anything() {
        let dir = tempfile::tempdir().unwrap();
        let saver = FakeSaver::default();

        let err = save_file_to_downloads_inner(Some(&saver), dir.path(), "  ", "text/plain", b"x")
            .await
            .unwrap_err();

        assert!(
            matches!(err, AppError::Validation { code: None, .. }),
            "{err:?}"
        );
        assert_eq!(saver.saved.lock().unwrap().len(), 0);
        assert_eq!(staged_files(dir.path()), 0);
    }

    #[tokio::test]
    async fn refuses_where_there_is_no_saver() {
        let dir = tempfile::tempdir().unwrap();
        let err = save_file_to_downloads_inner(None, dir.path(), "a.zip", "", b"x")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidOperation(_)), "{err:?}");
        assert_eq!(staged_files(dir.path()), 0);
    }

    #[test]
    fn the_plugin_arguments_and_reply_use_the_keys_the_kotlin_side_reads() {
        let args = serde_json::to_value(SaveArgs {
            path: "/cache/save-1",
            file_name: "a.zip",
            mime_type: "application/zip",
        })
        .unwrap();
        assert_eq!(
            args,
            serde_json::json!({
                "path": "/cache/save-1",
                "fileName": "a.zip",
                "mimeType": "application/zip",
            })
        );
        let reply: SaveReply = serde_json::from_str(r#"{"fileName":"a (1).zip"}"#).unwrap();
        assert_eq!(reply.file_name, "a (1).zip");
    }
}
