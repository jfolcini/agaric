//! #6525: what a sync session imported survives the process being killed
//! after the session ended, because [`SpacePlacementSink`] saves the engines
//! when it ends.
//!
//! Device A authors and device B pulls, one `apply_remote` per pull. B ends a
//! session through its sink, as the daemon does. A kill drops B's materializer
//! and engines without the exit save; boot rehydrates a new one from
//! `loro_doc_state` and runs boot recovery, which replays B's own ops after
//! the apply cursor.
//!
//! One test reads the process-global `sql_only_fallback_count()` before and
//! after its writes; nextest runs each test in its own process.

use std::sync::Arc;

use sqlx::SqlitePool;
use tempfile::TempDir;

use agaric_core::ulid::BlockId;
use agaric_engine::loro::engine::{LoroEngine, PropertyValue};
use agaric_store::space::SpaceId;
use agaric_sync::sync_events::{RecordingEventSink, SyncEvent, SyncEventSink};
use agaric_sync::sync_protocol::loro_sync::{
    ApplyOutcome, apply_remote, prepare_outgoing_for_pool,
};

use super::SpacePlacementSink;
use crate::commands::{
    create_block_inner, create_page_in_space_inner, create_space_inner, edit_block_inner,
    edit_block_inner_with_base, set_todo_state_inner,
};
use crate::materializer::Materializer;
use crate::mcp::view_notify::RecordingViewChangeEmitter;

const DEV_A: &str = "device-A";
const DEV_B: &str = "device-B";

struct Device {
    pool: SqlitePool,
    mat: Materializer,
    id: &'static str,
    _dir: TempDir,
}

impl Device {
    async fn new(id: &'static str) -> Self {
        let dir = TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = Materializer::new(pool.clone());
        super::bootstrap::bootstrap_spaces(&pool, id, &mat)
            .await
            .unwrap();
        Self {
            pool,
            mat,
            id,
            _dir: dir,
        }
    }

    /// Import what `from` holds of `space` and this device's engine lacks,
    /// with the fan-out a session runs. Returns how many blocks it changed.
    async fn pull(&self, from: &Device, space: &SpaceId) -> usize {
        from.mat.flush_background().await.unwrap();
        let vv = self.mat.loro_state().registry.loro_vv(space);
        let msg = prepare_outgoing_for_pool(
            &from.pool,
            &from.mat.loro_state().registry,
            space,
            from.id,
            vv.as_deref(),
        )
        .await
        .unwrap()
        .expect("the freshness gate passes a consistent engine");
        let outcome = apply_remote(&self.pool, &self.mat.loro_state().registry, self.id, msg)
            .await
            .unwrap();
        let ApplyOutcome::Imported { changed_blocks, .. } = outcome else {
            panic!("the doc imports, got {outcome:?}");
        };
        self.mat
            .enqueue_inbound_sync_rebuilds(&changed_blocks, &[])
            .await
            .unwrap();
        changed_blocks.len()
    }

    /// The sink the app wires in front of the daemon's events.
    fn sink(&self) -> SpacePlacementSink {
        SpacePlacementSink::new(
            Arc::new(RecordingEventSink(std::sync::Mutex::new(Vec::new()))),
            self.pool.clone(),
            self.pool.clone(),
            self.id.to_owned(),
            self.mat.clone(),
            Arc::new(RecordingViewChangeEmitter::new()),
        )
    }

    /// The daemon reports the session's end through the sink the app wires.
    async fn end_session(&self, event: SyncEvent) {
        let sink = self.sink();
        sink.on_sync_event(event);
        let task = sink
            .last_task
            .lock()
            .unwrap()
            .take()
            .expect("the session's end spawns its task");
        task.await.unwrap();
    }

    /// The periodic snapshot pass.
    async fn save(&self) {
        agaric_engine::loro::snapshot::save_engines_and_advance_cursor(&self.pool, &self.mat).await;
    }

    /// The OS kills the process, and the app boots again over its database.
    async fn kill_and_boot(&mut self) {
        self.mat.flush_background().await.unwrap();
        self.mat.shutdown();
        self.mat = Materializer::new(self.pool.clone());
        let registry = &self.mat.loro_state().registry;
        agaric_engine::loro::snapshot::rehydrate_registry(&self.pool, registry, self.id)
            .await
            .unwrap();
        agaric_sync::recovery::reset_recovery_guard();
        agaric_sync::recovery::recover_at_boot(&self.pool, self.id, &self.mat, registry)
            .await
            .unwrap();
        self.mat.flush_background().await.unwrap();
    }

    fn engine_content(&self, space: &SpaceId, block: &BlockId) -> Option<String> {
        let mut guard = self
            .mat
            .loro_state()
            .registry
            .for_space(space, self.id)
            .unwrap();
        guard
            .engine_mut()
            .read_block(block.as_str())
            .unwrap()
            .map(|b| b.content)
    }

    async fn sql_content(&self, block: &BlockId) -> String {
        sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(block.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    fn shutdown(&self) {
        self.mat.shutdown();
    }
}

fn complete(changed_blocks: usize) -> SyncEvent {
    SyncEvent::Complete {
        remote_device_id: DEV_A.into(),
        ops_received: 1,
        ops_sent: 0,
        changed_page_ids: Vec::new(),
        changed_blocks: Some(changed_blocks),
    }
}

/// A's space holding page `P` with block `X` ("abc"), which B pulled and the
/// periodic pass saved. Returns `(a, b, space, page, x)`.
async fn paired() -> (Device, Device, SpaceId, BlockId, BlockId) {
    let a = Device::new(DEV_A).await;
    let b = Device::new(DEV_B).await;
    let space = create_space_inner(&a.pool, DEV_A, &a.mat, "Shared".into(), None)
        .await
        .unwrap();
    let page = create_page_in_space_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        None,
        "P".into(),
        space.as_str().to_owned(),
    )
    .await
    .unwrap();
    let x = create_block_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        "content".into(),
        "abc".into(),
        Some(page.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    let space = SpaceId::from_trusted(space.as_str());
    b.pull(&a, &space).await;
    b.save().await;
    (a, b, space, page, x)
}

/// A edits X to "abcX" and creates page Y; B pulls that and ends the session.
/// Returns Y.
async fn session_bringing_an_edit_and_a_page(
    a: &Device,
    b: &Device,
    space: &SpaceId,
    x: &BlockId,
) -> BlockId {
    edit_block_inner(&a.pool, DEV_A, &a.mat, x.clone(), "abcX".into())
        .await
        .unwrap();
    let y = create_page_in_space_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        None,
        "Y".into(),
        space.as_str().to_owned(),
    )
    .await
    .unwrap();
    let changed = b.pull(a, space).await;
    b.end_session(complete(changed)).await;
    y
}

/// #6525 — a session's import is in B's engine after a kill that follows the
/// session's end: X's new text and the page A created.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sessions_import_survives_a_kill_after_the_session_ends_6525() {
    let (a, mut b, space, _page, x) = paired().await;
    let y = session_bringing_an_edit_and_a_page(&a, &b, &space, &x).await;

    b.kill_and_boot().await;

    assert_eq!(
        b.engine_content(&space, &x).as_deref(),
        Some("abcX"),
        "X's new text"
    );
    assert_eq!(
        b.engine_content(&space, &y).as_deref(),
        Some("Y"),
        "A's new page"
    );
    a.shutdown();
    b.shutdown();
}

/// #6525 — after the kill B writes over what the session brought: it edits X,
/// and creates a child under A's new page. Both reach B's engine (no SQL-only
/// fallback), and when A delivers again its insertion is in X once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_writes_after_a_kill_build_on_what_the_session_imported_6525() {
    let (a, mut b, space, _page, x) = paired().await;
    let y = session_bringing_an_edit_and_a_page(&a, &b, &space, &x).await;
    b.kill_and_boot().await;

    let fallbacks = crate::materializer::sql_only_fallback_count();
    edit_block_inner(&b.pool, DEV_B, &b.mat, x.clone(), "abcXZ".into())
        .await
        .unwrap();
    let child = create_block_inner(
        &b.pool,
        DEV_B,
        &b.mat,
        "content".into(),
        "under Y".into(),
        Some(y),
        None,
    )
    .await
    .unwrap()
    .id;
    b.mat.flush_background().await.unwrap();
    assert_eq!(
        crate::materializer::sql_only_fallback_count(),
        fallbacks,
        "both writes took the engine path"
    );
    assert_eq!(b.engine_content(&space, &child).as_deref(), Some("under Y"));

    b.pull(&a, &space).await;
    b.mat.flush_background().await.unwrap();

    assert_eq!(b.sql_content(&x).await, "abcXZ", "A's X is in X once");
    assert_eq!(b.engine_content(&space, &x).as_deref(), Some("abcXZ"));
    a.shutdown();
    b.shutdown();
}

/// #6525 — B ticks a task the session brought, is killed, boots and pulls
/// again: the tick is still in SQL, and in what B's engine exports.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tick_on_an_imported_task_survives_a_kill_and_the_next_pull_6525() {
    let (a, mut b, space, page, _x) = paired().await;
    let task = create_block_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        "content".into(),
        "a task".into(),
        Some(page),
        None,
    )
    .await
    .unwrap()
    .id;
    set_todo_state_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        task.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    let changed = b.pull(&a, &space).await;
    b.end_session(complete(changed)).await;
    set_todo_state_inner(
        &b.pool,
        DEV_B,
        &b.mat,
        task.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();

    b.kill_and_boot().await;
    b.pull(&a, &space).await;
    b.mat.flush_background().await.unwrap();

    let sql: Option<String> = sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = ?")
        .bind(task.as_str())
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(sql.as_deref(), Some("DONE"), "the tick is in SQL");
    let (_, export) = b
        .mat
        .loro_state()
        .registry
        .snapshot_all_engines()
        .into_iter()
        .find(|(s, _)| *s == space)
        .unwrap();
    let mut exported = LoroEngine::new();
    exported.import(&export.unwrap()).unwrap();
    assert!(
        exported
            .read_all_properties_typed(task.as_str())
            .unwrap()
            .contains(&("todo_state".to_owned(), PropertyValue::Str("DONE".into()))),
        "the tick is in the engine's export"
    );
    a.shutdown();
    b.shutdown();
}

/// #6525 — a session that fails after one space's import committed still
/// saves that import: the next space's doc does not import, and the daemon
/// reports an error.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_fails_after_an_import_still_saves_it_6525() {
    use agaric_sync::sync_protocol::loro_sync_types::{
        LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage,
    };
    let (a, mut b, space, _page, x) = paired().await;
    edit_block_inner(&a.pool, DEV_A, &a.mat, x.clone(), "abcX".into())
        .await
        .unwrap();
    b.pull(&a, &space).await;
    let unreadable = LoroSyncMessage::Snapshot {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id: SpaceId::from_trusted(super::SPACE_WORK_ULID),
        bytes: b"not a doc".to_vec(),
    };
    apply_remote(&b.pool, &b.mat.loro_state().registry, DEV_B, unreadable)
        .await
        .expect_err("the second space's doc does not import");
    b.end_session(SyncEvent::Error {
        message: "the second space's doc does not import".into(),
        remote_device_id: DEV_A.into(),
        code: None,
        peer_is_older: None,
    })
    .await;

    b.kill_and_boot().await;

    assert_eq!(b.engine_content(&space, &x).as_deref(), Some("abcX"));
    a.shutdown();
    b.shutdown();
}

/// A session that fails before importing anything, such as a peer that is
/// unreachable on every retry, leaves no engine dirty and spawns no save pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_fails_without_an_import_spawns_no_save() {
    let (a, b, _space, _page, _x) = paired().await;
    assert_eq!(b.mat.loro_state().registry.dirty_count(), 0);
    let sink = b.sink();
    sink.on_sync_event(SyncEvent::Error {
        message: "peer unreachable".into(),
        remote_device_id: DEV_A.into(),
        code: None,
        peer_is_older: None,
    });
    assert!(sink.last_task.lock().unwrap().is_none());
    a.shutdown();
    b.shutdown();
}

/// #6525 — the boot-replay divergence through the sync path. B imports A's
/// edit of X, edits X on top of it, ships that to A and is killed. Boot
/// replays B's edit onto B's saved engine; because the session's end saved
/// A's edit, the replay mints the op A already holds, and the two converge.
/// Without that save it replays onto "abc" and the two diverge under equal
/// version vectors (`loro::tests::boot_replay_onto_a_snapshot_without_the_peers_edit_diverges_6525`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_replayed_edit_converges_with_the_peer_it_was_shipped_to_6525() {
    let (a, mut b, space, _page, x) = paired().await;
    edit_block_inner(&a.pool, DEV_A, &a.mat, x.clone(), "abcX".into())
        .await
        .unwrap();
    let changed = b.pull(&a, &space).await;
    b.end_session(complete(changed)).await;
    edit_block_inner(&b.pool, DEV_B, &b.mat, x.clone(), "abcXY".into())
        .await
        .unwrap();
    a.pull(&b, &space).await;

    b.kill_and_boot().await;
    b.pull(&a, &space).await;
    a.pull(&b, &space).await;
    a.mat.flush_background().await.unwrap();
    b.mat.flush_background().await.unwrap();

    assert_eq!(
        (
            a.engine_content(&space, &x).as_deref(),
            b.engine_content(&space, &x).as_deref(),
        ),
        (Some("abcXY"), Some("abcXY")),
        "both engines hold B's edit once"
    );
    assert_eq!(
        (a.sql_content(&x).await, b.sql_content(&x).await),
        ("abcXY".to_owned(), "abcXY".to_owned()),
        "and both SQL rows"
    );
    a.shutdown();
    b.shutdown();
}

/// #6525 — a session that imports only a property definition changes no
/// block, yet its import dirtied B's engine, so its end still saves it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_imports_only_a_property_definition_saves_it_6525() {
    let (a, mut b, space, _page, _x) = paired().await;
    crate::commands::create_property_def_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        space.as_str(),
        "effort_6525".into(),
        "text".into(),
        None,
    )
    .await
    .unwrap();
    let changed = b.pull(&a, &space).await;
    assert_eq!(changed, 0, "a definition changes no block");
    b.end_session(complete(changed)).await;

    b.kill_and_boot().await;

    let def = b
        .mat
        .loro_state()
        .registry
        .for_space(&space, DEV_B)
        .unwrap()
        .engine_mut()
        .read_property_def("effort_6525")
        .unwrap();
    assert!(
        def.is_some(),
        "the definition is in B's engine after the kill"
    );
    a.shutdown();
    b.shutdown();
}

/// #6533 — a sync import reaches the engine before it takes the writer lock
/// to project. An editor's save that wins the lock in between is rebased on
/// the engine's text, which holds the peer's edit the row does not hold yet.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_between_a_sync_import_and_its_projection_keeps_the_peers_edit_6533() {
    let (a, b, space, _page, x) = paired().await;
    edit_block_inner(&a.pool, DEV_A, &a.mat, x.clone(), "Xabc".into())
        .await
        .unwrap();
    let (_, export) = a
        .mat
        .loro_state()
        .registry
        .snapshot_all_engines()
        .into_iter()
        .find(|(s, _)| *s == space)
        .unwrap();
    b.mat
        .loro_state()
        .registry
        .with_engine(&space, DEV_B, |engine| engine.import(&export.unwrap()))
        .unwrap()
        .unwrap();
    assert_eq!(
        (
            b.engine_content(&space, &x).as_deref(),
            b.sql_content(&x).await.as_str()
        ),
        (Some("Xabc"), "abc"),
        "the fixture: imported, not yet projected"
    );

    let saved = edit_block_inner_with_base(
        &b.pool,
        DEV_B,
        &b.mat,
        x.clone(),
        "abcY".into(),
        Some("abc".into()),
    )
    .await
    .unwrap();

    assert_eq!(saved.content.as_deref(), Some("XabcY"));
    assert_eq!(
        (
            b.engine_content(&space, &x).as_deref(),
            b.sql_content(&x).await.as_str()
        ),
        (Some("XabcY"), "XabcY")
    );
    a.shutdown();
    b.shutdown();
}
