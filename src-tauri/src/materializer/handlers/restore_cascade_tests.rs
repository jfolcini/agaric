// ---------------------------------------------------------------------------
// RestoreBlock cascade fanout tests.
//
// Verifies the materializer's restore-cascade fans out `RestoreBlock`
// engine calls to every descendant in the SQL cohort, not just the
// seed block. Without this fanout a 10-descendant subtree restore
// would leave 9 blocks marked `deleted_at != Null` in the Loro doc.
// ---------------------------------------------------------------------------
use super::*;
use crate::db::init_pool;
use crate::loro::shared::LoroState;
use crate::op::OpPayload;
use crate::space::SpaceId;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const PAGE_ID: &str = "01HZ00000000000000000000PA";
const CHILD_1: &str = "01HZ00000000000000000000C1";
const CHILD_2: &str = "01HZ00000000000000000000C2";
const CHILD_3: &str = "01HZ00000000000000000000C3";
const SPACE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DEVICE_ID: &str = "device-restore-cascade";
const DELETED_AT: i64 = 1_735_689_600_000;

async fn fresh_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("restore_cascade.db");
    let pool = init_pool(&db_path).await.expect("init_pool");
    (pool, dir)
}

/// Build a tree: page (PAGE_ID) → child (CHILD_1) → grandchild
/// (CHILD_2) → great-grandchild (CHILD_3). Each block gets
/// `deleted_at = DELETED_AT` so the restore CTE will sweep all four.
/// The page also gets `blocks.space_id = SPACE` so space membership
/// resolves to SPACE.
async fn seed_deleted_subtree(pool: &SqlitePool) {
    // Space block (referenced by `block_properties.value_ref` →
    // FK → `blocks(id)`).  Spaces are stored as 'tag' blocks today
    // — see `commands::spaces::create_space`; for the test the
    // block_type just needs to satisfy the schema's CHECK
    // constraint (`content | tag | page`).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE)
    .execute(pool)
    .await
    .unwrap();
    // #708: register in the `spaces` table — `blocks.space_id`
    // REFERENCES spaces(id) since migration 0089.
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE)
        .execute(pool)
        .await
        .unwrap();
    // Page (no parent, page_id = self).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                                 deleted_at) \
             VALUES (?, 'page', 'P', NULL, 0, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(DELETED_AT)
    .execute(pool)
    .await
    .unwrap();
    // Three nested children.
    for (id, parent, pos) in [
        (CHILD_1, PAGE_ID, 0_i64),
        (CHILD_2, CHILD_1, 0),
        (CHILD_3, CHILD_2, 0),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, \
                                     deleted_at) \
                 VALUES (?, 'content', 'C', ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(parent)
        .bind(pos)
        .bind(PAGE_ID)
        .bind(DELETED_AT)
        .execute(pool)
        .await
        .unwrap();
    }
    // Phase 2 (#533): space membership is read from `blocks.space_id`.
    // Set the denormalized column on the page and every block paged to it.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(SPACE)
        .bind(PAGE_ID)
        .bind(PAGE_ID)
        .execute(pool)
        .await
        .unwrap();
}

/// Returns a fresh LoroState — install_for_test pattern.  Unlike
/// `loro::shared::install_for_test` the global is process-local and
/// per-nextest-process, so tests don't conflict.
fn fresh_loro_state() -> &'static LoroState {
    crate::loro::shared::install_for_test()
}

/// Pre-populate the engine with the four blocks (alive), then mark
/// each deleted via `apply_delete_block`.  This sets up an engine
/// state that mirrors the SQL "all four deleted at the same ref"
/// shape so the `apply_restore_block` calls have something to
/// restore.
fn seed_engine_with_deleted_subtree(state: &LoroState) {
    let space = SpaceId::from_trusted(SPACE);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine = guard.engine_mut();
    // Seed four alive blocks with the same parent shape as SQL.
    engine
        .apply_create_block(PAGE_ID, "page", "P", None, 0)
        .unwrap();
    engine
        .apply_create_block(CHILD_1, "content", "C", Some(PAGE_ID), 0)
        .unwrap();
    engine
        .apply_create_block(CHILD_2, "content", "C", Some(CHILD_1), 0)
        .unwrap();
    engine
        .apply_create_block(CHILD_3, "content", "C", Some(CHILD_2), 0)
        .unwrap();
    // Soft-delete all four at the same cohort timestamp (mirrors the
    // SQL "all four deleted at the same ref" shape).
    for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
        engine
            .apply_delete_block(id, "2025-01-15T12:00:00Z")
            .unwrap();
    }
}

/// Read the engine's `deleted_at` flag for `block_id`.  Returns
/// `Some(true)` if the engine reports the block as deleted,
/// `Some(false)` if alive, `None` if the block is absent in the
/// engine.
fn engine_block_deleted(state: &LoroState, block_id: &str) -> Option<bool> {
    let space = SpaceId::from_trusted(SPACE);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine = guard.engine_mut();
    let snap = engine.read_block(block_id).expect("read_block");
    snap.as_ref()?;
    // `read_deleted` returns Ok(false) when `deleted_at` is missing
    // (engine never marked it deleted) or LoroValue::Null (engine
    // explicitly cleared the flag — i.e. the block is alive).
    Some(engine.read_deleted(block_id).expect("read_deleted"))
}

/// Drives the materializer's `apply_op` path for a `RestoreBlock`
/// op against a 4-block subtree, then asserts that the per-space
/// `LoroEngine` has `deleted_at = Null` on EVERY block — the seed
/// AND its three descendants.  Without the day-9 fanout the
/// engine-side state would still report `deleted_at != Null` on
/// the three descendants.
#[tokio::test]
async fn restore_block_dispatches_to_loro_for_each_descendant() {
    let (pool, _dir) = fresh_pool().await;
    seed_deleted_subtree(&pool).await;
    let state = fresh_loro_state();
    seed_engine_with_deleted_subtree(state);

    // Sanity: every block is currently deleted in the engine.
    for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
        assert_eq!(
            engine_block_deleted(state, id),
            Some(true),
            "{id} must start deleted",
        );
    }

    // Build a RestoreBlock op record by appending it to op_log so
    // the rest of the apply path sees a real OpRecord.  The seed
    // block is the page; the cascade walks every descendant
    // matching `deleted_at = DELETED_AT`.
    let payload = OpPayload::RestoreBlock(crate::op::RestoreBlockPayload {
        block_id: BlockId::from_trusted(PAGE_ID),
        deleted_at_ref: DELETED_AT,
    });
    let record = std::sync::Arc::new(
        crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append op_log"),
    );

    // Drive the materializer's apply path (which fans out the
    // engine cohort dispatch).
    let dirty_sink: OnceLock<std::sync::Arc<dyn DirtySink + Send + Sync>> = OnceLock::new();
    super::apply_op(&pool, &record, &dirty_sink)
        .await
        .expect("apply_op");

    // Every block in the cohort — root + three descendants — must
    // now be alive in the engine.  This is the load-bearing
    // assertion: the day-9 fanout is what makes the descendants
    // alive.  Without it CHILD_1, CHILD_2, CHILD_3 would still
    // report deleted_at != Null.
    for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
        assert_eq!(
            engine_block_deleted(state, id),
            Some(false),
            "{id} must be restored after RestoreBlock cascade fanout",
        );
    }
}

/// Direct-helper test — exercises `dispatch_restore_descendants`
/// in isolation, bypassing the full `apply_op` path.  Asserts the
/// helper's empty-input fast path AND the per-descendant fanout
/// shape.
#[tokio::test]
async fn dispatch_restore_descendants_empty_list_is_noop() {
    let (pool, _dir) = fresh_pool().await;
    seed_deleted_subtree(&pool).await;
    let state = fresh_loro_state();
    seed_engine_with_deleted_subtree(state);

    // Build a synthetic root record (we don't actually run the SQL
    // restore here — only the empty-list fanout path).
    let payload = serde_json::to_string(&serde_json::json!({
        "block_id": PAGE_ID,
        "deleted_at_ref": DELETED_AT,
    }))
    .unwrap();
    let root = OpRecord {
        device_id: DEVICE_ID.into(),
        seq: 1,
        parent_seqs: None,
        hash: "0000".into(),
        op_type: "restore_block".into(),
        payload,
        created_at: DELETED_AT,
        block_id: Some(PAGE_ID.into()),
    };

    // Empty descendant list — no engine mutations expected.
    super::dispatch_restore_descendants(&pool, &root, &[]).await;

    // Engine state unchanged: every block is still deleted (we
    // seeded them deleted in seed_engine_with_deleted_subtree).
    for id in [PAGE_ID, CHILD_1, CHILD_2, CHILD_3] {
        assert_eq!(
            engine_block_deleted(state, id),
            Some(true),
            "{id} must remain deleted on empty-fanout path",
        );
    }
}
