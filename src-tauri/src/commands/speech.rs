//! *Read aloud*'s backend (#5745): which engine this build speaks with, and on
//! Android the engine itself.
//!
//! - macOS and Windows speak through the webview's `speechSynthesis`, so the
//!   backend only reports `Webview` there and speaks nothing itself.
//! - Android speaks through `SpeechPlugin.kt`, a Tauri mobile plugin around
//!   `android.speech.tts.TextToSpeech`. *Read aloud* shows only once the engine
//!   says it can speak: a plugin that fails to load, an engine that fails to
//!   start or has no voice, and one that does not answer within
//!   [`AVAILABILITY_TIMEOUT`] all read as unavailable, and none of them touches
//!   app start, because the engine starts on the first availability check.
//! - Linux has no engine until the maintainer decides it.
//!
//! The kind of engine comes from `cfg`, never from sniffing the user agent.
//! Tests run only on Linux, against [`SpeechEngine`] fakes: the `Webview` arm is
//! checked on the macOS and Windows devices, and the Kotlin plugin, which has no
//! test harness in this repo, is compiled by CI's `android-build` and launched
//! by `android-launch-smoke.yml`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, Runtime, State};

use agaric_core::error::AppError;

/// The longest text one utterance may carry: Android's
/// `getMaxSpeechInputLength()`, in UTF-16 code units. The frontend splits
/// longer blocks under the same limit (`MAX_UTTERANCE_CHARS` in
/// `src/lib/speech/spoken-text.ts`).
pub const MAX_UTTERANCE_UNITS: usize = 4000;

/// How long the first availability check waits for the engine to start. A
/// `TextToSpeech` that never reports `onInit` would otherwise hold the check
/// open forever; *Read aloud* stays hidden instead.
pub const AVAILABILITY_TIMEOUT: Duration = Duration::from_secs(10);

/// Which engine speaks on this build, so the frontend can hide *Read aloud*
/// where there is none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum SpeechStatus {
    /// No engine: *Read aloud* is hidden.
    Unsupported,
    /// The frontend speaks through the webview's `speechSynthesis`.
    Webview,
    /// The backend speaks (Android): ask [`get_speech_engine_available`] before
    /// offering *Read aloud*, then speak with [`speak_text`].
    Native,
}

/// How an utterance ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SpeakOutcome {
    /// It was spoken to the end.
    Done,
    /// [`stop_speaking`], or a newer utterance, cut it off.
    Stopped,
}

/// Why the engine could not do what it was asked: its own message, kept for
/// the log and the error toast's details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError(pub String);

impl From<EngineError> for AppError {
    fn from(err: EngineError) -> Self {
        AppError::InvalidOperation(format!("the speech engine failed: {}", err.0))
    }
}

pub type EngineFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The OS text-to-speech engine, behind a trait so the commands are tested
/// against a fake.
pub trait SpeechEngine: Send + Sync {
    /// Whether it can speak now. Starts the engine on first use; never errors,
    /// because any failure means *Read aloud* stays hidden.
    fn available(&self) -> EngineFuture<'_, bool>;
    /// Speaks `text`, cutting off any utterance under way, and settles when it
    /// ends.
    fn speak<'a>(&'a self, text: &'a str) -> EngineFuture<'a, Result<SpeakOutcome, EngineError>>;
    /// Cuts off the utterance under way, if any.
    fn stop(&self) -> EngineFuture<'_, Result<(), EngineError>>;
}

/// The engine this process speaks with; `None` on every build but Android, and
/// on Android when the plugin failed to load.
pub struct SpeechState {
    engine: Option<Arc<dyn SpeechEngine>>,
}

impl SpeechState {
    pub fn new(engine: Option<Arc<dyn SpeechEngine>>) -> Self {
        Self { engine }
    }
}

/// Registers the engine and manages [`SpeechState`] on every build, so the
/// speech commands always find their state. A plugin that fails to load is
/// logged and leaves the engine unset; it never fails app start.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("speech")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let engine = android::register(&api);
            #[cfg(not(target_os = "android"))]
            let engine = {
                let _ = api;
                None
            };
            app.manage(SpeechState::new(engine));
            Ok(())
        })
        .build()
}

#[tauri::command]
#[specta::specta]
pub fn get_speech_status() -> Result<SpeechStatus, AppError> {
    Ok(if cfg!(any(target_os = "macos", target_os = "windows")) {
        SpeechStatus::Webview
    } else if cfg!(target_os = "android") {
        SpeechStatus::Native
    } else {
        SpeechStatus::Unsupported
    })
}

/// Whether the backend engine can speak now (see [`SpeechEngine::available`]).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn get_speech_engine_available(state: State<'_, SpeechState>) -> Result<bool, AppError> {
    Ok(engine_available_inner(state.engine.as_deref(), AVAILABILITY_TIMEOUT).await)
}

/// Speaks one utterance through the backend engine and settles when it ends.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn speak_text(
    state: State<'_, SpeechState>,
    text: String,
) -> Result<SpeakOutcome, AppError> {
    speak_text_inner(state.engine.as_deref(), &text).await
}

/// Cuts off the utterance the backend engine is speaking, if any.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip_all, err)]
pub async fn stop_speaking(state: State<'_, SpeechState>) -> Result<(), AppError> {
    stop_speaking_inner(state.engine.as_deref()).await
}

pub async fn engine_available_inner(engine: Option<&dyn SpeechEngine>, timeout: Duration) -> bool {
    let Some(engine) = engine else { return false };
    if let Ok(available) = tokio::time::timeout(timeout, engine.available()).await {
        available
    } else {
        tracing::warn!("the speech engine did not start in time; Read aloud stays hidden");
        false
    }
}

pub async fn speak_text_inner(
    engine: Option<&dyn SpeechEngine>,
    text: &str,
) -> Result<SpeakOutcome, AppError> {
    validate_utterance(text)?;
    let engine = engine
        .ok_or_else(|| AppError::InvalidOperation("no speech engine on this device".into()))?;
    Ok(engine.speak(text).await?)
}

pub async fn stop_speaking_inner(engine: Option<&dyn SpeechEngine>) -> Result<(), AppError> {
    match engine {
        Some(engine) => Ok(engine.stop().await?),
        None => Ok(()),
    }
}

fn validate_utterance(text: &str) -> Result<(), AppError> {
    if text.trim().is_empty() {
        return Err(AppError::validation(
            "an utterance needs text to speak".into(),
        ));
    }
    let units = text.encode_utf16().count();
    if units > MAX_UTTERANCE_UNITS {
        return Err(AppError::validation(format!(
            "an utterance is at most {MAX_UTTERANCE_UNITS} UTF-16 units; this one is {units}"
        )));
    }
    Ok(())
}

/// What `SpeechPlugin.kt` resolves `status` and `speak` with.
#[cfg(any(test, target_os = "android"))]
#[derive(Debug, Deserialize)]
struct StatusReply {
    available: bool,
}

#[cfg(any(test, target_os = "android"))]
#[derive(Debug, Deserialize)]
struct SpeakReply {
    outcome: SpeakOutcome,
}

#[cfg(any(test, target_os = "android"))]
#[derive(Debug, Serialize)]
struct SpeakArgs<'a> {
    text: &'a str,
}

#[cfg(target_os = "android")]
mod android {
    use std::sync::Arc;

    use tauri::Runtime;
    use tauri::plugin::{PluginApi, PluginHandle};

    use super::{
        EngineError, EngineFuture, SpeakArgs, SpeakOutcome, SpeakReply, SpeechEngine, StatusReply,
    };

    struct AndroidEngine<R: Runtime>(PluginHandle<R>);

    /// Loads `com.agaric.app.SpeechPlugin`. Its constructor does nothing, so
    /// the only failure is a missing class; that is logged, and the engine
    /// stays unset.
    pub(super) fn register<R: Runtime, C: serde::de::DeserializeOwned>(
        api: &PluginApi<R, C>,
    ) -> Option<Arc<dyn SpeechEngine>> {
        match api.register_android_plugin("com.agaric.app", "SpeechPlugin") {
            Ok(handle) => Some(Arc::new(AndroidEngine(handle))),
            Err(err) => {
                tracing::error!(error = %err, "the speech plugin did not load; Read aloud stays hidden");
                None
            }
        }
    }

    impl<R: Runtime> SpeechEngine for AndroidEngine<R> {
        fn available(&self) -> EngineFuture<'_, bool> {
            Box::pin(async move {
                match self
                    .0
                    .run_mobile_plugin_async::<StatusReply>("status", ())
                    .await
                {
                    Ok(reply) => reply.available,
                    Err(err) => {
                        tracing::warn!(error = %err, "the speech engine is unavailable");
                        false
                    }
                }
            })
        }

        fn speak<'a>(
            &'a self,
            text: &'a str,
        ) -> EngineFuture<'a, Result<SpeakOutcome, EngineError>> {
            Box::pin(async move {
                self.0
                    .run_mobile_plugin_async::<SpeakReply>("speak", SpeakArgs { text })
                    .await
                    .map(|reply| reply.outcome)
                    .map_err(|err| EngineError(err.to_string()))
            })
        }

        fn stop(&self) -> EngineFuture<'_, Result<(), EngineError>> {
            Box::pin(async move {
                self.0
                    .run_mobile_plugin_async::<serde_json::Value>("stop", ())
                    .await
                    .map(|_| ())
                    .map_err(|err| EngineError(err.to_string()))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn speech_status_is_unsupported_on_linux() {
        assert_eq!(get_speech_status().unwrap(), SpeechStatus::Unsupported);
    }

    /// Answers as told and records what it was asked to speak.
    #[derive(Default)]
    struct FakeEngine {
        available: bool,
        /// `None` speaks to the end.
        speak_result: Option<Result<SpeakOutcome, EngineError>>,
        stop_error: Option<EngineError>,
        spoken: Mutex<Vec<String>>,
        stops: Mutex<usize>,
    }

    impl SpeechEngine for FakeEngine {
        fn available(&self) -> EngineFuture<'_, bool> {
            Box::pin(async move { self.available })
        }

        fn speak<'a>(
            &'a self,
            text: &'a str,
        ) -> EngineFuture<'a, Result<SpeakOutcome, EngineError>> {
            self.spoken.lock().unwrap().push(text.to_owned());
            let result = self.speak_result.clone().unwrap_or(Ok(SpeakOutcome::Done));
            Box::pin(async move { result })
        }

        fn stop(&self) -> EngineFuture<'_, Result<(), EngineError>> {
            *self.stops.lock().unwrap() += 1;
            let result = self.stop_error.clone().map_or(Ok(()), Err);
            Box::pin(async move { result })
        }
    }

    /// An engine whose `onInit` never comes.
    struct HangingEngine;

    impl SpeechEngine for HangingEngine {
        fn available(&self) -> EngineFuture<'_, bool> {
            Box::pin(std::future::pending())
        }

        fn speak<'a>(&'a self, _: &'a str) -> EngineFuture<'a, Result<SpeakOutcome, EngineError>> {
            Box::pin(std::future::pending())
        }

        fn stop(&self) -> EngineFuture<'_, Result<(), EngineError>> {
            Box::pin(std::future::pending())
        }
    }

    fn available_engine() -> FakeEngine {
        FakeEngine {
            available: true,
            ..FakeEngine::default()
        }
    }

    #[tokio::test]
    async fn an_engine_that_can_speak_is_available() {
        let engine = available_engine();
        assert!(engine_available_inner(Some(&engine), AVAILABILITY_TIMEOUT).await);
    }

    #[tokio::test]
    async fn an_engine_that_failed_to_start_is_unavailable() {
        let engine = FakeEngine::default();
        assert!(!engine_available_inner(Some(&engine), AVAILABILITY_TIMEOUT).await);
    }

    #[tokio::test]
    async fn a_plugin_that_did_not_load_is_unavailable() {
        assert!(!engine_available_inner(None, AVAILABILITY_TIMEOUT).await);
    }

    #[tokio::test(start_paused = true)]
    async fn an_engine_that_never_starts_is_unavailable_after_the_timeout() {
        assert!(!engine_available_inner(Some(&HangingEngine), AVAILABILITY_TIMEOUT).await);
    }

    #[tokio::test]
    async fn speaks_the_text_and_reports_how_it_ended() {
        let engine = available_engine();
        assert_eq!(
            speak_text_inner(Some(&engine), "Hello").await.unwrap(),
            SpeakOutcome::Done
        );

        let stopped = FakeEngine {
            speak_result: Some(Ok(SpeakOutcome::Stopped)),
            ..available_engine()
        };
        assert_eq!(
            speak_text_inner(Some(&stopped), "Hi").await.unwrap(),
            SpeakOutcome::Stopped
        );
        assert_eq!(*engine.spoken.lock().unwrap(), vec!["Hello".to_owned()]);
    }

    #[tokio::test]
    async fn speaks_an_utterance_at_the_engine_limit_and_refuses_one_past_it() {
        let engine = available_engine();
        // 'é' is one UTF-16 unit and two UTF-8 bytes, so a byte count would refuse it.
        let at_limit = "é".repeat(MAX_UTTERANCE_UNITS);
        assert_eq!(
            speak_text_inner(Some(&engine), &at_limit).await.unwrap(),
            SpeakOutcome::Done
        );

        // '😀' is two UTF-16 units: half as many reach the limit.
        let past_limit = format!("{}a", "😀".repeat(MAX_UTTERANCE_UNITS / 2));
        let err = speak_text_inner(Some(&engine), &past_limit)
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Validation { code: None, .. }),
            "{err:?}"
        );
        assert_eq!(engine.spoken.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn refuses_an_utterance_with_nothing_to_speak() {
        let engine = available_engine();
        for text in ["", "  \n"] {
            let err = speak_text_inner(Some(&engine), text).await.unwrap_err();
            assert!(
                matches!(err, AppError::Validation { code: None, .. }),
                "{err:?}"
            );
        }
        assert!(engine.spoken.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn speaking_without_an_engine_is_an_invalid_operation() {
        let err = speak_text_inner(None, "Hello").await.unwrap_err();
        assert!(matches!(err, AppError::InvalidOperation(_)), "{err:?}");
    }

    #[tokio::test]
    async fn an_engine_error_while_speaking_maps_to_an_invalid_operation() {
        let engine = FakeEngine {
            speak_result: Some(Err(EngineError("synthesis failed".into()))),
            ..available_engine()
        };
        let err = speak_text_inner(Some(&engine), "Hello").await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Invalid operation: the speech engine failed: synthesis failed"
        );
    }

    #[tokio::test]
    async fn stop_reaches_the_engine_and_maps_its_error() {
        let engine = available_engine();
        stop_speaking_inner(Some(&engine)).await.unwrap();
        assert_eq!(*engine.stops.lock().unwrap(), 1);

        let failing = FakeEngine {
            stop_error: Some(EngineError("not bound".into())),
            ..available_engine()
        };
        let err = stop_speaking_inner(Some(&failing)).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Invalid operation: the speech engine failed: not bound"
        );
    }

    #[tokio::test]
    async fn stop_without_an_engine_has_nothing_to_stop() {
        stop_speaking_inner(None).await.unwrap();
    }

    /// The commands read the engine from the managed `SpeechState`.
    fn app_with(engine: Option<Arc<dyn SpeechEngine>>) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(SpeechState::new(engine));
        app
    }

    #[tokio::test]
    async fn the_commands_reach_the_managed_engine() {
        let engine = Arc::new(available_engine());
        let app = app_with(Some(engine.clone() as Arc<dyn SpeechEngine>));

        assert!(get_speech_engine_available(app.state()).await.unwrap());
        assert_eq!(
            speak_text(app.state(), "Hello".into()).await.unwrap(),
            SpeakOutcome::Done
        );
        stop_speaking(app.state()).await.unwrap();
        assert_eq!(*engine.spoken.lock().unwrap(), vec!["Hello".to_owned()]);
        assert_eq!(*engine.stops.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn the_commands_report_no_engine_and_surface_its_errors() {
        let app = app_with(None);
        assert!(!get_speech_engine_available(app.state()).await.unwrap());

        let failing = FakeEngine {
            stop_error: Some(EngineError("not bound".into())),
            ..available_engine()
        };
        let app = app_with(Some(Arc::new(failing)));
        let err = stop_speaking(app.state()).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidOperation(_)), "{err:?}");
    }

    /// The shapes `SpeechPlugin.kt` resolves with, which nothing compiles on
    /// Linux to check.
    #[test]
    fn reads_the_plugin_replies() {
        let status: StatusReply = serde_json::from_str(r#"{"available":true}"#).unwrap();
        assert!(status.available);
        for (json, outcome) in [
            (r#"{"outcome":"Done"}"#, SpeakOutcome::Done),
            (r#"{"outcome":"Stopped"}"#, SpeakOutcome::Stopped),
        ] {
            assert_eq!(
                serde_json::from_str::<SpeakReply>(json).unwrap().outcome,
                outcome
            );
        }
        assert_eq!(
            serde_json::to_string(&SpeakArgs { text: "Hi" }).unwrap(),
            r#"{"text":"Hi"}"#
        );
    }
}
