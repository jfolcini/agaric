//! Android per-uid network-block reporting (#3852).
//!
//! ## What this is for
//!
//! Android 15+ maintains a per-uid firewall chain (`FIREWALL_CHAIN_BACKGROUND`)
//! that drops **all** traffic for an app that is not top-of-stack. "Not
//! top-of-stack" includes the case where the app *is* the top activity and the
//! screen has simply gone to sleep — `dumpsys netpolicy` on the reporting
//! Pixel 8 read:
//!
//! ```text
//! UID=10408 state={procState=TPSL,seq=3377608,cap=-------TI}
//!   blocked_state={blocked=APP_BACKGROUND, allowed=NONE, effective=APP_BACKGROUND}
//! ```
//!
//! while the sync daemon was provably active: multicast lock held, QUIC
//! endpoint bound, mDNS record registered. The daemon cannot notice this. Its
//! sockets stay open, `sendto` keeps returning success, and inbound datagrams
//! are discarded at the cgroup-BPF ingress hook before they are enqueued (300
//! datagrams in, `/proc/net/udp` drops +300, `rx_queue` unchanged at 0).
//!
//! ## Why a callback and not a probe
//!
//! Everything the process can observe about a firewall block is *silence*, and
//! silence is indistinguishable from a quiet LAN, a sleeping peer, or a wrong
//! service type — #3852 was confidently misdiagnosed as each of those in turn.
//! `ConnectivityManager.registerDefaultNetworkCallback` +
//! `NetworkCallback.onBlockedStatusChanged(network, blocked)` is the platform
//! stating this uid's firewall status about itself. It is the only
//! non-inferential source, so it is the one used.
//!
//! ## Shape
//!
//! [`blocked_transition`] is the whole decision, as a pure function, so the
//! reporting rule is testable on any host with no JVM, no device, and no
//! process-global state. The Android half is a thin JNI call out to
//! `com.agaric.app.NetworkBlockMonitor`, which calls back in through
//! `Java_com_agaric_app_NetworkBlockMonitor_nativeOnBlockedStatusChanged` (in
//! the app crate — only the `cdylib` root reliably exports symbols; see
//! `src-tauri/src/android_jni.rs` for that argument in full).

// JNI FFI is the only way to reach `ConnectivityManager`. The two `unsafe`
// blocks below are justified inline and mirror `android_multicast`'s.
#![allow(unsafe_code)]

use std::sync::{Arc, Mutex, OnceLock};

use crate::sync_events::{SyncEvent, SyncEventSink};

/// The user-facing explanation attached to a block.
///
/// `onBlockedStatusChanged` carries a bare boolean — no reason code, no
/// message — so this text is ours. It names the user's next move rather than
/// the kernel mechanism, because the person reading it is mid-pair and the only
/// action available to them is to keep the screen on.
pub const BLOCKED_REASON: &str = "Android has paused this app's network access because it is not \
                                  in the foreground (the screen going off is enough). Keep the \
                                  screen on and this app open while pairing.";

/// The explanation attached to a recovery.
pub const UNBLOCKED_REASON: &str = "Android has restored this app's network access.";

/// Decide what to emit for a newly-reported blocked status.
///
/// `previous` is the last status this process reported, or `None` if it has
/// reported nothing yet.
///
/// Two rules, both of which exist to keep the event meaningful:
///
/// * **Only transitions.** `registerDefaultNetworkCallback` re-delivers the
///   current status on every network change, so an un-deduped forwarder would
///   emit on every Wi-Fi roam and every VPN flap. A banner that redraws
///   constantly is one the user learns to ignore.
/// * **A first reading of "not blocked" is not news.** It is the state every
///   healthy device is in, so emitting it would put this event — and the
///   listener cost behind it — on every boot to say nothing. `false` is worth
///   saying only as a *recovery*, i.e. after a `true`.
pub fn blocked_transition(previous: Option<bool>, now: bool) -> Option<SyncEvent> {
    match (previous, now) {
        // Already reported this exact state — say nothing.
        (Some(prev), now) if prev == now => None,
        // First reading, and it is healthy — nothing happened.
        (None, false) => None,
        (_, blocked) => Some(SyncEvent::NetworkBlockedByOs {
            blocked,
            reason: if blocked {
                BLOCKED_REASON
            } else {
                UNBLOCKED_REASON
            }
            .to_owned(),
        }),
    }
}

/// Sink + last-reported status, shared with the JNI callback thread.
///
/// A process-global because the callback arrives on a JVM-owned thread with no
/// path back to the daemon's stack: `onBlockedStatusChanged` is invoked by
/// `ConnectivityManager`, not by anything Agaric called.
struct Reporter {
    sink: Arc<dyn SyncEventSink>,
    last_reported: Mutex<Option<bool>>,
}

static REPORTER: OnceLock<Reporter> = OnceLock::new();

/// Install the sink the OS block reports are routed to.
///
/// First writer wins; later calls are ignored. The daemon can start, stop and
/// restart (dormant ⇄ active) many times per process, and the registration on
/// the Android side is likewise process-wide and never unregistered, so
/// re-installing would only swap one live sink for an equivalent one.
pub fn install_event_sink(sink: Arc<dyn SyncEventSink>) {
    let _ = REPORTER.set(Reporter {
        sink,
        last_reported: Mutex::new(None),
    });
}

/// Report a blocked-status reading from the platform.
///
/// Called from the JNI callback on Android; called directly by tests. A reading
/// that arrives before [`install_event_sink`] is dropped — there is nothing to
/// deliver it to, and buffering it would surface a stale firewall state at an
/// unrelated later moment.
pub fn report_blocked_status(blocked: bool) {
    let Some(reporter) = REPORTER.get() else {
        tracing::debug!(
            blocked,
            "OS network-block status arrived before a sink was installed; dropping"
        );
        return;
    };
    let Ok(mut last) = reporter.last_reported.lock() else {
        tracing::warn!("OS network-block state lock poisoned; dropping status update");
        return;
    };
    let Some(event) = blocked_transition(*last, blocked) else {
        return;
    };
    *last = Some(blocked);
    if blocked {
        // One line and byte-identical to its `STABLE_MESSAGES` entry in
        // `commands::bug_report`: the #700 drift guard scans for the quoted literal, so
        // a `\`-continued one would be redacted out of exactly the bug reports filed
        // about this failure.
        tracing::warn!(
            "the OS is blocking this app's network traffic; sync and pairing cannot reach the network until it is restored"
        );
    } else {
        tracing::info!("the OS has restored this app's network traffic");
    }
    reporter.sink.on_sync_event(event);
}

/// Ask the Android side to register the default-network callback.
///
/// Idempotent on the Kotlin side (it holds a single callback instance and
/// registers at most once per process), so this is safe to call on every
/// dormant → active transition.
#[cfg(target_os = "android")]
pub fn start_monitor() {
    if let Err(e) = start_monitor_inner() {
        tracing::warn!(
            error = %e,
            "could not register the Android network-block callback; an OS-level \
             network block will not be reported to the user"
        );
    }
}

/// No-op off Android: no other platform Agaric ships on has a per-uid firewall
/// that silently drops a foreground app's packets.
#[cfg(not(target_os = "android"))]
pub fn start_monitor() {}

#[cfg(target_os = "android")]
fn start_monitor_inner() -> Result<(), String> {
    use jni::objects::{JObject, JValue};
    use jni::vm::JavaVM;
    use jni::{jni_sig, jni_str};

    let ctx = crate::android_context::require()?;

    // SAFETY: identical invariant to `android_multicast::MulticastLock::acquire`
    // — `require()` returns `Ok` only after `JNI_OnLoad` installed a non-null
    // `JavaVM*` plus a JNI *global* reference to the Application, both owned by
    // the JVM and valid until the process exits.
    let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
    let context_ptr = ctx.context();

    vm.attach_current_thread(|env| -> Result<(), jni::errors::Error> {
        // SAFETY: as above; jni 0.22 anchors the local reference's lifetime to
        // the `Env` handed to this callback.
        let context = unsafe { JObject::from_raw(env, context_ptr.cast()) };
        env.call_static_method(
            jni_str!("com/agaric/app/NetworkBlockMonitor"),
            jni_str!("start"),
            jni_sig!("(Landroid/content/Context;)V"),
            &[JValue::Object(&context)],
        )?;
        Ok(())
    })
    .map_err(|e| format!("NetworkBlockMonitor.start failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_events::RecordingEventSink;

    fn blocked_flag(event: &SyncEvent) -> bool {
        match event {
            SyncEvent::NetworkBlockedByOs { blocked, .. } => *blocked,
            other => panic!("expected NetworkBlockedByOs, got {other:?}"),
        }
    }

    /// The event this whole path exists to produce.
    #[test]
    fn a_first_block_is_reported() {
        let event = blocked_transition(None, true).expect("a first block must be reported");
        assert!(
            blocked_flag(&event),
            "the event for a block must carry blocked = true"
        );
        match &event {
            SyncEvent::NetworkBlockedByOs { reason, .. } => assert!(
                reason.contains("screen"),
                "the reason must tell the user what to do (keep the screen on), got: {reason}"
            ),
            other => panic!("expected NetworkBlockedByOs, got {other:?}"),
        }
    }

    /// A healthy device must stay silent. `registerDefaultNetworkCallback`
    /// delivers the current status immediately on registration, so without this
    /// rule every boot on every platform would emit an event to say nothing
    /// happened.
    #[test]
    fn a_first_healthy_reading_is_not_an_event() {
        assert!(
            blocked_transition(None, false).is_none(),
            "an initial not-blocked reading is the normal state, not news"
        );
    }

    /// Recovery has to be reported, or the pairing UI's warning never clears.
    #[test]
    fn a_recovery_after_a_block_is_reported() {
        let event =
            blocked_transition(Some(true), false).expect("unblocking after a block is news");
        assert!(
            !blocked_flag(&event),
            "the recovery event must carry blocked = false"
        );
    }

    /// The callback re-fires on every network change (Wi-Fi roam, VPN flap)
    /// with the status unchanged. Those must not become events.
    #[test]
    fn a_repeated_reading_is_not_an_event() {
        assert!(
            blocked_transition(Some(true), true).is_none(),
            "a repeat of an already-reported block must not re-emit"
        );
        assert!(
            blocked_transition(Some(false), false).is_none(),
            "a repeat of an already-reported recovery must not re-emit"
        );
    }

    /// End to end over the real reporting entry point — the function the JNI
    /// callback calls — including its process-global dedup state.
    ///
    /// Deliberately the ONLY test that touches the global: a second one would
    /// be order-dependent under a shared-process runner. The whole sequence
    /// (install → healthy → block → repeat → recover) lives here instead.
    #[test]
    fn report_blocked_status_emits_only_on_transitions() {
        let typed = Arc::new(RecordingEventSink::new());
        let sink: Arc<dyn SyncEventSink> = typed.clone();
        install_event_sink(sink);

        report_blocked_status(false); // first reading, healthy — silent
        assert!(
            typed.events().is_empty(),
            "a healthy first reading must emit nothing, got {:?}",
            typed.events()
        );

        report_blocked_status(true); // the block
        report_blocked_status(true); // re-delivered on a network change
        assert_eq!(
            typed.events().len(),
            1,
            "a block must be reported exactly once, got {:?}",
            typed.events()
        );
        assert!(blocked_flag(&typed.events()[0]));

        report_blocked_status(false); // recovery
        let events = typed.events();
        assert_eq!(
            events.len(),
            2,
            "the recovery must be reported, got {events:?}"
        );
        assert!(
            !blocked_flag(&events[1]),
            "the second event must be the recovery"
        );
    }
}
