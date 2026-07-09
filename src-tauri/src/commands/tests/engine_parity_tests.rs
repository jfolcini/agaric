//! Engine/SQL lockstep regression tests for the block command layer.
//!
//! The per-space Loro engine is mutated synchronously inside command
//! transactions (`apply_op_projected`) or via post-commit fan-outs
//! (`merge::engine_apply`), but it has NO transactional rollback. These
//! tests pin the invariant that a command NEVER leaves the shared
//! in-memory engine diverged from the committed (or rolled-back) SQL
//! state:
//!
//! * a mid-batch rejection in `move_blocks_batch` / `create_blocks_batch`
//!   must not leave earlier ops applied in the engine (R2/R22);
//! * `purge_block` / `purge_all_deleted` must drop the purged subtree
//!   from the engine like `purge_blocks_by_ids` does (R10/R24, #1257);
//! * a create rejected by cross-space validation must not leave a
//!   phantom committed block in the engine (R25);
//! * the reserved `space` key must not be stampable onto a content block
//!   (R17 — pages and top-level tags are the only authoritative
//!   `space_id` holders).
//!
//! Every fixture seeds SQL rows AND the per-space engine identically
//! (mirroring the conformance runner's `seed_block_into_engine`) so the
//! commands take the production engine path, not the SQL-only fallback.

use super::super::*;
use super::common::*;
use crate::ulid::ActiveBlockId;

/// Seed one block into the per-space Loro engine, mirroring an
/// `insert_block` SQL seed so engine and SQL start in lockstep.
fn seed_engine_block(
    mat: &Materializer,
    space_id: &str,
    id: &str,
    block_type: &str,
    content: &str,
    parent: Option<&str>,
    position: i64,
) {
    let space = SpaceId::from_trusted(space_id);
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space, DEV)
        .expect("for_space (engine seed)");
    guard
        .engine_mut()
        .apply_create_block(id, block_type, content, parent, position)
        .expect("seed engine block");
}

/// Engine-side parent of `id` (panics if the block is not in the engine).
fn engine_parent(mat: &Materializer, space_id: &str, id: &str) -> Option<String> {
    let space = SpaceId::from_trusted(space_id);
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space, DEV)
        .expect("for_space (read)");
    guard.engine_mut().read_parent(id).expect("read_parent")
}

/// Whether the engine still holds ANY record for `id` (live or
/// soft-deleted). A purged block must return `false`.
fn engine_has_block(mat: &Materializer, space_id: &str, id: &str) -> bool {
    let space = SpaceId::from_trusted(space_id);
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space, DEV)
        .expect("for_space (read)");
    guard
        .engine_mut()
        .read_block(id)
        .expect("read_block")
        .is_some()
}

/// Engine-side ordered children of `parent` (empty when the parent is
/// absent from the engine).
fn engine_children(mat: &Materializer, space_id: &str, parent: Option<&str>) -> Vec<String> {
    let space = SpaceId::from_trusted(space_id);
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space, DEV)
        .expect("for_space (read)");
    guard
        .engine_mut()
        .children_ordered_block_ids(parent)
        .expect("children_ordered_block_ids")
}

async fn sql_parent(pool: &SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

// ======================================================================
// R2/R22 — move_blocks_batch: mid-batch rejection must not leave the
// engine ahead of the rolled-back tx
// ======================================================================

/// Multi-select drag of roots [A, B] onto B's own child B1 (the frontend
/// permits this: only the ACTIVE drag root's descendants are excluded
/// from drop targets). Move 0 (A → B1) is valid in isolation; move 1
/// (B → B1) is a cycle. The whole batch must be rejected AND the engine
/// must match the rolled-back SQL — no phantom A-under-B1 in the CRDT.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_blocks_batch_mid_batch_cycle_leaves_engine_in_lockstep_with_sql() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "MB_P", "page", "P", None, Some(1)).await;
    insert_block(&pool, "MB_A", "content", "A", Some("MB_P"), Some(1)).await;
    insert_block(&pool, "MB_B", "content", "B", Some("MB_P"), Some(2)).await;
    insert_block(&pool, "MB_B1", "content", "B1", Some("MB_B"), Some(1)).await;
    assign_all_to_test_space(&pool).await;
    seed_engine_block(&mat, TEST_SPACE_ID, "MB_P", "page", "P", None, 1);
    seed_engine_block(&mat, TEST_SPACE_ID, "MB_A", "content", "A", Some("MB_P"), 1);
    seed_engine_block(&mat, TEST_SPACE_ID, "MB_B", "content", "B", Some("MB_P"), 2);
    seed_engine_block(
        &mat,
        TEST_SPACE_ID,
        "MB_B1",
        "content",
        "B1",
        Some("MB_B"),
        1,
    );

    let result = move_blocks_batch_inner(
        &pool,
        DEV,
        &mat,
        vec!["MB_A".into(), "MB_B".into()],
        Some("MB_B1".into()),
        0,
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation { .. })),
        "moving B under its own child B1 must reject the batch, got {result:?}"
    );

    // SQL rolled back (already pinned elsewhere) …
    assert_eq!(sql_parent(&pool, "MB_A").await.as_deref(), Some("MB_P"));
    assert_eq!(sql_parent(&pool, "MB_B").await.as_deref(), Some("MB_P"));

    // … and the ENGINE must agree with it: before the fix, move 0 had
    // already committed A → B1 into the shared LoroDoc, which the tx drop
    // could not undo (R2/R22).
    assert_eq!(
        engine_parent(&mat, TEST_SPACE_ID, "MB_A").as_deref(),
        Some("MB_P"),
        "engine must not keep the rolled-back A → B1 move"
    );
    assert_eq!(
        engine_parent(&mat, TEST_SPACE_ID, "MB_B").as_deref(),
        Some("MB_P"),
        "engine must not keep any rolled-back move"
    );
    assert!(
        engine_children(&mat, TEST_SPACE_ID, Some("MB_B1")).is_empty(),
        "B1 must have no engine children after the rolled-back batch"
    );
}

/// Same shape via `create_blocks_batch`: spec 0 is valid, spec 1 fails
/// validation (unknown block_type). The rolled-back batch must not leave
/// spec 0's block committed in the engine.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_blocks_batch_mid_batch_rejection_leaves_engine_in_lockstep_with_sql() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "CBB_P", "page", "P", None, Some(1)).await;
    assign_all_to_test_space(&pool).await;
    seed_engine_block(&mat, TEST_SPACE_ID, "CBB_P", "page", "P", None, 1);

    let specs = vec![
        CreateBlockSpec {
            block_type: "content".into(),
            content: "valid first spec".into(),
            parent_id: Some("CBB_P".into()),
            position: None,
            properties: std::collections::HashMap::default(),
        },
        CreateBlockSpec {
            block_type: "bogus".into(),
            content: "invalid second spec".into(),
            parent_id: Some("CBB_P".into()),
            position: None,
            properties: std::collections::HashMap::default(),
        },
    ];
    let result = create_blocks_batch_inner(&pool, DEV, &mat, specs).await;
    assert!(
        matches!(result, Err(AppError::Validation { .. })),
        "unknown block_type must reject the batch, got {result:?}"
    );

    // SQL rolled back: the page has no children.
    let sql_children: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE parent_id = 'CBB_P'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sql_children, 0, "no SQL child rows survive the rollback");

    // Engine must agree: before the fix, spec 0's block was already
    // committed into the LoroDoc under CBB_P.
    assert!(
        engine_children(&mat, TEST_SPACE_ID, Some("CBB_P")).is_empty(),
        "no engine child may survive the rolled-back create batch"
    );
}

// ======================================================================
// R10/R24 — single purge_block / purge_all_deleted must drop the purged
// subtree from the engine (like purge_blocks_by_ids does, #1257)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_drops_purged_subtree_from_loro_engine() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PG_P", "page", "P", None, Some(1)).await;
    insert_block(&pool, "PG_C", "content", "C", Some("PG_P"), Some(1)).await;
    insert_block(&pool, "PG_C1", "content", "C1", Some("PG_C"), Some(1)).await;
    assign_all_to_test_space(&pool).await;
    seed_engine_block(&mat, TEST_SPACE_ID, "PG_P", "page", "P", None, 1);
    seed_engine_block(&mat, TEST_SPACE_ID, "PG_C", "content", "C", Some("PG_P"), 1);
    seed_engine_block(
        &mat,
        TEST_SPACE_ID,
        "PG_C1",
        "content",
        "C1",
        Some("PG_C"),
        1,
    );

    delete_block_inner(&pool, DEV, &mat, "PG_C".into())
        .await
        .expect("soft delete");
    // Soft delete keeps the nodes in the doc (tombstones export over sync).
    assert!(engine_has_block(&mat, TEST_SPACE_ID, "PG_C"));

    purge_block_inner(&pool, DEV, &mat, "PG_C".into())
        .await
        .expect("purge");

    // SQL rows are physically gone.
    let sql_rows: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE id IN ('PG_C', 'PG_C1')")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sql_rows, 0, "purged rows must be physically deleted");

    // REGRESSION (R10/R24): the engine must drop the purged subtree too,
    // exactly as the batch `purge_blocks_by_ids` path does — otherwise the
    // subtree stays alive in the CRDT and resurrects over sync.
    assert!(
        !engine_has_block(&mat, TEST_SPACE_ID, "PG_C"),
        "purged block must be gone from the engine"
    );
    assert!(
        !engine_has_block(&mat, TEST_SPACE_ID, "PG_C1"),
        "purged descendant must be gone from the engine"
    );
    // Unrelated blocks survive.
    assert!(engine_has_block(&mat, TEST_SPACE_ID, "PG_P"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_all_deleted_drops_purged_subtrees_from_loro_engine() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "PA_P", "page", "P", None, Some(1)).await;
    insert_block(&pool, "PA_C", "content", "C", Some("PA_P"), Some(1)).await;
    insert_block(&pool, "PA_C1", "content", "C1", Some("PA_C"), Some(1)).await;
    insert_block(&pool, "PA_D", "content", "D", Some("PA_P"), Some(2)).await;
    assign_all_to_test_space(&pool).await;
    seed_engine_block(&mat, TEST_SPACE_ID, "PA_P", "page", "P", None, 1);
    seed_engine_block(&mat, TEST_SPACE_ID, "PA_C", "content", "C", Some("PA_P"), 1);
    seed_engine_block(
        &mat,
        TEST_SPACE_ID,
        "PA_C1",
        "content",
        "C1",
        Some("PA_C"),
        1,
    );
    seed_engine_block(&mat, TEST_SPACE_ID, "PA_D", "content", "D", Some("PA_P"), 2);

    delete_block_inner(&pool, DEV, &mat, "PA_C".into())
        .await
        .expect("soft delete C");
    delete_block_inner(&pool, DEV, &mat, "PA_D".into())
        .await
        .expect("soft delete D");

    let resp = purge_all_deleted_inner(&pool, DEV, &mat)
        .await
        .expect("empty trash");
    assert_eq!(resp.affected_count, 3, "C, C1 and D purged");

    // REGRESSION (R10/R24): 'Empty trash' must drop every purged subtree
    // from the engine, mirroring the by-ids batch path.
    for id in ["PA_C", "PA_C1", "PA_D"] {
        assert!(
            !engine_has_block(&mat, TEST_SPACE_ID, id),
            "purged block {id} must be gone from the engine"
        );
    }
    assert!(engine_has_block(&mat, TEST_SPACE_ID, "PA_P"));
}

// ======================================================================
// R25 — a create rejected by cross-space validation must not leave a
// phantom committed block in the engine
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejected_cross_space_create_leaves_no_phantom_block_in_engine() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;

    // Page in space A; ULID-shaped target block in space B (the content
    // scanner only matches 26-char ULID tokens).
    let page_a = BlockId::new().into_string();
    let target_b = BlockId::new().into_string();
    insert_block(&pool, &page_a, "page", "PA", None, Some(1)).await;
    insert_block(&pool, &target_b, "page", "TB", None, Some(1)).await;
    assign_to_space(&pool, &page_a, TEST_SPACE_ID).await;
    assign_to_space(&pool, &target_b, TEST_SPACE_B_ID).await;
    seed_engine_block(&mat, TEST_SPACE_ID, &page_a, "page", "PA", None, 1);

    let result = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        format!("see [[{target_b}]] for details"),
        Some(page_a.clone().into()),
        Some(0),
    )
    .await;
    let err = result.expect_err("cross-space content ref must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }) && err.to_string().contains("cross-space"),
        "expected a cross-space Validation error, got {err:?}"
    );

    // SQL rolled back: the page has no children.
    let sql_children: i64 =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE parent_id = ?")
            .bind(&page_a)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sql_children, 0, "no SQL child rows survive the rejection");

    // REGRESSION (R25): before the fix, the block was committed into the
    // LoroDoc BEFORE the cross-space validation ran, leaving a phantom
    // node that exports over sync while op_log + SQL rolled back.
    assert!(
        engine_children(&mat, TEST_SPACE_ID, Some(&page_a)).is_empty(),
        "rejected create must not leave a phantom child in the engine"
    );
}

// ======================================================================
// R17 — reserved 'space' key must be rejected on non-page blocks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_space_key_rejected_on_content_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    insert_block(&pool, "SP_P", "page", "P", None, Some(1)).await;
    insert_block(&pool, "SP_C", "content", "C", Some("SP_P"), Some(1)).await;
    assign_to_space(&pool, "SP_P", TEST_SPACE_ID).await;
    assign_to_space(&pool, "SP_C", TEST_SPACE_ID).await;
    seed_engine_block(&mat, TEST_SPACE_ID, "SP_P", "page", "P", None, 1);
    seed_engine_block(&mat, TEST_SPACE_ID, "SP_C", "content", "C", Some("SP_P"), 1);

    // Reachable via the MCP set_property tool: stamping a CONTENT block
    // into a foreign space mis-scopes reads and mis-routes every later
    // per-space engine apply for the block. Must reject loudly.
    let result = set_property_inner(
        &pool,
        DEV,
        &mat,
        ActiveBlockId::from_trusted_active("SP_C"),
        "space".into(),
        None,
        None,
        None,
        Some(TEST_SPACE_B_ID.to_string()),
        None,
        None,
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Validation { .. })),
        "'space' on a content block must be a Validation error, got {result:?}"
    );

    // The content block keeps its original space.
    let space: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT space_id FROM blocks WHERE id = 'SP_C'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        space.as_deref(),
        Some(TEST_SPACE_ID),
        "rejected space write must not change the block's space"
    );

    // No op leaked into the op_log.
    let ops: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'set_property' AND block_id = 'SP_C'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ops, 0, "no SetProperty op may survive the rejection");
}

/// Control: the `space` key still works on PAGE blocks — that is the
/// documented way pages move between spaces.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_space_key_still_accepted_on_page_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    insert_block(&pool, "SPP_P", "page", "P", None, Some(1)).await;
    assign_to_space(&pool, "SPP_P", TEST_SPACE_ID).await;
    seed_engine_block(&mat, TEST_SPACE_ID, "SPP_P", "page", "P", None, 1);

    set_property_inner(
        &pool,
        DEV,
        &mat,
        ActiveBlockId::from_trusted_active("SPP_P"),
        "space".into(),
        None,
        None,
        None,
        Some(TEST_SPACE_B_ID.to_string()),
        None,
        None,
    )
    .await
    .expect("'space' on a page must stay accepted (page migration path)");

    let space: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT space_id FROM blocks WHERE id = 'SPP_P'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(space.as_deref(), Some(TEST_SPACE_B_ID));
}
