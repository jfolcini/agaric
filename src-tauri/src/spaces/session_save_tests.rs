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
    BlockEdit, create_block_inner, create_page_in_space_inner, create_space_inner,
    edit_block_inner, edit_block_inner_with_base, edit_blocks_batch_inner, set_property_inner,
    set_todo_state_inner,
};
use crate::materializer::Materializer;
use crate::mcp::view_notify::RecordingViewChangeEmitter;

const DEV_A: &str = "device-A";
const DEV_B: &str = "device-B";

/// How a device's process starts over its database.
#[derive(Clone, Copy)]
enum Boot {
    /// As the app does: each engine from its saved rows (#6521).
    SavedRows,
    /// As every build before #6521 did, and as boot still does when the saved
    /// rows cannot be used: the snapshots, then the op log replayed past them.
    Replay,
}

/// One test of `$scenario` under each [`Boot`].
macro_rules! under_both_boots {
    ($scenario:ident) => {
        mod $scenario {
            use super::Boot;

            #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
            async fn from_saved_rows() {
                super::$scenario(Boot::SavedRows).await;
            }

            #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
            async fn replaying_the_op_log() {
                super::$scenario(Boot::Replay).await;
            }
        }
    };
}

struct Device {
    pool: SqlitePool,
    mat: Materializer,
    id: &'static str,
    boot: Boot,
    _dir: TempDir,
}

impl Device {
    async fn new(id: &'static str, boot: Boot) -> Self {
        let dir = TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        let mat = Self::boot(&pool, id).await;
        super::bootstrap::bootstrap_spaces(&pool, id, &mat)
            .await
            .unwrap();
        Self {
            pool,
            mat,
            id,
            boot,
            _dir: dir,
        }
    }

    /// The app's boot over `pool`: a new process's materializer, its engines
    /// rehydrated, boot recovery run.
    async fn boot(pool: &SqlitePool, id: &str) -> Materializer {
        let mat = Materializer::new(pool.clone());
        let registry = &mat.loro_state().registry;
        agaric_engine::loro::snapshot::rehydrate_registry(pool, registry, id)
            .await
            .unwrap();
        agaric_sync::recovery::reset_recovery_guard();
        agaric_sync::recovery::recover_at_boot(pool, id, &mat, registry)
            .await
            .unwrap();
        mat
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
        from.mat.assert_saved_engines_match_live().await;
        self.mat.assert_saved_engines_match_live().await;
        changed_blocks.len()
    }

    /// What `from`'s engine holds of `space` reaches this device's engine and
    /// not its rows: a sync import before it takes the writer lock to project.
    fn import_without_projecting(&self, from: &Device, space: &SpaceId) {
        let (_, export) = from
            .mat
            .loro_state()
            .registry
            .snapshot_all_engines()
            .into_iter()
            .find(|(s, _)| s == space)
            .unwrap();
        self.mat
            .loro_state()
            .registry
            .with_engine(space, self.id, |engine| engine.import(&export.unwrap()))
            .unwrap()
            .unwrap();
    }

    /// Store `from`'s op log as audit rows, as a session does beside the doc.
    async fn receive_op_log(&self, from: &Device) {
        let ops = agaric_store::op_log::get_ops_since(
            &agaric_store::db::ReadPool(from.pool.clone()),
            from.id,
            0,
        )
        .await
        .unwrap();
        for op in &ops {
            agaric_engine::dag::ingest_replicated_record(&self.pool, op, "user")
                .await
                .unwrap();
        }
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
        self.mat.assert_saved_engines_match_live().await;
    }

    /// The periodic snapshot pass.
    async fn save(&self) {
        agaric_engine::loro::snapshot::save_engines_and_advance_cursor(&self.pool, &self.mat).await;
        self.mat.assert_saved_engines_match_live().await;
    }

    /// The OS kills the process, and the app boots again over its database.
    async fn kill_and_boot(&mut self) {
        self.mat.flush_background().await.unwrap();
        self.mat.shutdown();
        if matches!(self.boot, Boot::Replay) {
            agaric_engine::loro::delta::set_boots_from_saved_rows(&self.pool, false)
                .await
                .unwrap();
        }
        self.mat = Self::boot(&self.pool, self.id).await;
        self.mat.flush_background().await.unwrap();
        self.mat.assert_saved_engines_match_live().await;
    }

    /// The OS kills the process, and the database is booted twice: this
    /// device over it as the app boots, from the saved rows; the returned
    /// device over a copy of it by replaying the op log, the boot this one
    /// replaced, kept as its oracle (#6521).
    async fn kill_and_boot_both_ways(&mut self) -> Device {
        self.mat.flush_background().await.unwrap();
        self.mat.shutdown();
        let dir = TempDir::new().unwrap();
        let copy = dir.path().join("test.db");
        sqlx::query("VACUUM INTO ?")
            .bind(copy.to_str().unwrap())
            .execute(&self.pool)
            .await
            .unwrap();
        let pool = crate::db::init_pool(&copy).await.unwrap();
        agaric_engine::loro::delta::set_boots_from_saved_rows(&pool, false)
            .await
            .unwrap();
        let replayed = Device {
            mat: Self::boot(&pool, self.id).await,
            pool,
            id: self.id,
            boot: Boot::Replay,
            _dir: dir,
        };
        assert!(
            agaric_engine::loro::delta::boots_from_saved_rows(&self.pool)
                .await
                .unwrap(),
            "the fixture: this device boots from its saved rows"
        );
        self.mat = Self::boot(&self.pool, self.id).await;
        for device in [&*self, &replayed] {
            device.mat.flush_background().await.unwrap();
            device.mat.assert_saved_engines_match_live().await;
        }
        replayed
    }

    /// What this device's engines hold: by space, every block in the tree
    /// with its text, place, tombstone, tags and properties.
    fn engine_state(&self) -> EngineState {
        let registry = &self.mat.loro_state().registry;
        registry
            .space_ids()
            .into_iter()
            .map(|space| {
                let blocks = registry
                    .with_engine(&space, self.id, |engine| {
                        engine
                            .live_blocks_preorder()
                            .iter()
                            .map(|block| {
                                let id = block.as_str();
                                format!(
                                    "{:?}",
                                    (
                                        engine.read_block(id).unwrap(),
                                        engine.read_deleted_at(id).unwrap(),
                                        engine.read_tags(id).unwrap(),
                                        engine.read_all_properties_typed(id).unwrap(),
                                    )
                                )
                            })
                            .collect()
                    })
                    .unwrap();
                (space.as_str().to_owned(), blocks)
            })
            .collect()
    }

    /// The rows SQL projects from the engines, each block with its rank among
    /// its siblings or, without `ranks`, with none.
    async fn sql_state(&self, ranks: bool) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT 'block ' || id || ' ' || COALESCE(parent_id, '') || ' ' \
                    || CASE WHEN ?1 THEN position ELSE '' END || ' ' \
                    || block_type || ' ' || (deleted_at IS NOT NULL) || ' ' || content \
               FROM blocks \
             UNION ALL \
             SELECT 'property ' || block_id || ' ' || key || ' ' || COALESCE(value_text, '') \
                    || COALESCE(value_num, '') || COALESCE(value_date, '') || COALESCE(value_ref, '') \
               FROM block_properties \
             UNION ALL \
             SELECT 'tag ' || block_id || ' ' || tag_id FROM block_tags \
             ORDER BY 1",
        )
        .bind(ranks)
        .fetch_all(&self.pool)
        .await
        .unwrap()
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

    /// The boot repairs, on a vault that ran the #5670 hydration in an
    /// earlier release, as every vault in use has.
    async fn boot_repairs_after_the_first_hydration(&self) {
        sqlx::query(
            "INSERT INTO app_settings (key, value, updated_at) \
             VALUES ('repair.engine_missing_live_blocks.v1', '0', 0)",
        )
        .execute(&self.pool)
        .await
        .unwrap();
        crate::repair::repair_unreachable_content_at_boot(
            &self.pool, &self.pool, self.id, &self.mat,
        )
        .await;
        self.mat.flush_background().await.unwrap();
    }

    /// The live nodes carrying `block`'s id in what this device's engine
    /// exports for `space`.
    fn live_nodes(&self, space: &SpaceId, block: &BlockId) -> usize {
        let (_, export) = self
            .mat
            .loro_state()
            .registry
            .snapshot_all_engines()
            .into_iter()
            .find(|(s, _)| s == space)
            .unwrap();
        let mut exported = LoroEngine::new();
        exported.import(&export.unwrap()).unwrap();
        exported
            .live_blocks_preorder()
            .iter()
            .filter(|b| *b == block)
            .count()
    }

    /// The reconciliation oracle's `engine.*` divergences on this device, as
    /// `(artefact, key)`.
    async fn engine_divergences(&self) -> Vec<(String, String)> {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 11, 13).unwrap();
        crate::reconciliation_oracle::reconcile_all(&self.pool, self.mat.loro_state(), None, today)
            .await
            .unwrap()
            .into_iter()
            .filter(|d| d.artefact.starts_with("engine."))
            .map(|d| (d.artefact.to_owned(), d.key))
            .collect()
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
async fn paired(boot: Boot) -> (Device, Device, SpaceId, BlockId, BlockId) {
    let a = Device::new(DEV_A, boot).await;
    let b = Device::new(DEV_B, boot).await;
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
async fn a_sessions_import_survives_a_kill_after_the_session_ends_6525(boot: Boot) {
    let (a, mut b, space, _page, x) = paired(boot).await;
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
under_both_boots!(a_sessions_import_survives_a_kill_after_the_session_ends_6525);

/// #6525 — after the kill B writes over what the session brought: it edits X,
/// and creates a child under A's new page. Both reach B's engine (no SQL-only
/// fallback), and when A delivers again its insertion is in X once.
async fn local_writes_after_a_kill_build_on_what_the_session_imported_6525(boot: Boot) {
    let (a, mut b, space, _page, x) = paired(boot).await;
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
under_both_boots!(local_writes_after_a_kill_build_on_what_the_session_imported_6525);

/// #6525 — B ticks a task the session brought, is killed, boots and pulls
/// again: the tick is still in SQL, and in what B's engine exports.
async fn a_tick_on_an_imported_task_survives_a_kill_and_the_next_pull_6525(boot: Boot) {
    let (a, mut b, space, page, _x) = paired(boot).await;
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
under_both_boots!(a_tick_on_an_imported_task_survives_a_kill_and_the_next_pull_6525);

/// #6525 — a session that fails after one space's import committed still
/// saves that import: the next space's doc does not import, and the daemon
/// reports an error.
async fn a_session_that_fails_after_an_import_still_saves_it_6525(boot: Boot) {
    use agaric_sync::sync_protocol::loro_sync_types::{
        LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage,
    };
    let (a, mut b, space, _page, x) = paired(boot).await;
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
under_both_boots!(a_session_that_fails_after_an_import_still_saves_it_6525);

/// A session that fails before importing anything, such as a peer that is
/// unreachable on every retry, leaves no engine dirty and spawns no save pass.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_that_fails_without_an_import_spawns_no_save() {
    let (a, b, _space, _page, _x) = paired(Boot::SavedRows).await;
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
async fn a_replayed_edit_converges_with_the_peer_it_was_shipped_to_6525(boot: Boot) {
    let (a, mut b, space, _page, x) = paired(boot).await;
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
under_both_boots!(a_replayed_edit_converges_with_the_peer_it_was_shipped_to_6525);

/// #6525 — a session that imports only a property definition changes no
/// block, yet its import dirtied B's engine, so its end still saves it.
async fn a_session_that_imports_only_a_property_definition_saves_it_6525(boot: Boot) {
    let (a, mut b, space, _page, _x) = paired(boot).await;
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
under_both_boots!(a_session_that_imports_only_a_property_definition_saves_it_6525);

/// What a kill before the session-end save left behind: A creates page Y, B
/// pulls it and is killed with no save, so B boots with Y in SQL and in no
/// engine, and the child B then creates under Y lands in SQL only. Returns
/// `(a, b, space, x, y, child)`.
async fn a_child_stranded_under_a_peers_page()
-> (Device, Device, SpaceId, BlockId, BlockId, BlockId) {
    // The build that left a vault this way replayed the op log at boot, and
    // so lost from its engine an import no pass had saved.
    let (a, mut b, space, _page, x) = paired(Boot::Replay).await;
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
    b.pull(&a, &space).await;
    b.receive_op_log(&a).await;
    b.kill_and_boot().await;
    let child = create_block_inner(
        &b.pool,
        DEV_B,
        &b.mat,
        "content".into(),
        "under Y".into(),
        Some(y.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    b.mat.flush_background().await.unwrap();
    assert_eq!(
        (
            b.engine_content(&space, &y),
            b.engine_content(&space, &child)
        ),
        (None, None),
        "the fixture: neither is in B's engine"
    );
    (a, b, space, x, y, child)
}

/// #6525 — the block this device created under a peer's page while its engine
/// lacked the page is in SQL only, through later saves, sessions and boots.
/// The one-time hydration puts it in the engine under that page, with its
/// task state, and the peer then receives it once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hydration_brings_a_stranded_local_block_to_the_engine_and_the_peer_6525() {
    let (a, mut b, space, _x, y, child) = a_child_stranded_under_a_peers_page().await;
    set_todo_state_inner(
        &b.pool,
        DEV_B,
        &b.mat,
        child.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    b.save().await;
    let changed = b.pull(&a, &space).await;
    b.end_session(complete(changed)).await;
    b.kill_and_boot().await;
    assert_eq!(
        (
            b.engine_content(&space, &y).as_deref(),
            b.engine_content(&space, &child)
        ),
        (Some("Y"), None),
        "the fixture: A delivered Y again, and nothing brought the child"
    );

    b.boot_repairs_after_the_first_hydration().await;

    assert_eq!(b.engine_content(&space, &child).as_deref(), Some("under Y"));
    assert_eq!(b.live_nodes(&space, &child), 1);
    assert_eq!(
        b.engine_divergences().await,
        Vec::<(String, String)>::new(),
        "B's engine and SQL agree"
    );
    a.pull(&b, &space).await;
    a.mat.flush_background().await.unwrap();
    let (parent, todo_state): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT parent_id, todo_state FROM blocks WHERE id = ?")
            .bind(child.as_str())
            .fetch_one(&a.pool)
            .await
            .unwrap();
    assert_eq!(
        (parent.as_deref(), todo_state.as_deref()),
        (Some(y.as_str()), Some("TODO")),
        "A has it under Y, as a task"
    );
    assert_eq!(a.sql_content(&child).await, "under Y");
    assert_eq!(a.live_nodes(&space, &child), 1, "once");
    assert_eq!(
        a.engine_divergences().await,
        Vec::<(String, String)>::new(),
        "A's engine and SQL agree"
    );
    a.shutdown();
    b.shutdown();
}

/// #6525 — the hydration leaves a peer's block the engine lacks to sync:
/// seeded from SQL it would be a second node under this device's peer id
/// beside the one A delivers. The local child under it stays out of the doc
/// rather than enter it with no parent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hydration_does_not_twin_a_peers_block_the_engine_lacks_6525() {
    let (a, b, space, _x, y, child) = a_child_stranded_under_a_peers_page().await;

    b.boot_repairs_after_the_first_hydration().await;
    b.pull(&a, &space).await;

    assert_eq!(b.live_nodes(&space, &y), 1, "B holds Y once");
    assert_eq!(
        b.engine_content(&space, &child),
        None,
        "the child was not seeded"
    );
    a.pull(&b, &space).await;
    assert_eq!(a.live_nodes(&space, &y), 1, "and so does A");
    a.shutdown();
    b.shutdown();
}

/// A device holding one block, every op of which is past the retention
/// window and none of which a save has covered: what compaction would purge.
async fn device_with_one_unsaved_aged_block(boot: Boot) -> (Device, SpaceId, BlockId) {
    let a = Device::new(DEV_A, boot).await;
    let space = create_space_inner(&a.pool, DEV_A, &a.mat, "Mine".into(), None)
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
        Some(page),
        None,
    )
    .await
    .unwrap()
    .id;
    let space = SpaceId::from_trusted(space.as_str());
    a.mat.flush_background().await.unwrap();
    let mut tx = a.pool.begin().await.unwrap();
    sqlx::query("INSERT INTO _op_log_mutation_allowed (token) VALUES (1)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE op_log SET created_at = created_at - ?")
        .bind(91_i64 * 24 * 3600 * 1000)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("DELETE FROM _op_log_mutation_allowed")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    (a, space, x)
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// #6518 — the daily compaction can purge ops no save has covered yet (the
/// periodic save runs every five minutes), so it saves the engines first: a
/// kill after it boots with the purged ops' blocks still in the engine.
async fn a_compaction_before_any_save_keeps_its_blocks_after_a_kill_6518(boot: Boot) {
    let (mut a, space, x) = device_with_one_unsaved_aged_block(boot).await;

    crate::maintenance::op_log_compact(&a.pool, &a.mat)
        .await
        .unwrap();
    assert_eq!(op_count(&a.pool).await, 0, "every aged op is purged");
    a.kill_and_boot().await;

    assert_eq!(a.engine_content(&space, &x).as_deref(), Some("abc"));
    a.shutdown();
}
under_both_boots!(a_compaction_before_any_save_keeps_its_blocks_after_a_kill_6518);

/// #6518 — when that save leaves a dirty engine unwritten, the ops are all
/// that boot can restore it from, so neither the History card nor the daily
/// job purges any.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_compaction_whose_save_failed_purges_nothing_6518() {
    use agaric_core::error::AppError;
    use tauri::Manager as _;

    let (a, _space, _block) = device_with_one_unsaved_aged_block(Boot::SavedRows).await;
    let ops_before = op_count(&a.pool).await;
    sqlx::query(
        "CREATE TRIGGER the_disk_refuses_the_snapshot BEFORE INSERT ON loro_doc_state \
         BEGIN SELECT RAISE(ABORT, 'simulated persist failure'); END",
    )
    .execute(&a.pool)
    .await
    .unwrap();
    let app = tauri::test::mock_app();
    app.manage(crate::db::WriteCtx::new(
        a.pool.clone(),
        agaric_sync::device::DeviceId::new(DEV_A.into()),
        a.mat.clone(),
    ));

    let card = crate::commands::compaction::compact_op_log_cmd(app.state(), 90).await;
    assert_eq!(
        op_count(&a.pool).await,
        ops_before,
        "the card purges no op while an engine that holds it is unsaved"
    );
    let job = crate::maintenance::op_log_compact(&a.pool, &a.mat).await;
    assert_eq!(
        op_count(&a.pool).await,
        ops_before,
        "the job purges no op while an engine that holds it is unsaved"
    );

    assert!(
        matches!(card, Err(AppError::Internal(_))),
        "the card is told, with the cause in the log: {card:?}"
    );
    assert!(
        matches!(job, Err(AppError::Snapshot(_))),
        "the job reports the refusal, so it stays due: {job:?}"
    );
    a.shutdown();
}

/// #6533 — a sync import reaches the engine before it takes the writer lock
/// to project. An editor's save that wins the lock in between is rebased on
/// the engine's text, which holds the peer's edit the row does not hold yet.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_between_a_sync_import_and_its_projection_keeps_the_peers_edit_6533() {
    let (a, b, space, _page, x) = paired(Boot::SavedRows).await;
    edit_block_inner(&a.pool, DEV_A, &a.mat, x.clone(), "Xabc".into())
        .await
        .unwrap();
    b.import_without_projecting(&a, &space);
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

/// #6608 — the same gap under `edit_blocks_batch`: the row still holds what
/// the search returned, the engine holds a peer's edit the write would be
/// diffed over, so the block is left alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batch_edit_between_a_sync_import_and_its_projection_leaves_the_block_alone_6608() {
    let (a, b, space, _page, x) = paired(Boot::SavedRows).await;
    edit_block_inner(&a.pool, DEV_A, &a.mat, x.clone(), "Xabc".into())
        .await
        .unwrap();
    b.import_without_projecting(&a, &space);

    let edit = BlockEdit {
        block_id: x.clone(),
        expected: "abc".into(),
        to_text: "abZ".into(),
    };
    let reply = edit_blocks_batch_inner(&b.pool, DEV_B, &b.mat, vec![edit])
        .await
        .unwrap();

    assert_eq!(reply.skipped, vec![x.clone()]);
    assert_eq!(
        (
            b.engine_content(&space, &x).as_deref(),
            b.sql_content(&x).await.as_str()
        ),
        (Some("Xabc"), "abc")
    );
    a.shutdown();
    b.shutdown();
}

/// #6521 — B's last own op edits X; A then rewrites X and B's session brings
/// that in and saves it. A restart of B must leave A's text alone.
async fn a_restart_keeps_a_peers_edit_made_after_this_devices_last_op_6521(boot: Boot) {
    let (a, mut b, space, _page, x) = paired(boot).await;
    edit_block_inner(&b.pool, DEV_B, &b.mat, x.clone(), "abcB".into())
        .await
        .unwrap();
    b.save().await;
    a.pull(&b, &space).await;
    edit_block_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        x.clone(),
        "abcB, and A went on".into(),
    )
    .await
    .unwrap();
    let changed = b.pull(&a, &space).await;
    b.end_session(complete(changed)).await;
    assert_eq!(
        b.sql_content(&x).await,
        "abcB, and A went on",
        "the fixture"
    );

    b.kill_and_boot().await;

    assert_eq!(
        (
            b.engine_content(&space, &x).as_deref(),
            b.sql_content(&x).await.as_str()
        ),
        (Some("abcB, and A went on"), "abcB, and A went on"),
        "B still holds A's text after the restart"
    );
    a.pull(&b, &space).await;
    a.mat.flush_background().await.unwrap();
    assert_eq!(
        a.sql_content(&x).await,
        "abcB, and A went on",
        "and B's restart sent A nothing that undoes it"
    );
    a.shutdown();
    b.shutdown();
}
under_both_boots!(a_restart_keeps_a_peers_edit_made_after_this_devices_last_op_6521);

/// #6521 — the same when B's rows were saved and its cursor did not move, as
/// a direct `save_all_engines` leaves them and as a kill between a pass's rows
/// and its cursor move does. B's edit of X
/// is then after the cursor and in the rows, next to A's later edit.
async fn a_restart_with_rows_saved_and_the_cursor_behind_keeps_a_peers_edit_6521(boot: Boot) {
    let (a, mut b, space, _page, x) = paired(boot).await;
    edit_block_inner(&b.pool, DEV_B, &b.mat, x.clone(), "abcB".into())
        .await
        .unwrap();
    a.pull(&b, &space).await;
    edit_block_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        x.clone(),
        "abcB, and A went on".into(),
    )
    .await
    .unwrap();
    b.pull(&a, &space).await;
    agaric_engine::loro::snapshot::save_all_engines(&b.pool, &b.mat.loro_state().registry).await;
    assert_eq!(
        b.sql_content(&x).await,
        "abcB, and A went on",
        "the fixture"
    );

    b.kill_and_boot().await;

    assert_eq!(
        (
            b.engine_content(&space, &x).as_deref(),
            b.sql_content(&x).await.as_str()
        ),
        (Some("abcB, and A went on"), "abcB, and A went on"),
        "B still holds A's text after the restart"
    );
    a.pull(&b, &space).await;
    a.mat.flush_background().await.unwrap();
    assert_eq!(
        a.sql_content(&x).await,
        "abcB, and A went on",
        "and B's restart sent A nothing that undoes it"
    );
    a.shutdown();
    b.shutdown();
}
under_both_boots!(a_restart_with_rows_saved_and_the_cursor_behind_keeps_a_peers_edit_6521);

/// #6521 — the same for a property, where the replayed write would win as the
/// newer one: B's last own op sets a value, A changes it afterwards, and B's
/// session saves that.
async fn a_restart_keeps_a_peers_property_write_made_after_this_devices_last_op_6521(boot: Boot) {
    let (a, mut b, space, _page, x) = paired(boot).await;
    let set_effort = async |device: &Device, value: &str| {
        set_property_inner(
            &device.pool,
            device.id,
            &device.mat,
            x.to_string().into(),
            "effort".into(),
            Some(value.into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    };
    set_effort(&b, "1h").await;
    b.save().await;
    a.pull(&b, &space).await;
    set_effort(&a, "2h").await;
    let changed = b.pull(&a, &space).await;
    b.end_session(complete(changed)).await;

    b.kill_and_boot().await;
    a.pull(&b, &space).await;
    a.mat.flush_background().await.unwrap();

    let effort = async |device: &Device| -> Option<String> {
        sqlx::query_scalar(
            "SELECT value_text FROM block_properties WHERE block_id = ? AND key = 'effort'",
        )
        .bind(x.as_str())
        .fetch_one(&device.pool)
        .await
        .unwrap()
    };
    assert_eq!(
        (effort(&b).await.as_deref(), effort(&a).await.as_deref()),
        (Some("2h"), Some("2h")),
        "A's value stands on B and on A"
    );
    a.shutdown();
    b.shutdown();
}
under_both_boots!(a_restart_keeps_a_peers_property_write_made_after_this_devices_last_op_6521);

// ---------------------------------------------------------------------------
// #6521 — the boot from saved rows against the boot it replaced
// ---------------------------------------------------------------------------

type EngineState = std::collections::BTreeMap<String, Vec<String>>;

/// The blocks one of two engine states holds and the other does not, each
/// under its space and the side that holds it.
fn engine_differences(booted: &EngineState, held: &EngineState) -> Vec<String> {
    let mut differences = Vec::new();
    for (side, here, there) in [("booted", booted, held), ("held", held, booted)] {
        for (space, blocks) in here {
            let other = there.get(space);
            if other.is_none() {
                differences.push(format!("{side} only: space {space}"));
            }
            let other = other.map(Vec::as_slice).unwrap_or_default();
            for block in blocks.iter().filter(|block| !other.contains(block)) {
                differences.push(format!("{side} only, in {space}: {block}"));
            }
        }
    }
    differences
}

/// Boot `b`'s database both ways after a kill, and check the boot from saved
/// rows against what the dead process held and against the replay boot.
async fn assert_both_boots_restore(b: &mut Device, what: &str) -> Device {
    let held = b.engine_state();
    let sql = b.sql_state(true).await;
    let unranked = b.sql_state(false).await;
    let replayed = b.kill_and_boot_both_ways().await;
    assert_eq!(
        engine_differences(&b.engine_state(), &held),
        Vec::<String>::new(),
        "{what}: the boot from saved rows builds the engines the dead process held"
    );
    assert_eq!(
        engine_differences(&replayed.engine_state(), &held),
        Vec::<String>::new(),
        "{what}: and so does the replay boot"
    );
    assert_eq!(b.sql_state(true).await, sql, "{what}: SQL is as it was");
    // Without the ranks: the replay ends by ranking again every sibling group
    // it touched, which closes the gap a purge leaves in a session's ranks.
    assert_eq!(
        replayed.sql_state(false).await,
        unranked,
        "{what}: after the replay boot too"
    );
    replayed
}

/// B's own writes on what it pulled from A: an edit of X, a new block under
/// the page with a property, and a block it then deletes.
async fn local_writes(b: &Device, page: &BlockId, x: &BlockId, text: &str) -> BlockId {
    edit_block_inner(&b.pool, b.id, &b.mat, x.clone(), text.into())
        .await
        .unwrap();
    let block = |content: &str| {
        create_block_inner(
            &b.pool,
            b.id,
            &b.mat,
            "content".into(),
            content.into(),
            Some(page.clone()),
            None,
        )
    };
    let kept = block("kept").await.unwrap().id;
    set_todo_state_inner(
        &b.pool,
        b.id,
        &b.mat,
        kept.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    let deleted = block("deleted").await.unwrap().id;
    crate::commands::delete_block_inner(&b.pool, b.id, &b.mat, deleted)
        .await
        .unwrap();
    b.mat.flush_background().await.unwrap();
    kept
}

/// #6521 — a clean shutdown: the exit pass saved every engine and moved the
/// cursor. Both boots restore the same engines.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_boots_agree_after_a_clean_shutdown_6521() {
    let (a, mut b, _space, page, x) = paired(Boot::SavedRows).await;
    local_writes(&b, &page, &x, "abc, saved at exit").await;
    b.save().await;

    let replayed = assert_both_boots_restore(&mut b, "clean shutdown").await;

    for device in [a, b, replayed] {
        device.shutdown();
    }
}

/// #6521 — a kill between writes and the next pass: the writes are in
/// `loro_doc_delta` rows and, for the replay boot, in the op log.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_boots_agree_after_a_kill_between_a_write_and_the_next_pass_6521() {
    let (a, mut b, _space, page, x) = paired(Boot::SavedRows).await;
    local_writes(&b, &page, &x, "abc, not yet in a snapshot").await;

    let replayed = assert_both_boots_restore(&mut b, "kill before the pass").await;

    for device in [a, b, replayed] {
        device.shutdown();
    }
}

/// #6521 — a kill part-way through a pass: its rows are committed, with the
/// deltas they cover deleted, and the cursor has not moved. More writes
/// followed before the kill.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_boots_agree_after_a_kill_between_a_passes_rows_and_its_cursor_move_6521() {
    let (a, mut b, _space, page, x) = paired(Boot::SavedRows).await;
    local_writes(&b, &page, &x, "abc, in the pass's rows").await;
    agaric_engine::loro::snapshot::save_all_engines(&b.pool, &b.mat.loro_state().registry).await;
    local_writes(&b, &page, &x, "abc, after the pass").await;

    let replayed = assert_both_boots_restore(&mut b, "kill mid-pass").await;

    for device in [a, b, replayed] {
        device.shutdown();
    }
}

/// #6521 — a command that wrote the engine and rolled back, then one that
/// committed: the second reuses the first's op ids. Neither boot holds the
/// rolled-back text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_boots_agree_after_a_rolled_back_command_and_a_committed_one_6521() {
    let (a, mut b, space, _page, x) = paired(Boot::SavedRows).await;
    let state = b.mat.loro_state();
    let mut tx = crate::db::CommandTx::begin_immediate(&b.pool, "test_rolled_back_6521")
        .await
        .unwrap();
    tx.arm_engine_rollback(state);
    crate::commands::blocks::crud::edit_block_in_tx(
        &mut tx,
        state,
        b.id,
        x.as_str().to_owned(),
        "abc, rolled back".into(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        b.engine_content(&space, &x).as_deref(),
        Some("abc, rolled back"),
        "the fixture: the engine held the write before the rollback"
    );
    tx.rollback().await.unwrap();
    edit_block_inner(&b.pool, b.id, &b.mat, x.clone(), "abc, committed".into())
        .await
        .unwrap();

    let replayed = assert_both_boots_restore(&mut b, "rollback then commit").await;

    assert_eq!(
        b.engine_content(&space, &x).as_deref(),
        Some("abc, committed")
    );
    for device in [a, b, replayed] {
        device.shutdown();
    }
}

/// #6521 — a purge: the block is deleted, then purged with the block under
/// it, and is in neither boot's engine.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_boots_agree_after_a_purge_6521() {
    let (a, mut b, space, page, x) = paired(Boot::SavedRows).await;
    let purged = local_writes(&b, &page, &x, "abc, beside a purge").await;
    let under_it = create_block_inner(
        &b.pool,
        b.id,
        &b.mat,
        "content".into(),
        "purged with its parent".into(),
        Some(purged.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    crate::commands::delete_block_inner(&b.pool, b.id, &b.mat, purged.clone())
        .await
        .unwrap();
    crate::commands::purge_block_inner(&b.pool, b.id, &b.mat, purged.clone())
        .await
        .unwrap();
    b.mat.flush_background().await.unwrap();

    let replayed = assert_both_boots_restore(&mut b, "purge").await;

    for device in [&b, &replayed] {
        assert_eq!(
            (
                device.engine_content(&space, &purged),
                device.engine_content(&space, &under_it)
            ),
            (None, None),
            "the purged blocks are in no engine"
        );
    }
    for device in [a, b, replayed] {
        device.shutdown();
    }
}

/// #6521 — an import from a peer, a local edit on top, then a kill before
/// any pass. The boot from saved rows holds the peer's text: the import's
/// delta committed with its projection. The replay boot does not: it builds
/// from a snapshot without the import and replays the local edit over it, so
/// its engine and SQL disagree until the peer delivers again (the loss the
/// saved rows close; #6525 narrowed it to the length of one pass).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_boot_from_saved_rows_keeps_a_peers_import_the_replay_boot_loses_6521() {
    let (a, mut b, space, page, x) = paired(Boot::SavedRows).await;
    let from_a = create_block_inner(
        &a.pool,
        DEV_A,
        &a.mat,
        "content".into(),
        "from A".into(),
        Some(page.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    b.pull(&a, &space).await;
    edit_block_inner(&b.pool, b.id, &b.mat, x.clone(), "abc, B went on".into())
        .await
        .unwrap();
    let held = b.engine_state();

    let replayed = b.kill_and_boot_both_ways().await;

    assert_eq!(
        engine_differences(&b.engine_state(), &held),
        Vec::<String>::new(),
        "the boot from saved rows builds the engines the dead process held"
    );
    assert_eq!(b.engine_content(&space, &from_a).as_deref(), Some("from A"));
    assert_eq!(
        b.engine_divergences().await,
        Vec::<(String, String)>::new(),
        "its engines and SQL agree"
    );
    assert_eq!(
        replayed.engine_content(&space, &from_a),
        None,
        "the replay boot's engine lacks what the peer sent after the last pass"
    );
    assert_eq!(
        replayed.sql_content(&from_a).await,
        "from A",
        "while its SQL has it"
    );
    for device in [a, b, replayed] {
        device.shutdown();
    }
}

/// #6521 — the first boot after the update. The vault's last process was a
/// build whose boot replayed the op log and kept no rows across it: whatever
/// rows it left are deleted, its ops past the snapshot are replayed once, and
/// the boot after that builds from the rows the replay and the session saved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_boot_after_the_update_replays_once_6521() {
    let (a, mut b, _space, page, x) = paired(Boot::Replay).await;
    local_writes(&b, &page, &x, "abc, written by the older build").await;
    let held = b.engine_state();
    let rows = async |pool: &SqlitePool| -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_delta")
            .fetch_one(pool)
            .await
            .unwrap()
    };
    assert!(rows(&b.pool).await > 0, "the fixture: it left rows");

    b.kill_and_boot().await;

    assert_eq!(b.engine_state(), held, "the replay restores its engines");
    assert!(
        agaric_engine::loro::delta::boots_from_saved_rows(&b.pool)
            .await
            .unwrap(),
        "and from here the saved rows hold every engine write"
    );
    b.boot = Boot::SavedRows;
    local_writes(&b, &page, &x, "abc, written by this build").await;
    let held = b.engine_state();
    let saved = rows(&b.pool).await;

    b.kill_and_boot().await;

    assert_eq!(b.engine_state(), held, "the next boot builds from the rows");
    assert_eq!(
        rows(&b.pool).await,
        saved,
        "and keeps them: nothing was replayed, so nothing replaced them"
    );
    a.shutdown();
    b.shutdown();
}
