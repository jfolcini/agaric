//! #6524 / #6744 spike: a device whose own history is behind what its peer holds
//! of it.
//!
//! A is restored from a copy of its database taken before its last synced edit,
//! so B holds ops under A's PeerID that A no longer has. Each test drives full
//! sync sessions between two devices (the #602 two-registry seam) and asserts
//! both converge with every edit present, the one the copy lost included.

use super::*;
use crate::sync_protocol::{SyncOrchestrator, SyncState};
use agaric_engine::loro::peer_epoch::PEER_EPOCH_KEY;
use agaric_engine::loro::shared::LoroState;
use agaric_store::space::SpaceId;

const DEV_A: &str = "DEV6524A";
const DEV_B: &str = "DEV6524B";
const SPACE: &str = "01HZ6524SPACEXXXXXXXXXXXXX";
/// On A before the copy is taken.
const BEFORE_COPY: &str = "01HZ6524BEFREXXXXXXXXXXXXX";
/// On B, synced to A before the copy is taken.
const FROM_B: &str = "01HZ6524FRMBXXXXXXXXXXXXXX";
/// On A after the copy, synced to B, then lost to A by the restore.
const LOST_BY_RESTORE: &str = "01HZ6524LSTXXXXXXXXXXXXXXX";
/// On A after the restore.
const AFTER_RESTORE: &str = "01HZ6524AFTRXXXXXXXXXXXXXX";

struct Device {
    id: &'static str,
    pool: SqlitePool,
    mat: Materializer,
    state: Arc<LoroState>,
}

impl Device {
    async fn edit(&self, block_id: &str, ts: i64) {
        self.edit_with(block_id, block_id, ts).await;
    }

    async fn edit_with(&self, block_id: &str, content: &str, ts: i64) {
        let space = SpaceId::from_trusted(SPACE);
        make_local_edit_602(
            &self.pool,
            &self.mat,
            &self.state,
            self.id,
            &space,
            block_id,
            content,
            ts,
        )
        .await;
    }

    async fn content(&self, block_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
    }

    fn engine_content(&self, block_id: &str) -> Option<String> {
        let space = SpaceId::from_trusted(SPACE);
        let mut guard = self.state.registry.for_space(&space, self.id).unwrap();
        guard.engine_mut().read_block_content(block_id).unwrap()
    }

    fn engine_snapshot(&self) -> Vec<u8> {
        let space = SpaceId::from_trusted(SPACE);
        let mut guard = self.state.registry.for_space(&space, self.id).unwrap();
        guard.engine_mut().export_snapshot().unwrap()
    }

    /// `(seq, hash, payload, created_at)` of every op this database holds for
    /// `device_id`, oldest first, with `op_type` folded into the payload.
    async fn ops_of(&self, device_id: &str) -> Vec<(i64, String, String, i64)> {
        sqlx::query_as(
            "SELECT seq, hash, json_set(payload, '$.op_type', op_type), created_at \
             FROM op_log WHERE device_id = ? ORDER BY seq",
        )
        .bind(device_id)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    fn version_vector(&self) -> loro::VersionVector {
        let space = SpaceId::from_trusted(SPACE);
        let mut guard = self.state.registry.for_space(&space, self.id).unwrap();
        loro::VersionVector::decode(&guard.engine_mut().version_vector()).unwrap()
    }
}

fn device(id: &'static str, pool: SqlitePool) -> Device {
    let mat = Materializer::new(pool.clone());
    let state = Arc::clone(mat.loro_state());
    Device {
        id,
        pool,
        mat,
        state,
    }
}

/// One session in which `puller` initiates and so receives `source`'s state.
async fn pull(puller: &Device, source: &Device) -> (SyncState, SyncState) {
    let mut init = SyncOrchestrator::new(
        puller.pool.clone(),
        puller.id.into(),
        Arc::new(puller.mat.clone()),
    )
    .with_expected_remote_id(source.id.into());
    let mut resp = SyncOrchestrator::new(
        source.pool.clone(),
        source.id.into(),
        Arc::new(source.mat.clone()),
    )
    .with_expected_remote_id(puller.id.into());
    pump_full_session_602(&mut init, &mut resp).await;
    (init.session().state.clone(), resp.session().state.clone())
}

/// The daily snapshot's copy: engines saved, then `VACUUM INTO`.
async fn copy_database(device: &Device, to: &std::path::Path) {
    device.mat.flush_foreground().await.unwrap();
    let pass =
        agaric_engine::loro::snapshot::save_all_engines(&device.pool, &device.state.registry).await;
    assert!(
        pass.persisted_through.is_some(),
        "the copy must carry A's engine state"
    );
    sqlx::query("VACUUM INTO ?")
        .bind(to.to_str().unwrap())
        .execute(&device.pool)
        .await
        .unwrap();
}

/// Boot `id` on the copy at `path` the way `crate::run` does, after writing
/// `epoch` (when given) the way a restore would before any engine loads.
async fn boot_restored(id: &'static str, path: &std::path::Path, epoch: Option<u64>) -> Device {
    let pool = init_pool(path).await.unwrap();
    if let Some(epoch) = epoch {
        sqlx::query(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, 0)",
        )
        .bind(PEER_EPOCH_KEY)
        .bind(epoch.to_string())
        .execute(&pool)
        .await
        .unwrap();
    }
    let restored = device(id, pool);
    let epoch = agaric_engine::loro::peer_epoch::load_peer_epoch(&restored.pool)
        .await
        .unwrap();
    restored.state.registry.set_peer_epoch(epoch);
    agaric_engine::loro::snapshot::rehydrate_registry(&restored.pool, &restored.state.registry, id)
        .await
        .unwrap();
    restored
}

/// A and B in step, then A edits once more and B pulls it, after `copy` has
/// been taken of A. Returns A as it stands (not yet restored) and B.
async fn diverge_after_copy(
    copy: &std::path::Path,
    lost_content: &str,
) -> (Device, Device, TempDir, TempDir) {
    let (pool_a, dir_a) = test_pool().await;
    let (pool_b, dir_b) = test_pool().await;
    let a = device(DEV_A, pool_a);
    let b = device(DEV_B, pool_b);
    peer_refs::upsert_peer_ref(&a.pool, DEV_B).await.unwrap();
    peer_refs::upsert_peer_ref(&b.pool, DEV_A).await.unwrap();

    a.edit(BEFORE_COPY, 1_736_942_400_000).await;
    b.edit(FROM_B, 1_736_942_401_000).await;
    assert_eq!(
        pull(&a, &b).await,
        (SyncState::Complete, SyncState::Complete)
    );
    assert_eq!(
        pull(&b, &a).await,
        (SyncState::Complete, SyncState::Complete)
    );

    copy_database(&a, copy).await;

    a.edit_with(LOST_BY_RESTORE, lost_content, 1_736_942_402_000)
        .await;
    assert_eq!(
        pull(&b, &a).await,
        (SyncState::Complete, SyncState::Complete)
    );
    assert_eq!(
        b.content(LOST_BY_RESTORE).await.as_deref(),
        Some(lost_content),
        "B must hold the edit the copy predates before A is restored"
    );
    (a, b, dir_a, dir_b)
}

/// The restore #6744 builds: the copy goes in under a fresh peer-id epoch
/// before any engine loads, so A never mints an op at a counter B already
/// holds under A's old PeerID.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restore_under_a_fresh_epoch_converges_and_recovers_the_lost_edit_6744() {
    let copies = TempDir::new().unwrap();
    let copy = copies.path().join("notes.db.daily-copy");
    let (a, b, _dir_a, _dir_b) = diverge_after_copy(&copy, LOST_BY_RESTORE).await;
    a.mat.shutdown();

    let restored = boot_restored(DEV_A, &copy, Some(0x6524_6744_0000_0001)).await;
    assert_eq!(
        restored.content(LOST_BY_RESTORE).await,
        None,
        "the copy predates this edit, so the restored A starts without it"
    );
    restored.edit(AFTER_RESTORE, 1_736_942_403_000).await;

    assert_eq!(
        pull(&restored, &b).await,
        (SyncState::Complete, SyncState::Complete),
        "the restored A must pull from B"
    );
    assert_eq!(
        pull(&b, &restored).await,
        (SyncState::Complete, SyncState::Complete),
        "B must pull from the restored A"
    );

    for device in [&restored, &b] {
        for block in [BEFORE_COPY, FROM_B, LOST_BY_RESTORE, AFTER_RESTORE] {
            assert_eq!(
                device.content(block).await.as_deref(),
                Some(block),
                "{} must hold {block} after the restore and two sessions",
                device.id
            );
        }
    }
    assert_eq!(restored.version_vector(), b.version_vector());

    restored.mat.shutdown();
    b.mat.shutdown();
}

/// The decided spike case: A was restored without an epoch bump and has
/// already written under its old PeerID. B's copy of A's ops is longer than
/// A's, so the fork is detected. The prototype heal rebuilds A's engine from
/// B's snapshot and re-applies the ops of A's that B does not hold, found by
/// `(seq, hash)` against B's audit copy of A's op log, so it needs no record
/// of when the rewind happened. The re-applied ops continue from B's counter
/// for A, so the PeerID can stay: the ops it replaces never left A.
///
/// Asserted on A's engine, not its database: the rebuilt engine already holds
/// the lost edit, so no session delivers it to A's SQL, which a reproject
/// from the engine has to bring up.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_that_wrote_after_a_rewind_heals_from_its_peer_6524() {
    const LONG: &str = "an edit long enough that B holds more of A's counters than A";
    let space = SpaceId::from_trusted(SPACE);
    let copies = TempDir::new().unwrap();
    let copy = copies.path().join("notes.db.daily-copy");
    let (a, b, _dir_a, _dir_b) = diverge_after_copy(&copy, LONG).await;
    a.mat.shutdown();

    let rewound = boot_restored(DEV_A, &copy, None).await;
    rewound.edit(AFTER_RESTORE, 1_736_942_403_000).await;
    let peer_snapshot = b.engine_snapshot();
    {
        let mut guard = rewound.state.registry.for_space(&space, DEV_A).unwrap();
        assert!(
            guard
                .engine_mut()
                .own_peer_fork_in_blob(&peer_snapshot)
                .is_some(),
            "B's snapshot must be flagged as forking A's own history"
        );
    }

    // A's ops B does not hold, by (seq, hash).
    let held_by_b: std::collections::HashSet<(i64, String)> = b
        .ops_of(DEV_A)
        .await
        .into_iter()
        .map(|(seq, hash, _, _)| (seq, hash))
        .collect();
    let tail: Vec<(i64, String, i64)> = rewound
        .ops_of(DEV_A)
        .await
        .into_iter()
        .filter(|(seq, hash, _, _)| !held_by_b.contains(&(*seq, hash.clone())))
        .map(|(seq, _, payload, created_at)| (seq, payload, created_at))
        .collect();
    let tail_blocks: Vec<String> = tail
        .iter()
        .map(|(_, payload, _)| {
            serde_json::from_str::<serde_json::Value>(payload).unwrap()["block_id"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        tail_blocks,
        [AFTER_RESTORE],
        "exactly the edit made after the rewind"
    );

    // The heal.
    let mut engine = agaric_engine::loro::engine::LoroEngine::with_peer_id_epoch(
        DEV_A,
        rewound.state.registry.peer_epoch(),
    )
    .unwrap();
    engine.import(&peer_snapshot).unwrap();
    rewound.state.registry.install_engine(space.clone(), engine);
    for (seq, payload, created_at) in &tail {
        let op: agaric_store::op::OpPayload = serde_json::from_str(payload).unwrap();
        agaric_engine::merge::engine_apply(
            &format!("{DEV_A}/{seq}"),
            &op,
            DEV_A,
            &space,
            &created_at.to_string(),
            &rewound.state,
        );
    }

    assert_eq!(
        pull(&rewound, &b).await,
        (SyncState::Complete, SyncState::Complete)
    );
    assert_eq!(
        pull(&b, &rewound).await,
        (SyncState::Complete, SyncState::Complete)
    );
    for (block, content) in [
        (BEFORE_COPY, BEFORE_COPY),
        (FROM_B, FROM_B),
        (LOST_BY_RESTORE, LONG),
        (AFTER_RESTORE, AFTER_RESTORE),
    ] {
        assert_eq!(
            rewound.engine_content(block).as_deref(),
            Some(content),
            "A's engine: {block}"
        );
        assert_eq!(
            b.content(block).await.as_deref(),
            Some(content),
            "B's database: {block}"
        );
    }
    assert_eq!(rewound.version_vector(), b.version_vector());

    rewound.mat.shutdown();
    b.mat.shutdown();
}
