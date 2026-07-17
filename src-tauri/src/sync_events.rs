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
    /// its multicast lock). Sync still works via manual IP entry, but the
    /// frontend should surface this to the user instead of showing an
    /// Empty peer list. See.
    MdnsDisabled { reason: String },
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

// ---------------------------------------------------------------------------
// mDNS status (#2506) — backfill for the peers/device-management surface
// ---------------------------------------------------------------------------

/// #2506: durable, user-visible mDNS peer-discovery status.
///
/// Derived from the [`SyncEvent::MdnsDisabled`] event (whose `reason` field
/// it mirrors) and returned by the `get_mdns_status` command so a frontend
/// that mounts after the sync daemon already emitted the event (same boot
/// race as `recovery:degraded`, see [`crate::recovery::RecoveryStatus`])
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

#[cfg(test)]
pub struct RecordingEventSink(pub std::sync::Mutex<Vec<SyncEvent>>);

#[cfg(test)]
impl Default for RecordingEventSink {
    fn default() -> Self {
        Self(std::sync::Mutex::new(Vec::new()))
    }
}

#[cfg(test)]
impl RecordingEventSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn events(&self) -> Vec<SyncEvent> {
        self.0.lock().unwrap().clone()
    }
}

#[cfg(test)]
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
