//! #4717: place a synced-in space-less block when the session that brought
//! it completes, instead of at the next boot.
//!
//! `bootstrap_spaces` names sync as the path that can deliver a block without
//! a space, then only runs at startup. A session that stays open for days
//! and syncs in a space-less tag from a peer on an older build carried that
//! tag broken until a restart: hidden from every space's tag list, refused by
//! `reindex_block_tag_refs` as cross-space, rendered as a raw `#[ULID]`.
//!
//! This sink wraps the daemon's event sink and, on every `Complete` except a
//! converged `Some(0)`, runs the boot pass's placement half
//! ([`place_space_less_blocks`]) off the session task. `None` is the
//! whole-space snapshot catch-up (`sync_daemon::snapshot_transfer`), the
//! ingress that moves entire spaces and so the one most likely to carry a
//! space-less block; it is "changed, count unknown", never "nothing changed"
//! (`SyncEvent::Complete::changed_blocks`). The pass probes for a space-less
//! row on the read path before it takes the write lock, so a session that
//! delivered nothing space-less costs one indexed lookup. The boot pass
//! stays as the backstop for every other ingress.
//!
//! #4781: `sync:complete` is forwarded before the placement commits, so the
//! frontend's reload on it still sees the unplaced block. Once the placement
//! and the tag-ref rebuilds it enqueues have drained, the sink emits
//! `blocks:changed` with no page ids — the full-reload form — the same signal
//! an MCP write uses for an out-of-band local write.

use std::sync::Arc;

use sqlx::SqlitePool;

use agaric_sync::sync_events::{SyncEvent, SyncEventSink};

use super::bootstrap::place_space_less_blocks;
use crate::materializer::Materializer;
use crate::mcp::view_notify::ViewChangeEmitter;

/// Sink layer that places space-less blocks after an inbound sync.
pub struct SpacePlacementSink {
    pub inner: Arc<dyn SyncEventSink>,
    pub pool: SqlitePool,
    /// Serves the pre-lock probe, so a converged session never touches a writer.
    pub read_pool: SqlitePool,
    pub device_id: String,
    pub materializer: Materializer,
    pub view: Arc<dyn ViewChangeEmitter>,
    /// The task spawned by the latest `Complete`, so a test can await it.
    #[cfg(test)]
    pub last_task: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl SpacePlacementSink {
    pub fn new(
        inner: Arc<dyn SyncEventSink>,
        pool: SqlitePool,
        read_pool: SqlitePool,
        device_id: String,
        materializer: Materializer,
        view: Arc<dyn ViewChangeEmitter>,
    ) -> Self {
        Self {
            inner,
            pool,
            read_pool,
            device_id,
            materializer,
            view,
            #[cfg(test)]
            last_task: std::sync::Mutex::new(None),
        }
    }
}

impl SyncEventSink for SpacePlacementSink {
    fn on_sync_event(&self, event: SyncEvent) {
        if let SyncEvent::Complete {
            changed_blocks,
            remote_device_id,
            ..
        } = &event
            && *changed_blocks != Some(0)
        {
            let pool = self.pool.clone();
            let read_pool = self.read_pool.clone();
            let device_id = self.device_id.clone();
            let materializer = self.materializer.clone();
            let view = self.view.clone();
            let peer = remote_device_id.clone();
            let task = tokio::spawn(async move {
                match place_space_less_blocks(&pool, &read_pool, &device_id, &materializer).await {
                    Ok((0, 0)) => {}
                    Ok((pages, tags)) => {
                        tracing::info!(
                            peer_id = %peer,
                            pages,
                            tags,
                            "placed space-less blocks after inbound sync"
                        );
                        // The rebuilds are what turn a raw `#[ULID]` back into
                        // a tag; signal only once they have drained. The wait
                        // fails only on shutdown, when the signal has no
                        // listener either.
                        let _ = materializer.flush_background().await;
                        view.emit_blocks_changed(Vec::new());
                    }
                    // Non-fatal: the boot pass remains the backstop.
                    Err(e) => tracing::warn!(
                        peer_id = %peer,
                        error = %e,
                        "failed to place space-less blocks after inbound sync"
                    ),
                }
            });
            #[cfg(test)]
            {
                *self.last_task.lock().expect("placement task slot poisoned") = Some(task);
            }
            #[cfg(not(test))]
            drop(task);
        }
        self.inner.on_sync_event(event);
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use agaric_core::ulid::BlockId;
    use agaric_store::space::SpaceId;
    use agaric_sync::sync_events::RecordingEventSink;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use super::*;
    use crate::db::init_pool;
    use crate::mcp::view_notify::RecordingViewChangeEmitter;
    use crate::spaces::bootstrap::{
        SPACE_PERSONAL_ULID, SPACE_WORK_ULID, bootstrap_spaces_for_test,
    };

    const DEV: &str = "test-device";

    async fn seeded_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        (pool, dir)
    }

    /// A space-less tag plus a Work page whose content references it — the
    /// shape an older peer delivers. Returns the tag id.
    async fn seed_synced_in_orphan_tag(pool: &SqlitePool) -> String {
        let tag_id = BlockId::new().to_string();
        let page_id = BlockId::new().to_string();
        let body = format!("meeting #[{tag_id}]");
        // Runtime queries: a test-only statement earns no `.sqlx` entry.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', 'synced-in', NULL, 1, NULL)",
        )
        .bind(&tag_id)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', ?, NULL, 1, ?, ?)",
        )
        .bind(&page_id)
        .bind(&body)
        .bind(&page_id)
        .bind(SPACE_WORK_ULID)
        .execute(pool)
        .await
        .unwrap();
        tag_id
    }

    async fn space_of(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>("SELECT space_id FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    fn complete(changed_blocks: Option<usize>) -> SyncEvent {
        SyncEvent::Complete {
            remote_device_id: "PEER".into(),
            ops_received: 1,
            ops_sent: 0,
            changed_page_ids: vec![],
            changed_blocks,
        }
    }

    fn sink(
        pool: &SqlitePool,
        materializer: &Materializer,
    ) -> (
        SpacePlacementSink,
        Arc<RecordingEventSink>,
        Arc<RecordingViewChangeEmitter>,
    ) {
        let recording = Arc::new(RecordingEventSink(std::sync::Mutex::new(Vec::new())));
        let view = Arc::new(RecordingViewChangeEmitter::new());
        let sink = SpacePlacementSink::new(
            recording.clone(),
            pool.clone(),
            pool.clone(),
            DEV.into(),
            materializer.clone(),
            view.clone(),
        );
        (sink, recording, view)
    }

    async fn places_the_synced_in_tag_after(changed_blocks: Option<usize>) {
        let (pool, _dir) = seeded_pool().await;
        let tag_id = seed_synced_in_orphan_tag(&pool).await;
        assert_eq!(space_of(&pool, &tag_id).await, None);
        let materializer = Materializer::new(pool.clone());
        let (sink, recording, view) = sink(&pool, &materializer);

        sink.on_sync_event(complete(changed_blocks));
        let task = sink
            .last_task
            .lock()
            .unwrap()
            .take()
            .expect("a placement task was spawned");
        task.await.unwrap();

        assert_eq!(
            space_of(&pool, &tag_id).await,
            Some(SPACE_WORK_ULID.to_string())
        );
        // #4743 — the column is half of it: Work's engine holds the block too.
        let mut work = materializer
            .loro_state()
            .registry
            .for_space(&SpaceId::from_trusted(SPACE_WORK_ULID), DEV)
            .unwrap();
        assert!(work.engine_mut().contains_block(&tag_id));
        // The event still reaches the wrapped sink.
        assert_eq!(recording.0.lock().unwrap().len(), 1);
        // #4781 — and the frontend is told to reload once the placement landed.
        assert_eq!(view.blocks_changed(), vec![Vec::<String>::new()]);
        materializer.shutdown();
    }

    /// A session that moved blocks but delivered nothing space-less must not
    /// trigger a full frontend reload.
    #[tokio::test]
    async fn a_session_with_nothing_to_place_signals_nothing_4781() {
        let (pool, _dir) = seeded_pool().await;
        let materializer = Materializer::new(pool.clone());
        let (sink, _recording, view) = sink(&pool, &materializer);

        sink.on_sync_event(complete(Some(3)));
        let task = sink.last_task.lock().unwrap().take().expect("spawned");
        task.await.unwrap();

        assert!(view.blocks_changed().is_empty());
        materializer.shutdown();
    }

    #[tokio::test]
    async fn a_complete_that_moved_blocks_places_the_synced_in_tag_4717() {
        places_the_synced_in_tag_after(Some(1)).await;
    }

    /// The whole-space snapshot catch-up reports `None`: changed, count
    /// unknown. It is the ingress that moves entire spaces, so it must place.
    #[tokio::test]
    async fn a_snapshot_catch_up_places_the_synced_in_tag_4717() {
        places_the_synced_in_tag_after(None).await;
    }

    /// The pre-lock probe must see a space-less page as well as a tag.
    #[tokio::test]
    async fn the_pass_places_a_space_less_page_in_personal_4717() {
        let (pool, _dir) = seeded_pool().await;
        let page_id = BlockId::new().to_string();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'synced-in', NULL, 1, ?)",
        )
        .bind(&page_id)
        .bind(&page_id)
        .execute(&pool)
        .await
        .unwrap();
        let materializer = Materializer::new(pool.clone());

        let placed = place_space_less_blocks(&pool, &pool, DEV, &materializer)
            .await
            .unwrap();

        assert_eq!(placed, (1, 0));
        assert_eq!(
            space_of(&pool, &page_id).await,
            Some(SPACE_PERSONAL_ULID.to_string())
        );
        materializer.shutdown();
    }

    /// Records, at the moment of the signal, how many background tasks the
    /// materializer had finished.
    struct DrainedAtSignal {
        materializer: Materializer,
        drained: std::sync::Mutex<Vec<u64>>,
    }

    impl ViewChangeEmitter for DrainedAtSignal {
        fn emit_blocks_changed(&self, _changed_page_ids: Vec<String>) {
            let n = self
                .materializer
                .metrics()
                .bg_processed
                .load(std::sync::atomic::Ordering::Relaxed);
            self.drained.lock().unwrap().push(n);
        }

        fn emit_property_changed(&self, _block_id: String, _changed_keys: Vec<String>) {}
    }

    /// #4785 — the signal waits for the placement's own rebuilds. On the
    /// current-thread runtime nothing runs between the enqueue and the emit
    /// unless the sink awaits the drain barrier, so a signal that does not
    /// wait sees the count it started with.
    #[tokio::test]
    async fn the_signal_waits_for_the_placement_rebuilds_4785() {
        let (pool, _dir) = seeded_pool().await;
        let tag_id = seed_synced_in_orphan_tag(&pool).await;
        let materializer = Materializer::new(pool.clone());
        let before = materializer
            .metrics()
            .bg_processed
            .load(std::sync::atomic::Ordering::Relaxed);
        let view = Arc::new(DrainedAtSignal {
            materializer: materializer.clone(),
            drained: std::sync::Mutex::new(Vec::new()),
        });
        let sink = SpacePlacementSink::new(
            Arc::new(RecordingEventSink(std::sync::Mutex::new(Vec::new()))),
            pool.clone(),
            pool.clone(),
            DEV.into(),
            materializer.clone(),
            view.clone(),
        );

        sink.on_sync_event(complete(None));
        let task = sink.last_task.lock().unwrap().take().expect("spawned");
        task.await.unwrap();

        // The two tag-ref rebuilds and the drain barrier itself.
        assert_eq!(view.drained.lock().unwrap().clone(), vec![before + 3]);
        // ...and those rebuilds are what made the tag resolvable.
        let refs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_tag_refs WHERE tag_id = ?")
            .bind(&tag_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(refs, 1);
        materializer.shutdown();
    }

    #[tokio::test]
    async fn a_converged_session_spawns_nothing_4717() {
        let (pool, _dir) = seeded_pool().await;
        let tag_id = seed_synced_in_orphan_tag(&pool).await;
        let materializer = Materializer::new(pool.clone());
        let (sink, recording, view) = sink(&pool, &materializer);

        sink.on_sync_event(complete(Some(0)));

        assert!(sink.last_task.lock().unwrap().is_none());
        assert_eq!(space_of(&pool, &tag_id).await, None);
        assert_eq!(recording.0.lock().unwrap().len(), 1);
        assert!(view.blocks_changed().is_empty());
        materializer.shutdown();
    }
}
