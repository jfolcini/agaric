//! Android's check for a newer release (#6546).
//!
//! Android has no Tauri updater: a newer APK is installed by hand from the
//! releases page. So that a phone learns one exists before sync stops against
//! an updated desktop, [`check_latest_release`] reads the `version` of the
//! `latest.json` the desktop updater fetches and says whether it is newer than
//! this build. Nothing is downloaded or installed, and the frontend asks at
//! most once a day (`src/hooks/useUpdateCheck.ts`).
//!
//! The request is made by `ReleaseCheckPlugin.kt`, with the platform's own
//! HTTPS client. The webview cannot make it (the CSP in `tauri.conf.json`),
//! and `reqwest`'s certificate verifier on Android calls into a JVM handle
//! this app never gives it.
//!
//! Tests run on the host against a [`ManifestFetcher`] fake. The Kotlin plugin
//! has no test harness in this repo: CI's `android-build` compiles it, and the
//! request itself is checked on a phone (#6513).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Deserialize;
use tauri::{Manager, Runtime, State};

use agaric_core::error::AppError;

use super::sanitize_internal_error;

/// The manifest of the newest release: the desktop updater's endpoint
/// (`plugins.updater.endpoints` in `tauri.conf.json`).
pub const LATEST_RELEASE_MANIFEST_URL: &str =
    "https://github.com/jfolcini/agaric/releases/latest/download/latest.json";

/// Why the manifest could not be fetched: the platform's own message, kept for
/// the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError(pub String);

pub type FetchFuture<'a> = Pin<Box<dyn Future<Output = Result<String, FetchError>> + Send + 'a>>;

/// The platform's HTTPS client, behind a trait so the command is tested
/// against a fake.
pub trait ManifestFetcher: Send + Sync {
    /// The body of a successful GET of `url`.
    fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a>;
}

/// What fetches the manifest in this process; `None` on every build but
/// Android, and on Android when the plugin failed to load.
pub struct ReleaseCheckState {
    fetcher: Option<Arc<dyn ManifestFetcher>>,
}

/// Registers the fetcher and manages [`ReleaseCheckState`] on every build, so
/// the command always finds its state. A plugin that fails to load is logged
/// and leaves the fetcher unset; it never fails app start.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("release-check")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let fetcher = android::register(&api);
            #[cfg(not(target_os = "android"))]
            let fetcher = {
                let _ = api;
                None
            };
            app.manage(ReleaseCheckState { fetcher });
            Ok(())
        })
        .build()
}

/// The version of the newest release when it is newer than this build, else
/// `None`. Android only: every other build refuses, and updates through the
/// Tauri updater.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn check_latest_release<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, ReleaseCheckState>,
) -> Result<Option<String>, AppError> {
    let running = app.package_info().version.to_string();
    check_latest_release_inner(state.fetcher.as_deref(), &running)
        .await
        .map_err(sanitize_internal_error)
}

pub async fn check_latest_release_inner(
    fetcher: Option<&dyn ManifestFetcher>,
    running: &str,
) -> Result<Option<String>, AppError> {
    let fetcher = fetcher.ok_or_else(|| {
        AppError::InvalidOperation("the release check is available on Android only".into())
    })?;
    let manifest = fetcher
        .fetch(LATEST_RELEASE_MANIFEST_URL)
        .await
        .map_err(|err| AppError::Io(std::io::Error::other(err.0)))?;
    newer_release(running, &manifest)
}

/// The `version` a release manifest names, when it is newer than `running`.
pub fn newer_release(running: &str, manifest: &str) -> Result<Option<String>, AppError> {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }
    let Manifest { version } = serde_json::from_str(manifest)?;
    let latest = release_number(&version)?;
    Ok((latest > release_number(running)?).then(|| version.trim_start_matches('v').to_owned()))
}

/// `major.minor.patch` as numbers, so `0.10.0` is newer than `0.9.0`. A leading
/// `v` is dropped, and so is a pre-release or build suffix: a pre-release
/// compares as the release it precedes.
fn release_number(version: &str) -> Result<(u64, u64, u64), AppError> {
    let core = version.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next().unwrap_or(core);
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(Some(major)), Some(Some(minor)), Some(Some(patch)), None) => {
            Ok((major, minor, patch))
        }
        _ => Err(AppError::validation(format!(
            "{version:?} is not a major.minor.patch version"
        ))),
    }
}

/// What `ReleaseCheckPlugin.kt` reads from `fetchText`.
#[cfg(any(test, target_os = "android"))]
#[derive(Debug, serde::Serialize)]
struct FetchArgs<'a> {
    url: &'a str,
}

/// What `ReleaseCheckPlugin.kt` resolves `fetchText` with.
#[cfg(any(test, target_os = "android"))]
#[derive(Debug, Deserialize)]
struct FetchReply {
    body: String,
}

#[cfg(target_os = "android")]
mod android {
    use std::sync::Arc;

    use tauri::Runtime;
    use tauri::plugin::{PluginApi, PluginHandle};

    use super::{FetchArgs, FetchError, FetchFuture, FetchReply, ManifestFetcher};

    struct AndroidFetcher<R: Runtime>(PluginHandle<R>);

    /// Loads `com.agaric.app.ReleaseCheckPlugin`. Its constructor does nothing,
    /// so the only failure is a missing class; that is logged, and the check
    /// then fails quietly.
    pub(super) fn register<R: Runtime, C: serde::de::DeserializeOwned>(
        api: &PluginApi<R, C>,
    ) -> Option<Arc<dyn ManifestFetcher>> {
        match api.register_android_plugin("com.agaric.app", "ReleaseCheckPlugin") {
            Ok(handle) => Some(Arc::new(AndroidFetcher(handle))),
            Err(err) => {
                tracing::error!(error = %err, "the release-check plugin did not load; no update notice");
                None
            }
        }
    }

    impl<R: Runtime> ManifestFetcher for AndroidFetcher<R> {
        fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a> {
            Box::pin(async move {
                self.0
                    .run_mobile_plugin_async::<FetchReply>("fetchText", FetchArgs { url })
                    .await
                    .map(|reply| reply.body)
                    .map_err(|err| FetchError(err.to_string()))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// Answers as told and records the URLs it was asked for.
    struct FakeFetcher {
        result: Result<String, FetchError>,
        asked: Mutex<Vec<String>>,
    }

    impl FakeFetcher {
        fn answering(result: Result<&str, &str>) -> Self {
            Self {
                result: result.map(str::to_owned).map_err(|e| FetchError(e.into())),
                asked: Mutex::new(Vec::new()),
            }
        }
    }

    impl ManifestFetcher for FakeFetcher {
        fn fetch<'a>(&'a self, url: &'a str) -> FetchFuture<'a> {
            self.asked.lock().unwrap().push(url.to_owned());
            let result = self.result.clone();
            Box::pin(async move { result })
        }
    }

    fn manifest(version: &str) -> String {
        format!(r#"{{"version":"{version}","notes":"","platforms":{{}}}}"#)
    }

    #[test]
    fn a_newer_release_is_named_by_its_version() {
        assert_eq!(
            newer_release("0.23.0", &manifest("0.24.0")).unwrap(),
            Some("0.24.0".to_owned())
        );
        assert_eq!(
            newer_release("0.23.0", &manifest("0.23.1")).unwrap(),
            Some("0.23.1".to_owned())
        );
        assert_eq!(
            newer_release("0.23.9", &manifest("1.0.0")).unwrap(),
            Some("1.0.0".to_owned())
        );
    }

    #[test]
    fn the_running_release_and_an_older_one_are_not_newer() {
        assert_eq!(newer_release("0.23.0", &manifest("0.23.0")).unwrap(), None);
        assert_eq!(newer_release("0.24.0", &manifest("0.23.9")).unwrap(), None);
        assert_eq!(newer_release("1.0.0", &manifest("0.99.99")).unwrap(), None);
    }

    #[test]
    fn versions_compare_as_numbers_not_as_text() {
        assert_eq!(
            newer_release("0.9.0", &manifest("0.10.0")).unwrap(),
            Some("0.10.0".to_owned())
        );
        assert_eq!(newer_release("0.10.0", &manifest("0.9.0")).unwrap(), None);
    }

    #[test]
    fn a_leading_v_and_a_pre_release_suffix_are_read_past() {
        assert_eq!(
            newer_release("v0.23.0", &manifest("v0.24.0")).unwrap(),
            Some("0.24.0".to_owned())
        );
        assert_eq!(
            newer_release("0.24.0-beta.1", &manifest("0.24.0")).unwrap(),
            None
        );
        assert_eq!(
            newer_release("0.23.0", &manifest("0.24.0-rc.1+build.5")).unwrap(),
            Some("0.24.0-rc.1+build.5".to_owned())
        );
    }

    #[test]
    fn a_manifest_that_names_no_usable_version_is_an_error() {
        for body in [
            "<html>not found</html>",
            r#"{"notes":"no version"}"#,
            &manifest("latest"),
            &manifest("1.2"),
            &manifest("1.2.3.4"),
            &manifest("1.x.3"),
        ] {
            assert!(newer_release("0.23.0", body).is_err(), "{body}");
        }
    }

    #[tokio::test]
    async fn asks_the_updater_endpoint_and_reports_the_newer_release() {
        let fetcher = FakeFetcher::answering(Ok(&manifest("0.24.0")));

        let newer = check_latest_release_inner(Some(&fetcher), "0.23.0")
            .await
            .unwrap();

        assert_eq!(newer, Some("0.24.0".to_owned()));
        assert_eq!(
            *fetcher.asked.lock().unwrap(),
            vec![LATEST_RELEASE_MANIFEST_URL.to_owned()]
        );
    }

    #[tokio::test]
    async fn a_request_that_fails_is_an_error() {
        let fetcher = FakeFetcher::answering(Err("HTTP 503"));
        let err = check_latest_release_inner(Some(&fetcher), "0.23.0")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Io(_)), "{err:?}");
        assert!(err.to_string().contains("HTTP 503"), "{err}");
    }

    #[tokio::test]
    async fn refuses_where_there_is_no_fetcher() {
        let err = check_latest_release_inner(None, "0.23.0")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidOperation(_)), "{err:?}");
    }

    #[test]
    fn the_manifest_is_the_one_the_desktop_updater_fetches() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["plugins"]["updater"]["endpoints"],
            serde_json::json!([LATEST_RELEASE_MANIFEST_URL])
        );
    }

    #[test]
    fn the_plugin_arguments_and_reply_use_the_keys_the_kotlin_side_reads() {
        let args = serde_json::to_value(FetchArgs { url: "https://x" }).unwrap();
        assert_eq!(args, serde_json::json!({ "url": "https://x" }));
        let reply: FetchReply = serde_json::from_str(r#"{"body":"{}"}"#).unwrap();
        assert_eq!(reply.body, "{}");
    }
}
