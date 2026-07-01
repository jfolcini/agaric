use crate::db::init_pool;
use crate::op::{
    AddTagPayload, CreateBlockPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpPayload, PurgeBlockPayload, RemoveTagPayload, RestoreBlockPayload,
    SetPropertyPayload,
};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ00000000000000000000P5";
const BLOCK_ID: &str = "01HZ00000000000000000000B6";
const DEVICE_ID: &str = "device-engine-path";

async fn fresh_pool_with_page() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("engine_path.db");
    let pool = init_pool(&db_path).await.expect("init_pool");

    // Seed a page with `blocks.space_id = SPACE_ID` so that
    // resolve_block_space succeeds for CreateBlock with parent
    // = PAGE_ID.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .unwrap();
    // #708: register in the `spaces` table — `blocks.space_id`
    // REFERENCES spaces(id) since migration 0089.
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'page-content', NULL, 0, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .execute(&pool)
    .await
    .unwrap();
    // Phase 2 (#533): space membership is read from `blocks.space_id`.
    // Set the denormalized column on the page and every block paged to it.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .unwrap();
    (pool, dir)
}

/// `apply_op_tx` for a CreateBlock op routes through the engine
/// plus projection helpers and produces the expected SQL row
/// shape. Load-bearing invariant: the engine path produces stable
/// SQL output for single-author ops.
#[tokio::test]
async fn apply_op_tx_create_block_engine_path() {
    let (pool, _dir) = fresh_pool_with_page().await;
    // The engine path reads the Loro state global; install it for
    // the test.
    let _state = crate::loro::shared::install_for_test();
    // Phase 3: the parent page must exist in the engine tree.
    seed_page_via_loro(&pool).await;

    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(7),
        index: None,
        content: "loro-path content".into(),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append op");

    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    // SQL row matches what reading from the engine projected.
    let row: (String, String, Option<String>, i64) =
        sqlx::query_as("SELECT content, block_type, parent_id, position FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
    assert_eq!(row.0, "loro-path content");
    assert_eq!(row.1, "content");
    assert_eq!(row.2, Some(PAGE_ID.into()));
    // #400: the engine projects the authoritative DENSE 1-based rank from
    // the fractional sibling order, not the legacy sparse `position`. This
    // is the only child of PAGE_ID, so its dense rank is 1 (was 7).
    assert_eq!(row.3, 1);

    // Engine actually saw the apply (proves the loro path ran).
    let state = crate::loro::shared::get().expect("Loro state present");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine_snap = guard
        .engine_mut()
        .read_block(BLOCK_ID)
        .expect("read")
        .expect("engine state has the block");
    drop(guard);
    assert_eq!(engine_snap.content, "loro-path content");
    // #400: the engine's projected position is the dense 1-based rank from
    // the fractional sibling order; sole child of PAGE_ID ⇒ rank 1.
    assert_eq!(engine_snap.position, 1);

    // Reset the flag for any other tests in this binary.  The
    // OnceLock-installed flag is process-global; tests that rely on
    // default-off must explicitly install `false` themselves.
}

/// EditBlock loro path: pre-existing block, run an EditBlock op
/// with the flag on, verify the SQL `content` column matches the
/// engine's post-edit content (which is also the payload's
/// `to_text` for a single-author op).
#[tokio::test]
async fn apply_op_tx_edit_block_engine_path() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    // First create the block via the loro path (so the engine has
    // it).  This also exercises the create branch's
    // happy-path twice, which is intentional — the create's apply
    // is a precondition for the edit's apply to make sense.
    let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(0),
        index: None,
        content: "before-edit".into(),
    });
    let create_record = crate::op_log::append_local_op(&pool, DEVICE_ID, create_payload)
        .await
        .expect("append create");
    let mut tx = pool.begin().await.expect("begin1");
    super::apply_op_tx(&mut tx, &create_record)
        .await
        .expect("apply create");
    tx.commit().await.expect("commit1");

    // Production sets `blocks.page_id` / `blocks.space_id` via background
    // rebuild (`cache::rebuild_page_ids` + `rebuild_space_ids`) or
    // per-command updaters; the projection helper does not. Phase 2
    // (#533): `resolve_block_space` reads `blocks.space_id` directly, so
    // without it the EditBlock engine path falls back to the SQL-only
    // fallback and the engine never sees the edit. Mirror the rebuild's
    // effect inline so the EditBlock path resolves to SPACE_ID cleanly.
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(BLOCK_ID)
        .execute(&pool)
        .await
        .expect("set page_id");

    // Sanity: SQL row from create exists with the create's content.
    let pre_edit: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch row pre-edit");
    assert_eq!(pre_edit.0, "before-edit", "create projection wrote row");

    // Now edit through the loro path.
    let edit_payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        to_text: "after-edit-content".into(),
        prev_edit: None,
    });
    let edit_record = crate::op_log::append_local_op(&pool, DEVICE_ID, edit_payload)
        .await
        .expect("append edit");
    let mut tx = pool.begin().await.expect("begin2");
    super::apply_op_tx(&mut tx, &edit_record)
        .await
        .expect("apply edit");
    tx.commit().await.expect("commit2");

    let row: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch row");
    assert_eq!(row.0, "after-edit-content");

    // Engine state matches.
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine_snap = guard
        .engine_mut()
        .read_block(BLOCK_ID)
        .expect("read")
        .expect("engine has block");
    drop(guard);
    assert_eq!(engine_snap.content, "after-edit-content");
}

/// Test helper: seed a block under PAGE_ID via the loro path so the
/// engine has it (precondition for SetProperty / DeleteBlock /
/// MoveBlock loro-path tests), then set `page_id` so subsequent
/// `resolve_block_space` calls walk to the page's space property.
/// Mirrors the inline pattern used in the EditBlock test.
/// Create the PAGE_ID node in the Loro engine (not just SQL).
/// Phase 3: the block hierarchy is a LoroTree, so a child's parent must
/// exist in the engine for `read_block` to derive its `parent_id`.
/// Production always creates pages through the op-log → engine; the
/// `fresh_pool_with_page` SQL-only shortcut does not, so the
/// engine-path tests seed the page node here. Idempotent in SQL
/// (`INSERT OR IGNORE` — the row already exists).
async fn seed_page_via_loro(pool: &SqlitePool) {
    let create_page = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(PAGE_ID),
        block_type: "page".into(),
        parent_id: None,
        position: Some(0),
        index: None,
        content: "page-content".into(),
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, create_page)
        .await
        .expect("append create page");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply create page");
    tx.commit().await.expect("commit");
}

async fn seed_block_via_loro(pool: &SqlitePool) {
    seed_page_via_loro(pool).await;
    let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(0),
        index: None,
        content: "seed".into(),
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, create_payload)
        .await
        .expect("append create");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply create");
    tx.commit().await.expect("commit");

    sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(BLOCK_ID)
        .execute(pool)
        .await
        .expect("set page_id");
    // Phase 2 (#533): a fresh block inherits its parent page's space via
    // the post-commit `SetBlockPageId` materialize task, which this
    // op-log-only seed does not run. Set `blocks.space_id` directly so
    // `resolve_block_space(BLOCK_ID)` routes subsequent ops to SPACE_ID's
    // engine (the seed previously relied on the now-removed
    // `block_properties` `key='space'` read).
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ?")
        .bind(SPACE_ID)
        .bind(BLOCK_ID)
        .execute(pool)
        .await
        .expect("set space_id");
}

// -----------------------------------------------------------------
// SetProperty
// -----------------------------------------------------------------

#[tokio::test]
async fn apply_op_tx_set_property_engine_path() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    let payload = OpPayload::SetProperty(SetPropertyPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        key: "effort".into(),
        value_text: None,
        value_num: Some(3.5),
        value_date: None,
        value_ref: None,
        value_bool: None,
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    // SQL row written by the projection.
    let prop: (Option<f64>,) =
        sqlx::query_as("SELECT value_num FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(BLOCK_ID)
            .bind("effort")
            .fetch_one(&pool)
            .await
            .expect("fetch prop");
    assert_eq!(prop.0, Some(3.5));

    // Engine has the property (proves the loro path ran).
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let prop_opt = guard
        .engine_mut()
        .read_property_typed(BLOCK_ID, "effort")
        .expect("read_property_typed");
    drop(guard);
    assert!(prop_opt.is_some(), "engine must see the property");
}

// -----------------------------------------------------------------
// DeleteBlock
// -----------------------------------------------------------------

#[tokio::test]
async fn apply_op_tx_delete_block_engine_path() {
    // Verifies BOTH (a) the engine path runs (engine `read_deleted`
    // returns true for the seed) AND (b) the projection's
    // CTE-driven cascade fires — seed + two children are all
    // soft-deleted in SQL after a single DeleteBlock op against
    // the seed. The engine path only sees the seed apply; the
    // descendant cohort fans out to the engine post-commit.
    const CHILD_1: &str = "01HZ00000000000000000000C1";
    const CHILD_2: &str = "01HZ00000000000000000000C2";

    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    // Add two children parented on BLOCK_ID via the loro path so
    // the SQL `parent_id` chain is correct for the cascade CTE.
    for child_id in [CHILD_1, CHILD_2] {
        let create_child = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(child_id),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(BLOCK_ID)),
            position: Some(0),
            index: None,
            content: "child".into(),
        });
        let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, create_child)
            .await
            .expect("append child");
        let mut tx = pool.begin().await.expect("begin child");
        super::apply_op_tx(&mut tx, &rec)
            .await
            .expect("apply child create");
        tx.commit().await.expect("commit child");
    }

    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append");
    let record_created_at = record.created_at;
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    // SQL: seed + both children all carry the projection's
    // `deleted_at = record.created_at` — the CTE-driven cascade
    // mirrors `apply_delete_block_tx`.
    for id in [BLOCK_ID, CHILD_1, CHILD_2] {
        let row: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(
            row.0,
            Some(record_created_at),
            "cascade must soft-delete {id}",
        );
    }

    // Engine sees the seed delete (engine fanout is deferred).
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let deleted = guard
        .engine_mut()
        .read_deleted(BLOCK_ID)
        .expect("read_deleted");
    drop(guard);
    assert!(deleted, "engine must see the seed delete");
}

// -----------------------------------------------------------------
// MoveBlock
// -----------------------------------------------------------------

#[tokio::test]
async fn apply_op_tx_move_block_engine_path() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    // Move to (parent=PAGE_ID, position=42).
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        new_parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        new_position: 42,
        new_index: None,
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    let row: (Option<String>, i64) =
        sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
            .bind(BLOCK_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
    assert_eq!(row.0.as_deref(), Some(PAGE_ID));
    // #400: the engine projects the authoritative DENSE 1-based rank from
    // the fractional sibling order, not the legacy sparse `new_position`.
    // The moved block is the only child of PAGE_ID ⇒ dense rank 1 (was 42).
    assert_eq!(row.1, 1);

    // Engine sees the move.
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine_snap = guard
        .engine_mut()
        .read_block(BLOCK_ID)
        .expect("read")
        .expect("engine has block");
    drop(guard);
    assert_eq!(engine_snap.parent_id.as_deref(), Some(PAGE_ID));
    // #400: the engine's projected position is the dense 1-based rank from
    // the fractional sibling order; sole child of PAGE_ID ⇒ rank 1.
    assert_eq!(engine_snap.position, 1);
}

// -----------------------------------------------------------------
// RestoreBlock / PurgeBlock / AddTag / RemoveTag / DeleteProperty
// engine-path tests.
// -----------------------------------------------------------------

/// RestoreBlock engine-path: seed via engine, soft-delete, then
/// restore. Verifies SQL `deleted_at` is cleared for the seed AND
/// that the engine's `read_deleted` returns `false`. The
/// descendant cohort fan-out lives in
/// `dispatch_restore_descendants` (post-
/// commit) — we inspect engine state for the seed only here.
#[tokio::test]
async fn apply_op_tx_restore_block_engine_path() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    // Soft-delete via the loro path so the engine sees it.
    let delete_payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
    });
    let delete_record = crate::op_log::append_local_op(&pool, DEVICE_ID, delete_payload)
        .await
        .expect("append delete");
    let deleted_at_ref = delete_record.created_at;
    let mut tx = pool.begin().await.expect("begin1");
    super::apply_op_tx(&mut tx, &delete_record)
        .await
        .expect("apply delete");
    tx.commit().await.expect("commit1");

    // Sanity: SQL has deleted_at set, engine `read_deleted` is true.
    let pre: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch pre");
    assert!(pre.0.is_some(), "delete must have run");

    // Now restore.
    let restore_payload = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        deleted_at_ref,
    });
    let restore_record = crate::op_log::append_local_op(&pool, DEVICE_ID, restore_payload)
        .await
        .expect("append restore");
    let mut tx = pool.begin().await.expect("begin2");
    super::apply_op_tx(&mut tx, &restore_record)
        .await
        .expect("apply restore");
    tx.commit().await.expect("commit2");

    // SQL: deleted_at cleared.
    let post: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch post");
    assert_eq!(post.0, None, "restore must clear deleted_at");

    // Engine: seed is no longer marked deleted.
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let deleted = guard
        .engine_mut()
        .read_deleted(BLOCK_ID)
        .expect("read_deleted");
    drop(guard);
    assert!(!deleted, "engine must see the seed restore");
}

/// PurgeBlock loro-path: seed via loro, then purge.  Verifies SQL
/// row is gone (cascade ran) AND the engine's `read_block` returns
/// `None` for the purged block.
#[tokio::test]
async fn apply_op_tx_purge_block_engine_path() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    // SQL: row is gone.
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(BLOCK_ID)
        .fetch_one(&pool)
        .await
        .expect("fetch count");
    assert_eq!(count.0, 0, "purge must remove the row");

    // Engine: block is gone.
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let engine_snap = guard.engine_mut().read_block(BLOCK_ID).expect("read_block");
    drop(guard);
    assert!(
        engine_snap.is_none(),
        "engine must drop the block on purge; got {engine_snap:?}",
    );
}

/// AddTag loro-path: seed two blocks (a target + a tag), apply
/// AddTag, verify SQL row + engine `read_tags` both reflect the
/// association.
#[tokio::test]
async fn apply_op_tx_add_tag_engine_path() {
    const TAG_ID: &str = "01HZ00000000000000000000T7";

    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    // Create the tag block under the page, also via the loro path,
    // so its `parent_id` resolves to a space.
    let create_tag = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(TAG_ID),
        block_type: "tag".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(1),
        index: None,
        content: "tag-Y".into(),
    });
    let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, create_tag)
        .await
        .expect("append create tag");
    let mut tx = pool.begin().await.expect("begin tag");
    super::apply_op_tx(&mut tx, &rec)
        .await
        .expect("apply create tag");
    tx.commit().await.expect("commit tag");

    // Now add the tag.
    let payload = OpPayload::AddTag(AddTagPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        tag_id: BlockId::from_trusted(TAG_ID),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    // SQL: row exists.
    let count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(BLOCK_ID)
            .bind(TAG_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch count");
    assert_eq!(count.0, 1, "block_tags row must be inserted");

    // Engine: tag is associated.
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let tags = guard.engine_mut().read_tags(BLOCK_ID).expect("read_tags");
    drop(guard);
    assert!(
        tags.iter().any(|t| t == TAG_ID),
        "engine must see the tag association; got {tags:?}",
    );
}

/// RemoveTag loro-path: seed + tag-association, then remove.  SQL
/// row gone, engine `read_tags` no longer returns the tag.
#[tokio::test]
async fn apply_op_tx_remove_tag_engine_path() {
    const TAG_ID: &str = "01HZ00000000000000000000T8";

    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    // Create the tag + add it via loro.
    let create_tag = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(TAG_ID),
        block_type: "tag".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(1),
        index: None,
        content: "tag-Z".into(),
    });
    let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, create_tag)
        .await
        .expect("append create tag");
    let mut tx = pool.begin().await.expect("begin tag");
    super::apply_op_tx(&mut tx, &rec)
        .await
        .expect("apply create tag");
    tx.commit().await.expect("commit tag");

    let add = OpPayload::AddTag(AddTagPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        tag_id: BlockId::from_trusted(TAG_ID),
    });
    let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, add)
        .await
        .expect("append add");
    let mut tx = pool.begin().await.expect("begin add");
    super::apply_op_tx(&mut tx, &rec).await.expect("apply add");
    tx.commit().await.expect("commit add");

    // Now remove.
    let payload = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        tag_id: BlockId::from_trusted(TAG_ID),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    // SQL: row gone.
    let count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
            .bind(BLOCK_ID)
            .bind(TAG_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch count");
    assert_eq!(count.0, 0, "block_tags row must be deleted");

    // Engine: tag association is gone.
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let tags = guard.engine_mut().read_tags(BLOCK_ID).expect("read_tags");
    drop(guard);
    assert!(
        !tags.iter().any(|t| t == TAG_ID),
        "engine must drop the tag association; got {tags:?}",
    );
}

/// DeleteProperty loro-path: seed a non-reserved property, delete
/// it.  Verifies SQL row gone + engine `read_property` returns None.
#[tokio::test]
async fn apply_op_tx_delete_property_engine_path() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    seed_block_via_loro(&pool).await;

    // Set a non-reserved property via the loro path so the engine
    // has it.
    let set = OpPayload::SetProperty(SetPropertyPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        key: "effort".into(),
        value_text: None,
        value_num: Some(4.0),
        value_date: None,
        value_ref: None,
        value_bool: None,
    });
    let rec = crate::op_log::append_local_op(&pool, DEVICE_ID, set)
        .await
        .expect("append set");
    let mut tx = pool.begin().await.expect("begin set");
    super::apply_op_tx(&mut tx, &rec).await.expect("apply set");
    tx.commit().await.expect("commit set");

    // Sanity precondition: SQL has the row.
    let pre: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'effort'",
    )
    .bind(BLOCK_ID)
    .fetch_one(&pool)
    .await
    .expect("fetch pre");
    assert_eq!(pre.0, 1, "set property must have written the row");

    // Now delete.
    let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
        block_id: BlockId::from_trusted(BLOCK_ID),
        key: "effort".into(),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, payload)
        .await
        .expect("append");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply_op_tx");
    tx.commit().await.expect("commit");

    // SQL: row gone.
    let count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'effort'",
    )
    .bind(BLOCK_ID)
    .fetch_one(&pool)
    .await
    .expect("fetch count");
    assert_eq!(count.0, 0, "delete property must remove the row");

    // Engine: property gone.
    let state = crate::loro::shared::get().expect("Loro state");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let prop = guard
        .engine_mut()
        .read_property_typed(BLOCK_ID, "effort")
        .expect("read_property_typed");
    drop(guard);
    assert!(
        prop.is_none(),
        "engine must drop the property; got {prop:?}",
    );
}

// -----------------------------------------------------------------
// #2017: RestoreBlock upward ANCESTOR-chain engine fan-out
// -----------------------------------------------------------------

/// #2017 regression — the live-orphan ancestor restore must reach the
/// ENGINE, not just SQL, or a subsequent reproject re-deletes the ancestor
/// (self-perpetuating CRDT divergence).
///
/// Topology under PAGE_ID:  PAGE_ID → B1 (intermediate) → B2 (grandchild).
///
/// Scenario reproducing the #1884 live-orphan setup:
///   1. Delete B2  → B2 tombstoned at T1 (engine + SQL).
///   2. Delete B1  → B1 tombstoned at T2. The descendant cascade SKIPS the
///      already-deleted B2 (it has a different `deleted_at`), so B2 becomes
///      a trash root sitting under the tombstoned B1.
///   3. Restore B2 → the SQL restore clears B2's cohort AND walks UPWARD,
///      un-deleting the contiguous tombstoned ancestor chain (B1) — the
///      #1884 fix.
///
/// Before #2017 the upward restore was SQL-only: B1 was alive in SQL but
/// still tombstoned in the per-space engine. This test drives the restore
/// through the FULL `apply_op` path (which runs the post-commit ancestor
/// fan-out) and asserts:
///   (a) B1 is alive IN THE ENGINE (`read_deleted` false),
///   (b) feeding the engine's `read_deleted_at(B1)` back through
///       `reproject_block_deleted_at_from_engine` does NOT re-delete B1 in
///       SQL (the self-perpetuating-divergence guard — the crux of #2017),
///   (c) PAGE_ID's `pages_cache.child_block_count` counts B1 + B2 again.
#[tokio::test]
async fn apply_op_restore_fans_ancestor_chain_out_to_engine_no_reproject_redelete() {
    const B1: &str = "01HZ0000000000000000000AN1";
    const B2: &str = "01HZ0000000000000000000AN2";

    let (pool, _dir) = fresh_pool_with_page().await;
    let _state = crate::loro::shared::install_for_test();

    // Seed PAGE_ID + the B1 → B2 chain through the engine path.
    seed_page_via_loro(&pool).await;

    let create_b1 = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(B1),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(0),
        index: None,
        content: "intermediate".into(),
    });
    let rec_b1 = crate::op_log::append_local_op(&pool, DEVICE_ID, create_b1)
        .await
        .expect("append create b1");
    super::apply_op(&pool, &std::sync::Arc::new(rec_b1))
        .await
        .expect("apply create b1");
    // Production stamps page_id/space_id via background rebuild; mirror it
    // inline (BEFORE creating B2) so B2's create resolves B1's space and
    // routes to SPACE_ID's engine rather than the SQL-only fallback.
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(B1)
        .execute(&pool)
        .await
        .expect("stamp b1 page/space");

    let create_b2 = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(B2),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(B1)),
        position: Some(0),
        index: None,
        content: "grandchild".into(),
    });
    let rec_b2 = crate::op_log::append_local_op(&pool, DEVICE_ID, create_b2)
        .await
        .expect("append create b2");
    super::apply_op(&pool, &std::sync::Arc::new(rec_b2))
        .await
        .expect("apply create b2");

    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(B2)
        .execute(&pool)
        .await
        .expect("stamp b2 page/space");

    // (1) Delete B2 first (becomes a trash root at its own timestamp).
    let del_b2 = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(B2),
    });
    let rec_del_b2 = crate::op_log::append_local_op(&pool, DEVICE_ID, del_b2)
        .await
        .expect("append delete b2");
    super::apply_op(&pool, &std::sync::Arc::new(rec_del_b2))
        .await
        .expect("apply delete b2");

    // (2) Delete B1 — its cascade SKIPS the already-deleted B2.
    let del_b1 = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(B1),
    });
    let rec_del_b1 = crate::op_log::append_local_op(&pool, DEVICE_ID, del_b1)
        .await
        .expect("append delete b1");
    super::apply_op(&pool, &std::sync::Arc::new(rec_del_b1))
        .await
        .expect("apply delete b1");

    // Sanity: both B1 and B2 are tombstoned in SQL and the engine.
    let b2_deleted_at: Option<i64> =
        sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(B2)
            .fetch_one(&pool)
            .await
            .expect("fetch b2 deleted_at");
    let b2_ref = b2_deleted_at.expect("b2 must be soft-deleted");
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    {
        let state = crate::loro::shared::get().expect("Loro state");
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert!(
            guard
                .engine_mut()
                .read_deleted(B1)
                .expect("read_deleted b1"),
            "precondition: B1 tombstoned in engine after delete",
        );
    }

    // (3) Restore B2 through the FULL apply path (post-commit ancestor
    // fan-out runs here). This un-deletes B2's cohort AND the B1 ancestor
    // chain in SQL, and — with #2017 — fans the B1 restore onto the engine.
    let restore = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(B2),
        deleted_at_ref: b2_ref,
    });
    let rec_restore = crate::op_log::append_local_op(&pool, DEVICE_ID, restore)
        .await
        .expect("append restore");
    super::apply_op(&pool, &std::sync::Arc::new(rec_restore))
        .await
        .expect("apply restore");

    // SQL: both B1 (ancestor) and B2 (seed) are alive again.
    let b1_sql: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(B1)
        .fetch_one(&pool)
        .await
        .expect("fetch b1 post-restore");
    assert_eq!(b1_sql, None, "SQL must restore the B1 ancestor");

    // (a) #2017 CORE: B1 is alive IN THE ENGINE, not just SQL.
    let engine_b1_deleted_at: Option<String> = {
        let state = crate::loro::shared::get().expect("Loro state");
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space");
        assert!(
            !guard
                .engine_mut()
                .read_deleted(B1)
                .expect("read_deleted b1"),
            "#2017: restoring B2 must restore the B1 ancestor IN THE ENGINE \
             (was SQL-only → permanent CRDT divergence)",
        );
        guard
            .engine_mut()
            .read_deleted_at(B1)
            .expect("read_deleted_at b1")
    };
    assert!(
        engine_b1_deleted_at.is_none(),
        "#2017: engine must report B1 alive (deleted_at None); got {engine_b1_deleted_at:?}",
    );

    // (b) THE GUARD: a reproject driven by the engine's view of B1 must NOT
    // re-delete it in SQL. Pre-#2017 the engine still said "deleted", so
    // this call would stamp `deleted_at` back onto B1 → self-perpetuating
    // divergence on every reproject.
    {
        let mut tx = pool.begin().await.expect("begin reproject");
        crate::loro::projection::reproject_block_deleted_at_from_engine(
            &mut tx,
            &BlockId::from_trusted(B1),
            engine_b1_deleted_at.as_deref(),
        )
        .await
        .expect("reproject b1");
        tx.commit().await.expect("commit reproject");
    }
    let b1_after_reproject: Option<i64> =
        sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(B1)
            .fetch_one(&pool)
            .await
            .expect("fetch b1 after reproject");
    assert_eq!(
        b1_after_reproject, None,
        "#2017 GUARD: reproject must NOT re-delete the restored ancestor B1 \
         (a stale engine tombstone would re-stamp deleted_at every reproject)",
    );

    // (c) pages_cache child_block_count counts both restored blocks again.
    // #2042: RestoreBlock defers the page-wide count recompute to the background
    // `RebuildPagesCacheCounts` task (no longer synchronous in the apply tx), so
    // drive that recompute here before asserting the settled count.
    crate::cache::rebuild_pages_cache_counts(&pool)
        .await
        .expect("rebuild pages_cache counts");
    let child_count: i64 =
        sqlx::query_scalar("SELECT child_block_count FROM pages_cache WHERE page_id = ?")
            .bind(PAGE_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch child_block_count");
    assert_eq!(
        child_count, 2,
        "#2017: restored ancestor B1 + seed B2 must be reflected in \
         PAGE_ID.child_block_count (was left stale)",
    );
}
