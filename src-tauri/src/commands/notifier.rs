//! OS-notification command handlers.
//!
//! Provides the minimal backend path for surfacing a due / scheduled task
//! as a native OS notification through the platform notification backend
//! (`notify-rust` directly on Linux, `tauri-plugin-notification` elsewhere).
//! This is the shippable vertical slice of (issue #138): one command,
//! [`notify_task`], that the frontend can call to fire a notification right
//! now.  It deliberately does *not* yet include the full scheduler, dedupe
//! ledger, snooze semantics, or the Settings sub-tab described in the issue
//! body — those remain open follow-up work tracked on #138.
//!
//! ## Why a "fire now" command rather than native scheduling
//!
//! `tauri-plugin-notification` does expose a `schedule` API, but its
//! semantics (and reliability) differ sharply per platform, and the issue
//! explicitly calls out dedupe / "do not re-fire on materialize replay"
//! as the hard part of the design.  Wiring a thin "show this notification
//! now" command first lets the frontend (or a future Rust scheduler) own
//! the *when* and the dedupe ledger, while the plugin owns only the *how*.
//! This keeps the slice small, testable, and forward-compatible with the
//! eventual `notifier::mod.rs` scheduler.
//!
//! ## Permissions
//!
//! Desktop fires immediately once the capability grants
//! `notification:default`.  Android 13+ requires the `POST_NOTIFICATIONS`
//! runtime grant, which the frontend requests via the plugin's JS
//! permission API (`requestPermission`) before invoking this command; the
//! command itself does not block on the grant (a denied permission simply
//! results in the OS swallowing the notification).

use serde::{Deserialize, Serialize};
use specta::Type;
// Used by the plugin dispatch path on macOS/Windows; Linux dispatches via
// notify-rust directly (see `dispatch_linux_notification`).
#[cfg(not(target_os = "linux"))]
use tauri_plugin_notification::NotificationExt;

use crate::commands::sanitize_internal_error;
use agaric_core::error::AppError;

/// Payload describing the notification to fire for a due / scheduled task.
///
/// `title` is required and non-empty; `body` is optional (a notification
/// with only a title is valid on every platform).  `block_id` is carried
/// purely so the frontend / a future scheduler can correlate the
/// notification with the originating block for dedupe — it is not surfaced
/// to the OS.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotification {
    /// The notification title (e.g. the task's text). Must be non-empty.
    pub title: String,
    /// Optional notification body (e.g. "Due 09:00" / "Scheduled in 10m").
    #[serde(default)]
    pub body: Option<String>,
    /// ULID of the originating block, for caller-side dedupe correlation.
    /// Optional — a free-form notification need not reference a block.
    #[serde(default)]
    pub block_id: Option<String>,
}

/// Validate a [`TaskNotification`] before handing it to the OS.
///
/// Returns the trimmed `(title, body)` pair to display, or an
/// [`AppError::Validation`] if the title is blank.  Split out from the
/// command so the validation contract is unit-testable without a live
/// `AppHandle` / OS notification backend.
pub(crate) fn prepare_notification(
    notification: &TaskNotification,
) -> Result<(String, Option<String>), AppError> {
    let title = notification.title.trim();
    if title.is_empty() {
        return Err(AppError::validation(
            "notification title must not be empty".to_string(),
        ));
    }
    let body = notification
        .body
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);
    Ok((title.to_string(), body))
}

/// Tauri command: fire an OS notification for a due / scheduled task.
///
/// Validates the payload via [`prepare_notification`], then dispatches it
/// through the platform notification backend. A dispatch failure surfaces as
/// [`AppError::InvalidOperation`]; a blank title surfaces as
/// [`AppError::Validation`].
#[tauri::command]
#[specta::specta]
pub async fn notify_task(
    app: tauri::AppHandle,
    notification: TaskNotification,
) -> Result<(), AppError> {
    notify_task_inner(&app, &notification)
        .await
        .map_err(sanitize_internal_error)
}

/// Validate and dispatch the notification through the platform backend.
///
/// Split from the `#[tauri::command]` wrapper so the dispatch path is one
/// unit and the wrapper can funnel errors through
/// [`sanitize_internal_error`] (per the IPC error-sanitization convention).
#[tracing::instrument(skip(app, notification), err)]
async fn notify_task_inner<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    notification: &TaskNotification,
) -> Result<(), AppError> {
    let (title, body) = prepare_notification(notification)?;

    // Linux: dispatch via notify-rust directly on a dedicated OS thread.
    //
    // Observed (0.3.5, GNOME 46 / Wayland): the app's notifications never
    // reach the FDO daemon — none appear in the notification center and a
    // D-Bus monitor captures no `Notify` from the app, yet standalone
    // notify-rust calls (same zbus/async-io backend) do appear. The plugin
    // fires notify-rust's blocking `show()` via `tauri::async_runtime::spawn`
    // and discards the `Result` (`let _ = …`), so the failure is swallowed and
    // the IPC command still returns `Ok` (the user only sees the in-app
    // "sent" toast). The most likely cause is notify-rust's async-io blocking
    // call not driving to completion inside Tauri's async runtime.
    //
    // Running the blocking call on a plain `std::thread` makes dispatch
    // independent of the surrounding runtime (verified to emit the `Notify`
    // and land in the center). #702 keeps that thread detached so the native
    // call cannot pin shutdown. #3266 delivers its result through a Tokio
    // oneshot awaited under `tokio::time::timeout`, so waiting yields the
    // runtime worker; a real failure still surfaces to the caller / logs.
    #[cfg(target_os = "linux")]
    {
        let _ = app; // plugin handle unused on this path
        dispatch_linux_notification(title, body).await
    }

    #[cfg(not(target_os = "linux"))]
    {
        let mut builder = app.notification().builder().title(title);
        if let Some(body) = body {
            builder = builder.body(body);
        }
        builder.show().map_err(|e| {
            AppError::InvalidOperation(format!("failed to dispatch OS notification: {e}"))
        })?;
        Ok(())
    }
}

/// Upper bound on how long we wait for the dedicated notification thread to
/// finish before giving up. #702: a hung D-Bus / FDO daemon can leave
/// `notify-rust`'s blocking `show()` parked forever. The async receiver wait
/// yields its Tokio worker and expires after this duration. Expiry stops only
/// the caller's wait: the detached OS thread is not cancellable and can remain
/// parked indefinitely if the daemon never recovers. 5s is generously above a
/// healthy daemon's sub-millisecond `Notify` round-trip.
#[cfg(target_os = "linux")]
const LINUX_NOTIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Dispatch an OS notification on Linux via `notify-rust`, with its blocking
/// call off the Tokio runtime. See [`notify_task_inner`] for why the plugin
/// path is bypassed.
///
/// #702: the dedicated-thread workaround is kept (it's what makes the
/// blocking `show()` independent of the surrounding async runtime), but the
/// thread is **detached** and its result delivered over a Tokio oneshot. The
/// receiver is awaited under [`tokio::time::timeout`], so a hung notification
/// daemon cannot park the calling Tokio worker. Timeout returns an error but
/// cannot cancel the native call; its detached OS thread may remain parked.
#[cfg(target_os = "linux")]
async fn dispatch_linux_notification(title: String, body: Option<String>) -> Result<(), AppError> {
    spawn_and_wait_notification(LINUX_NOTIFY_TIMEOUT, move || {
        let mut n = notify_rust::Notification::new();
        n.summary(&title);
        if let Some(body) = &body {
            n.body(body);
        }
        // Associate with the installed `agaric.desktop` so GNOME shows the
        // app icon, lists it under per-app notification settings, and
        // retains it in the notification center.
        n.hint(notify_rust::Hint::DesktopEntry("agaric".to_string()));
        n.show().map(|_| ()).map_err(|e| e.to_string())
    })
    .await
}

/// Run `work` on a dedicated, **detached** OS thread and wait at most
/// `timeout` for its result over an async oneshot.
///
/// Split from [`dispatch_linux_notification`] so the timeout / hang-guard
/// behaviour (#702) is unit-testable without a live D-Bus daemon: a test can
/// pass controlled work and assert the async caller stays schedulable while it
/// waits, without depending on a live D-Bus daemon.
///
/// On timeout the worker thread is left running (detached). If the underlying
/// call eventually unblocks, sending fails harmlessly because the receiver has
/// gone; if it never unblocks, that OS thread remains parked.
#[cfg(target_os = "linux")]
async fn spawn_and_wait_notification<F>(
    timeout: std::time::Duration,
    work: F,
) -> Result<(), AppError>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("os-notify".into())
        .spawn(move || {
            send_notification_result(tx, work);
        })
        .map_err(|e| {
            AppError::InvalidOperation(format!("failed to spawn notification thread: {e}"))
        })?;

    wait_for_notification_result(timeout, rx).await
}

#[cfg(target_os = "linux")]
fn send_notification_result<F>(tx: tokio::sync::oneshot::Sender<Result<(), String>>, work: F)
where
    F: FnOnce() -> Result<(), String>,
{
    // If the receiver has already given up (timeout or cancellation), log and
    // drop the result. The detached thread then exits cleanly.
    if tx.send(work()).is_err() {
        tracing::debug!("OS notification result receiver dropped before the worker completed");
    }
}

#[cfg(target_os = "linux")]
async fn wait_for_notification_result(
    timeout: std::time::Duration,
    rx: tokio::sync::oneshot::Receiver<Result<(), String>>,
) -> Result<(), AppError> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(e))) => Err(AppError::InvalidOperation(format!(
            "failed to dispatch OS notification: {e}"
        ))),
        Err(_) => {
            tracing::warn!(
                timeout_secs = timeout.as_secs(),
                "OS notification dispatch timed out (notification daemon unresponsive); \
                 giving up the async wait; the detached OS thread may remain parked"
            );
            Err(AppError::InvalidOperation(
                "notification dispatch timed out".into(),
            ))
        }
        Ok(Err(_)) => Err(AppError::InvalidOperation(
            "notification dispatch thread exited without a result".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(title: &str, body: Option<&str>) -> TaskNotification {
        TaskNotification {
            title: title.to_string(),
            body: body.map(str::to_string),
            block_id: None,
        }
    }

    #[test]
    fn prepare_keeps_title_and_body() {
        let (title, body) = prepare_notification(&n("Buy groceries", Some("Due 09:00")))
            .expect("valid notification");
        assert_eq!(title, "Buy groceries");
        assert_eq!(body.as_deref(), Some("Due 09:00"));
    }

    #[test]
    fn prepare_trims_whitespace() {
        let (title, body) = prepare_notification(&n("  Buy groceries  ", Some("  Due 09:00  ")))
            .expect("valid notification");
        assert_eq!(title, "Buy groceries");
        assert_eq!(body.as_deref(), Some("Due 09:00"));
    }

    #[test]
    fn prepare_allows_missing_body() {
        let (title, body) = prepare_notification(&n("Standup", None)).expect("valid");
        assert_eq!(title, "Standup");
        assert_eq!(body, None);
    }

    #[test]
    fn prepare_drops_blank_body() {
        let (_, body) = prepare_notification(&n("Standup", Some("   "))).expect("valid title");
        assert_eq!(body, None, "whitespace-only body should be dropped");
    }

    #[test]
    fn prepare_rejects_empty_title() {
        let err = prepare_notification(&n("", Some("body"))).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    }

    #[test]
    fn prepare_rejects_whitespace_only_title() {
        let err = prepare_notification(&n("   ", None)).unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    }

    #[test]
    fn block_id_round_trips_through_serde() {
        let json = r#"{"title":"t","body":"b","blockId":"01ABC"}"#;
        let parsed: TaskNotification = serde_json::from_str(json).expect("deserialize");
        assert_eq!(parsed.block_id.as_deref(), Some("01ABC"));
        assert_eq!(parsed.title, "t");
    }

    #[test]
    fn body_defaults_to_none_when_absent() {
        let json = r#"{"title":"t"}"#;
        let parsed: TaskNotification = serde_json::from_str(json).expect("deserialize");
        assert_eq!(parsed.body, None);
        assert_eq!(parsed.block_id, None);
    }

    // -- #702/#3266: detached-thread async wait --------------------------

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn notify_dispatch_returns_worker_result_when_fast() {
        let timeout = std::time::Duration::from_secs(5);
        let ok = spawn_and_wait_notification(timeout, || Ok(())).await;
        assert!(ok.is_ok(), "fast success must propagate, got {ok:?}");

        let err = spawn_and_wait_notification(timeout, || Err("daemon said no".to_string())).await;
        match err {
            Err(AppError::InvalidOperation(msg)) => {
                assert!(
                    msg.contains("daemon said no"),
                    "error text propagated: {msg}"
                );
            }
            other => panic!("fast failure must propagate as InvalidOperation, got {other:?}"),
        }
    }

    /// #3266: awaiting a parked native worker must yield a single-threaded
    /// Tokio runtime. The sibling future releases the OS worker only after one
    /// runtime turn; a synchronous receive would prevent that release, hit the
    /// five-second error path, and make this assertion fail. No elapsed-time
    /// threshold is involved.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "current_thread")]
    async fn notify_dispatch_wait_keeps_current_thread_runtime_responsive() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let waiting = spawn_and_wait_notification(std::time::Duration::from_secs(5), move || {
            started_tx
                .send(())
                .expect("signal that notification worker started");
            release_rx
                .recv()
                .map_err(|error| format!("release worker: {error}"))?;
            Ok(())
        });
        let release = async move {
            started_rx
                .await
                .expect("notification worker must signal startup");
            tokio::task::yield_now().await;
            release_tx.send(()).expect("release notification worker");
        };

        let (result, ()) = tokio::join!(waiting, release);
        assert!(
            result.is_ok(),
            "async wait must let the sibling release future run: {result:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(start_paused = true)]
    async fn notify_dispatch_timeout_is_reported_with_virtual_time() {
        let timeout = std::time::Duration::from_secs(5);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel::<()>();
        let waiting = tokio::spawn(spawn_and_wait_notification(timeout, move || {
            started_tx
                .send(())
                .expect("signal that notification worker started");
            release_rx
                .recv()
                .map_err(|error| format!("release worker: {error}"))?;
            finished_tx
                .send(())
                .expect("signal that notification worker finished");
            Ok(())
        }));

        started_rx
            .await
            .expect("notification worker must signal startup");
        tokio::time::advance(timeout).await;
        let result = waiting.await.expect("notification wait task must join");
        match result {
            Err(AppError::InvalidOperation(message)) => {
                assert!(message.contains("timed out"), "timeout error: {message}");
            }
            other => panic!("pending sender must time out, got {other:?}"),
        }

        release_tx.send(()).expect("release timed-out worker");
        finished_rx
            .await
            .expect("timed-out notification worker must exit");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn notify_dispatch_disconnected_sender_is_reported() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(tx);
        let result = wait_for_notification_result(std::time::Duration::from_secs(5), rx).await;
        match result {
            Err(AppError::InvalidOperation(message)) => assert!(
                message.contains("exited without a result"),
                "disconnect error: {message}"
            ),
            other => panic!("dropped sender must report disconnect, got {other:?}"),
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn notification_worker_tolerates_disconnected_receiver() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        drop(rx);
        let work_ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let work_ran_in_worker = std::sync::Arc::clone(&work_ran);

        send_notification_result(tx, move || {
            work_ran_in_worker.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        });

        assert!(
            work_ran.load(std::sync::atomic::Ordering::SeqCst),
            "worker must complete even when its receiver was cancelled"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn cancelling_notification_wait_drops_receiver_and_worker_can_exit() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (finished_tx, finished_rx) = tokio::sync::oneshot::channel::<()>();
        let waiting = tokio::spawn(spawn_and_wait_notification(
            std::time::Duration::from_secs(5),
            move || {
                started_tx
                    .send(())
                    .expect("signal that notification worker started");
                release_rx
                    .recv()
                    .map_err(|error| format!("release worker: {error}"))?;
                finished_tx
                    .send(())
                    .expect("signal that notification worker finished");
                Ok(())
            },
        ));

        started_rx
            .await
            .expect("notification worker must signal startup");
        waiting.abort();
        let join_error = waiting
            .await
            .expect_err("aborted notification wait must be cancelled");
        assert!(join_error.is_cancelled(), "join error: {join_error}");

        release_tx.send(()).expect("release cancelled worker");
        finished_rx
            .await
            .expect("cancelled notification worker must exit");
    }
}
