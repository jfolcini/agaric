//! Sync event types and emission infrastructure.
//!
//! The [`SyncEventSink`] trait decouples the [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator)
//! from Tauri, allowing tests to capture events without an `AppHandle`.

use serde::{Deserialize, Serialize};
use specta::Type;

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

/// Streaming progress payload carried over the sync channel.
///
/// Made this a tagged enum so a single channel per sync
/// session carries both the orchestrator's state-transition stream
/// (`Sync`) and the post-sync attachment-transfer stream (`Files`).
/// Frontend consumers switch on `kind` and read the variant-specific
/// fields.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncProgressUpdate {
    /// Op-sync state transitions (Tier 1). Mirrors the
    /// [`SyncEvent::Progress`] / [`SyncEvent::Complete`] /
    /// [`SyncEvent::Error`] envelope, with `state` carrying
    /// `"complete"` / `"error"` for the terminal cases.
    Sync {
        state: String,
        remote_device_id: String,
        ops_received: u64,
        ops_sent: u64,
    },
    /// Per-frame attachment transfer progress (Tier 2). Emitted by
    /// `sync_files::run_file_transfer_*` between binary frames so the
    /// UI can render a real bytes-done bar instead of a spinner.
    Files {
        /// `"sending"` (we are pushing files to the peer),
        /// `"receiving"` (we are pulling files from the peer), or
        /// `"complete"` (both halves are done for this session).
        phase: String,
        remote_device_id: String,
        /// Files fully transferred so far in the current `phase`.
        files_done: u64,
        /// Total files the peer or we requested for this `phase`. May
        /// be 0 in the steady-state "nothing to transfer" case.
        files_total: u64,
        /// Bytes shipped/received so far in the current `phase`,
        /// including in-progress frames.
        bytes_done: u64,
        /// Aggregate byte total advertised for the current `phase`.
        bytes_total: u64,
    },
    /// Per-frame snapshot catch-up transfer progress. Emitted by
    /// `sync_daemon::snapshot_transfer` between 5 MB binary frames while
    /// the compressed snapshot blob streams over the wire, so the UI can
    /// render a real bytes-done bar for the catch-up blob the same way the
    /// `Files` variant does for attachments.
    Snapshot {
        /// `"sending"` (responder is shipping the snapshot blob),
        /// `"receiving"` (initiator is pulling it), or `"complete"`
        /// (the blob finished transferring for this session).
        phase: String,
        remote_device_id: String,
        /// Bytes shipped/received so far in the current `phase`.
        bytes_done: u64,
        /// Total compressed snapshot size advertised for the transfer.
        bytes_total: u64,
    },
}

/// Payload sent over Tauri events for sync progress/completion/errors.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SyncEvent {
    Progress {
        state: String,
        remote_device_id: String,
        ops_received: usize,
        ops_sent: usize,
    },
    Complete {
        remote_device_id: String,
        ops_received: usize,
        ops_sent: usize,
        /// #1071: deduped set of owning *page* ids (page-root block ids)
        /// touched by the ops applied during this sync session. The frontend
        /// reloads ONLY the mounted page stores whose id is in this set (and
        /// gates the resolve preload on it being non-empty), falling back to
        /// reloading EVERY mounted store + a full preload when the field is
        /// absent/empty — preserving backward compatibility with peers on the
        /// old protocol and the snapshot-catch-up path (which sends empty).
        #[serde(default)]
        changed_page_ids: Vec<String>,
    },
    Error {
        message: String,
        remote_device_id: String,
    },
    /// Per-frame attachment-transfer progress emitted
    /// by `sync_files`. The `ChannelEventSink` forwards these to the
    /// `Channel<SyncProgressUpdate>` as the `Files` variant; the
    /// production `TauriEventSink` drops them (no `app.emit`
    /// fallback — file-transfer progress was never on the legacy event
    /// bus, so the channel is the single canonical source).
    FileProgress {
        phase: String,
        remote_device_id: String,
        files_done: u64,
        files_total: u64,
        bytes_done: u64,
        bytes_total: u64,
    },
    /// Per-frame snapshot catch-up transfer progress emitted by
    /// `sync_daemon::snapshot_transfer`. The `ChannelEventSink` forwards
    /// these to the `Channel<SyncProgressUpdate>` as the `Snapshot`
    /// variant; the production `TauriEventSink` drops them (the
    /// channel is the single canonical source, mirroring `FileProgress`).
    SnapshotProgress {
        phase: String,
        remote_device_id: String,
        bytes_done: u64,
        bytes_total: u64,
    },
    /// Emitted when mDNS peer discovery cannot be initialized (e.g. the
    /// iOS sandbox blocks raw UDP multicast, or the Android app is missing
    /// its multicast lock). There is no fallback for a peer that has never
    /// paired: a first pair requires an mDNS resolve to learn the peer's
    /// `endpoint_id`, so with mDNS disabled a first-ever pair cannot be
    /// completed at all (see `sync_daemon::discovery::resolve_peer_address`).
    /// Already-paired peers can still be dialed via their cached
    /// `peer_refs.last_address`, once bound. The frontend should surface
    /// this to the user instead of showing an Empty peer list.
    MdnsDisabled { reason: String },
    /// #3864: emitted once per daemon start when the sync endpoint bound a
    /// **globally-routable** address, so the QUIC listener may be reachable
    /// from outside the local network.
    ///
    /// #3853 had to widen `lan_only`'s locality gate from "RFC 1918" to "an
    /// address this host holds", because the reporting user's home LAN is
    /// numbered out of public space (`192.160.160.0/24`). On a host that is
    /// genuinely internet-facing — a VPS, a cloud box, a non-NAT ISP link —
    /// that starts a listener where the daemon previously refused to bind at
    /// all, which is the "opens a listening port the user did not ask for"
    /// class in `SECURITY.md` § In scope. Nothing observable from inside the
    /// host separates the two situations, so this event states only what is
    /// known (the address is outside the private ranges) and leaves the
    /// verdict to the user. A `tracing::warn!` alone was not a user-visible
    /// signal, which is what this variant exists to be.
    InternetFacingBind {
        /// The bound IPv4 address, e.g. `"192.160.160.80"`.
        address: String,
        /// The UDP port the listener actually got. The bind requests port 0,
        /// so this is assigned by the OS **and differs on every start** — it
        /// identifies the current listener, it is not a stable firewall rule.
        port: u16,
    },
    /// #3852: the operating system says it is blocking (or has stopped
    /// blocking) **this application's** network traffic.
    ///
    /// Android 15+ runs a per-uid background firewall
    /// (`FIREWALL_CHAIN_BACKGROUND`) that drops every packet for an app that is
    /// not top-of-stack — including when the app *is* the top activity and the
    /// screen has merely gone to sleep (`procState=TOP_SLEEPING`). The daemon
    /// keeps running, keeps its sockets, keeps the multicast lock, and cannot
    /// send or receive anything. On the reporting Pixel 8 this was measured
    /// directly: 300 datagrams aimed at the app's bound `0.0.0.0:5353` raised
    /// `/proc/net/udp`'s drop counter by exactly 300 with `rx_queue` never
    /// leaving 0, i.e. discarded at the cgroup-BPF ingress hook before enqueue.
    ///
    /// The `blocked` flag comes from `NetworkCallback.onBlockedStatusChanged`,
    /// which is the platform stating this uid's firewall status about itself.
    /// That matters more than it sounds: every other route to this fact is an
    /// inference from silence, and silence is also what a quiet LAN, a sleeping
    /// peer, and a wrong service type look like. #3852 spent three days being
    /// mistaken for each of those in turn.
    ///
    /// `blocked: false` is emitted only as a *recovery* — after a block was
    /// reported — so a healthy device never emits this event at all.
    NetworkBlockedByOs {
        /// `true` while the OS is dropping this app's traffic.
        blocked: bool,
        /// The **i18n key** naming the explanation the pairing UI shows, not
        /// the explanation itself. `onBlockedStatusChanged` carries only a
        /// boolean, so the wording is Agaric's — and wording built in Rust is
        /// English for every user in every locale, because the daemon has no
        /// idea what language the window is in. The frontend translates this
        /// key; see `BLOCKED_REASON_KEY` in
        /// `sync_daemon::android_network_block` for the constant and for why no
        /// human-readable twin rides along.
        ///
        /// `Some` exactly when `blocked`: a recovery removes the banner, so it
        /// has no text to name.
        reason_key: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

pub const EVENT_SYNC_PROGRESS: &str = "sync:progress";
pub const EVENT_SYNC_COMPLETE: &str = "sync:complete";
pub const EVENT_SYNC_ERROR: &str = "sync:error";
/// Emitted when mDNS peer discovery is unavailable on this device
/// Payload is [`SyncEvent::MdnsDisabled`].
pub const EVENT_SYNC_MDNS_DISABLED: &str = "sync:mdns_disabled";
/// Emitted when the sync endpoint bound a globally-routable address (#3864).
/// Payload is [`SyncEvent::InternetFacingBind`].
pub const EVENT_SYNC_INTERNET_FACING_BIND: &str = "sync:internet_facing_bind";
/// Emitted when the OS starts or stops blocking this app's network traffic (#3852).
/// Payload is [`SyncEvent::NetworkBlockedByOs`].
pub const EVENT_SYNC_NETWORK_BLOCKED: &str = "sync:network_blocked";

// ---------------------------------------------------------------------------
// mDNS status (#2506) — backfill for the peers/device-management surface
// ---------------------------------------------------------------------------

/// #2506: durable, user-visible mDNS peer-discovery status.
///
/// Derived from the [`SyncEvent::MdnsDisabled`] event (whose `reason` field
/// it mirrors) and returned by the `get_mdns_status` command so a frontend
/// that mounts after the sync daemon already emitted the event (same boot
/// race as `recovery:degraded`, see `crate::recovery::RecoveryStatus` (app-side))
/// can still discover the disabled state. `disabled = false` (the default)
/// means either mDNS is working or the daemon has not attempted to
/// initialize it yet (e.g. still dormant, waiting for the first pairing).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MdnsStatus {
    /// `true` once mDNS initialization has failed at least once.
    pub disabled: bool,
    /// The failure reason from the most recent init attempt (the same
    /// string carried by [`SyncEvent::MdnsDisabled`]). `None` while
    /// `disabled` is `false`.
    pub reason: Option<String>,
}

/// #2506: managed-state holder for the current [`MdnsStatus`].
///
/// Written by `TauriEventSink::on_sync_event` whenever a
/// `SyncEvent::MdnsDisabled` is emitted, and read by the `get_mdns_status`
/// command. Wrapped in a `Mutex` only to satisfy `Send + Sync` for Tauri
/// managed state — mirrors `recovery::RecoveryStatusState`.
pub struct MdnsStatusState(pub std::sync::Mutex<MdnsStatus>);

// ---------------------------------------------------------------------------
// Bind exposure status (#3864) — backfill for the same surface
// ---------------------------------------------------------------------------

/// The globally-routable endpoint the sync daemon is currently listening on.
///
/// Both fields are always present together — an internet-facing bind without
/// an address is not a state the daemon can be in — which is why they live in
/// one struct behind a single `Option` rather than as two independent
/// `Option` fields on [`BindExposureStatus`]. Two optionals that must agree
/// admit three unrepresentable-but-typeable states, and a frontend guard
/// against one of them is a branch no production input can take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct InternetFacingBind {
    /// The bound IPv4 address, e.g. `"192.160.160.80"`.
    pub address: String,
    /// The UDP port of that listener. OS-assigned (the bind requests port 0),
    /// so it changes on every daemon start.
    pub port: u16,
}

/// #3864: durable, user-visible "the sync listener may be reachable from off
/// the LAN" status.
///
/// Mirrors [`SyncEvent::InternetFacingBind`] and is returned by the
/// `get_bind_exposure_status` command. It exists for the **same boot race**
/// [`MdnsStatus`] exists for, and more acutely: the bind happens within the
/// first moments of `daemon_loop`, long before a webview that is still
/// mounting can have registered a `sync:internet_facing_bind` listener. A live
/// event alone would therefore be a signal the user usually never sees.
///
/// Unlike [`MdnsStatus`] there is no separate boolean discriminator: `None`
/// (the default) means either the bind is not globally routable or the daemon
/// has not bound yet, and those are the same thing from the frontend's side —
/// nothing to warn about.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BindExposureStatus {
    /// `Some` once the daemon has bound a globally-routable address.
    pub internet_facing: Option<InternetFacingBind>,
}

/// #3864: managed-state holder for the current [`BindExposureStatus`].
///
/// Written by `TauriEventSink::on_sync_event` whenever a
/// `SyncEvent::InternetFacingBind` is emitted, and read by the
/// `get_bind_exposure_status` command. `Mutex` only for `Send + Sync` —
/// mirrors [`MdnsStatusState`].
pub struct BindExposureStatusState(pub std::sync::Mutex<BindExposureStatus>);

// ---------------------------------------------------------------------------
// OS network-block status (#4035) — a mount-time read of the CURRENT block
// ---------------------------------------------------------------------------

/// #4035: what the platform says about this app's network **right now**.
///
/// Unlike [`MdnsStatus`] and [`BindExposureStatus`], this is not a record of a
/// past emission, and it deliberately has no `…State` holder written by the
/// event sink. [`SyncEvent::NetworkBlockedByOs`] fires only on a *transition*
/// (`sync_daemon::android_network_block::blocked_transition`) and the dedup
/// behind that rule is process-global, so a frontend that starts listening
/// while a block is already in progress receives no event at all: the one
/// event for that block was emitted before it subscribed, and the next will
/// not come until the block ends. That is #3852's failure mode — a clean UI on
/// a device whose network is cut — for exactly the user who went looking at
/// the pairing screen *because* the network had already stopped working.
///
/// The answer is a read of the *current* status, not a replay of the last
/// transition. #4034 declined a backfill because "a status queried at mount
/// could describe a block that ended seconds ago"; that is an argument against
/// replaying a past event, and this is not one. `blocked` is the most recent
/// thing `onBlockedStatusChanged` said, updated on **every** delivery —
/// including the repeats the event stream deliberately swallows — so it cannot
/// outlive the block it describes: the platform delivers the recovery and this
/// value follows it to `false`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct OsNetworkBlockStatus {
    /// `true` while the platform's most recent statement about this uid is
    /// "blocked". `false` also covers "the platform has never said anything":
    /// a device that was never told it is blocked is not blocked, and on every
    /// platform but Android that is the only value this can take.
    pub blocked: bool,
    /// The i18n key naming the explanation to show, `Some` exactly when
    /// `blocked` — the same field, built from the same constant, as
    /// [`SyncEvent::NetworkBlockedByOs`]'s, so the frontend narrows a backfill
    /// and a live event through one code path instead of two.
    pub reason_key: Option<String>,
}

/// Event emitted when block properties change (for panel invalidation).
pub const EVENT_PROPERTY_CHANGED: &str = "block:properties-changed";

/// Payload for property change events.
#[derive(Debug, Clone, Serialize)]
pub struct PropertyChangedEvent {
    pub block_id: String,
    pub changed_keys: Vec<String>,
}

/// #2505: event emitted when an **out-of-band local write** — a write that
/// does not flow through a page store's own optimistic path — changes content
/// on one or more pages, so any open view rendering those pages reloads.
///
/// Today the sole producer is the MCP read-write tool surface
/// (`append_block` / `update_block_content` / `set_property` / `add_tag` /
/// `create_page` / `delete_block`): those land in SQL + the Loro engine but,
/// before #2505, emitted only `mcp:activity`, so an open page displaying the
/// affected block never learned about the write (stale until navigate-away-
/// and-back — `sync:complete` never fires for a same-device write). Any future
/// out-of-band local write path (deep-link-driven mutations, automations)
/// should funnel through this **one** signal rather than minting a new one.
pub const EVENT_BLOCKS_CHANGED: &str = "blocks:changed";

/// Payload for [`EVENT_BLOCKS_CHANGED`].
///
/// `changed_page_ids` carries the **identical** semantics as
/// [`SyncEvent::Complete`]'s `changed_page_ids` field (#1071): the deduped set
/// of owning *page* ids (page-root block ids) touched by the write. The
/// frontend routes this through the exact `forEachPageStore` targeted-reload
/// machinery `useSyncEvents` already uses for `sync:complete` — mounted stores
/// whose id is in the set reload (undo re-anchor first), and an empty/absent
/// set falls back to reloading every mounted store. Keeping the payload shape
/// (`changed_page_ids: string[]`) equal to the `sync:complete` field is what
/// lets the frontend consumer share one code path with no new vocabulary.
#[derive(Debug, Clone, Serialize)]
pub struct BlocksChangedEvent {
    #[serde(default)]
    pub changed_page_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// Sink trait
// ---------------------------------------------------------------------------

/// Abstraction for emitting sync events.
///
/// Implemented by `TauriEventSink` for production use and by
/// [`RecordingEventSink`] (test-only) for capturing events in tests.
pub trait SyncEventSink: Send + Sync {
    fn on_sync_event(&self, event: SyncEvent);
}

/// Blanket impl so `Arc<T: SyncEventSink>` also satisfies the trait.
impl<T: SyncEventSink> SyncEventSink for std::sync::Arc<T> {
    fn on_sync_event(&self, event: SyncEvent) {
        (**self).on_sync_event(event);
    }
}

// ---------------------------------------------------------------------------
// Helper: SyncState → string label
// ---------------------------------------------------------------------------

/// Convert backend [`SyncState`](crate::sync_protocol::SyncState) to a
/// frontend-friendly string.
pub fn sync_state_label(state: &crate::sync_protocol::SyncState) -> &'static str {
    use crate::sync_protocol::SyncState;
    match state {
        SyncState::Idle => "idle",
        SyncState::ExchangingHeads => "exchanging_heads",
        SyncState::StreamingOps => "streaming_ops",
        SyncState::ApplyingOps => "applying_ops",
        SyncState::Merging => "merging",
        SyncState::TransferringFiles => "transferring_files",
        SyncState::Complete => "complete",
        SyncState::ResetRequired => "reset_required",
        SyncState::Failed(_) => "failed",
    }
}

// ---------------------------------------------------------------------------
// Test-only recording sink
// ---------------------------------------------------------------------------

// #2621 Sync-D: gated `test-util` (not just `test`) so the app's hosted
// `sync_event_sinks` tests can build against it cross-crate.
#[cfg(any(test, feature = "test-util"))]
pub struct RecordingEventSink(pub std::sync::Mutex<Vec<SyncEvent>>);

#[cfg(any(test, feature = "test-util"))]
impl Default for RecordingEventSink {
    fn default() -> Self {
        Self(std::sync::Mutex::new(Vec::new()))
    }
}

#[cfg(any(test, feature = "test-util"))]
impl RecordingEventSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn events(&self) -> Vec<SyncEvent> {
        self.0.lock().unwrap().clone()
    }
}

#[cfg(any(test, feature = "test-util"))]
impl SyncEventSink for RecordingEventSink {
    fn on_sync_event(&self, event: SyncEvent) {
        self.0.lock().unwrap().push(event);
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_protocol::SyncState;

    #[test]
    fn sync_event_progress_serializes_with_type_tag() {
        let event = SyncEvent::Progress {
            state: "exchanging_heads".into(),
            remote_device_id: "DEV_B".into(),
            ops_received: 0,
            ops_sent: 3,
        };
        let json = serde_json::to_value(&event).expect("serialize Progress");
        assert_eq!(
            json["type"], "progress",
            "Progress variant should serialize with type=progress"
        );
        assert_eq!(
            json["state"], "exchanging_heads",
            "state field should be present"
        );
        assert_eq!(
            json["remote_device_id"], "DEV_B",
            "remote_device_id should be present"
        );
        assert_eq!(json["ops_received"], 0, "ops_received should be 0");
        assert_eq!(json["ops_sent"], 3, "ops_sent should be 3");
    }

    #[test]
    fn sync_event_complete_serializes_with_type_tag() {
        let event = SyncEvent::Complete {
            remote_device_id: "DEV_B".into(),
            ops_received: 5,
            ops_sent: 2,
            changed_page_ids: vec!["PAGE01".into(), "PAGE02".into()],
        };
        let json = serde_json::to_value(&event).expect("serialize Complete");
        assert_eq!(
            json["type"], "complete",
            "Complete variant should serialize with type=complete"
        );
        assert_eq!(json["ops_received"], 5, "ops_received should be 5");
        assert_eq!(json["ops_sent"], 2, "ops_sent should be 2");
        // #1071: the targeted-invalidation page-id set rides on Complete.
        let pages = json["changed_page_ids"]
            .as_array()
            .expect("changed_page_ids should serialize as an array");
        assert_eq!(pages.len(), 2, "both changed page ids should be present");
        assert_eq!(pages[0], "PAGE01");
        assert_eq!(pages[1], "PAGE02");
    }

    #[test]
    fn sync_event_error_serializes_with_type_tag() {
        let event = SyncEvent::Error {
            message: "something broke".into(),
            remote_device_id: "DEV_B".into(),
        };
        let json = serde_json::to_value(&event).expect("serialize Error");
        assert_eq!(
            json["type"], "error",
            "Error variant should serialize with type=error"
        );
        assert_eq!(
            json["message"], "something broke",
            "message field should be present"
        );
    }

    #[test]
    fn sync_state_label_returns_correct_strings() {
        assert_eq!(sync_state_label(&SyncState::Idle), "idle");
        assert_eq!(
            sync_state_label(&SyncState::ExchangingHeads),
            "exchanging_heads"
        );
        assert_eq!(sync_state_label(&SyncState::StreamingOps), "streaming_ops");
        assert_eq!(sync_state_label(&SyncState::ApplyingOps), "applying_ops");
        assert_eq!(sync_state_label(&SyncState::Merging), "merging");
        assert_eq!(
            sync_state_label(&SyncState::TransferringFiles),
            "transferring_files"
        );
        assert_eq!(sync_state_label(&SyncState::Complete), "complete");
        assert_eq!(
            sync_state_label(&SyncState::ResetRequired),
            "reset_required"
        );
        assert_eq!(sync_state_label(&SyncState::Failed("err".into())), "failed");
    }

    #[test]
    fn recording_event_sink_captures_events_in_order() {
        let sink = RecordingEventSink::new();

        sink.on_sync_event(SyncEvent::Progress {
            state: "exchanging_heads".into(),
            remote_device_id: "DEV_B".into(),
            ops_received: 0,
            ops_sent: 0,
        });
        sink.on_sync_event(SyncEvent::Progress {
            state: "streaming_ops".into(),
            remote_device_id: "DEV_B".into(),
            ops_received: 0,
            ops_sent: 3,
        });
        sink.on_sync_event(SyncEvent::Complete {
            remote_device_id: "DEV_B".into(),
            ops_received: 5,
            ops_sent: 3,
            changed_page_ids: Vec::new(),
        });

        let events = sink.events();
        assert_eq!(events.len(), 3, "should have captured 3 events");

        // First event: Progress with exchanging_heads
        match &events[0] {
            SyncEvent::Progress { state, .. } => {
                assert_eq!(state, "exchanging_heads", "first event state mismatch");
            }
            other => panic!("expected Progress, got {other:?}"),
        }

        // Second event: Progress with streaming_ops
        match &events[1] {
            SyncEvent::Progress { state, .. } => {
                assert_eq!(state, "streaming_ops", "second event state mismatch");
            }
            other => panic!("expected Progress, got {other:?}"),
        }

        // Third event: Complete
        match &events[2] {
            SyncEvent::Complete {
                ops_received,
                ops_sent,
                ..
            } => {
                assert_eq!(*ops_received, 5, "complete ops_received mismatch");
                assert_eq!(*ops_sent, 3, "complete ops_sent mismatch");
            }
            other => panic!("expected Complete, got {other:?}"),
        }
    }

    // #459 — edge cases

    #[test]
    fn recording_event_sink_concurrent_emission() {
        use std::sync::Arc;
        use std::thread;

        let sink = Arc::new(RecordingEventSink::new());
        let mut handles = vec![];

        for t in 0..4 {
            let s = sink.clone();
            handles.push(thread::spawn(move || {
                for i in 0..25 {
                    s.on_sync_event(SyncEvent::Progress {
                        state: format!("msg-{i}"),
                        remote_device_id: format!("peer-{t}"),
                        ops_received: 0,
                        ops_sent: 0,
                    });
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let events = sink.events();
        assert_eq!(
            events.len(),
            100,
            "4 threads × 25 events = 100 total events"
        );
    }

    #[test]
    fn recording_event_sink_large_volume() {
        let sink = RecordingEventSink::new();
        for i in 0..1000 {
            sink.on_sync_event(SyncEvent::Progress {
                state: format!("event-{i}"),
                remote_device_id: "PEER".to_string(),
                ops_received: 0,
                ops_sent: 0,
            });
        }
        let events = sink.events();
        assert_eq!(events.len(), 1000, "sink should hold 1000+ events");
    }

    #[test]
    fn recording_event_sink_special_characters_in_message() {
        let sink = RecordingEventSink::new();
        let special = "emoji: 📱 — unicode: é à ü — control: \t\n — quotes: \"hello\"";
        sink.on_sync_event(SyncEvent::Progress {
            state: special.to_string(),
            remote_device_id: "PEER".to_string(),
            ops_received: 0,
            ops_sent: 0,
        });
        let events = sink.events();
        assert_eq!(events.len(), 1, "one event should be recorded");
        match &events[0] {
            SyncEvent::Progress { state, .. } => {
                assert_eq!(state, special, "special characters should roundtrip");
            }
            _ => panic!("expected Progress event"),
        }
    }

    #[test]
    fn property_changed_event_serializes_correctly() {
        let event = PropertyChangedEvent {
            block_id: "BLK01".to_string(),
            changed_keys: vec!["todo_state".to_string(), "completed_at".to_string()],
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("BLK01"));
        assert!(json.contains("todo_state"));
        assert!(json.contains("completed_at"));
    }

    #[test]
    fn property_changed_event_serialization_roundtrip() {
        let event = PropertyChangedEvent {
            block_id: "block-42".to_string(),
            changed_keys: vec!["title".to_string(), "priority".to_string()],
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["block_id"], "block-42", "block_id should roundtrip");
        let keys = json["changed_keys"].as_array().unwrap();
        assert_eq!(keys.len(), 2, "changed_keys should have 2 entries");
        assert_eq!(keys[0], "title");
        assert_eq!(keys[1], "priority");
    }

    #[test]
    fn event_name_constants_have_expected_values() {
        assert_eq!(EVENT_SYNC_PROGRESS, "sync:progress");
        assert_eq!(EVENT_SYNC_COMPLETE, "sync:complete");
        assert_eq!(EVENT_SYNC_ERROR, "sync:error");
        assert_eq!(EVENT_SYNC_MDNS_DISABLED, "sync:mdns_disabled");
        assert_eq!(EVENT_PROPERTY_CHANGED, "block:properties-changed");
        // #3852 — mirrored by `SYNC_NETWORK_BLOCKED_EVENT` in
        // `src/hooks/useOsNetworkBlock.ts`. The two sides share no type; the
        // only thing keeping the listener attached to the emitter is that this
        // string does not change.
        assert_eq!(EVENT_SYNC_NETWORK_BLOCKED, "sync:network_blocked");
    }

    // ── NetworkBlockedByOs variant (#3852) ─────────────────────────

    /// The pairing dialog reads `blocked` and `reason_key` off this payload by
    /// name. Serde renames the tag but not the fields, so a variant rename or a
    /// field rename would silently produce an event no listener recognises —
    /// which is the same "everything looks fine, nothing happens" shape #3852
    /// is about.
    ///
    /// The field is spelled `reason_key`, not `reason`, on purpose: what
    /// crosses this boundary is an i18n key the frontend translates. A field
    /// carrying English would be shown verbatim to every non-English user.
    #[test]
    fn sync_event_network_blocked_serializes_with_type_tag_and_both_fields() {
        let event = SyncEvent::NetworkBlockedByOs {
            blocked: true,
            reason_key: Some("pairing.osNetworkBlocked".into()),
        };
        let json = serde_json::to_value(&event).expect("serialize NetworkBlockedByOs");
        assert_eq!(
            json["type"], "network_blocked_by_os",
            "the variant must serialize with its snake_case type tag"
        );
        assert_eq!(
            json["blocked"], true,
            "the frontend gates the whole banner on this flag"
        );
        assert_eq!(
            json["reason_key"], "pairing.osNetworkBlocked",
            "the key is what the frontend translates; it must round-trip under \
             this exact field name"
        );
    }

    /// The recovery direction has to serialize too — it is what clears the
    /// banner. A payload that only ever carried `true` would leave the warning
    /// on screen after the block lifted. It carries `reason_key: null`, because
    /// a cleared banner has no text.
    #[test]
    fn sync_event_network_blocked_carries_the_recovery_direction() {
        let event = SyncEvent::NetworkBlockedByOs {
            blocked: false,
            reason_key: None,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "network_blocked_by_os");
        assert_eq!(json["blocked"], false);
        assert!(
            json["reason_key"].is_null(),
            "a recovery names no string to show, got: {json}"
        );
    }

    // ── MdnsDisabled variant ──────────────────────────────────────

    #[test]
    fn sync_event_mdns_disabled_serializes_with_type_tag() {
        let event = SyncEvent::MdnsDisabled {
            reason: "multicast lock missing".into(),
        };
        let json = serde_json::to_value(&event).expect("serialize MdnsDisabled");
        assert_eq!(
            json["type"], "mdns_disabled",
            "MdnsDisabled variant should serialize with snake_case type tag"
        );
        assert_eq!(
            json["reason"], "multicast lock missing",
            "reason field should round-trip"
        );
    }

    #[test]
    fn sync_event_mdns_disabled_empty_reason() {
        let event = SyncEvent::MdnsDisabled {
            reason: String::new(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "mdns_disabled");
        assert_eq!(json["reason"], "");
    }

    #[test]
    fn recording_sink_captures_mdns_disabled() {
        let sink = RecordingEventSink::new();
        sink.on_sync_event(SyncEvent::MdnsDisabled {
            reason: "io error: raw socket blocked".into(),
        });
        let events = sink.events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SyncEvent::MdnsDisabled { reason } => {
                assert_eq!(reason, "io error: raw socket blocked");
            }
            other => panic!("expected MdnsDisabled, got {other:?}"),
        }
    }

    // ── MdnsStatus / MdnsStatusState (#2506 backfill) ───────────────

    #[test]
    fn mdns_status_default_is_not_disabled() {
        let status = MdnsStatus::default();
        assert!(!status.disabled);
        assert_eq!(status.reason, None);
    }

    #[test]
    fn mdns_status_state_round_trips_disabled() {
        let state = MdnsStatusState(std::sync::Mutex::new(MdnsStatus {
            disabled: true,
            reason: Some("multicast lock missing".to_string()),
        }));
        let got = state.0.lock().unwrap().clone();
        assert!(got.disabled);
        assert_eq!(got.reason, Some("multicast lock missing".to_string()));
    }

    #[test]
    fn mdns_status_serializes_camel_case() {
        let status = MdnsStatus {
            disabled: true,
            reason: Some("sandboxed platform".to_string()),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["disabled"], true);
        assert_eq!(json["reason"], "sandboxed platform");
    }

    // ── InternetFacingBind / BindExposureStatus (#3864) ─────────────

    /// The frontend reads `address` and `port` off the raw event payload, so
    /// those key names are wire contract, not implementation detail.
    #[test]
    fn internet_facing_bind_serializes_address_and_port() {
        let event = SyncEvent::InternetFacingBind {
            address: "192.160.160.80".into(),
            port: 54321,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "internet_facing_bind");
        assert_eq!(json["address"], "192.160.160.80");
        assert_eq!(json["port"], 54321);
    }

    #[test]
    fn bind_exposure_status_default_is_not_internet_facing() {
        let status = BindExposureStatus::default();
        assert_eq!(
            status.internet_facing, None,
            "a device that has not bound a routable address must have nothing to warn about"
        );
    }

    #[test]
    fn bind_exposure_status_serializes_the_nested_bind() {
        let status = BindExposureStatus {
            internet_facing: Some(InternetFacingBind {
                address: "203.0.113.9".into(),
                port: 41234,
            }),
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["internet_facing"]["address"], "203.0.113.9");
        assert_eq!(json["internet_facing"]["port"], 41234);
    }

    #[test]
    fn arc_blanket_impl_forwards_events() {
        use std::sync::Arc;
        let sink = Arc::new(RecordingEventSink::new());
        // Call on_sync_event through the Arc (exercises the blanket impl)
        SyncEventSink::on_sync_event(
            &sink,
            SyncEvent::Progress {
                state: "arc_test".into(),
                remote_device_id: "DEV_ARC".into(),
                ops_received: 1,
                ops_sent: 2,
            },
        );
        let events = sink.events();
        assert_eq!(events.len(), 1, "Arc blanket impl should forward event");
        match &events[0] {
            SyncEvent::Progress {
                state,
                remote_device_id,
                ops_received,
                ops_sent,
            } => {
                assert_eq!(state, "arc_test");
                assert_eq!(remote_device_id, "DEV_ARC");
                assert_eq!(*ops_received, 1);
                assert_eq!(*ops_sent, 2);
            }
            other => panic!("expected Progress, got {other:?}"),
        }
    }

    #[test]
    fn sync_event_progress_all_fields_in_json() {
        let event = SyncEvent::Progress {
            state: "streaming_ops".into(),
            remote_device_id: "DEVICE_X".into(),
            ops_received: 100,
            ops_sent: 200,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "progress");
        assert_eq!(json["state"], "streaming_ops");
        assert_eq!(json["remote_device_id"], "DEVICE_X");
        assert_eq!(json["ops_received"], 100);
        assert_eq!(json["ops_sent"], 200);
        // Verify exactly 5 fields (type, state, remote_device_id, ops_received, ops_sent)
        let obj = json.as_object().unwrap();
        assert_eq!(obj.len(), 5, "Progress JSON should have exactly 5 fields");
    }

    #[test]
    fn sync_event_error_with_empty_message() {
        let event = SyncEvent::Error {
            message: String::new(),
            remote_device_id: "DEV_EMPTY".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "error");
        assert_eq!(
            json["message"], "",
            "empty message should serialize as empty string"
        );
        assert_eq!(json["remote_device_id"], "DEV_EMPTY");
    }

    #[test]
    fn recording_event_sink_new_starts_empty() {
        let sink = RecordingEventSink::new();
        assert!(
            sink.events().is_empty(),
            "fresh RecordingEventSink should have no events"
        );
    }
}
