//! Android's half of `save_to_downloads` (#6546): the shared Downloads
//! collection, reached through `MediaStore`.
//!
//! The Android WebView handles no `blob:` download, and an app cannot write
//! into the shared Downloads folder by path as [`super::downloads`] does on
//! macOS. So on Android the command stages the bytes in the app's cache
//! directory and has `FileSavePlugin.kt` copy the staged file into
//! `MediaStore.Downloads`, which needs no permission from Android 10 on and is
//! what the Files app shows.
//!
//! The bytes are staged in a file because a mobile plugin's arguments are one
//! JSON string: an export sent that way would be held three times over in the
//! JVM.
//!
//! Tests run on the host against a [`FileSaver`] fake. The Kotlin plugin has no
//! test harness in this repo: CI's `android-build` compiles it, and what it
//! writes is checked on a phone (#6513).

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use tauri::{Manager, Runtime};

use agaric_core::error::AppError;

/// Why the OS did not take the file: its own message, kept for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveError(pub String);

pub type SaverFuture<'a> = Pin<Box<dyn Future<Output = Result<String, SaveError>> + Send + 'a>>;

/// The OS's shared Downloads collection, behind a trait so the save is tested
/// against a fake.
pub trait FileSaver: Send + Sync {
    /// Copies the file at `staged` into Downloads as `file_name` and returns
    /// the name it has there: the OS renames a file whose name is taken.
    fn save<'a>(&'a self, staged: &'a Path, file_name: &'a str) -> SaverFuture<'a>;
}

/// What saves files through the OS in this process; `None` on every build but
/// Android, and on Android when the plugin failed to load.
pub struct FileSaveState {
    saver: Option<Arc<dyn FileSaver>>,
}

impl FileSaveState {
    pub fn saver(&self) -> Option<&dyn FileSaver> {
        self.saver.as_deref()
    }
}

/// Registers the saver and manages [`FileSaveState`] on every build, so
/// `save_to_downloads` always finds its state. A plugin that fails to load is
/// logged and leaves the saver unset; it never fails app start.
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

/// Stages `bytes` under `staging_dir`, has `saver` copy them into Downloads as
/// `file_name`, and returns the name the file has there. The staged copy is
/// removed whether or not the save worked.
///
/// # Errors
///
/// [`AppError::Validation`] when `file_name` is not a bare file name;
/// [`AppError::Io`] when the bytes cannot be staged or the OS refuses the file.
pub async fn save_through(
    saver: &dyn FileSaver,
    staging_dir: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<String, AppError> {
    super::downloads::require_bare_file_name(file_name)?;
    tokio::fs::create_dir_all(staging_dir).await?;
    let staged = staging_dir.join(format!("save-{}", ulid::Ulid::generate()));
    let saved = match tokio::fs::write(&staged, bytes).await {
        Ok(()) => saver
            .save(&staged, file_name)
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
        fn save<'a>(&'a self, staged: &'a Path, file_name: &'a str) -> SaverFuture<'a> {
            Box::pin(async move {
                let path = staged.to_string_lossy();
                self.0
                    .run_mobile_plugin_async::<SaveReply>(
                        "saveToDownloads",
                        SaveArgs {
                            path: &path,
                            file_name,
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
        bytes: Vec<u8>,
    }

    #[derive(Default)]
    struct FakeSaver {
        /// `None` saves under the name it was given.
        result: Option<Result<String, SaveError>>,
        saved: Mutex<Vec<Saved>>,
    }

    impl FileSaver for FakeSaver {
        fn save<'a>(&'a self, staged: &'a Path, file_name: &'a str) -> SaverFuture<'a> {
            self.saved.lock().unwrap().push(Saved {
                staged: staged.to_owned(),
                file_name: file_name.to_owned(),
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

        let name = save_through(&saver, dir.path(), "export.zip", b"PK\x03\x04")
            .await
            .unwrap();

        assert_eq!(name, "export (1).zip");
        let saved = saver.saved.lock().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].staged.parent(), Some(dir.path()));
        assert_eq!(saved[0].file_name, "export.zip");
        assert_eq!(saved[0].bytes, b"PK\x03\x04");
    }

    #[tokio::test]
    async fn leaves_no_staged_file_after_a_save() {
        let dir = tempfile::tempdir().unwrap();
        save_through(&FakeSaver::default(), dir.path(), "a.md", b"hi")
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

        let err = save_through(&saver, dir.path(), "a.zip", b"x")
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
        save_through(&FakeSaver::default(), &staging, "a.md", b"hi")
            .await
            .unwrap();
        assert_eq!(staged_files(&staging), 0);
    }

    #[tokio::test]
    async fn refuses_a_name_that_is_a_path_before_staging_anything() {
        let dir = tempfile::tempdir().unwrap();
        let saver = FakeSaver::default();

        for name in ["", "..", "../escaped.md", "sub/file.md"] {
            let err = save_through(&saver, dir.path(), name, b"x")
                .await
                .unwrap_err();
            assert!(
                matches!(err, AppError::Validation { .. }),
                "{name:?} gave {err:?}"
            );
        }

        assert_eq!(saver.saved.lock().unwrap().len(), 0);
        assert_eq!(staged_files(dir.path()), 0);
    }

    #[test]
    fn the_plugin_arguments_and_reply_use_the_keys_the_kotlin_side_reads() {
        let args = serde_json::to_value(SaveArgs {
            path: "/cache/save-1",
            file_name: "a.zip",
        })
        .unwrap();
        assert_eq!(
            args,
            serde_json::json!({ "path": "/cache/save-1", "fileName": "a.zip" })
        );
        let reply: SaveReply = serde_json::from_str(r#"{"fileName":"a (1).zip"}"#).unwrap();
        assert_eq!(reply.file_name, "a (1).zip");
    }
}
