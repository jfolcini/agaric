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
#[cfg(not(tarpaulin_include))]
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

    let mut builder = app.notification().builder().title(title);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    builder.show().map_err(|e| {
        AppError::InvalidOperation(format!("failed to dispatch OS notification: {e}"))
    })?;
    Ok(())
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
}
