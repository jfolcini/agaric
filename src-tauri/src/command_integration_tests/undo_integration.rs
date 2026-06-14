//! Isolation contract — run with `cargo nextest`, NEVER `cargo test` (#1079).
//!
//! These tests `install_for_test()` the PROCESS-GLOBAL Loro engine and isolate
//! by `state.registry.clear()` (drops every engine in the process) under a
//! single shared `TEST_SPACE_ID`. They are only safe one-process-per-test, which
//! `cargo nextest` (CI + pre-push hook) provides; plain `cargo test` runs the
//! binary multi-threaded in one process and will flake. See
//! `loro::shared::install_for_test` and
//! <https://github.com/jfolcini/agaric/issues/1079>.

use super::common::*;

// ======================================================================
// undo / redo — integration tests
// ======================================================================

// ----------------------------------------------------------------------
// #928 — undo-of-move reprojection (engine path)
// ----------------------------------------------------------------------

/// Seed one pre-existing block into BOTH SQL and the per-space Loro engine tree,
/// mirroring the conformance harness's `insert_seed_block` + `seed_block_into_engine`.
/// Production never seeds out-of-band (every block is born from a CreateBlock op),
/// but a brand-new ROOT page created via op resolves no space yet and would take
/// the SQL-only fallback, so — like conformance — we replay the synthetic
/// pre-existing state straight into the engine. Parents must be seeded before
/// their children (the engine's parent-before-child requirement).
async fn seed_block_both(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: i64,
) {
    insert_block(pool, id, block_type, content, parent_id, Some(position)).await;
    let space = SpaceId::from_trusted(TEST_SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEV)
        .expect("for_space seed");
    guard
        .engine_mut()
        .apply_create_block(id, block_type, content, parent_id, position)
        .expect("seed apply_create_block into engine");
    drop(guard);
}

/// Drive a single op through the production ENGINE path (#891 / #928): append it
/// to the op-log, then run the foreground `ApplyOp` (`dispatch_op` →
/// `apply_op_tx` → `apply_*_via_loro` + `reproject_dense_positions`) and settle
/// the background fan-out. This is the SAME pipeline the conformance harness
/// uses; the local `*_inner` command layer writes only PROVISIONAL positions and
/// never reprojects, so a faithful "what does production materialise" test must
/// route the forward move through here, NOT through `move_block_inner`.
async fn dispatch_via_engine(pool: &SqlitePool, mat: &Materializer, payload: crate::op::OpPayload) {
    let record = crate::op_log::append_local_op(pool, DEV, payload)
        .await
        .expect("append_local_op");
    mat.dispatch_op(&record).await.expect("dispatch_op");
    settle(mat).await;
}

/// Finding 2 of #928. Undo of a cross-page move must leave the SOURCE sibling
/// group densely 1-based with no duplicates/gaps.
///
/// Scenario: `S1 > {A, B, C}` (dense 1,2,3) + a second page `S2`. Move `B` to
/// `S2`; the engine reprojects `S1`'s survivors to `A=1, C=2`. Then undo the
/// move: the reverse `MoveBlock` re-homes `B` back under `S1` at a PROVISIONAL
/// `index_to_provisional_position(idx)` rank via a raw `UPDATE` in
/// `apply_reverse_in_tx`. Before the #928 fix that raw write was the whole story
/// — the reverse-apply path enqueues only a background CACHE rebuild and never
/// runs the foreground engine reproject — so `S1` ended with duplicate/gapped
/// positions that never converged. The fix reprojects both affected groups in
/// `apply_reverse_in_tx::MoveBlock`; this test pins the converged dense end-state.
///
/// ENGINE-PATH confirmation: this test installs the process-global Loro engine
/// (`install_for_test`), seeds the per-space tree (`seed_block_both`), and routes
/// the forward move through `dispatch_op` (the engine apply + reproject). The
/// guard at the end asserts every block is present in the engine tree, so a
/// silent regression to the SQL-only fallback fails loudly rather than passing
/// against the wrong code.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_cross_page_move_reprojects_source_group_dense() {
    use crate::op::{CreateBlockPayload, MoveBlockPayload, OpPayload};
    use crate::ulid::BlockId;

    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // #891/#928: install the engine so the move routes through
    // `apply_*_via_loro` (dense reproject), not the SQL-only fallback. The
    // OnceLock is process-global; clear the registry so this test starts from a
    // fresh per-space tree regardless of sibling tests in the binary.
    let state = crate::loro::shared::install_for_test();
    state.registry.clear();

    // Fixed ids so the engine guard + SQL asserts can reference them directly.
    const S1: &str = "01HZ928000000000000000PAG1";
    const S2: &str = "01HZ928000000000000000PAG2";
    const A: &str = "01HZ9280000000000000000AAA";
    const B: &str = "01HZ9280000000000000000BBB";
    const C: &str = "01HZ9280000000000000000CCC";

    // Seed the two ROOT pages into SQL + engine. A brand-new root page created
    // via op resolves no space yet and would take the SQL-only fallback, so —
    // like the conformance harness — pre-existing roots are replayed straight
    // into the engine. Assign the space NOW so the child CreateBlock ops below
    // resolve their space and route through the engine path.
    seed_block_both(&pool, state, S1, "page", "page-1", None, 1).await;
    seed_block_both(&pool, state, S2, "page", "page-2", None, 2).await;
    assign_all_to_test_space(&pool).await;

    // Create S1's three children via real CreateBlock ops (slots 0,1,2 ⇒ dense
    // ranks 1,2,3). Routing through `dispatch_op` lands them in the engine AND
    // records the op-log create entries that `compute_reverse` walks to
    // reconstruct B's prior placement when the move is undone.
    for (i, child) in [A, B, C].into_iter().enumerate() {
        dispatch_via_engine(
            &pool,
            &mat,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(child),
                block_type: "content".into(),
                parent_id: Some(BlockId::from_trusted(S1)),
                position: None,
                index: Some(i64::try_from(i).unwrap()),
                content: child.into(),
            }),
        )
        .await;
    }
    assign_all_to_test_space(&pool).await;

    // Sanity: S1 children are dense 1,2,3 before the move.
    let pre: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id, position FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
         ORDER BY position",
    )
    .bind(S1)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        pre,
        vec![(A.to_owned(), 1), (B.to_owned(), 2), (C.to_owned(), 3)],
        "sanity: S1 starts dense 1,2,3"
    );

    // Move B under S2 (slot 0). The engine reprojects S1's survivors to A=1, C=2.
    dispatch_via_engine(
        &pool,
        &mat,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(B),
            new_parent_id: Some(BlockId::from_trusted(S2)),
            new_position: 1,
            new_index: Some(0),
        }),
    )
    .await;
    assign_all_to_test_space(&pool).await;

    let after_move: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id, position FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
         ORDER BY position",
    )
    .bind(S1)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        after_move,
        vec![(A.to_owned(), 1), (C.to_owned(), 2)],
        "after the move, S1 survivors re-densify to A=1, C=2"
    );

    // Undo the move. The reverse op re-homes B under S1; `apply_reverse_in_tx`
    // writes a provisional rank then (with the #928 fix) reprojects S1.
    // move_block ops journal against the NEW parent's page, so undo targets S2.
    let undo = undo_page_op_inner(&pool, DEV, &mat, S2.to_owned(), 0)
        .await
        .expect("undo move");
    settle(&mat).await;
    assert_eq!(
        undo.reversed_op_type, "move_block",
        "undo target must be the move_block op"
    );

    // CORE ASSERTION (#928): S1 is dense 1-based with no duplicates/gaps and B is
    // restored to its prior slot (0 ⇒ rank 1), so the order is B,A,C ⇒ 1,2,3.
    let restored: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id, position FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
         ORDER BY position, id",
    )
    .bind(S1)
    .fetch_all(&pool)
    .await
    .unwrap();
    let positions: Vec<i64> = restored.iter().map(|(_, p)| *p).collect();
    let n = i64::try_from(restored.len()).unwrap();
    assert_eq!(
        positions,
        (1..=n).collect::<Vec<_>>(),
        "after undo, S1 must be dense 1..N with no duplicates/gaps; got {restored:?}"
    );
    assert!(
        restored.iter().any(|(id, _)| id == B),
        "B must be restored under S1; got {restored:?}"
    );
    // B was originally created at slot 1 (between A at 0 and C at 2); the reverse
    // op restores that prior placement, so the converged dense order is
    // A=1, B=2, C=3 with B back in the middle.
    assert_eq!(
        restored
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec![A, B, C],
        "undo restores B to its original middle slot; dense order A,B,C; got {restored:?}"
    );

    // ENGINE-PATH GUARD (#891/#928): the moved block must exist in the per-space
    // engine tree. The SQL-only fallback never touches the engine, so this
    // proves the forward ops genuinely ran the production `apply_*_via_loro`
    // path; if a future change drops `install_for_test` / the space assignment
    // and silently regresses to the fallback, this fails loudly.
    {
        let space = SpaceId::from_trusted(TEST_SPACE_ID);
        let mut guard = state.registry.for_space(&space, DEV).expect("for_space");
        for id in [S1, S2, A, B, C] {
            assert!(
                guard
                    .engine_mut()
                    .read_block(id)
                    .expect("read_block")
                    .is_some(),
                "block {id} absent from the engine tree — forward ops took the \
                 SQL-only FALLBACK, not the production engine path (#891)",
            );
        }
        drop(guard);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_page_op_reverses_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Undo Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a child block with "original"
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Edit child to "modified"
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "modified".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Undo the most recent op on the page
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    settle(&mat).await;

    assert_eq!(
        result.new_op_type, "edit_block",
        "undo of an edit must produce an edit_block op"
    );
    assert_eq!(
        result.reversed_op_type, "edit_block",
        "reversed_op_type must echo the op_type of the op being undone"
    );
    assert!(!result.is_redo, "undo must not be flagged as redo");

    // Content should be back to "original"
    let fetched = get_block_inner(&pool, child.id).await.unwrap();
    assert_eq!(
        fetched.content,
        Some("original".into()),
        "undo must restore content to 'original'"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_then_redo_restores_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Redo Test Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a child with "original"
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Edit to "modified"
    edit_block_inner(&pool, DEV, &mat, child.id.clone(), "modified".into())
        .await
        .unwrap();
    settle(&mat).await;

    // Undo
    let undo_result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    settle(&mat).await;

    // Content should be "original" after undo
    let fetched = get_block_inner(&pool, child.id.clone()).await.unwrap();
    assert_eq!(
        fetched.content,
        Some("original".into()),
        "after undo, content must be 'original'"
    );

    // Redo using the new_op_ref from the undo result
    let redo_result = redo_page_op_inner(
        &pool,
        DEV,
        &mat,
        undo_result.new_op_ref.device_id.clone(),
        undo_result.new_op_ref.seq,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert!(redo_result.is_redo, "redo must be flagged as is_redo");
    assert_eq!(
        redo_result.reversed_op_type, "edit_block",
        "reversed_op_type on redo should reflect the undo op being reversed (an edit_block undo)"
    );

    // Content should be back to "modified"
    let fetched = get_block_inner(&pool, child.id).await.unwrap();
    assert_eq!(
        fetched.content,
        Some("modified".into()),
        "after redo, content must be 'modified'"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_property_change_restores_prior_value() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Create a page
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Property Undo Page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Create a child block
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        Some(page.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Set a custom property "importance" to "low"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        child.id.as_str().into(),
        "importance".into(),
        Some("low".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Change "importance" to "high"
    set_property_inner(
        &pool,
        DEV,
        &mat,
        child.id.as_str().into(),
        "importance".into(),
        Some("high".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    // Undo the most recent op on the page (the "high" set)
    let result = undo_page_op_inner(&pool, DEV, &mat, page.id.clone().into_string(), 0)
        .await
        .unwrap();
    settle(&mat).await;

    assert!(
        !result.is_redo,
        "undo of property change must not be flagged as redo"
    );

    // "importance" should be back to "low" (prior value restored)
    let props = get_properties_inner(&pool, child.id).await.unwrap();
    let importance = props.iter().find(|p| p.key == "importance");
    assert!(
        importance.is_some(),
        "importance property must still exist after undo"
    );
    assert_eq!(
        importance.unwrap().value_text.as_deref(),
        Some("low"),
        "undo must restore property value to 'low'"
    );
}

/// MAINT-214 (b): `apply_reverse_in_tx` for `OpPayload::MoveBlock`
/// must refresh the denormalised `page_id` column synchronously,
/// mirroring the M6 fix in `move_block_inner`
/// (`commands/blocks/move_ops.rs:174-231`). Pre-fix, undoing a
/// cross-page move relied on the async `RebuildPageIds` materializer
/// task to update page_id, leaving an observable staleness window
/// after the undo tx committed.
///
/// Scenario:
///
/// 1. Build a tree under `page_a`: `page_a → leaf`.
/// 2. Move `leaf` under `page_b` (sync M6 already refreshes
///    `leaf.page_id = page_b`).
/// 3. Shut the materialiser down so async catch-up can't mask the
///    sync-update behaviour we are testing.
/// 4. Undo the move via `undo_page_op_inner`. The reverse payload is
///    a `MoveBlock` putting the leaf back under `page_a`. With the
///    MAINT-214 (b) fix, `apply_reverse_in_tx` synchronously rewrites
///    `leaf.page_id = page_a`. Without the fix the column stays at
///    `page_b` (async catch-up is blocked).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undo_move_block_synchronously_refreshes_page_id() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let page_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Move Undo Page A".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let page_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Move Undo Page B".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let leaf = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "leaf".into(),
        Some(page_a.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(
        leaf.page_id
            .as_ref()
            .map(super::super::ulid::BlockId::as_str),
        Some(page_a.id.as_str()),
        "sanity: leaf starts under page_a"
    );

    // Move leaf to page_b. move_block_inner's sync M6 rewrites
    // leaf.page_id = page_b.
    move_block_inner(
        &pool,
        DEV,
        &mat,
        leaf.id.clone(),
        Some(page_b.id.clone()),
        1,
    )
    .await
    .unwrap();
    settle(&mat).await;

    let leaf_page_after_move: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(&leaf.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        leaf_page_after_move.as_deref(),
        Some(page_b.id.as_str()),
        "sanity: leaf.page_id is page_b after the move"
    );

    // Shut the materialiser down so async RebuildPageIds cannot
    // catch up — only the sync MAINT-214 (b) fix can produce the
    // expected post-state.
    mat.shutdown();

    // Undo on page_b (where the move op was journalled — move_block
    // ops attach to the new parent's page).
    let undo_result = undo_page_op_inner(&pool, DEV, &mat, page_b.id.clone().into_string(), 0)
        .await
        .unwrap();
    assert_eq!(
        undo_result.reversed_op_type, "move_block",
        "undo target must be the move_block op"
    );

    let leaf_page_after_undo: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(&leaf.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        leaf_page_after_undo.as_deref(),
        Some(page_a.id.as_str()),
        "MAINT-214 (b): apply_reverse_in_tx for MoveBlock must \
         synchronously refresh page_id back to page_a — async \
         RebuildPageIds is blocked by the materialiser shutdown"
    );

    // Sanity: leaf is now parented to page_a again.
    let leaf_row = get_block_inner(&pool, leaf.id.clone()).await.unwrap();
    assert_eq!(
        leaf_row
            .parent_id
            .as_ref()
            .map(super::super::ulid::BlockId::as_str),
        Some(page_a.id.as_str()),
        "sanity: undo restored parent_id to page_a"
    );
}
