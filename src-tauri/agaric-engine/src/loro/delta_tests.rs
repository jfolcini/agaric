//! `loro_doc_delta` (#6521): the save paths in [`super::delta`], and the
//! oracle the rest of the suite leans on.

use sqlx::SqlitePool;

use super::delta::{insert_delta, saved_engine_divergences, write_engines};
use super::shared::LoroState;
use agaric_core::error::AppError;
use agaric_store::space::SpaceId;

const SPACE_A: &str = "01DELTATESTSPACE0000000001";
const SPACE_B: &str = "01DELTATESTSPACE0000000002";
const DEVICE: &str = "delta-test-device";

fn space(id: &str) -> SpaceId {
    SpaceId::from_trusted(id)
}

async fn delta_rows(pool: &SqlitePool, space_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_delta WHERE space_id = ?")
        .bind(space_id)
        .fetch_one(pool)
        .await
        .expect("count the space's deltas")
}

/// Create `block` in `space_id`'s engine the way a post-commit fan-out does:
/// under the write lock, with its delta.
async fn create_saved(pool: &SqlitePool, state: &LoroState, space_id: &str, block: &str) {
    write_engines(pool, &state.registry, &state.revert, "test_write", async {
        state
            .registry
            .for_space_recording(&space(space_id), DEVICE, &state.revert)
            .expect("engine")
            .engine_mut()
            .apply_create_block(block, "content", block, None, 0)
            .expect("create");
    })
    .await
    .expect("save the write");
}

/// Create `block` in `space_id`'s engine and save nothing.
fn create_unsaved(state: &LoroState, space_id: &str, block: &str) {
    state
        .registry
        .for_space(&space(space_id), DEVICE)
        .expect("engine")
        .engine_mut()
        .apply_create_block(block, "content", block, None, 0)
        .expect("create");
}

fn holds(state: &LoroState, space_id: &str, block: &str) -> bool {
    state
        .registry
        .for_space(&space(space_id), DEVICE)
        .expect("engine")
        .engine_mut()
        .read_block(block)
        .expect("read")
        .is_some()
}

#[tokio::test]
async fn an_engine_write_is_saved_as_one_delta_per_space_it_wrote_6521() {
    let (pool, _dir) = agaric_store::test_support::test_pool().await;
    let state = LoroState::new();

    create_saved(&pool, &state, SPACE_A, "BLOCK1").await;
    create_saved(&pool, &state, SPACE_A, "BLOCK2").await;
    write_engines(&pool, &state.registry, &state.revert, "test_read", async {
        // A space the transaction reads and does not write saves nothing.
        let mut guard = state
            .registry
            .for_space_recording(&space(SPACE_B), DEVICE, &state.revert)
            .expect("engine");
        assert!(guard.engine_mut().read_block("BLOCK1").unwrap().is_none());
    })
    .await
    .expect("a read commits");

    assert_eq!(delta_rows(&pool, SPACE_A).await, 2, "one row per write");
    assert_eq!(delta_rows(&pool, SPACE_B).await, 0, "a read saves no row");
    assert_eq!(
        saved_engine_divergences(&pool, &state.registry)
            .await
            .unwrap(),
        Vec::<String>::new(),
        "the two rows rebuild the engine"
    );
}

#[tokio::test]
async fn the_oracle_names_the_space_whose_engine_write_saved_no_delta_6521() {
    let (pool, _dir) = agaric_store::test_support::test_pool().await;
    let state = LoroState::new();
    create_saved(&pool, &state, SPACE_A, "BLOCK1").await;
    create_saved(&pool, &state, SPACE_B, "BLOCK1").await;

    create_unsaved(&state, SPACE_A, "BLOCK2");

    let divergences = saved_engine_divergences(&pool, &state.registry)
        .await
        .unwrap();
    assert_eq!(
        divergences.len(),
        1,
        "only space A diverges: {divergences:?}"
    );
    assert!(
        divergences[0].starts_with(&format!("space {SPACE_A}:")),
        "the divergence names space A: {divergences:?}"
    );

    // A later write that is saved does not close the gap: its row depends on
    // the op no row holds.
    create_saved(&pool, &state, SPACE_A, "BLOCK3").await;
    let divergences = saved_engine_divergences(&pool, &state.registry)
        .await
        .unwrap();
    assert_eq!(divergences.len(), 1, "the gap stays: {divergences:?}");
    assert!(
        divergences[0].contains("pending"),
        "the later row is left pending on the unsaved op: {divergences:?}"
    );
}

#[tokio::test]
async fn a_delta_that_cannot_be_saved_rewinds_the_engine_write_6521() {
    let (pool, _dir) = agaric_store::test_support::test_pool().await;
    let state = LoroState::new();
    create_saved(&pool, &state, SPACE_A, "KEPT").await;
    sqlx::query(
        "CREATE TRIGGER refuse_deltas BEFORE INSERT ON loro_doc_delta \
         BEGIN SELECT RAISE(ABORT, 'no deltas today'); END",
    )
    .execute(&pool)
    .await
    .unwrap();

    let saved: Result<(), AppError> =
        write_engines(&pool, &state.registry, &state.revert, "test_write", async {
            state
                .registry
                .for_space_recording(&space(SPACE_A), DEVICE, &state.revert)
                .expect("engine")
                .engine_mut()
                .apply_create_block("LOST", "content", "lost", None, 1)
                .expect("create");
        })
        .await;

    assert!(saved.is_err(), "the refused row fails the write");
    assert!(
        holds(&state, SPACE_A, "KEPT"),
        "the earlier write stays in the engine"
    );
    assert!(
        !holds(&state, SPACE_A, "LOST"),
        "the write whose delta was refused is rewound"
    );
    assert_eq!(
        saved_engine_divergences(&pool, &state.registry)
            .await
            .unwrap(),
        Vec::<String>::new(),
        "the engine still equals its saved rows"
    );
}

#[tokio::test]
async fn the_oracle_counts_an_inbound_blob_its_projection_has_not_cleared_6521() {
    let (pool, _dir) = agaric_store::test_support::test_pool().await;
    let state = LoroState::new();
    let peer = LoroState::new();
    create_unsaved(&peer, SPACE_A, "FROM_PEER");
    let blob = peer
        .registry
        .with_engine(&space(SPACE_A), "peer-device", |engine| {
            engine.export_snapshot()
        })
        .unwrap()
        .unwrap();

    // The import reached the engine, and its projection has not committed:
    // the blob is in the inbox, and no delta is saved yet.
    sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, 0)")
        .bind(SPACE_A)
        .bind(blob.as_slice())
        .execute(&pool)
        .await
        .unwrap();
    let (_, delta) = state
        .registry
        .with_engine(&space(SPACE_A), DEVICE, |engine| {
            engine.capturing_delta(|engine| engine.import(&blob))
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        saved_engine_divergences(&pool, &state.registry)
            .await
            .unwrap(),
        Vec::<String>::new(),
        "the inbox row stands for the import until the projection commits"
    );

    // The projection commits: the slot goes and the delta is saved.
    let mut tx = pool.begin().await.unwrap();
    insert_delta(
        &mut tx,
        &space(SPACE_A),
        &delta.expect("the import added ops"),
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM loro_sync_inbox")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        saved_engine_divergences(&pool, &state.registry)
            .await
            .unwrap(),
        Vec::<String>::new(),
        "the delta alone rebuilds what the import added"
    );
}
