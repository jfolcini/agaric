//! PERF-24: Application foreground lifecycle hooks.
//!
//! On mobile (Android) the app can be alive-but-backgrounded for several
//! minutes before the OS suspends it (Doze, App Standby). During that
//! window, periodic background work like the sync daemon's 30 s resync
//! tick and the materializer's 5 min metrics log keep firing — harmless
//! per-tick but preventing long idle-task-park windows.
//!
//! The [`LifecycleHooks`] value is shared between `lib.rs`'s window-event
//! listener and the background tasks. When the app is focused, tasks
//! behave normally; when unfocused (`is_foreground == false`) they skip
//! their periodic work bodies. Foreground transitions wake waiters via
//! [`tokio::sync::Notify`] so no tick is lost on resume.
//!
//! On desktop the same hooks double as a "laptop-lid-closed" optimization
//! — Tauri emits `WindowEvent::Focused(false)` when the window loses
//! focus on every supported platform.
//!
//! Cross-platform (not gated on `target_os = "android"`) because the same
//! mechanism applies to iOS / backgrounded desktop use.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

/// Paired foreground flag + wake notifier, passed into the sync daemon
/// and materializer so they can gate periodic work on app focus state.
///
/// Clones cheaply (inner `Arc`s) — safe to share across async tasks and
/// to store in multiple Tauri managed-state wrappers.
#[derive(Clone)]
pub struct LifecycleHooks {
    /// `true` while the main window is focused / visible. Tasks should
    /// skip periodic work bodies when this reads `false`.
    pub is_foreground: Arc<AtomicBool>,
    /// Notified every time the app transitions to foreground. Waiters
    /// should treat a notification as "check the flag and possibly
    /// resume work immediately" rather than "do the work".
    pub wake: Arc<Notify>,
}

impl LifecycleHooks {
    /// Build a fresh hook pair with `is_foreground = true` (initial
    /// startup state) and an un-notified wake.
    #[must_use]
    pub fn new() -> Self {
        Self {
            is_foreground: Arc::new(AtomicBool::new(true)),
            wake: Arc::new(Notify::new()),
        }
    }

    /// Cheap check: should the caller skip its periodic work body?
    #[must_use]
    pub fn is_backgrounded(&self) -> bool {
        !self.is_foreground.load(Ordering::Acquire)
    }

    /// Mark the app as foreground and wake any waiters. Called from the
    /// window-event listener on `Focused(true)`.
    pub fn mark_foreground(&self) {
        self.is_foreground.store(true, Ordering::Release);
        self.wake.notify_waiters();
    }

    /// Mark the app as backgrounded. Called from the window-event
    /// listener on `Focused(false)`.
    pub fn mark_backgrounded(&self) {
        self.is_foreground.store(false, Ordering::Release);
        // Intentionally do not notify — waiters wake when we return to
        // foreground, not when we leave.
    }
}

impl Default for LifecycleHooks {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri managed-state wrapper for [`LifecycleHooks`].
///
/// Registered in `lib.rs`'s `setup()` so future commands (e.g. a "sync
/// now" handler) can inject the same shared flag/wake pair.
pub struct AppLifecycle(pub LifecycleHooks);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_starts_in_foreground() {
        let h = LifecycleHooks::new();
        assert!(
            !h.is_backgrounded(),
            "freshly constructed hooks must start in foreground"
        );
    }

    #[test]
    fn mark_backgrounded_flips_flag() {
        let h = LifecycleHooks::new();
        h.mark_backgrounded();
        assert!(
            h.is_backgrounded(),
            "mark_backgrounded must set is_foreground=false"
        );
    }

    #[test]
    fn mark_foreground_resets_flag_and_wakes_waiters() {
        let h = LifecycleHooks::new();
        h.mark_backgrounded();
        assert!(h.is_backgrounded());
        h.mark_foreground();
        assert!(!h.is_backgrounded(), "mark_foreground must reset flag");
    }

    #[tokio::test]
    async fn wake_notifies_on_mark_foreground() {
        let h = LifecycleHooks::new();
        h.mark_backgrounded();
        let h2 = h.clone();
        let task = tokio::spawn(async move {
            h2.wake.notified().await;
            h2.is_backgrounded()
        });
        // Yield so the waiter registers before we notify.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        h.mark_foreground();
        let was_backgrounded_when_notified = task.await.unwrap();
        // After mark_foreground, is_foreground is set BEFORE notify so
        // the waker observes the transition, not just a bare wake.
        assert!(
            !was_backgrounded_when_notified,
            "waker observes is_foreground=true when notified"
        );
    }

    #[test]
    fn clone_shares_underlying_state() {
        let h = LifecycleHooks::new();
        let h2 = h.clone();
        h.mark_backgrounded();
        assert!(
            h2.is_backgrounded(),
            "cloned hook must see the same is_foreground flag"
        );
        h2.mark_foreground();
        assert!(
            !h.is_backgrounded(),
            "flipping on one clone must be visible through the original"
        );
    }

    #[test]
    fn default_matches_new() {
        let d = LifecycleHooks::default();
        assert!(!d.is_backgrounded());
    }
}
