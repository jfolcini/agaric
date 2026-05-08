//! Sync event types and emission infrastructure.
//!
//! The [`SyncEventSink`] trait decouples the [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator)
//! from Tauri, allowing tests to capture events without an `AppHandle`.

use serde::Serialize;
use specta::Type;

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

/// Streaming progress payload carried over the sync channel.
///
/// PEND-06 Tier 2 made this a tagged enum so a single channel per sync
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
    },
    Error {
        message: String,
        remote_device_id: String,
    },
    /// PEND-06 Tier 2: per-frame attachment-transfer progress emitted
    /// by `sync_files`. The [`ChannelEventSink`] forwards these to the
    /// `Channel<SyncProgressUpdate>` as the `Files` variant; the
    /// production [`TauriEventSink`] drops them (no `app.emit`
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
    /// Emitted when mDNS peer discovery cannot be initialized (e.g. the
    /// iOS sandbox blocks raw UDP multicast, or the Android app is missing
    /// its multicast lock). Sync still works via manual IP entry, but the
    /// frontend should surface this to the user instead of showing an
    /// empty peer list. See BUG-38 / BUG-39.
    MdnsDisabled { reason: String },
}

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

pub const EVENT_SYNC_PROGRESS: &str = "sync:progress";
pub const EVENT_SYNC_COMPLETE: &str = "sync:complete";
pub const EVENT_SYNC_ERROR: &str = "sync:error";
/// Emitted when mDNS peer discovery is unavailable on this device
/// (BUG-38). Payload is [`SyncEvent::MdnsDisabled`].
pub const EVENT_SYNC_MDNS_DISABLED: &str = "sync:mdns_disabled";

/// Event emitted when block properties change (for panel invalidation).
pub const EVENT_PROPERTY_CHANGED: &str = "block:properties-changed";

/// Payload for property change events.
#[derive(Debug, Clone, Serialize)]
pub struct PropertyChangedEvent {
    pub block_id: String,
    pub changed_keys: Vec<String>,
}

// ---------------------------------------------------------------------------
// Sink trait
// ---------------------------------------------------------------------------

/// Abstraction for emitting sync events.
///
/// Implemented by [`TauriEventSink`] for production use and by
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
// Tauri production sink
// ---------------------------------------------------------------------------

/// Wraps a [`tauri::AppHandle`] to emit real Tauri events.
pub struct TauriEventSink<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> SyncEventSink for TauriEventSink<R> {
    fn on_sync_event(&self, event: SyncEvent) {
        use tauri::Emitter;
        let event_name = match &event {
            SyncEvent::Progress { .. } => EVENT_SYNC_PROGRESS,
            SyncEvent::Complete { .. } => EVENT_SYNC_COMPLETE,
            SyncEvent::Error { .. } => EVENT_SYNC_ERROR,
            SyncEvent::MdnsDisabled { .. } => EVENT_SYNC_MDNS_DISABLED,
            // PEND-06 Tier 2: file-transfer progress was never on the
            // legacy `app.emit` bus, so this sink drops it. The
            // canonical path is `ChannelEventSink` → `Channel<…>::Files`;
            // a `TauriEventSink` reached without the channel wrapper
            // means no active sync command is listening, and there's
            // nothing for a side-channel `app.emit` to deliver to.
            SyncEvent::FileProgress { .. } => return,
        };
        if let Err(e) = self.0.emit(event_name, &event) {
            tracing::warn!(%event_name, error = %e, "Failed to emit sync event");
        }
    }
}

/// A sink that forwards events to an underlying sink AND a Tauri IPC channel,
/// with PEND-06 Phase 2 semantics: `Progress` events go to the channel only
/// (the inner sink's `sync:progress` `app.emit` was the dual-emission
/// migration runway in Phase 1 and is no longer needed now that
/// `useSyncEvents` has dropped the `sync:progress` listener).
///
/// `Complete` and `Error` events still dual-emit because the inner sink's
/// `sync:complete` / `sync:error` listeners in `useSyncEvents` carry
/// post-sync side effects (toast, page reload, conflict-list refresh) that
/// the channel callback in `useSyncTrigger` does not duplicate. Other
/// non-progress events (e.g. `MdnsDisabled`) hit the inner sink only —
/// the channel is reserved for the active sync's progress stream.
///
/// PEND-06 Tier 2 added the `FileProgress` variant: it goes to the
/// channel only (no legacy `app.emit` listener to keep in lockstep) and
/// is delivered as `SyncProgressUpdate::Files`.
pub struct ChannelEventSink {
    pub inner: std::sync::Arc<dyn SyncEventSink>,
    pub channel: tauri::ipc::Channel<SyncProgressUpdate>,
}

impl SyncEventSink for ChannelEventSink {
    fn on_sync_event(&self, event: SyncEvent) {
        // PEND-06 Phase 2 — Progress events go to the channel ONLY. The
        // inner sink's `sync:progress` `app.emit` from Phase 1 has no
        // remaining frontend consumer (`useSyncEvents` dropped its
        // listener in lockstep with this commit), so the dual-emit
        // would burn an extra serialise + IPC round-trip per state
        // transition (~10 per sync) for nobody to listen to.
        //
        // Complete + Error stay dual-emit for now because
        // `useSyncEvents.sync:complete` / `.sync:error` carry
        // post-sync side effects (toast, page reload, conflict refresh)
        // that the channel-stream callback in `useSyncTrigger` does
        // not own. A later cleanup can move those side effects into
        // the channel path and drop the inner emission for Complete
        // + Error too — out of scope for PEND-06 Phase 2.
        //
        // PEND-06 Tier 2 — FileProgress is channel-only by construction:
        // the legacy event bus never carried per-frame attachment
        // progress, so there's no inner listener to feed.
        let channel_only = matches!(
            event,
            SyncEvent::Progress { .. } | SyncEvent::FileProgress { .. }
        );
        if !channel_only {
            self.inner.on_sync_event(event.clone());
        }

        // Forward progress updates to the channel
        match event {
            SyncEvent::Progress {
                state,
                remote_device_id,
                ops_received,
                ops_sent,
            } => {
                let _ = self.channel.send(SyncProgressUpdate::Sync {
                    state,
                    remote_device_id,
                    ops_received: ops_received as u64,
                    ops_sent: ops_sent as u64,
                });
            }
            SyncEvent::Complete {
                remote_device_id,
                ops_received,
                ops_sent,
            } => {
                let _ = self.channel.send(SyncProgressUpdate::Sync {
                    state: "complete".to_string(),
                    remote_device_id,
                    ops_received: ops_received as u64,
                    ops_sent: ops_sent as u64,
                });
            }
            SyncEvent::Error {
                message: _,
                remote_device_id,
            } => {
                let _ = self.channel.send(SyncProgressUpdate::Sync {
                    state: "error".to_string(),
                    remote_device_id,
                    ops_received: 0,
                    ops_sent: 0,
                });
            }
            SyncEvent::FileProgress {
                phase,
                remote_device_id,
                files_done,
                files_total,
                bytes_done,
                bytes_total,
            } => {
                let _ = self.channel.send(SyncProgressUpdate::Files {
                    phase,
                    remote_device_id,
                    files_done,
                    files_total,
                    bytes_done,
                    bytes_total,
                });
            }
            _ => {}
        }
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
        };
        let json = serde_json::to_value(&event).expect("serialize Complete");
        assert_eq!(
            json["type"], "complete",
            "Complete variant should serialize with type=complete"
        );
        assert_eq!(json["ops_received"], 5, "ops_received should be 5");
        assert_eq!(json["ops_sent"], 2, "ops_sent should be 2");
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
        });

        let events = sink.events();
        assert_eq!(events.len(), 3, "should have captured 3 events");

        // First event: Progress with exchanging_heads
        match &events[0] {
            SyncEvent::Progress { state, .. } => {
                assert_eq!(state, "exchanging_heads", "first event state mismatch");
            }
            other => panic!("expected Progress, got {:?}", other),
        }

        // Second event: Progress with streaming_ops
        match &events[1] {
            SyncEvent::Progress { state, .. } => {
                assert_eq!(state, "streaming_ops", "second event state mismatch");
            }
            other => panic!("expected Progress, got {:?}", other),
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
            other => panic!("expected Complete, got {:?}", other),
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

    // ── BUG-38: MdnsDisabled variant ──────────────────────────────────────

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
        let event = SyncEvent::MdnsDisabled { reason: "".into() };
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
            other => panic!("expected Progress, got {:?}", other),
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
            message: "".into(),
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

    // ── PEND-06 Phase 1 — Channel<T> dual-emission contract ───────────────────
    //
    // ChannelEventSink wraps an inner sink (production: TauriEventSink for
    // legacy `app.emit` consumers) and a `tauri::ipc::Channel<T>` (new
    // streaming path). The contract during the Phase 1 transition window:
    // every event reaches the inner sink, AND Progress/Complete/Error events
    // also reach the channel as a [`SyncProgressUpdate`]. The next-release
    // Phase 2 cleanup will drop the duplicate inner emission for the three
    // progress-shaped variants, so these tests pin the dual-emission
    // semantics now and will be updated in lockstep with that change.

    use std::sync::Arc;

    /// Build a `Channel<SyncProgressUpdate>` whose payloads land in a
    /// shared `Vec` for assertion. The `Channel::new` constructor is the
    /// public API; the message handler receives an `InvokeResponseBody`
    /// that wraps a JSON payload, which we deserialize back into the
    /// strongly-typed update.
    fn capturing_channel() -> (
        tauri::ipc::Channel<SyncProgressUpdate>,
        Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
    ) {
        // SyncProgressUpdate is serde_serialize-only (no Deserialize) so
        // the test captures the raw JSON `Value` and reads fields by key.
        let captured: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);
        let channel = tauri::ipc::Channel::<SyncProgressUpdate>::new(move |body| {
            // `Channel.send(SyncProgressUpdate)` serializes the typed
            // payload into an `InvokeResponseBody::Json(String)`. Match
            // the Json variant explicitly so a future internal change
            // (e.g. binary frames) is a deliberate test update rather
            // than a silent miss.
            let json_str = match body {
                tauri::ipc::InvokeResponseBody::Json(s) => s,
                tauri::ipc::InvokeResponseBody::Raw(_) => {
                    panic!("expected JSON channel payload, got binary")
                }
            };
            let parsed: serde_json::Value =
                serde_json::from_str(&json_str).expect("channel body must be valid JSON");
            captured_clone.lock().unwrap().push(parsed);
            Ok(())
        });
        (channel, captured)
    }

    #[test]
    fn channel_event_sink_progress_forwards_only_to_channel() {
        // PEND-06 Phase 2 — Progress events are channel-only now. The
        // inner sink's `sync:progress` app.emit from Phase 1 had no
        // remaining frontend consumer once `useSyncEvents` dropped its
        // listener, so we stopped paying for an extra IPC round-trip
        // per state transition that nobody was listening to. A future
        // peer-discovery / conflict-notification consumer of the inner
        // sink is unaffected — they hit different SyncEvent variants.
        let inner = Arc::new(RecordingEventSink::new());
        let (channel, captured) = capturing_channel();
        let sink = ChannelEventSink {
            inner: Arc::clone(&inner) as Arc<dyn SyncEventSink>,
            channel,
        };

        let event = SyncEvent::Progress {
            state: "streaming_ops".into(),
            remote_device_id: "DEV_PEER".into(),
            ops_received: 7,
            ops_sent: 3,
        };
        sink.on_sync_event(event.clone());

        // Phase 2 contract: inner sink stays silent on Progress.
        assert!(
            inner.events().is_empty(),
            "Phase 2: inner sink must NOT observe Progress events (channel is canonical)",
        );

        let channel_msgs = captured.lock().unwrap().clone();
        assert_eq!(
            channel_msgs.len(),
            1,
            "channel must receive a SyncProgressUpdate for Progress events"
        );
        // PEND-06 Tier 2: SyncProgressUpdate is now a tagged enum
        // (`#[serde(tag = "kind")]`). Op-sync transitions land as
        // `kind: "sync"`; the file-transfer path uses `kind: "files"`.
        assert_eq!(channel_msgs[0]["kind"], "sync");
        assert_eq!(channel_msgs[0]["state"], "streaming_ops");
        assert_eq!(channel_msgs[0]["remote_device_id"], "DEV_PEER");
        assert_eq!(channel_msgs[0]["ops_received"], 7);
        assert_eq!(channel_msgs[0]["ops_sent"], 3);
    }

    #[test]
    fn channel_event_sink_complete_translates_to_complete_state() {
        let inner = Arc::new(RecordingEventSink::new());
        let (channel, captured) = capturing_channel();
        let sink = ChannelEventSink {
            inner: Arc::clone(&inner) as Arc<dyn SyncEventSink>,
            channel,
        };

        sink.on_sync_event(SyncEvent::Complete {
            remote_device_id: "DEV_PEER".into(),
            ops_received: 12,
            ops_sent: 4,
        });

        // Inner sink sees the original Complete variant (semantics
        // preserved for legacy listeners).
        assert_eq!(inner.events().len(), 1);
        // Channel receives a SyncProgressUpdate::Sync with state="complete" —
        // PEND-06 normalises Complete + Error into the same envelope so
        // the frontend has a single switch on `state` rather than two
        // different shapes.
        let msgs = captured.lock().unwrap().clone();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["kind"], "sync");
        assert_eq!(msgs[0]["state"], "complete");
        assert_eq!(msgs[0]["ops_received"], 12);
        assert_eq!(msgs[0]["ops_sent"], 4);
    }

    #[test]
    fn channel_event_sink_error_translates_to_error_state_with_zero_counts() {
        let inner = Arc::new(RecordingEventSink::new());
        let (channel, captured) = capturing_channel();
        let sink = ChannelEventSink {
            inner: Arc::clone(&inner) as Arc<dyn SyncEventSink>,
            channel,
        };

        sink.on_sync_event(SyncEvent::Error {
            message: "kapow".into(),
            remote_device_id: "DEV_PEER".into(),
        });

        assert_eq!(inner.events().len(), 1);
        let msgs = captured.lock().unwrap().clone();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["kind"], "sync");
        assert_eq!(msgs[0]["state"], "error");
        // SyncEvent::Error doesn't carry ops counts, so the channel
        // payload reports 0/0 — pinned here so a future "carry the last
        // known counts" change is a deliberate decision.
        assert_eq!(msgs[0]["ops_received"], 0);
        assert_eq!(msgs[0]["ops_sent"], 0);
    }

    #[test]
    fn channel_event_sink_file_progress_forwards_to_channel_only() {
        // PEND-06 Tier 2 — FileProgress is channel-only by construction.
        // The legacy event bus never carried per-frame attachment
        // progress, so the inner sink stays silent and the channel
        // receives a `SyncProgressUpdate::Files` payload.
        let inner = Arc::new(RecordingEventSink::new());
        let (channel, captured) = capturing_channel();
        let sink = ChannelEventSink {
            inner: Arc::clone(&inner) as Arc<dyn SyncEventSink>,
            channel,
        };

        sink.on_sync_event(SyncEvent::FileProgress {
            phase: "sending".into(),
            remote_device_id: "DEV_PEER".into(),
            files_done: 1,
            files_total: 3,
            bytes_done: 5_000_000,
            bytes_total: 15_000_000,
        });

        assert!(
            inner.events().is_empty(),
            "FileProgress must NOT reach the inner sink (channel is canonical)"
        );

        let msgs = captured.lock().unwrap().clone();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["kind"], "files");
        assert_eq!(msgs[0]["phase"], "sending");
        assert_eq!(msgs[0]["remote_device_id"], "DEV_PEER");
        assert_eq!(msgs[0]["files_done"], 1);
        assert_eq!(msgs[0]["files_total"], 3);
        assert_eq!(msgs[0]["bytes_done"], 5_000_000);
        assert_eq!(msgs[0]["bytes_total"], 15_000_000);
    }

    #[test]
    fn channel_event_sink_skips_non_progress_events() {
        // MdnsDisabled is a peer-discovery event, not a sync-progress
        // update — it must NOT land on the channel (which is reserved
        // for the active sync's Progress/Complete/Error stream).
        let inner = Arc::new(RecordingEventSink::new());
        let (channel, captured) = capturing_channel();
        let sink = ChannelEventSink {
            inner: Arc::clone(&inner) as Arc<dyn SyncEventSink>,
            channel,
        };

        sink.on_sync_event(SyncEvent::MdnsDisabled {
            reason: "test".into(),
        });

        // Inner sink still sees it (legacy listener path stays intact).
        assert_eq!(inner.events().len(), 1);
        // Channel stays silent — no progress update.
        assert!(
            captured.lock().unwrap().is_empty(),
            "non-progress events must not produce a channel payload"
        );
    }
}
