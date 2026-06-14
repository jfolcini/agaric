//! OS-notification command handlers (FEAT-11).
//!
//! Provides the minimal backend path for surfacing a due / scheduled task
//! as a native OS notification through `tauri-plugin-notification`.  This is
//! the shippable vertical slice of FEAT-11 (issue #138): one command,
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
use crate::error::AppError;

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
        return Err(AppError::Validation(
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
/// Validates the payload via [`prepare_notification`], then builds and
/// shows the notification through `tauri-plugin-notification`.  A failure
/// to dispatch (e.g. the plugin is unavailable) surfaces as
/// [`AppError::InvalidOperation`]; a blank title surfaces as
/// [`AppError::Validation`].
#[tauri::command]
#[specta::specta]
pub async fn notify_task(
    app: tauri::AppHandle,
    notification: TaskNotification,
) -> Result<(), AppError> {
    notify_task_inner(&app, &notification).map_err(sanitize_internal_error)
}

/// Validate and dispatch the notification through the plugin.
///
/// Split from the `#[tauri::command]` wrapper so the dispatch path is one
/// unit and the wrapper can funnel errors through
/// [`sanitize_internal_error`] (per the IPC error-sanitization convention).
fn notify_task_inner<R: tauri::Runtime>(
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
    // and land in the center). #702: the thread is detached and its result
    // collected over a bounded channel (`recv_timeout`) so a hung daemon
    // can't park a tokio worker; a real failure still surfaces to the
    // caller / logs, and a timeout is logged and returned as an error.
    #[cfg(target_os = "linux")]
    {
        let _ = app; // plugin handle unused on this path
        dispatch_linux_notification(title, body)
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
/// `notify-rust`'s blocking `show()` parked forever; a synchronous
/// `JoinHandle::join()` inside the async command would then pin a tokio
/// worker indefinitely. We wait at most this long, then return without
/// blocking. 5s is generously above a healthy daemon's sub-millisecond
/// `Notify` round-trip while still bounding the worst case.
#[cfg(target_os = "linux")]
const LINUX_NOTIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Dispatch an OS notification on Linux via `notify-rust`, off the tokio
/// runtime. See [`notify_task_inner`] for why the plugin path is bypassed.
///
/// #702: the dedicated-thread workaround is kept (it's what makes the
/// blocking `show()` independent of the surrounding async runtime), but the
/// thread is **detached** and its result delivered over a bounded
/// `mpsc::recv_timeout`. A hung notification daemon can therefore no longer
/// park the calling tokio worker: on timeout we log and return, leaving the
/// orphaned thread to drain on its own.
#[cfg(target_os = "linux")]
fn dispatch_linux_notification(title: String, body: Option<String>) -> Result<(), AppError> {
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
}

/// Run `work` on a dedicated, **detached** OS thread and wait at most
/// `timeout` for its result over a bounded channel.
///
/// Split from [`dispatch_linux_notification`] so the timeout / hang-guard
/// behaviour (#702) is unit-testable without a live D-Bus daemon: a test can
/// pass a `work` closure that sleeps past `timeout` and assert the call
/// returns promptly with an error instead of blocking forever.
///
/// On timeout the worker thread is left running (detached); it will finish
/// and drop its send half harmlessly once the underlying call unblocks.
#[cfg(target_os = "linux")]
fn spawn_and_wait_notification<F>(timeout: std::time::Duration, work: F) -> Result<(), AppError>
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    std::thread::Builder::new()
        .name("os-notify".into())
        .spawn(move || {
            // If the receiver has already given up (timeout), the send fails
            // and we simply drop the result — the thread exits cleanly.
            let _ = tx.send(work());
        })
        .map_err(|e| {
            AppError::InvalidOperation(format!("failed to spawn notification thread: {e}"))
        })?;

    match rx.recv_timeout(timeout) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(AppError::InvalidOperation(format!(
            "failed to dispatch OS notification: {e}"
        ))),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            tracing::warn!(
                timeout_secs = timeout.as_secs(),
                "OS notification dispatch timed out (notification daemon unresponsive); \
                 abandoning the attempt without blocking the async runtime"
            );
            Err(AppError::InvalidOperation(
                "notification dispatch timed out".into(),
            ))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(AppError::InvalidOperation(
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
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn prepare_rejects_whitespace_only_title() {
        let err = prepare_notification(&n("   ", None)).unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
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

    // -- #702: bounded-wait hang guard -----------------------------------

    /// #702: a hung notification daemon must NOT park the caller. With a
    /// short timeout and a worker that sleeps well past it, the call returns
    /// promptly (an error), proving the blocking `join()` was replaced by a
    /// bounded `recv_timeout`.
    #[cfg(target_os = "linux")]
    #[test]
    fn notify_dispatch_times_out_instead_of_blocking() {
        use std::time::{Duration, Instant};

        let timeout = Duration::from_millis(50);
        let start = Instant::now();
        let result = spawn_and_wait_notification(timeout, || {
            // Simulate a wedged D-Bus call that never returns in time.
            std::thread::sleep(Duration::from_secs(30));
            Ok(())
        });
        let elapsed = start.elapsed();

        assert!(
            matches!(result, Err(AppError::InvalidOperation(_))),
            "hung dispatch must return an error, got {result:?}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "call must return shortly after the {timeout:?} timeout, took {elapsed:?}"
        );
    }

    /// #702 happy path: a fast worker's result is delivered before the
    /// timeout and propagated faithfully (success and failure).
    #[cfg(target_os = "linux")]
    #[test]
    fn notify_dispatch_returns_worker_result_when_fast() {
        use std::time::Duration;

        let ok = spawn_and_wait_notification(Duration::from_secs(5), || Ok(()));
        assert!(ok.is_ok(), "fast success must propagate, got {ok:?}");

        let err = spawn_and_wait_notification(Duration::from_secs(5), || {
            Err("daemon said no".to_string())
        });
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
}
