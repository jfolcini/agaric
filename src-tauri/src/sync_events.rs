//! Sync event types and emission infrastructure.
//!
//! The [`SyncEventSink`] trait decouples the [`SyncOrchestrator`](crate::sync_protocol::SyncOrchestrator)
//! from Tauri, allowing tests to capture events without an `AppHandle`.

use serde::Serialize;

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

pub const EVENT_SYNC_PROGRESS: &str = "sync:progress";
pub const EVENT_SYNC_COMPLETE: &str = "sync:complete";
pub const EVENT_SYNC_ERROR: &str = "sync:error";

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
        };
        let _ = self.0.emit(event_name, &event);
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
        assert_eq!(events.len(), 100, "4 threads × 25 events = 100 total events");
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
}
