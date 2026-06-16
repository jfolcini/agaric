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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// #704: the two genuinely distinct lifecycle states the shell must
/// tell apart.
///
/// Tauri emits `WindowEvent::Focused(false)` both when the window
/// merely loses input focus (the user clicked another window — the app
/// is still on-screen, still foreground) **and** as a side effect of a
/// real minimize/hide on some platforms. Gating maintenance / periodic
/// sync directly on `Focused(false)` therefore conflates the two: a
/// device that simply lost focus would start running backgrounded-only
/// maintenance (a noticeable pause while the user is still looking at
/// the window), and the periodic sync tick would starve.
///
/// [`derive_app_state`] is the pure discrimination function: it takes
/// the relevant window-state flags and returns which regime the app is
/// actually in, so the thin Tauri-event wiring stays a trivial
/// (untested) mapping while the decision logic is unit-tested.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppState {
    /// The app is on-screen and usable — either focused, or merely
    /// unfocused but still visible (another window is on top). Periodic
    /// and maintenance work should behave as foreground.
    Foreground,
    /// The app is genuinely backgrounded — minimized, hidden, or
    /// OS-suspended. Maintenance may run its heavier jobs and periodic
    /// sync short-circuits.
    Background,
}

impl AppState {
    /// `true` when the app is genuinely backgrounded.
    #[must_use]
    pub fn is_background(self) -> bool {
        matches!(self, AppState::Background)
    }
}

/// The window-state inputs a lifecycle event carries, normalised so the
/// discrimination logic ([`derive_app_state`]) is pure and testable.
///
/// `focused` is the bool from `WindowEvent::Focused(_)`. `visible` /
/// `minimized` are queried from the window when focus is lost
/// (`window.is_visible()` / `window.is_minimized()`), since Tauri does
/// not emit a dedicated minimize/hide event on desktop — a minimize
/// arrives as `Focused(false)` and is only distinguishable by querying
/// the window. `os_suspended` carries the mobile-only
/// `WindowEvent::Suspended` signal (Android `onPause` / iOS
/// resign-active), which is an unambiguous background transition.
#[derive(Debug, Clone, Copy)]
pub struct WindowStateFlags {
    /// The window currently holds input focus.
    pub focused: bool,
    /// The window is on-screen (not hidden via `hide()`).
    pub visible: bool,
    /// The window is minimized to the taskbar / dock.
    pub minimized: bool,
    /// The OS reported a genuine suspend (mobile `Suspended`). When
    /// `true` it dominates: the app is backgrounded regardless of the
    /// other flags.
    pub os_suspended: bool,
}

/// #704: pure discrimination between mere focus-loss and genuine
/// backgrounding.
///
/// Rules (first match wins):
/// 1. An OS suspend (`os_suspended`) is always background.
/// 2. Hidden (`!visible`) or minimized is background.
/// 3. Otherwise — focused, or unfocused-but-visible — the app is still
///    foreground. Losing focus alone never backgrounds the app.
#[must_use]
pub fn derive_app_state(flags: WindowStateFlags) -> AppState {
    if flags.os_suspended || !flags.visible || flags.minimized {
        AppState::Background
    } else {
        // Focused, or unfocused-but-visible-and-not-minimized: the app
        // is on-screen and counts as foreground. `flags.focused` is
        // intentionally not consulted here — focus state alone does not
        // change the regime.
        AppState::Foreground
    }
}

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
    /// listener when a window event resolves to genuine backgrounding
    /// (minimize / hide / OS suspend), not on mere focus-loss.
    pub fn mark_backgrounded(&self) {
        self.is_foreground.store(false, Ordering::Release);
        // Intentionally do not notify — waiters wake when we return to
        // foreground, not when we leave.
    }

    /// #704: apply a [`derive_app_state`] result to the shared flag.
    /// `Foreground` marks foreground (and wakes waiters); `Background`
    /// marks backgrounded. The window-event listener feeds its derived
    /// [`AppState`] through here so the foreground/background decision
    /// lives in one tested place.
    pub fn apply_state(&self, state: AppState) {
        match state {
            AppState::Foreground => self.mark_foreground(),
            AppState::Background => self.mark_backgrounded(),
        }
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

    // --- #704: focus-vs-background discrimination ------------------

    /// Helper: build flags with sensible "on-screen" defaults so each
    /// test varies only the dimension under test.
    fn flags(
        focused: bool,
        visible: bool,
        minimized: bool,
        os_suspended: bool,
    ) -> WindowStateFlags {
        WindowStateFlags {
            focused,
            visible,
            minimized,
            os_suspended,
        }
    }

    #[test]
    fn focused_and_visible_is_foreground() {
        assert_eq!(
            derive_app_state(flags(true, true, false, false)),
            AppState::Foreground,
            "a focused, visible, non-minimized window is foreground"
        );
    }

    #[test]
    fn focus_lost_but_still_visible_is_foreground() {
        // #704 core case: clicking another window drops focus but the
        // app is still on-screen — it must NOT be treated as
        // backgrounded.
        let state = derive_app_state(flags(false, true, false, false));
        assert_eq!(
            state,
            AppState::Foreground,
            "focus-loss while still visible must stay foreground (#704)"
        );
        assert!(
            !state.is_background(),
            "focus-loss-but-visible is not background"
        );
    }

    #[test]
    fn minimized_is_background() {
        // A minimize arrives as Focused(false) on desktop; the
        // minimized flag is what distinguishes it from plain focus-loss.
        assert_eq!(
            derive_app_state(flags(false, true, true, false)),
            AppState::Background,
            "a minimized window is genuinely backgrounded"
        );
    }

    #[test]
    fn hidden_is_background() {
        assert_eq!(
            derive_app_state(flags(false, false, false, false)),
            AppState::Background,
            "a hidden (not visible) window is genuinely backgrounded"
        );
    }

    #[test]
    fn os_suspended_is_background_even_if_flags_look_foreground() {
        // The mobile Suspended event dominates: even if the cached
        // visibility flags still read on-screen, an OS suspend is
        // background.
        assert_eq!(
            derive_app_state(flags(true, true, false, true)),
            AppState::Background,
            "an OS suspend backgrounds the app regardless of window flags"
        );
    }

    #[test]
    fn focused_but_minimized_resolves_to_background() {
        // Defensive: if a platform ever reports focused+minimized, the
        // minimize wins — the window isn't on-screen.
        assert_eq!(
            derive_app_state(flags(true, true, true, false)),
            AppState::Background,
            "minimized dominates even when focused"
        );
    }

    #[test]
    fn apply_state_foreground_clears_backgrounded_flag() {
        let h = LifecycleHooks::new();
        h.mark_backgrounded();
        assert!(h.is_backgrounded());
        h.apply_state(AppState::Foreground);
        assert!(
            !h.is_backgrounded(),
            "apply_state(Foreground) must clear the backgrounded flag"
        );
    }

    #[test]
    fn apply_state_background_sets_backgrounded_flag() {
        let h = LifecycleHooks::new();
        h.apply_state(AppState::Background);
        assert!(
            h.is_backgrounded(),
            "apply_state(Background) must set the backgrounded flag"
        );
    }

    #[test]
    fn focus_loss_via_apply_state_does_not_background_the_daemon() {
        // End-to-end of the wiring contract: a Focused(false) event from
        // a still-visible window must leave the daemon-visible
        // is_foreground flag set — periodic sync keeps running.
        let h = LifecycleHooks::new();
        let state = derive_app_state(flags(false, true, false, false));
        h.apply_state(state);
        assert!(
            !h.is_backgrounded(),
            "focus-loss-but-visible must not starve periodic sync (#704)"
        );
    }
}
