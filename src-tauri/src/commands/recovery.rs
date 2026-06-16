//! #1255: boot-recovery status command.
//!
//! `recover_at_boot`'s C-2b op-log replay can fail wholesale (a corrupted
//! `op_log`, a stuck foreground queue, or the #412 multi-device hard-abort).
//! Previously that error was downgraded to a `tracing::warn!` one level up
//! and never surfaced — the app booted into an incomplete/stale materialized
//! view with zero UI signal. Boot now emits a durable
//! [`EVENT_RECOVERY_DEGRADED`](crate::recovery::EVENT_RECOVERY_DEGRADED)
//! event AND stores the [`RecoveryStatus`] in managed state.
//!
//! The frontend listens for the event, but a listener that registers after
//! boot has already emitted would miss it (boot runs before the webview
//! mounts). This command lets the frontend backfill the status on mount —
//! the same "emit + query-on-mount backfill" shape the deep-link router
//! uses (`useDeepLinkRouter` + `getCurrent()`).

use crate::error::AppError;
use crate::recovery::{RecoveryStatus, RecoveryStatusState};

/// Tauri command: return the boot-recovery status.
///
/// Used by the frontend to backfill the degraded-boot signal on mount, in
/// case its `recovery:degraded` listener registered after boot emitted.
#[tauri::command]
#[specta::specta]
pub async fn get_recovery_status(
    state: tauri::State<'_, RecoveryStatusState>,
) -> Result<RecoveryStatus, AppError> {
    // The lock is held only for the clone; a poisoned lock (a panic while
    // holding it — which never happens here, it is written once at boot)
    // still yields the inner value via `into_inner`-style recovery.
    let guard = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Ok(guard.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_state_round_trips_degraded() {
        let state = RecoveryStatusState(std::sync::Mutex::new(RecoveryStatus {
            degraded: true,
            replay_errors: vec!["replay aborted: boom".to_string()],
        }));
        let got = state.0.lock().unwrap().clone();
        assert!(got.degraded);
        assert_eq!(got.replay_errors, vec!["replay aborted: boom".to_string()]);
    }

    #[test]
    fn status_state_default_is_healthy() {
        let state = RecoveryStatusState(std::sync::Mutex::new(RecoveryStatus::default()));
        let got = state.0.lock().unwrap().clone();
        assert!(!got.degraded);
        assert!(got.replay_errors.is_empty());
    }
}
