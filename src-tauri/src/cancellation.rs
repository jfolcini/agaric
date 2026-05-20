//! PEND-70 — Hand-rolled cancellation primitive for in-flight Tauri commands.
//!
//! The palette debounces keystrokes at 80 ms (see
//! `src/components/CommandPalette.tsx`) but a fast typist firing 5
//! keystrokes in 400 ms still queues 5 sequential `search_blocks_partitioned`
//! IPCs. The frontend's `generationRef` discards the stale results, but
//! the Rust futures still run to completion and waste read-pool slots —
//! `max_connections(4)` on the read pool means a burst can stall the
//! page browser and backlinks queries running on neighbouring surfaces.
//!
//! [`CancellationGuard`] is the **sender** side of a
//! [`tokio::sync::watch::channel`]`<bool>`. The Tauri command wrapper
//! stores the guard in the [`CancellationRegistry`] extension state
//! (keyed by a server-generated request id) and spawns the search
//! inner via `tokio::spawn` so its lifetime is **independent of the
//! wrapper future**. A [`CancelOnDrop`] guard held in the wrapper
//! future fires `registry.cancel(request_id)` when the wrapper
//! future drops (window close, panic unwind, future `cancel_search`
//! IPC), and the spawned task observes the signal via its token at
//! the next `tokio::select!` boundary.
//!
//! This two-layer architecture — extension-state guard registry +
//! spawned worker — is what makes the cancel actually fire when the
//! IPC future is dropped. (A purely in-future guard, as in the first
//! cut of PEND-70, would drop together with the inner future and the
//! watch signal would have no separate-task receiver to wake.)
//!
//! [`CancellationToken`] is a cheap-to-clone **receiver** handle. Loops
//! in the search builder call [`CancellationToken::is_cancelled`]
//! between row-fetch batches, or use [`CancellationToken::cancelled`]
//! to race a long-running future against the cancel signal via
//! `tokio::select!`. The token is `Clone` so multiple co-operating
//! sub-tasks can each carry one.
//!
//! ## Why hand-rolled?
//!
//! There is no first-party cancellation primitive in Tauri 2's command
//! pipeline (see PEND-70 § "Open questions"). The community plugin
//! landscape is small and `tokio::sync::watch` is already in the
//! dependency graph. ~40 LOC of in-tree helper is auditable and
//! avoids a new dependency surface.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::watch;

/// Sender-side handle. Lives in the Tauri command wrapper; firing
/// happens on `Drop` so the in-flight Rust future is signalled when
/// the IPC future itself is dropped (the JS-side promise was discarded
/// or the window closed).
///
/// The guard does NOT cancel on `commit`-style success paths: the
/// command wrapper that owns the guard finishes its work before
/// dropping it, so a fired cancel signal at that point is harmless
/// — no awaiting task is reading the channel any more.
#[derive(Debug)]
pub struct CancellationGuard {
    tx: watch::Sender<bool>,
}

impl CancellationGuard {
    /// Build a fresh cancel channel. The initial value is `false`
    /// (not cancelled). The returned guard is the sender; clone
    /// [`Self::token`] handles to thread into worker code.
    #[must_use]
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        Self { tx }
    }

    /// Create a fresh receiver handle. Cheap (refcount increment);
    /// callers may clone the returned token across sub-tasks.
    #[must_use]
    pub fn token(&self) -> CancellationToken {
        CancellationToken {
            rx: self.tx.subscribe(),
        }
    }

    /// Explicitly fire the cancel signal. Idempotent; subsequent
    /// `Drop` calls are no-ops once `*tx.borrow() == true`.
    ///
    /// Production callers rely on the `Drop` impl; this method exists
    /// for tests that want to fire the signal without dropping the
    /// guard (so they can keep observing the receiver state).
    pub fn cancel(&self) {
        // `send` is fire-and-forget — even with zero subscribers we
        // still want the stored value flipped so a later `subscribe`
        // sees the cancelled state. `send_replace` always updates.
        let _ = self.tx.send_replace(true);
    }
}

impl Default for CancellationGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        // Fire the cancel signal so any awaiting receiver
        // (`is_cancelled` poll, `cancelled().await` race) wakes up.
        // Idempotent if `cancel()` was already called.
        let _ = self.tx.send_replace(true);
    }
}

/// Receiver-side handle. Cheaply cloneable; threaded into the search
/// builder so it can poll the cancellation state between row batches
/// or race a long-running future against the cancel signal.
#[derive(Debug, Clone)]
pub struct CancellationToken {
    rx: watch::Receiver<bool>,
}

impl CancellationToken {
    /// `true` once the owning [`CancellationGuard`] has been dropped
    /// (or explicitly cancelled). Cheap; no `.await` involved.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// Wait for cancellation. Resolves immediately if the guard has
    /// already been dropped; otherwise pends until the next
    /// `tx.send_replace(true)` (the `Drop` impl on
    /// [`CancellationGuard`]).
    ///
    /// Designed for `tokio::select!` against a long-running future —
    /// when the cancel arm fires, the other arm's future is dropped
    /// cleanly.
    pub async fn cancelled(&mut self) {
        // Fast path: already cancelled.
        if *self.rx.borrow() {
            return;
        }
        // Slow path: wait for a value change to `true`. `changed()`
        // returns `Err` once every sender has dropped — which is
        // equivalent to cancellation in our model.
        loop {
            match self.rx.changed().await {
                Ok(()) => {
                    if *self.rx.borrow() {
                        return;
                    }
                    // Spurious wakeup with value still `false` — keep waiting.
                }
                Err(_) => {
                    // All senders dropped → guard gone → cancelled.
                    return;
                }
            }
        }
    }

    /// Build a detached token that never cancels.
    ///
    /// Useful as a default for call sites that don't have a real
    /// guard (test fixtures, command paths that were never wired
    /// for cancellation). The internal channel keeps one sender
    /// alive in a `static` so `changed()` never returns `Err`.
    #[must_use]
    pub fn never_cancelled() -> Self {
        // OnceLock-backed static so the sender is leaked exactly
        // once per process and the receiver clones share it.
        use std::sync::OnceLock;
        static NEVER: OnceLock<watch::Sender<bool>> = OnceLock::new();
        let tx = NEVER.get_or_init(|| watch::channel(false).0);
        Self { rx: tx.subscribe() }
    }
}

// ────────────────────────────────────────────────────────────────────
// Extension-state registry — PEND-70 P1-A architectural fix
// ────────────────────────────────────────────────────────────────────

/// Per-process registry that maps a server-generated `request_id`
/// to the [`CancellationGuard`] for an in-flight search IPC.
///
/// Lives in Tauri managed state (`app.manage(CancellationRegistry::new())`).
///
/// The registry exists so the guard outlives the wrapper future. The
/// search work is spawned via `tokio::spawn` so it lives independently
/// of the wrapper; when the wrapper's [`CancelOnDrop`] guard fires
/// (because the wrapper future was dropped, or a future `cancel_search`
/// IPC fired it externally), the cancel signal propagates to the
/// spawned task via the receiver token.
#[derive(Debug, Clone, Default)]
pub struct CancellationRegistry {
    inner: Arc<Mutex<HashMap<String, Arc<CancellationGuard>>>>,
}

impl CancellationRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a guard for a request. Caller must pair this with a
    /// [`CancelOnDrop`] (or an explicit [`Self::cancel`] call) so the
    /// entry is eventually evicted.
    pub fn insert(&self, request_id: String, guard: Arc<CancellationGuard>) {
        self.inner
            .lock()
            .expect("CancellationRegistry mutex poisoned")
            .insert(request_id, guard);
    }

    /// Fire the cancel signal on the matching entry and evict it.
    /// Returns `true` if an entry was present.
    pub fn cancel(&self, request_id: &str) -> bool {
        let removed = self
            .inner
            .lock()
            .expect("CancellationRegistry mutex poisoned")
            .remove(request_id);
        if let Some(guard) = removed {
            guard.cancel();
            true
        } else {
            false
        }
    }

    /// Snapshot of the current entry count. Test-facing.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .expect("CancellationRegistry mutex poisoned")
            .len()
    }

    /// Test-facing companion to [`Self::len`].
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// RAII helper for the wrapper future. On drop, evicts the
/// [`CancellationRegistry`] entry for `request_id` and fires the
/// stored guard's cancel signal. The spawned search task — which
/// holds the token — bails at its next `tokio::select!` boundary.
pub struct CancelOnDrop {
    registry: CancellationRegistry,
    request_id: String,
}

impl CancelOnDrop {
    #[must_use]
    pub fn new(registry: CancellationRegistry, request_id: String) -> Self {
        Self {
            registry,
            request_id,
        }
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        // Idempotent: if a `cancel_search` IPC already evicted the
        // entry, `cancel()` is a no-op. Otherwise the wrapper future
        // dropped (window close, panic unwind, etc.) and we still
        // want the spawned task to bail.
        self.registry.cancel(&self.request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn fresh_token_is_not_cancelled() {
        let guard = CancellationGuard::new();
        let token = guard.token();
        assert!(
            !token.is_cancelled(),
            "fresh token must not report cancelled"
        );
    }

    #[tokio::test]
    async fn explicit_cancel_flips_token() {
        let guard = CancellationGuard::new();
        let token = guard.token();
        guard.cancel();
        assert!(
            token.is_cancelled(),
            "explicit cancel() must flip is_cancelled to true"
        );
    }

    #[tokio::test]
    async fn dropping_guard_fires_cancellation() {
        let guard = CancellationGuard::new();
        let token = guard.token();
        drop(guard);
        assert!(
            token.is_cancelled(),
            "dropping the guard must fire the cancel signal"
        );
    }

    #[tokio::test]
    async fn cancelled_await_resolves_immediately_when_already_cancelled() {
        let guard = CancellationGuard::new();
        let mut token = guard.token();
        guard.cancel();
        // Should resolve within a single tick.
        timeout(Duration::from_millis(50), token.cancelled())
            .await
            .expect("cancelled() must resolve immediately when already cancelled");
    }

    #[tokio::test]
    async fn cancelled_await_wakes_on_guard_drop() {
        let guard = CancellationGuard::new();
        let mut token = guard.token();
        let fired = Arc::new(AtomicBool::new(false));
        let fired_clone = Arc::clone(&fired);
        let handle = tokio::spawn(async move {
            token.cancelled().await;
            fired_clone.store(true, Ordering::SeqCst);
        });
        // Yield so the spawned task is parked on `changed()`.
        tokio::task::yield_now().await;
        assert!(
            !fired.load(Ordering::SeqCst),
            "task must wait until cancel fires"
        );
        drop(guard);
        timeout(Duration::from_millis(200), handle)
            .await
            .expect("cancellation must propagate within 200ms")
            .expect("spawned task must complete cleanly");
        assert!(
            fired.load(Ordering::SeqCst),
            "task must observe the cancel signal"
        );
    }

    #[tokio::test]
    async fn never_cancelled_token_does_not_fire() {
        let token = CancellationToken::never_cancelled();
        assert!(
            !token.is_cancelled(),
            "never_cancelled() must not report cancelled"
        );
    }

    #[tokio::test]
    async fn clones_share_cancel_signal() {
        let guard = CancellationGuard::new();
        let token_a = guard.token();
        let token_b = token_a.clone();
        drop(guard);
        assert!(token_a.is_cancelled(), "clone A must see cancel");
        assert!(token_b.is_cancelled(), "clone B must see cancel");
    }
}
