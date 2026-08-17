//! Tauri-backed sync event sinks (#2621 agaric-sync split).
//!
//! The pure `SyncEvent` / `SyncProgressUpdate` types and the `SyncEventSink`
//! trait live in [`agaric_sync::sync_events`]; this app-side module holds the two
//! concrete sinks that depend on Tauri — `TauriEventSink` (real `app.emit`
//! events + `MdnsStatusState` backfill) and `ChannelEventSink` (the
//! `tauri::ipc::Channel` streaming path). Keeping them out of `sync_events`
//! leaves that module free of any Tauri dependency.

use agaric_sync::sync_events::{
    BindExposureStatus, BindExposureStatusState, EVENT_SYNC_COMPLETE, EVENT_SYNC_ERROR,
    EVENT_SYNC_INTERNET_FACING_BIND, EVENT_SYNC_MDNS_DISABLED, EVENT_SYNC_NETWORK_BLOCKED,
    EVENT_SYNC_PROGRESS, InternetFacingBind, MdnsStatus, MdnsStatusState, SyncEvent, SyncEventSink,
    SyncProgressUpdate,
};

// ---------------------------------------------------------------------------
// Tauri production sink
// ---------------------------------------------------------------------------

/// Wraps a [`tauri::AppHandle`] to emit real Tauri events.
pub struct TauriEventSink<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> SyncEventSink for TauriEventSink<R> {
    fn on_sync_event(&self, event: SyncEvent) {
        use tauri::{Emitter, Manager};
        let event_name = match &event {
            SyncEvent::Progress { .. } => EVENT_SYNC_PROGRESS,
            SyncEvent::Complete { .. } => EVENT_SYNC_COMPLETE,
            SyncEvent::Error { .. } => EVENT_SYNC_ERROR,
            SyncEvent::MdnsDisabled { .. } => EVENT_SYNC_MDNS_DISABLED,
            SyncEvent::InternetFacingBind { .. } => EVENT_SYNC_INTERNET_FACING_BIND,
            // #3852 — the OS says it is dropping this app's packets. Goes on
            // the legacy `app.emit` bus, like the other two "why is discovery
            // not working" events: its audience is the pairing dialog and the
            // device-management surface, not an active sync's progress stream.
            SyncEvent::NetworkBlockedByOs { .. } => EVENT_SYNC_NETWORK_BLOCKED,
            // File-transfer progress was never on the
            // legacy `app.emit` bus, so this sink drops it. The
            // canonical path is `ChannelEventSink` → `Channel<…>::Files`;
            // a `TauriEventSink` reached without the channel wrapper
            // means no active sync command is listening, and there's
            // nothing for a side-channel `app.emit` to deliver to.
            SyncEvent::FileProgress { .. } => return,
            // Snapshot-transfer progress, like FileProgress, was never on
            // the legacy `app.emit` bus — the channel is the canonical
            // source — so this sink drops it.
            SyncEvent::SnapshotProgress { .. } => return,
        };

        // #2506: persist the mDNS status into managed state BEFORE emitting
        // so `get_mdns_status` backfills a frontend whose `sync:mdns_disabled`
        // listener registers after this emission (the daemon can start
        // before the webview finishes mounting, same race `recovery:degraded`
        // has). Normal production setup manages `MdnsStatusState` before the
        // daemon can invoke this sink. `try_state` (not `state`) preserves
        // non-panicking behavior for optional or minimally configured hosts
        // that construct the concrete sink without that managed state.
        if let SyncEvent::MdnsDisabled { reason } = &event
            && let Some(status) = self.0.try_state::<MdnsStatusState>()
            && let Ok(mut guard) = status.0.lock()
        {
            *guard = MdnsStatus {
                disabled: true,
                reason: Some(reason.clone()),
            };
        }

        // #3864: same backfill, same reason, sharper race. The endpoint binds
        // in the opening moments of `daemon_loop` — well before a webview that
        // is still mounting could have registered a
        // `sync:internet_facing_bind` listener — so without this write the
        // banner would essentially never appear. `try_state` for the same
        // reason as above.
        if let SyncEvent::InternetFacingBind { address, port } = &event
            && let Some(status) = self.0.try_state::<BindExposureStatusState>()
            && let Ok(mut guard) = status.0.lock()
        {
            *guard = BindExposureStatus {
                internet_facing: Some(InternetFacingBind {
                    address: address.clone(),
                    port: *port,
                }),
            };
        }

        if let Err(e) = self.0.emit(event_name, &event) {
            tracing::warn!(%event_name, error = %e, "Failed to emit sync event");
        }
    }
}

/// A sink that forwards events to an underlying sink AND a Tauri IPC channel,
/// With Phase 2 semantics: `Progress` events go to the channel only
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
/// Added the `FileProgress` variant: it goes to the
/// channel only (no legacy `app.emit` listener to keep in lockstep) and
/// is delivered as `SyncProgressUpdate::Files`.
pub struct ChannelEventSink {
    pub inner: std::sync::Arc<dyn SyncEventSink>,
    pub channel: tauri::ipc::Channel<SyncProgressUpdate>,
}

impl SyncEventSink for ChannelEventSink {
    fn on_sync_event(&self, event: SyncEvent) {
        // Phase 2 — Progress events go to the channel ONLY. The
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
        // + Error too — out of scope for Phase 2.
        //
        // FileProgress is channel-only by construction:
        // the legacy event bus never carried per-frame attachment
        // progress, so there's no inner listener to feed.
        let channel_only = matches!(
            event,
            SyncEvent::Progress { .. }
                | SyncEvent::FileProgress { .. }
                | SyncEvent::SnapshotProgress { .. }
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
                // #1071: the channel `Sync` progress envelope is the
                // per-state-transition stream consumed by `useSyncTrigger`;
                // it carries no page-invalidation set. The targeted reload
                // is driven from the inner-sink `sync:complete` event (the
                // dual-emit above clones the full SyncEvent, page ids and
                // all), so the channel deliberately ignores this field.
                changed_page_ids: _,
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
            SyncEvent::SnapshotProgress {
                phase,
                remote_device_id,
                bytes_done,
                bytes_total,
            } => {
                let _ = self.channel.send(SyncProgressUpdate::Snapshot {
                    phase,
                    remote_device_id,
                    bytes_done,
                    bytes_total,
                });
            }
            _ => {}
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    // ── Phase 1 — Channel<T> dual-emission contract ───────────────────
    //
    // ChannelEventSink wraps an inner sink (production: TauriEventSink for
    // legacy `app.emit` consumers) and a `tauri::ipc::Channel<T>` (new
    // streaming path). The contract during the Phase 1 transition window:
    // every event reaches the inner sink, AND Progress/Complete/Error events
    // also reach the channel as a [`SyncProgressUpdate`]. The next-release
    // Phase 2 cleanup will drop the duplicate inner emission for the three
    // progress-shaped variants, so these tests pin the dual-emission
    // semantics now and will be updated in lockstep with that change.

    use super::{ChannelEventSink, TauriEventSink};
    use agaric_sync::sync_events::{
        BindExposureStatus, BindExposureStatusState, EVENT_SYNC_INTERNET_FACING_BIND,
        EVENT_SYNC_MDNS_DISABLED, InternetFacingBind, MdnsStatus, MdnsStatusState,
        RecordingEventSink, SyncEvent, SyncEventSink, SyncProgressUpdate,
    };
    use std::sync::Arc;
    use tauri::{Listener, Manager};

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
    fn tauri_event_sink_mdns_disabled_backfills_managed_status() {
        let app = tauri::test::mock_app();
        app.manage(MdnsStatusState(
            std::sync::Mutex::new(MdnsStatus::default()),
        ));
        let sink = TauriEventSink(app.handle().clone());

        sink.on_sync_event(SyncEvent::MdnsDisabled {
            reason: "multicast unavailable".into(),
        });

        let status = app.state::<MdnsStatusState>();
        let actual = status.0.lock().expect("mDNS status mutex not poisoned");
        assert_eq!(
            *actual,
            MdnsStatus {
                disabled: true,
                reason: Some("multicast unavailable".into()),
            },
            "the concrete Tauri sink must backfill the exact managed mDNS status"
        );
    }

    #[test]
    fn tauri_event_sink_mdns_disabled_without_managed_status_still_emits() {
        // Deliberately no `app.manage(MdnsStatusState(..))`: this is the
        // optional/minimally-configured host the `try_state` (rather than
        // `state`) call in the sink exists for. The guarantee under test is
        // that the missing managed state neither panics nor swallows the
        // event — the `sync:mdns_disabled` emission still reaches the bus
        // with its reason intact. Asserting on the emission (rather than on
        // `try_state().is_none()`, which merely restates this setup) is what
        // makes a regression to `state()` or to an early return visible.
        let app = tauri::test::mock_app();
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_clone = Arc::clone(&seen);
        app.listen(EVENT_SYNC_MDNS_DISABLED, move |event| {
            seen_clone.lock().unwrap().push(event.payload().to_string());
        });
        let sink = TauriEventSink(app.handle().clone());

        sink.on_sync_event(SyncEvent::MdnsDisabled {
            reason: "not managed in this host".into(),
        });

        let payloads = seen.lock().expect("emitted-event capture not poisoned");
        assert_eq!(
            payloads.len(),
            1,
            "the sink must still emit `{EVENT_SYNC_MDNS_DISABLED}` exactly once when \
             the host manages no `MdnsStatusState`, got {payloads:?}"
        );
        assert!(
            payloads[0].contains("not managed in this host"),
            "the emitted payload must carry the disable reason, got {}",
            payloads[0]
        );
    }

    /// #3864 boot race: the endpoint binds in the opening moments of
    /// `daemon_loop`, so a webview that is still mounting misses the live
    /// `sync:internet_facing_bind` event outright. The listener here registers
    /// **after** the emission on purpose — that is the production ordering, not
    /// a contrived one — and the assertions are the two halves of the fix: the
    /// late listener genuinely receives nothing, and the managed status the
    /// `get_bind_exposure_status` command reads still carries the bind.
    ///
    /// Without the durable status this feature would be a banner nobody ever
    /// sees, and a test that only emitted-then-listened would not notice.
    #[test]
    fn internet_facing_bind_status_survives_a_listener_that_registers_late() {
        let app = tauri::test::mock_app();
        app.manage(BindExposureStatusState(std::sync::Mutex::new(
            BindExposureStatus::default(),
        )));
        let sink = TauriEventSink(app.handle().clone());

        // The daemon binds and emits while the frontend is still mounting.
        sink.on_sync_event(SyncEvent::InternetFacingBind {
            address: "192.160.160.80".into(),
            port: 54321,
        });

        // …and only now does the frontend get its listener up.
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_clone = Arc::clone(&seen);
        app.listen(EVENT_SYNC_INTERNET_FACING_BIND, move |event| {
            seen_clone.lock().unwrap().push(event.payload().to_string());
        });

        assert!(
            seen.lock()
                .expect("late-listener capture not poisoned")
                .is_empty(),
            "a listener registered after the emission must miss it — if it did not, \
             this test would not be exercising the race the durable status exists for"
        );

        let status = app.state::<BindExposureStatusState>();
        let actual = status.0.lock().expect("bind exposure mutex not poisoned");
        assert_eq!(
            *actual,
            BindExposureStatus {
                internet_facing: Some(InternetFacingBind {
                    address: "192.160.160.80".into(),
                    port: 54321,
                }),
            },
            "the status a late-mounting frontend queries must carry the exact bind"
        );
    }

    /// The mirror of the mDNS case: a host that manages no
    /// `BindExposureStatusState` must still get the live event, with its
    /// address and port intact. Asserting on the emission (not on
    /// `try_state().is_none()`, which only restates this setup) is what makes
    /// a regression to `state()` — a panic — or to an early return visible.
    #[test]
    fn tauri_event_sink_internet_facing_bind_without_managed_status_still_emits() {
        let app = tauri::test::mock_app();
        let seen: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_clone = Arc::clone(&seen);
        app.listen(EVENT_SYNC_INTERNET_FACING_BIND, move |event| {
            seen_clone.lock().unwrap().push(event.payload().to_string());
        });
        let sink = TauriEventSink(app.handle().clone());

        sink.on_sync_event(SyncEvent::InternetFacingBind {
            address: "203.0.113.9".into(),
            port: 41234,
        });

        let payloads = seen.lock().expect("emitted-event capture not poisoned");
        assert_eq!(
            payloads.len(),
            1,
            "the sink must still emit `{EVENT_SYNC_INTERNET_FACING_BIND}` exactly once \
             when the host manages no `BindExposureStatusState`, got {payloads:?}"
        );
        assert!(
            payloads[0].contains("203.0.113.9") && payloads[0].contains("41234"),
            "the emitted payload must carry the bound address and port, got {}",
            payloads[0]
        );
    }

    #[test]
    fn channel_event_sink_progress_forwards_only_to_channel() {
        // Phase 2 — Progress events are channel-only now. The
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
        // SyncProgressUpdate is now a tagged enum
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
            changed_page_ids: vec!["PAGE_X".into()],
        });

        // Inner sink sees the original Complete variant (semantics
        // preserved for legacy listeners).
        assert_eq!(inner.events().len(), 1);
        // Channel receives a SyncProgressUpdate::Sync with state="complete" —
        // Normalises Complete + Error into the same envelope so
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
        // FileProgress is channel-only by construction.
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
    fn channel_event_sink_snapshot_progress_forwards_to_channel_only() {
        // SnapshotProgress is channel-only by construction, mirroring
        // FileProgress: the legacy event bus never carried snapshot
        // catch-up progress, so the inner sink stays silent and the
        // channel receives a `SyncProgressUpdate::Snapshot` payload.
        let inner = Arc::new(RecordingEventSink::new());
        let (channel, captured) = capturing_channel();
        let sink = ChannelEventSink {
            inner: Arc::clone(&inner) as Arc<dyn SyncEventSink>,
            channel,
        };

        sink.on_sync_event(SyncEvent::SnapshotProgress {
            phase: "receiving".into(),
            remote_device_id: "DEV_PEER".into(),
            bytes_done: 5_000_000,
            bytes_total: 20_000_000,
        });

        assert!(
            inner.events().is_empty(),
            "SnapshotProgress must NOT reach the inner sink (channel is canonical)"
        );

        let msgs = captured.lock().unwrap().clone();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["kind"], "snapshot");
        assert_eq!(msgs[0]["phase"], "receiving");
        assert_eq!(msgs[0]["remote_device_id"], "DEV_PEER");
        assert_eq!(msgs[0]["bytes_done"], 5_000_000);
        assert_eq!(msgs[0]["bytes_total"], 20_000_000);
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
