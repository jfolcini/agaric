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

/// The i18n key naming the explanation shown to the user when blocked.
///
/// `onBlockedStatusChanged` carries a bare boolean — no reason code, no
/// message — so the *wording* is Agaric's. It lives in the frontend catalog
/// (`src/lib/i18n/sync.ts`), not here: a string built in Rust is English for
/// every user, in every locale, forever, and the daemon has no access to the
/// user's chosen language. What crosses the boundary is this key.
///
/// # Why there is no human-readable twin on the payload
///
/// A payload that carried *both* a key for the UI and prose for the logs would
/// leave two fields whose relationship nobody could state. There is no need:
/// the log line for this condition is emitted separately by
/// [`report_blocked_status`] as its own `tracing::warn!` literal — which is
/// what `STABLE_MESSAGES` in `commands::bug_report` pins and what a bug report
/// carries. The event is the UI's channel and the `tracing` call is the log's;
/// neither borrows the other's text.
pub const BLOCKED_REASON_KEY: &str = "pairing.osNetworkBlocked";

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
        // A recovery removes the banner, so it has no text to show and carries
        // no key. Sending one would be dead weight: nothing renders it, and the
        // catalog entry behind it could never be reached.
        (_, blocked) => Some(SyncEvent::NetworkBlockedByOs {
            blocked,
            reason_key: blocked.then(|| BLOCKED_REASON_KEY.to_owned()),
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
    }

    /// The wire payload must carry a **translation key**, not English prose.
    ///
    /// The literal below is deliberately spelled out rather than compared to
    /// [`BLOCKED_REASON_KEY`]: a constant-to-constant assertion is a tautology,
    /// and the thing that has to hold is that this exact string is also a key
    /// in `src/lib/i18n/sync.ts`. Its twin on the other side of the boundary is
    /// `OS_NETWORK_BLOCKED_REASON_KEY` in `src/hooks/useOsNetworkBlock.ts`,
    /// pinned by the same literal.
    ///
    /// The absent `reason` field matters as much as the present key: while the
    /// daemon shipped an English `reason`, every non-English user was shown
    /// English and the catalog entry that should have translated it was
    /// unreachable.
    #[test]
    fn a_block_carries_a_translation_key_and_no_english_prose() {
        let event = blocked_transition(None, true).expect("a first block must be reported");
        let json = serde_json::to_value(&event).expect("serialize NetworkBlockedByOs");
        assert_eq!(
            json["reason_key"], "pairing.osNetworkBlocked",
            "the block must name an i18n key the frontend can translate, got: {json}"
        );
        assert!(
            json.get("reason").is_none(),
            "no English prose may ride along on the payload — it would be shown \
             verbatim to a non-English user, got: {json}"
        );
    }

    /// The recovery direction carries no key at all.
    ///
    /// A recovery *removes* the banner, so there is no string to show and a key
    /// here would be dead on arrival — exactly the shape this change exists to
    /// delete. `reason_key` is therefore `None` precisely when `blocked` is
    /// `false`, and the frontend's result type encodes that as a discriminated
    /// union rather than as a nullable field plus an unreachable fallback.
    #[test]
    fn a_recovery_carries_no_translation_key() {
        let event = blocked_transition(Some(true), false).expect("a recovery is news");
        let json = serde_json::to_value(&event).expect("serialize NetworkBlockedByOs");
        assert!(
            json["reason_key"].is_null(),
            "a recovery shows no text, so it must carry no key, got: {json}"
        );
        assert!(
            json.get("reason").is_none(),
            "no English prose may ride along on the payload, got: {json}"
        );
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
