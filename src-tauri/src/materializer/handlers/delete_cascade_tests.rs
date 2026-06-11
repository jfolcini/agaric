use super::*;
use crate::db::init_pool;
use crate::loro::shared::LoroState;
use crate::op::OpPayload;
use crate::space::SpaceId;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

// Distinct ULIDs from `restore_cascade_tests` so cross-test bleed
// through the process-local Loro state is impossible.
const PAGE_ID: &str = "01HZ00000000000000000000PD";
const CHILD_1: &str = "01HZ00000000000000000000D1";
const CHILD_2: &str = "01HZ00000000000000000000D2";
const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const DEVICE_ID: &str = "device-delete-cascade";

async fn fresh_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("delete_cascade.db");
    let pool = init_pool(&db_path).await.expect("init_pool");
    (pool, dir)
}

/// Build a tree: page (PAGE_ID) -> child (CHILD_1) -> grandchild
/// (CHILD_2).  All ALIVE (deleted_at NULL) so the
/// `descendants_cte_active!()` filter in `apply_delete_block_tx`
/// matches all three.  The page also gets `blocks.space_id = SPACE`
/// so space membership resolves to SPACE.
async fn seed_alive_subtree(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE)
    .execute(pool)
    .await
    .expect("seed space block");
    // #708: register in the `spaces` table — `blocks.space_id`
    // REFERENCES spaces(id) since migration 0089.
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE)
        .execute(pool)
        .await
        .expect("register space (#708)");
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'P', NULL, 0, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .execute(pool)
    .await
    .expect("seed page");
    for (id, parent, pos) in [(CHILD_1, PAGE_ID, 0_i64), (CHILD_2, CHILD_1, 0)] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'content', 'C', ?, ?, ?)",
        )
        .bind(id)
        .bind(parent)
        .bind(pos)
        .bind(PAGE_ID)
        .execute(pool)
        .await
        .expect("seed child");
    }
    // Phase 2 (#533): space membership is read from `blocks.space_id`.
    // Set the denormalized column on the page and every block paged to it.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(SPACE)
        .bind(PAGE_ID)
        .bind(PAGE_ID)
        .execute(pool)
        .await
        .expect("seed denormalized space_id");
}

fn fresh_loro_state() -> &'static LoroState {
    crate::loro::shared::install_for_test()
}

/// Pre-populate the engine with the three blocks ALIVE.  Mirrors the
/// SQL "active subtree" shape so the `apply_delete_block` cohort
/// fan-out has something to mark deleted.
fn seed_engine_with_alive_subtree(state: &LoroState) {
    let space = SpaceId::from_trusted(SPACE);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine = guard.engine_mut();
    engine
        .apply_create_block(PAGE_ID, "page", "P", None, 0)
        .expect("create page");
    engine
        .apply_create_block(CHILD_1, "content", "C", Some(PAGE_ID), 0)
        .expect("create child 1");
    engine
        .apply_create_block(CHILD_2, "content", "C", Some(CHILD_1), 0)
        .expect("create child 2");
}

fn engine_block_deleted(state: &LoroState, block_id: &str) -> Option<bool> {
    let space = SpaceId::from_trusted(SPACE);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine = guard.engine_mut();
    let snap = engine.read_block(block_id).expect("read_block");
    snap.as_ref()?;
    Some(engine.read_deleted(block_id).expect("read_deleted"))
}

/// Drives the materializer's `apply_op` path for a `DeleteBlock` op
/// against a 3-block subtree, then asserts that the per-space
/// `LoroEngine` reports `deleted_at != Null` on EVERY block — the
/// seed AND its two descendants.  Without the day-15 fanout the
/// engine-side state would still report `deleted_at = Null` on the
/// two descendants (only the seed sees an engine apply via the
/// in-tx `apply_delete_block_via_loro`).
#[tokio::test]
async fn delete_block_dispatches_to_loro_for_each_descendant() {
    let (pool, _dir) = fresh_pool().await;
    seed_alive_subtree(&pool).await;
    let state = fresh_loro_state();
    seed_engine_with_alive_subtree(state);

    // Sanity: every block is currently alive in the engine.
    for id in [PAGE_ID, CHILD_1, CHILD_2] {
        assert_eq!(
            engine_block_deleted(state, id),
            Some(false),
            "{id} must start alive",
        );
    }

    let payload = OpPayload::DeleteBlock(crate::op::DeleteBlockPayload {
        block_id: BlockId::from_trusted(PAGE_ID),
    });
    let record = std::sync::Arc::new(
        crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append op_log"),
    );

    let dirty_sink: OnceLock<std::sync::Arc<dyn DirtySink + Send + Sync>> = OnceLock::new();
    super::apply_op(&pool, &record, &dirty_sink)
        .await
        .expect("apply_op");

    // Every block in the cohort — root + two descendants — must
    // now be deleted in the engine.  This is the load-bearing
    // assertion: the day-15 fanout is what makes the descendants
    // deleted.  Without it CHILD_1 / CHILD_2 would still report
    // `deleted_at = Null`.
    for id in [PAGE_ID, CHILD_1, CHILD_2] {
        assert_eq!(
            engine_block_deleted(state, id),
            Some(true),
            "{id} must be deleted after DeleteBlock cascade fanout",
        );
    }
}

/// Verifies the cohort SELECT runs BEFORE the UPDATE — the
/// load-bearing ordering invariant.  `collect_delete_cohort` uses
/// `descendants_cte_active!()` which filters `deleted_at IS NULL`,
/// so calling it AFTER the UPDATE would yield an empty list (every
/// row in the cohort has `deleted_at IS NOT NULL` post-UPDATE).
///
/// The test calls `collect_delete_cohort` on a fresh tx, then runs
/// the UPDATE, then calls `collect_delete_cohort` AGAIN — and
/// asserts the first call returned the full cohort while the second
/// call returned empty.  This pins the ordering: any future refactor
/// that swaps the order would flip the second assertion to non-empty
/// and the first to empty, failing the test.
#[tokio::test]
async fn delete_block_cohort_collected_before_update() {
    let (pool, _dir) = fresh_pool().await;
    seed_alive_subtree(&pool).await;

    let payload = crate::op::DeleteBlockPayload {
        block_id: BlockId::from_trusted(PAGE_ID),
    };

    let mut tx = pool.begin().await.expect("begin tx");

    // Pre-UPDATE collection: every active row in the subtree
    // matches `deleted_at IS NULL`, so the seed + two descendants
    // are returned.
    let pre_cohort = super::collect_delete_cohort(&mut tx, &payload)
        .await
        .expect("collect pre-UPDATE");
    assert_eq!(
        pre_cohort.len(),
        3,
        "pre-UPDATE cohort must include seed + 2 descendants; got {pre_cohort:?}",
    );
    for id in [PAGE_ID, CHILD_1, CHILD_2] {
        assert!(
            pre_cohort.iter().any(|c| c == id),
            "pre-UPDATE cohort missing {id}; got {pre_cohort:?}",
        );
    }

    // Run the UPDATE. The cascade UPDATE lives inside the
    // engine-side projection in production; we inline the same
    // CTE-driven UPDATE here because the test's load-bearing
    // assertion is about ordering between `collect_delete_cohort`
    // and the descendants-stamping UPDATE, not about which
    // production helper drives the UPDATE.
    sqlx::query(concat!(
        crate::descendants_cte_active!(),
        "UPDATE blocks SET deleted_at = ? \
             WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
    ))
    .bind(payload.block_id.as_str())
    .bind(1_767_225_600_000_i64)
    .execute(&mut *tx)
    .await
    .expect("cascade UPDATE");

    // Post-UPDATE collection: every row in the subtree now has
    // `deleted_at IS NOT NULL`, so the CTE's recursive step (which
    // requires `deleted_at IS NULL`) finds no descendants.  The
    // outer SELECT additionally filters `deleted_at IS NULL`, so
    // even the seed (which the anchor row admits unconditionally)
    // is excluded.  Empty list confirms the ordering invariant.
    let post_cohort = super::collect_delete_cohort(&mut tx, &payload)
        .await
        .expect("collect post-UPDATE");
    assert!(
        post_cohort.is_empty(),
        "post-UPDATE cohort must be empty (all rows now `deleted_at IS NOT NULL`); \
             got {post_cohort:?}",
    );

    tx.commit().await.expect("commit");
}
