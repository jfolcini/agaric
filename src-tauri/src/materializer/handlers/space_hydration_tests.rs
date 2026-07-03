//! #2326 — space-assignment subtree hydration.
//!
//! A page created before its `SetProperty(space)` (the create-then-assign
//! ordering surfaced by #2249) has no space at create time, so its subtree ops
//! legitimately fall back to `sql_only` (recorded as `SpaceUnresolved`) — the
//! blocks never enter any engine. #2326 hydrates the whole subtree into the
//! per-space engine the moment the space is assigned, so subsequent ops on
//! those blocks take the live engine path instead of the `EngineMissingTarget`
//! fallback.
//!
//! These tests drive the SAME `apply_op_tx` production path the LOCAL command /
//! REMOTE sync routes use, and assert on both the engine tree (via
//! `registry.for_space(...).engine_mut()`) and the process-global
//! `sql_only_fallback::count()` DELTA — the counter is monotonic and shared
//! across the binary, so every assertion is a before/after delta, never an
//! absolute.

use crate::db::init_pool;
use crate::loro::engine::PropertyValue;
use crate::op::{
    AddTagPayload, CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload,
    OpPayload, SPACE_PROPERTY_KEY, SetPropertyPayload,
};
use crate::space::SpaceId;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ00000000000000000000P5";
const CHILD_ID: &str = "01HZ00000000000000000000C7";
const GRAND_ID: &str = "01HZ00000000000000000000G8";
const TAG_ID: &str = "01HZ00000000000000000000T9";
const DEVICE_ID: &str = "device-space-hydration";

/// Pool with a REGISTERED space block but NO page yet. The page + subtree are
/// created with no space (mirroring #2249), then `SetProperty(space)` assigns
/// the space and triggers hydration.
async fn fresh_pool_with_registered_space() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("space_hydration.db");
    let pool = init_pool(&db_path).await.expect("init_pool");

    // The space block itself (block_type 'tag', content 'space'); it IS the
    // space, so its own `space_id` stays NULL.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .unwrap();
    // #708: `blocks.space_id` REFERENCES spaces(id) since migration 0089, and
    // `project_set_property(space)` skips an unregistered target — so the space
    // must be registered for the assignment (and thus hydration) to land.
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
    (pool, dir)
}

/// Append `payload` to the op log and drive it through the production
/// `apply_op_tx` (LOCAL path), committing.
async fn apply(pool: &SqlitePool, state: &crate::loro::shared::LoroState, payload: OpPayload) {
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append op");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");
}

/// Drive a `SetProperty` payload straight through the apply handler under test,
/// bypassing the op-log validator (which rejects an all-None "clear" space op).
/// A clear reaches `apply_set_property_via_loro` in production via reverse/undo
/// and sync, so exercising the handler directly is the faithful path.
async fn apply_set_property_direct(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    payload: SetPropertyPayload,
) {
    let mut tx = pool.begin().await.expect("begin");
    super::apply_set_property_via_loro(&mut tx, state, DEVICE_ID, &payload)
        .await
        .expect("apply_set_property_via_loro");
    tx.commit().await.expect("commit");
}

fn create_op(block_id: &str, block_type: &str, parent: Option<&str>, content: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: block_type.into(),
        parent_id: parent.map(BlockId::from_trusted),
        position: Some(0),
        index: None,
        content: content.into(),
    })
}

/// `SetProperty(space)` op: `value_ref = Some(space)` assigns; `None` clears.
fn set_space_op(block_id: &str, space: Option<&str>) -> OpPayload {
    OpPayload::SetProperty(SetPropertyPayload {
        block_id: BlockId::from_trusted(block_id),
        key: SPACE_PROPERTY_KEY.into(),
        value_text: None,
        value_num: None,
        value_date: None,
        value_ref: space.map(BlockId::from_trusted),
        value_bool: None,
    })
}

/// Simulate the deferred `SetBlockPageId` materialize task (which the direct
/// `apply_op_tx` test harness does not run): stamp a content block's `page_id`
/// so the later `SetProperty(space)` fan-out (`WHERE id = ? OR page_id = ?`)
/// reaches it and `resolve_block_space` routes its subsequent ops to the space.
async fn stamp_page_id(pool: &SqlitePool, block_id: &str) {
    sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(block_id)
        .execute(pool)
        .await
        .expect("stamp page_id");
}

/// Create page + child + grandchild with NO space, page_id stamped on the
/// content blocks. Leaves the subtree in the pre-assignment #2249 state.
async fn create_no_space_subtree(pool: &SqlitePool, state: &crate::loro::shared::LoroState) {
    apply(pool, state, create_op(PAGE_ID, "page", None, "page")).await;
    apply(
        pool,
        state,
        create_op(CHILD_ID, "content", Some(PAGE_ID), "child"),
    )
    .await;
    apply(
        pool,
        state,
        create_op(GRAND_ID, "content", Some(CHILD_ID), "grand"),
    )
    .await;
    stamp_page_id(pool, CHILD_ID).await;
    stamp_page_id(pool, GRAND_ID).await;
}

fn space() -> SpaceId {
    SpaceId::from_trusted(SPACE_ID)
}

// --------------------------------------------------------------------------
// 1. No-space creates legitimately fall back (SpaceUnresolved).
// --------------------------------------------------------------------------

#[tokio::test]
async fn no_space_creates_take_sql_only_fallback() {
    let (pool, _dir) = fresh_pool_with_registered_space().await;
    let state = crate::loro::shared::LoroState::new();

    let before = super::sql_only_fallback::count();
    apply(&pool, &state, create_op(PAGE_ID, "page", None, "page")).await;
    apply(
        &pool,
        &state,
        create_op(CHILD_ID, "content", Some(PAGE_ID), "child"),
    )
    .await;
    apply(
        &pool,
        &state,
        create_op(GRAND_ID, "content", Some(CHILD_ID), "grand"),
    )
    .await;
    // Each create resolves no space (the page has none yet), so each takes the
    // legitimate SpaceUnresolved fallback: +3.
    assert_eq!(super::sql_only_fallback::count() - before, 3);

    // Nothing entered the space engine.
    assert!(
        state.registry.is_empty(),
        "no engine should exist before the space is assigned"
    );
}

// --------------------------------------------------------------------------
// 2. SetProperty(space) hydrates the whole subtree into the space engine.
// --------------------------------------------------------------------------

#[tokio::test]
async fn set_property_space_hydrates_subtree() {
    let (pool, _dir) = fresh_pool_with_registered_space().await;
    let state = crate::loro::shared::LoroState::new();
    create_no_space_subtree(&pool, &state).await;

    let before = super::sql_only_fallback::count();
    apply(&pool, &state, set_space_op(PAGE_ID, Some(SPACE_ID))).await;
    // The space op is intercepted before the resolve gate and hydrates — it
    // records NO fallback of its own.
    assert_eq!(
        super::sql_only_fallback::count() - before,
        0,
        "SetProperty(space) hydration must not record a fallback"
    );

    let mut guard = state
        .registry
        .for_space(&space(), DEVICE_ID)
        .expect("for_space");
    let engine = guard.engine_mut();

    // Every subtree block is present with correct content + parent linkage.
    let page = engine.read_block(PAGE_ID).unwrap().expect("page in engine");
    assert_eq!(page.content, "page");
    assert_eq!(page.parent_id, None);
    let child = engine
        .read_block(CHILD_ID)
        .unwrap()
        .expect("child in engine");
    assert_eq!(child.content, "child");
    assert_eq!(child.parent_id.as_deref(), Some(PAGE_ID));
    let grand = engine
        .read_block(GRAND_ID)
        .unwrap()
        .expect("grand in engine");
    assert_eq!(grand.content, "grand");
    assert_eq!(grand.parent_id.as_deref(), Some(CHILD_ID));

    // children_ordered_block_ids matches the SQL sibling order.
    assert_eq!(
        engine.children_ordered_block_ids(Some(PAGE_ID)).unwrap(),
        vec![CHILD_ID.to_string()]
    );
    assert_eq!(
        engine.children_ordered_block_ids(Some(CHILD_ID)).unwrap(),
        vec![GRAND_ID.to_string()]
    );
}

// --------------------------------------------------------------------------
// 3. After hydration, subtree ops take the engine path — ZERO further
//    EngineMissingTarget fallbacks. This is the whole point of #2326.
// --------------------------------------------------------------------------

#[tokio::test]
async fn subtree_ops_take_engine_path_after_hydration() {
    let (pool, _dir) = fresh_pool_with_registered_space().await;
    let state = crate::loro::shared::LoroState::new();
    // A tag block for the AddTag op (block_tags.tag_id REFERENCES blocks(id)).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, space_id) \
             VALUES (?, 'tag', 'label', NULL, 0, ?)",
    )
    .bind(TAG_ID)
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .unwrap();

    create_no_space_subtree(&pool, &state).await;
    apply(&pool, &state, set_space_op(PAGE_ID, Some(SPACE_ID))).await;

    // From here every op resolves the (now-assigned) space AND finds its target
    // already in the engine tree, so none may fall back.
    let before = super::sql_only_fallback::count();

    apply(
        &pool,
        &state,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(CHILD_ID),
            to_text: "child edited".into(),
            prev_edit: None,
        }),
    )
    .await;
    apply(
        &pool,
        &state,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(GRAND_ID),
            new_parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            new_position: 1,
            new_index: Some(1),
        }),
    )
    .await;
    apply(
        &pool,
        &state,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted(CHILD_ID),
            tag_id: BlockId::from_trusted(TAG_ID),
        }),
    )
    .await;
    apply(
        &pool,
        &state,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(CHILD_ID),
        }),
    )
    .await;

    assert_eq!(
        super::sql_only_fallback::count() - before,
        0,
        "post-hydration subtree ops must take the engine path (zero EngineMissingTarget)"
    );
}

// --------------------------------------------------------------------------
// 4. Engine == SQL for the subtree: parent linkage, dense position,
//    properties, and tags all seeded.
// --------------------------------------------------------------------------

#[tokio::test]
async fn engine_matches_sql_for_subtree() {
    let (pool, _dir) = fresh_pool_with_registered_space().await;
    let state = crate::loro::shared::LoroState::new();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, space_id) \
             VALUES (?, 'tag', 'label', NULL, 0, ?)",
    )
    .bind(TAG_ID)
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .unwrap();

    create_no_space_subtree(&pool, &state).await;

    // Set a non-reserved property and a tag on the child DURING the no-space
    // window (both land in SQL via the sql_only fallback, never the engine).
    apply(
        &pool,
        &state,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::from_trusted(CHILD_ID),
            key: "note".into(),
            value_text: Some("hi".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    apply(
        &pool,
        &state,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::from_trusted(CHILD_ID),
            tag_id: BlockId::from_trusted(TAG_ID),
        }),
    )
    .await;

    // Assign the space → hydrate (nodes + properties + tags).
    apply(&pool, &state, set_space_op(PAGE_ID, Some(SPACE_ID))).await;

    // SQL: dense 1-based positions + parent linkage.
    let child_row: (Option<String>, i64) =
        sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
            .bind(CHILD_ID)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(child_row.0.as_deref(), Some(PAGE_ID));
    assert_eq!(child_row.1, 1);
    let grand_row: (Option<String>, i64) =
        sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
            .bind(GRAND_ID)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(grand_row.0.as_deref(), Some(CHILD_ID));
    assert_eq!(grand_row.1, 1);

    // Engine: parent linkage matches SQL, and the property + tag were seeded.
    let mut guard = state
        .registry
        .for_space(&space(), DEVICE_ID)
        .expect("for_space");
    let engine = guard.engine_mut();
    assert_eq!(
        engine
            .read_block(CHILD_ID)
            .unwrap()
            .unwrap()
            .parent_id
            .as_deref(),
        Some(PAGE_ID)
    );
    assert_eq!(
        engine.read_property_typed(CHILD_ID, "note").unwrap(),
        Some(PropertyValue::Str("hi".into())),
        "hydration must seed the block's properties into the engine"
    );
    assert_eq!(
        engine.read_tags(CHILD_ID).unwrap(),
        vec![TAG_ID.to_string()],
        "hydration must seed the block's tags into the engine"
    );
}

// --------------------------------------------------------------------------
// 5. Idempotency: re-assigning the same space and a boot-replay re-applying
//    the original Creates neither duplicate nodes nor move the counter.
// --------------------------------------------------------------------------

#[tokio::test]
async fn re_hydration_and_boot_replay_are_idempotent() {
    let (pool, _dir) = fresh_pool_with_registered_space().await;
    let state = crate::loro::shared::LoroState::new();
    create_no_space_subtree(&pool, &state).await;
    apply(&pool, &state, set_space_op(PAGE_ID, Some(SPACE_ID))).await;

    let before = super::sql_only_fallback::count();

    // Re-apply the SAME space assignment: every node already present ⇒ all
    // skipped, nothing reprojected, no fallback.
    apply(&pool, &state, set_space_op(PAGE_ID, Some(SPACE_ID))).await;

    // Simulate a boot-replay re-applying the original CreateBlock ops: the
    // read_block-present skip (create path re-applies in place) prevents any
    // duplicate node.
    apply(&pool, &state, create_op(PAGE_ID, "page", None, "page")).await;
    apply(
        &pool,
        &state,
        create_op(CHILD_ID, "content", Some(PAGE_ID), "child"),
    )
    .await;
    apply(
        &pool,
        &state,
        create_op(GRAND_ID, "content", Some(CHILD_ID), "grand"),
    )
    .await;

    assert_eq!(
        super::sql_only_fallback::count() - before,
        0,
        "re-hydration + boot-replay of Creates must not fall back"
    );

    let mut guard = state
        .registry
        .for_space(&space(), DEVICE_ID)
        .expect("for_space");
    let engine = guard.engine_mut();
    // No duplicate nodes: each parent still has exactly its one child.
    assert_eq!(
        engine.children_ordered_block_ids(Some(PAGE_ID)).unwrap(),
        vec![CHILD_ID.to_string()]
    );
    assert_eq!(
        engine.children_ordered_block_ids(Some(CHILD_ID)).unwrap(),
        vec![GRAND_ID.to_string()]
    );
}

// --------------------------------------------------------------------------
// 6a. Guard: assigning an UNREGISTERED space projects a skip (#708) and does
//     NOT hydrate — no panic.
// --------------------------------------------------------------------------

#[tokio::test]
async fn unregistered_space_skips_hydration() {
    // A valid ULID that is NOT registered in `spaces`.
    const UNREGISTERED: &str = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

    let (pool, _dir) = fresh_pool_with_registered_space().await;
    let state = crate::loro::shared::LoroState::new();
    create_no_space_subtree(&pool, &state).await;

    let before = super::sql_only_fallback::count();
    apply(&pool, &state, set_space_op(PAGE_ID, Some(UNREGISTERED))).await;
    assert_eq!(super::sql_only_fallback::count() - before, 0);

    // Projection skipped the unregistered target, so `blocks.space_id` stays
    // NULL and hydration never runs — no engine was created.
    let page_space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(PAGE_ID)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(page_space, None, "unregistered space must not be stamped");
    assert!(
        state.registry.is_empty(),
        "no engine should be created for an unregistered space"
    );
}

// --------------------------------------------------------------------------
// 6b. Guard: clearing the space (value_ref = None → space_id NULL) does NOT
//     hydrate — no panic.
// --------------------------------------------------------------------------

#[tokio::test]
async fn clearing_space_skips_hydration() {
    let (pool, _dir) = fresh_pool_with_registered_space().await;
    let state = crate::loro::shared::LoroState::new();
    create_no_space_subtree(&pool, &state).await;
    // First assign so there is something to clear.
    apply(&pool, &state, set_space_op(PAGE_ID, Some(SPACE_ID))).await;

    let before = super::sql_only_fallback::count();
    // Clear: value_ref None ⇒ space_id NULL for the group ⇒ resolve None ⇒ no
    // hydration, no fallback, no panic.
    apply_set_property_direct(
        &pool,
        &state,
        SetPropertyPayload {
            block_id: BlockId::from_trusted(PAGE_ID),
            key: SPACE_PROPERTY_KEY.into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        },
    )
    .await;
    assert_eq!(super::sql_only_fallback::count() - before, 0);

    let page_space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(PAGE_ID)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(page_space, None, "clearing must NULL the space_id");
}
