use super::snapshot_transfer::*;
use crate::sync_events::RecordingEventSink;
use crate::sync_events::{SyncEvent, SyncEventSink};
use crate::sync_protocol::SyncMessage;
use crate::transport::session::{recv_sync_message, send_sync_message};
use crate::transport::test_support::quic_pair;
use agaric_core::error::AppError;
use agaric_engine::materializer::Materializer;
use agaric_store::peer_refs;
use agaric_store::test_support::init_pool;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use tempfile::TempDir;

const LOCAL_DEV: &str = "01HZ00000000000000000LOCAL0";
const REMOTE_DEV: &str = "01HZ0000000000000000REMOTE0";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

// -----------------------------------------------------------------
// Initiator side: non-LoroSync first message → InvalidOperation
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_errors_on_unexpected_message() {
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Responder protocol-violates: sends a file-transfer frame instead of the
    // LoroSync snapshot after ResetRequired. One framed message, sent before the
    // receive starts — the initiator's read is bounded by `RECV_TIMEOUT`
    // now, so it has to actually find something on the stream.
    //
    // #4960: `SyncComplete` used to be the frame here, which made this test
    // vacuous once that became the legitimate "nothing to offer" terminator.
    // `FileRequest` belongs to the post-`SyncComplete` sub-flow and is never
    // valid in a catch-up.
    send_sync_message(
        &mut server.send,
        &SyncMessage::FileRequest {
            attachment_ids: vec!["01HZ000000000000000000ATT0".into()],
        },
    )
    .await
    .unwrap();

    let result = try_receive_snapshot_catchup(
        &mut client.send,
        &mut client.recv,
        &init_pool,
        &materializer,
        &event_sink,
        REMOTE_DEV,
        None,
        None,
    )
    .await;
    assert!(result.is_err(), "unexpected message must surface as Err");
    match result.unwrap_err() {
        AppError::InvalidOperation(msg) => {
            assert!(
                msg.contains("expected LoroSync"),
                "error message must mention the expected message type, got {msg:?}"
            );
            // #4960: the frame we got is named, not printed as the ordinal
            // `Discriminant(8)` — which shifts whenever a variant is inserted,
            // so an archived log would decode to the wrong frame.
            assert!(
                msg.contains("FileRequest"),
                "error message must name the offending variant, got {msg:?}"
            );
        }
        other => panic!("expected InvalidOperation, got {other:?}"),
    }

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Initiator side: responder had nothing to offer → Ok, no error event
// -----------------------------------------------------------------

/// #4960: a responder whose engine registry is empty ends the catch-up with a
/// terminal `SyncComplete`. The initiator must treat that as "the peer had
/// nothing to catch us up with" — `Ok(())`, no `SyncEvent::Error` — instead of
/// failing the session and booking a backoff the next attempt would repeat
/// forever.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_accepts_empty_offer() {
    use agaric_engine::loro::registry::LoroEngineRegistry;

    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_registry = LoroEngineRegistry::new();

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let recorder = Arc::new(RecordingEventSink::new());
    let init_sink: Arc<dyn SyncEventSink> = recorder.clone();
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // The real responder half, not a hand-written frame: what it sends on an
    // empty registry is exactly what this test pins the initiator against.
    let (offer_res, recv_res) = tokio::join!(
        try_offer_loro_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &resp_pool,
            &resp_registry,
            &resp_sink,
            REMOTE_DEV,
            LOCAL_DEV,
        ),
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &init_sink,
            REMOTE_DEV,
            None,
            None,
        ),
    );

    assert_eq!(
        offer_res.expect("offer must succeed with nothing to send"),
        LoroCatchupSent {
            spaces_sent: 0,
            bytes_sent: 0
        },
        "empty registry must report nothing sent"
    );
    recv_res.expect("an empty catch-up is not a sync failure");
    let events = recorder.events();
    let errors: Vec<&SyncEvent> = events
        .iter()
        .filter(|e| matches!(e, SyncEvent::Error { .. }))
        .collect();
    assert!(
        errors.is_empty(),
        "an empty catch-up must emit no SyncEvent::Error, got {errors:?}"
    );
    // #2539: exactly one terminal event per session per role, and on this path
    // the orchestrator emits none — without it the UI stays on the
    // `reset_required` state it last saw. `Some(0)` keeps it silent (#4305).
    let completes: Vec<&SyncEvent> = events
        .iter()
        .filter(|e| matches!(e, SyncEvent::Complete { .. }))
        .collect();
    assert_eq!(
        completes.len(),
        1,
        "an empty catch-up must emit exactly one SyncEvent::Complete, got {events:?}"
    );
    assert!(
        matches!(
            completes[0],
            SyncEvent::Complete {
                changed_blocks: Some(0),
                ..
            }
        ),
        "nothing was merged, so the Complete must report zero changed blocks, got {:?}",
        completes[0]
    );

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Initiator side: peer surfaces Error instead of a catch-up
// -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_surfaces_peer_error() {
    let (init_pool, _init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let event_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    send_sync_message(
        &mut server.send,
        &SyncMessage::Error {
            message: "responder internal error".into(),
        },
    )
    .await
    .unwrap();

    let result = try_receive_snapshot_catchup(
        &mut client.send,
        &mut client.recv,
        &init_pool,
        &materializer,
        &event_sink,
        REMOTE_DEV,
        None,
        None,
    )
    .await;
    assert!(result.is_err(), "peer Error must surface as Err");
    match result.unwrap_err() {
        AppError::InvalidOperation(msg) => {
            assert!(
                msg.contains("responder internal error"),
                "error message must include the peer's error text, got {msg:?}"
            );
        }
        other => panic!("expected InvalidOperation, got {other:?}"),
    }

    materializer.shutdown();
}

// -----------------------------------------------------------------
// Peer_refs fallback (empty remote_device_id)
// -----------------------------------------------------------------

/// Helper for the fallback / failure tests: drive a successful
/// Loro-snapshot catch-up end-to-end with the given `remote_device_id` /
/// `expected_remote_id` pair and return the receive-side result so
/// the caller can assert on the resolved peer_refs row (or the
/// returned error).
///
/// The recording sink is returned as well (#4097): which peer id the emitted
/// events are attributed to is part of this path's contract, not incidental.
async fn run_catchup_with_ids(
    remote_device_id: &str,
    expected_remote_id: Option<&str>,
) -> (
    SqlitePool,
    TempDir,
    Result<(), AppError>,
    Arc<RecordingEventSink>,
) {
    use agaric_engine::loro::registry::LoroEngineRegistry;
    use agaric_store::space::SpaceId;

    const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    let space = SpaceId::from_trusted(SPACE);

    // Responder: one block in its engine, which is what the catch-up streams.
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_registry = LoroEngineRegistry::new();
    {
        let mut g = resp_registry.for_space(&space, REMOTE_DEV).unwrap();
        g.engine_mut()
            .apply_create_block("RESPBLOCK002", "content", "responder ahead", None, 0)
            .unwrap();
    }

    // Initiator (empty DB + empty engine).
    let (init_pool, init_dir) = test_pool().await;
    let materializer = Materializer::new(init_pool.clone());
    let init_registry = LoroEngineRegistry::new();

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let recording = Arc::new(RecordingEventSink::new());
    let event_sink: Arc<dyn SyncEventSink> = recording.clone();
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (result, offer_res) = tokio::join!(
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &materializer,
            &event_sink,
            remote_device_id,
            expected_remote_id,
            Some(EngineReloadCtx {
                registry: &init_registry,
                device_id: LOCAL_DEV,
            }),
        ),
        try_offer_loro_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &resp_pool,
            &resp_registry,
            &resp_sink,
            REMOTE_DEV,
            LOCAL_DEV,
        ),
    );
    let sent = offer_res.expect("responder offer must succeed");
    assert_eq!(
        sent.spaces_sent, 1,
        "precondition: the responder must stream exactly one space snapshot"
    );

    materializer.flush_background().await.unwrap();
    materializer.shutdown();

    (init_pool, init_dir, result, recording)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_falls_back_to_expected_remote_id_when_session_id_empty() {
    // HeadExchange sometimes carries only our own heads, so
    // the initiator's `session.remote_device_id` ends up empty.
    // The daemon's `expected_remote_id` (from mTLS / mDNS) must
    // fill in so the peer_refs row uses the real peer identity.
    let (init_pool, _dir, result, _sink) = run_catchup_with_ids("", Some(REMOTE_DEV)).await;
    result.expect("catch-up must succeed when expected_remote_id provides the fallback");

    // Empty `remote_device_id` must NOT have produced an empty-keyed
    // peer_refs row.
    assert!(
        peer_refs::get_peer_ref(&init_pool, "")
            .await
            .unwrap()
            .is_none(),
        "fallback path must not write a peer_refs row keyed by empty string",
    );

    // The fallback peer_id (from expected_remote_id) must own the row.
    let fallback = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap()
        .expect("expected_remote_id must own the peer_refs row");
    assert!(
        fallback.synced_at.is_some(),
        "synced_at must be populated on the fallback row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_errors_when_both_remote_ids_empty() {
    // With neither `remote_device_id` nor `expected_remote_id`
    // available, the function must fail loudly so the scheduler
    // records a failed session — silently completing would write a
    // peer_refs row keyed by the empty string and corrupt the
    // bookkeeping.
    let (_init_pool, _dir, result, _sink) = run_catchup_with_ids("", None).await;
    let err = result.expect_err("catch-up must fail when both remote ids are empty");
    match err {
        AppError::InvalidOperation(msg) => {
            assert!(
                msg.contains("refusing to record peer_refs"),
                "error message should reference the empty-id failure; got {msg:?}",
            );
        }
        other => panic!("expected InvalidOperation, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn try_receive_snapshot_catchup_prefers_session_id_over_expected() {
    // When both ids are present and disagree, the
    // session-level `remote_device_id` (from HeadExchange) wins
    // because that's the value the protocol actually exchanged.
    let (init_pool, _dir, result, _sink) =
        run_catchup_with_ids(REMOTE_DEV, Some("OTHER_PEER_FROM_MTLS")).await;
    result.expect("catch-up must succeed when remote_device_id is non-empty");

    let session_owned = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap();
    let expected_owned = peer_refs::get_peer_ref(&init_pool, "OTHER_PEER_FROM_MTLS")
        .await
        .unwrap();
    assert!(
        session_owned.is_some() && expected_owned.is_none(),
        "session-level remote_device_id must own the peer_refs row when both ids are present",
    );
}

// -----------------------------------------------------------------
// #4097 — the fallback's log level, and who the events name
// -----------------------------------------------------------------

/// Thread-safe buffered writer for in-process log capture.
///
/// Mirrors the helper in `sync_protocol/tests.rs`. Kept module-local so each
/// test module stays self-contained (see AGENTS.md § "Test helper duplication
/// is intentional").
#[derive(Clone, Default)]
struct CatchupLogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CatchupLogBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CatchupLogBuf {
    type Writer = CatchupLogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl CatchupLogBuf {
    fn contents(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

/// Install a scoped subscriber capturing every `agaric_sync` event down to
/// DEBUG, with the level rendered so a test can assert on it.
///
/// The catch-up runs inline on the test task (`tokio::join!` polls, it does not
/// spawn), and `block_on` drives that task on the thread `set_default` was
/// called from — so the thread-local subscriber is visible for the whole
/// transfer. Anything the runtime moves to a worker thread simply is not
/// captured, and none of the lines under test live there.
fn capture_catchup_logs() -> (CatchupLogBuf, tracing::subscriber::DefaultGuard) {
    use tracing_subscriber::layer::SubscriberExt;
    let writer = CatchupLogBuf::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("agaric_sync=debug"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_level(true)
                .with_target(true),
        );
    let guard = tracing::subscriber::set_default(subscriber);
    (writer, guard)
}

/// Return the captured lines that mention the identity fallback.
fn fallback_lines(logged: &str) -> Vec<&str> {
    logged
        .lines()
        .filter(|l| l.contains("remote_device_id was empty at snapshot catch-up"))
        .collect()
}

/// #4097 — falling back to the daemon-supplied peer identity is the DESIGNED
/// path on this code path, so it logs at DEBUG.
///
/// `HeadExchange` is initiator-*sent*, and the initiator is the only role that
/// ever reaches a catch-up, so a session id sourced from the authenticated peer
/// identity rather than from the wire is routine, not an anomaly. This site
/// logged it at `warn!` — a per-session warning on a healthy path, which is
/// precisely the shape of alert that trains people to ignore the level. #4085
/// demoted the structurally identical fallback in the session state machine;
/// leaving this one shouting made the pair inconsistent as well as wrong.
///
/// Both halves matter and the test pins both: the line must still be THERE
/// (demoting is not deleting — an operator diagnosing a mis-keyed `peer_refs`
/// row needs to know which source supplied the id), and it must be DEBUG.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_catchup_identity_fallback_logs_at_debug_not_warn_4097() {
    let (writer, guard) = capture_catchup_logs();
    let (_init_pool, _dir, result, _sink) = run_catchup_with_ids("", Some(REMOTE_DEV)).await;
    drop(guard);
    result.expect("precondition: the fallback path must still complete the catch-up");

    let logged = writer.contents();
    let lines = fallback_lines(&logged);
    assert_eq!(
        lines.len(),
        1,
        "the fallback must still say which source supplied the peer id — \
         demoting a level is not deleting the line. Captured:\n{logged}"
    );
    assert!(
        !lines[0].contains("WARN"),
        "#4097: the expected fallback must not WARN — it fires on the healthy \
         path, and a per-session warning on a healthy path is what teaches \
         readers to ignore warnings. Line: {}",
        lines[0]
    );
    assert!(
        lines[0].contains("DEBUG"),
        "#4097: and it must be DEBUG specifically, matching #4085's treatment of \
         the identical fallback in the session state machine. Line: {}",
        lines[0]
    );
}

/// #4097 — the WARN moves to the case that is actually surprising: a catch-up
/// that completed with no peer identity from *either* source.
///
/// This is the half that makes the demotion above safe to make. The level is
/// not being lowered because nothing here is worth warning about; it is being
/// lowered because the warning was attached to the wrong branch. Completing a
/// catch-up we cannot key a `peer_refs` row on is a real anomaly — the snapshot
/// is durable but unattributable, and the next sync treats the peer as unknown
/// again — and it logged *nothing* at `warn!` before.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_catchup_with_no_identity_at_all_still_warns_4097() {
    let (writer, guard) = capture_catchup_logs();
    let (_init_pool, _dir, result, _sink) = run_catchup_with_ids("", None).await;
    drop(guard);
    result.expect_err("precondition: no identity from either source must fail the catch-up");

    let logged = writer.contents();
    let warned = logged.lines().any(|l| {
        l.contains("WARN")
            && l.contains("refusing to key peer_refs bookkeeping on an empty peer_id")
    });
    assert!(
        warned,
        "#4097: the genuinely-no-identity case must WARN. That is the branch \
         worth a warning, and the one that had none. Captured:\n{logged}"
    );
    assert!(
        fallback_lines(&logged).is_empty(),
        "and it must not also claim a fallback happened — there was nothing to \
         fall back to. Captured:\n{logged}"
    );
}

/// #4097, the non-cosmetic half (the same one #4085 had): when the identity
/// comes from the fallback, every event the catch-up emits must still name the
/// peer.
///
/// The id was resolved only at the completion write, so a fallback session
/// emitted `Progress` and its terminal `Complete` with `remote_device_id: ""`
/// — a UI keyed on that field drops or mis-attributes the whole transfer.
/// Resolving up front fixes the events, not just the log line.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn snapshot_catchup_events_carry_the_resolved_peer_id_4097() {
    let (_init_pool, _dir, result, sink) = run_catchup_with_ids("", Some(REMOTE_DEV)).await;
    result.expect("the fallback path must complete the catch-up");

    let events = sink.events();
    // The three peer-keyed variants a catch-up emits. The daemon-level
    // variants (MdnsDisabled, InternetFacingBind, …) are not peer-scoped and
    // this path never emits them.
    let peer_ids: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            SyncEvent::Progress {
                remote_device_id, ..
            }
            | SyncEvent::Complete {
                remote_device_id, ..
            }
            | SyncEvent::Error {
                remote_device_id, ..
            } => Some(remote_device_id.clone()),
            _ => None,
        })
        .collect();

    assert!(
        !peer_ids.is_empty(),
        "precondition: the catch-up must emit events at all"
    );
    assert!(
        peer_ids.iter().all(|id| id == REMOTE_DEV),
        "#4097: every event of a fallback-identity catch-up must name the peer \
         the daemon authenticated. An event carrying \"\" is dropped or \
         mis-attributed by any peer-keyed UI. Got: {peer_ids:?}"
    );
}

/// #2696 — the boot-time sweep must remove stale
/// `snapshot-recv-*.tmp` orphans (left by a pre-#3487 process that died
/// mid-receive; that path is gone, so no NEW orphan can appear, but an
/// upgraded vault can still hold one at 256 MB) while leaving every non-matching
/// entry untouched: unrelated files, a `snapshot-recv-*` name without
/// the `.tmp` suffix, and a directory that happens to match the
/// pattern.
#[test]
fn sweep_removes_only_orphaned_snapshot_temps_2696() {
    let dir = TempDir::new().unwrap();
    let root = dir.path();

    // Two stale orphans matching the real `receive_snapshot_to_temp`
    // naming scheme.
    let orphan_a = root.join("snapshot-recv-0123456789abcdef0123456789abcdef.tmp");
    let orphan_b = root.join("snapshot-recv-fedcba9876543210fedcba9876543210.tmp");
    std::fs::write(&orphan_a, b"stale partial snapshot A").unwrap();
    std::fs::write(&orphan_b, b"stale partial snapshot B").unwrap();

    // Must-survive entries:
    //  * the real database and an unrelated temp,
    //  * a `snapshot-recv-*` file WITHOUT the `.tmp` suffix,
    //  * a directory whose name matches the pattern.
    let db = root.join("notes.db");
    let unrelated = root.join("something-else.tmp");
    let no_suffix = root.join("snapshot-recv-partialname");
    std::fs::write(&db, b"db").unwrap();
    std::fs::write(&unrelated, b"unrelated").unwrap();
    std::fs::write(&no_suffix, b"no suffix").unwrap();
    let matching_dir = root.join("snapshot-recv-lookslikeatemp.tmp");
    std::fs::create_dir(&matching_dir).unwrap();

    let removed = super::sweep_orphaned_snapshot_temps(root);

    assert_eq!(removed, 2, "exactly the two orphaned temps must be removed");
    assert!(!orphan_a.exists(), "orphan A must be swept");
    assert!(!orphan_b.exists(), "orphan B must be swept");
    assert!(db.exists(), "the database must never be swept");
    assert!(unrelated.exists(), "unrelated .tmp must survive");
    assert!(
        no_suffix.exists(),
        "a snapshot-recv name without .tmp must survive"
    );
    assert!(
        matching_dir.is_dir(),
        "a directory matching the pattern must not be removed"
    );
}

/// #2696 — a sweep over a directory that does not exist must not
/// panic and must report zero removals (defensive: boot can race
/// `create_dir_all`).
#[test]
fn sweep_missing_dir_is_noop_2696() {
    let dir = TempDir::new().unwrap();
    let missing = dir.path().join("does-not-exist");
    assert_eq!(super::sweep_orphaned_snapshot_temps(&missing), 0);
}

// -----------------------------------------------------------------
// #2503 — Loro-snapshot catch-up (merge, not wipe)
// -----------------------------------------------------------------

/// #2503 end-to-end at the sub-flow layer: a responder far ahead in a
/// space, an initiator holding an UNSYNCED local edit in the same space.
/// The Loro-snapshot catch-up (`try_offer_loro_snapshot_catchup` ↔
/// `try_receive_snapshot_catchup`) MERGES the responder's snapshot into
/// the initiator's engine and reprojects SQL. Post-session the initiator
/// holds the UNION of both blocks — the local edit SURVIVES (inverting the
/// #2474 wipe contract) — and no `reset_count` bump occurs (a merge is a
/// pull, not a reset).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loro_snapshot_catchup_merges_and_preserves_unsynced_local_2503() {
    use agaric_engine::loro::registry::LoroEngineRegistry;
    use agaric_store::space::SpaceId;

    const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let space = SpaceId::from_trusted(SPACE);

    // Responder: engine holds the far-ahead block (no SQL row needed —
    // the offer exports from the engine registry, not from SQL tables).
    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_registry = LoroEngineRegistry::new();
    {
        let mut g = resp_registry.for_space(&space, REMOTE_DEV).unwrap();
        g.engine_mut()
            .apply_create_block("RESPBLOCK001", "content", "responder ahead", None, 0)
            .unwrap();
    }

    // Initiator: engine + SQL hold an UNSYNCED local block under a
    // DISTINCT device id (so its Loro PeerID differs — no #792 self-fork
    // when it imports the responder's snapshot).
    let (init_pool, _init_dir) = test_pool().await;
    let init_mat = Materializer::new(init_pool.clone());
    let init_registry = LoroEngineRegistry::new();
    {
        let mut g = init_registry.for_space(&space, LOCAL_DEV).unwrap();
        g.engine_mut()
            .apply_create_block("INITLOCAL001", "content", "unsynced local", None, 0)
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'content', 'unsynced local', 1)",
    )
    .bind("INITLOCAL001")
    .execute(&init_pool)
    .await
    .unwrap();

    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let resp_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    let init_sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    // Drive both sides concurrently on one task (borrows, no 'static).
    let (offer_res, recv_res) = tokio::join!(
        try_offer_loro_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &resp_pool,
            &resp_registry,
            &resp_sink,
            REMOTE_DEV, // responder's own device id
            LOCAL_DEV,  // the initiator, as the responder sees it
        ),
        try_receive_snapshot_catchup(
            &mut client.send,
            &mut client.recv,
            &init_pool,
            &init_mat,
            &init_sink,
            REMOTE_DEV, // the peer (responder)
            None,
            Some(EngineReloadCtx {
                registry: &init_registry,
                device_id: LOCAL_DEV,
            }),
        ),
    );

    let sent = offer_res.expect("responder offer must succeed");
    assert_eq!(
        sent.spaces_sent, 1,
        "responder must stream exactly one space snapshot"
    );
    recv_res.expect("initiator merge catch-up must succeed");

    init_mat.flush_background().await.unwrap();

    // ── SQL union: both blocks present ───────────────────────────────
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(&init_pool)
        .await
        .unwrap();
    assert_eq!(
        count, 2,
        "initiator SQL must hold the UNION: its unsynced local block + the \
             merged responder block"
    );
    for (id, content) in [
        ("INITLOCAL001", "unsynced local"),
        ("RESPBLOCK001", "responder ahead"),
    ] {
        let got: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&init_pool)
            .await
            .unwrap_or_else(|_| panic!("block {id} must exist in initiator SQL after merge"));
        assert_eq!(got, content, "block {id} content must survive the merge");
    }

    // ── Engine union: both blocks live in the merged engine ──────────
    {
        let mut g = init_registry.for_space(&space, LOCAL_DEV).unwrap();
        let engine = g.engine_mut();
        assert!(
            engine.read_block("INITLOCAL001").unwrap().is_some(),
            "#2503: the initiator's unsynced local edit must survive in the engine"
        );
        assert!(
            engine.read_block("RESPBLOCK001").unwrap().is_some(),
            "#2503: the responder's block must be merged into the engine"
        );
    }

    // ── Merge is a pull, not a reset ─────────────────────────────────
    let peer = peer_refs::get_peer_ref(&init_pool, REMOTE_DEV)
        .await
        .unwrap()
        .expect("peer_refs row must exist after the merge catch-up");
    assert!(
        peer.synced_at.is_some(),
        "synced_at must be populated after the merge (it is a pull)"
    );
    assert_eq!(
        peer.reset_count, 0,
        "#2503: a Loro-snapshot MERGE must NOT bump reset_count (no reset occurred)"
    );

    // ── loro_doc_state was NOT wiped — the merged engine persists ─────
    // (The legacy CBOR path would have zeroed these; the merge leaves the
    // sidecar intact, only writing the write-ahead inbox for the import.)
    init_mat.shutdown();
}

/// #2503: a responder whose engine registry is empty has nothing to
/// export — it sends a terminal `SyncComplete` and reports `spaces_sent: 0`
/// rather than streaming a zero-space payload.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn loro_snapshot_catchup_empty_registry_offers_nothing_2503() {
    use agaric_engine::loro::registry::LoroEngineRegistry;

    let (resp_pool, _resp_dir) = test_pool().await;
    let resp_registry = LoroEngineRegistry::new();
    let mut pair = quic_pair().await;
    let (client, server) = (&mut pair.client, &mut pair.server);
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());

    let (offer_res, first) = tokio::join!(
        try_offer_loro_snapshot_catchup(
            &mut server.send,
            &mut server.recv,
            &resp_pool,
            &resp_registry,
            &sink,
            REMOTE_DEV,
            LOCAL_DEV,
        ),
        async { recv_sync_message(&mut client.recv).await },
    );

    let sent = offer_res.expect("offer must succeed even with nothing to send");
    assert_eq!(
        sent,
        LoroCatchupSent {
            spaces_sent: 0,
            bytes_sent: 0
        },
        "empty registry must report nothing sent"
    );
    assert!(
        matches!(first.expect("recv"), SyncMessage::SyncComplete { .. }),
        "empty offer must terminate with SyncComplete so the initiator stops waiting"
    );
}
