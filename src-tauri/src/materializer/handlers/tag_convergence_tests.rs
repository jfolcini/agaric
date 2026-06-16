//! #1323 (Step 1, tags only): conformance test that drives the SAME
//! `AddTag` then `RemoveTag` ops through BOTH the engine arm
//! (`apply_*_via_loro`, via the real foreground `apply_op_tx` pipeline
//! with the Loro engine installed) AND the sql_only fallback arm
//! (`apply_*_sql_only`, called directly — exactly the fn the routing
//! dispatches to when `crate::loro::shared::get()` is `None`), then
//! asserts the resulting `block_tags` + `block_tag_inherited` rows are
//! byte-for-byte IDENTICAL between the two arms after each settle.
//!
//! The fixture uses a parent → child hierarchy so the tag inheritance
//! fan-out (`tag_inheritance::propagate_tag_to_descendants` on add,
//! `remove_inherited_tag` on remove) is actually exercised: tagging the
//! PARENT must write a `block_tag_inherited` row for the CHILD in BOTH
//! arms.
//!
//! #891 lesson: a test without `install_for_test` silently runs the
//! FALLBACK, not production. The engine arm therefore asserts that
//! `sql_only_fallback::count()` did NOT increment across its ops
//! (delta == 0), proving the engine path actually ran.
//!
//! Process isolation: the `GLOBAL` Loro `OnceLock` is process-wide and
//! first-write-wins (see `loro::shared::install_for_test`), so a single
//! process cannot toggle the engine off after installing it. The
//! fallback arm therefore drives the `apply_*_sql_only` fns directly
//! (the established pattern — see `move_sql_only_cycle_tests`), which is
//! the identical code the via-loro routing calls on `get() == None`.
//! Run under `cargo nextest run` (one process per test), never plain
//! `cargo test`.

use super::*;
use crate::db::init_pool;
use crate::op::{AddTagPayload, CreateBlockPayload, OpPayload, RemoveTagPayload};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ0000000000000000TAGP01";
const PARENT_ID: &str = "01HZ0000000000000000TAGPAR";
const CHILD_ID: &str = "01HZ0000000000000000TAGCHD";
const TAG_ID: &str = "01HZ0000000000000000TAGTAG";
const DEVICE_ID: &str = "device-tag-convergence";

/// One row of `block_tags`. Ordered SELECT → `Vec` for a stable,
/// arm-to-arm comparable snapshot.
type TagRow = (String, String);
/// One row of `block_tag_inherited` (block_id, tag_id, inherited_from).
type InheritedRow = (String, String, String);

async fn snapshot_block_tags(pool: &SqlitePool) -> Vec<TagRow> {
    sqlx::query_as("SELECT block_id, tag_id FROM block_tags ORDER BY block_id, tag_id")
        .fetch_all(pool)
        .await
        .expect("snapshot block_tags")
}

async fn snapshot_inherited(pool: &SqlitePool) -> Vec<InheritedRow> {
    sqlx::query_as(
        "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
         ORDER BY block_id, tag_id, inherited_from",
    )
    .fetch_all(pool)
    .await
    .expect("snapshot block_tag_inherited")
}

/// Seed the shared `blocks` rows (space, page, parent, child, tag) in a
/// fresh DB. Used by BOTH arms so the inheritance walk (which is a SQL
/// `blocks.parent_id` walk in both arms) sees the identical hierarchy.
async fn seed_blocks_sql(pool: &SqlitePool) {
    // The `space` block + its `spaces` registry row (#708).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
    // page → parent → child, plus the tag block, all in SPACE_ID.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'page', NULL, 0, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', 'parent', ?, 0, ?, ?)",
    )
    .bind(PARENT_ID)
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', 'child', ?, 0, ?, ?)",
    )
    .bind(CHILD_ID)
    .bind(PARENT_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'tag', 'tag-content', ?, 1, ?, ?)",
    )
    .bind(TAG_ID)
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
}

/// Drive a CreateBlock op through the real `apply_op_tx` pipeline so the
/// Loro engine has the node (precondition for the engine-arm AddTag /
/// RemoveTag to resolve a space and route through `apply_*_via_loro`).
async fn create_via_loro(
    pool: &SqlitePool,
    block_id: &str,
    block_type: &str,
    parent: Option<&str>,
    position: i64,
) {
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: block_type.into(),
        parent_id: parent.map(BlockId::from_trusted),
        position: Some(position),
        index: None,
        content: "seed".into(),
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append create");
    let mut tx = pool.begin().await.expect("begin create");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply create");
    tx.commit().await.expect("commit create");
}

/// Engine arm: install the Loro engine, seed the hierarchy through the
/// real pipeline, drive AddTag(parent) then RemoveTag(parent), snapshot
/// `block_tags` + `block_tag_inherited` after each. Returns
/// `(after_add_tags, after_add_inherited, after_remove_tags,
/// after_remove_inherited)`.
///
/// Asserts `sql_only_fallback::count()` did NOT move across the two tag
/// ops — proving the engine path actually ran (#891).
async fn run_engine_arm() -> (
    Vec<TagRow>,
    Vec<InheritedRow>,
    Vec<TagRow>,
    Vec<InheritedRow>,
) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("engine_arm.db"))
        .await
        .expect("init_pool");

    // The `space` block + its `spaces` registry row (#708) must exist
    // before `blocks.space_id` (FK → spaces(id)) can be stamped below.
    // Seed it in SQL only — mirrors `engine_path_tests::fresh_pool_with_page`.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .expect("seed space block");
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .expect("register space");

    let _state = crate::loro::shared::install_for_test();
    // Seed the whole hierarchy through the engine so every block resolves
    // to SPACE_ID and the AddTag / RemoveTag ops take the via_loro arm.
    create_via_loro(&pool, PAGE_ID, "page", None, 0).await;
    create_via_loro(&pool, PARENT_ID, "content", Some(PAGE_ID), 0).await;
    create_via_loro(&pool, CHILD_ID, "content", Some(PARENT_ID), 0).await;
    create_via_loro(&pool, TAG_ID, "tag", Some(PAGE_ID), 1).await;

    // Production fills `blocks.page_id` / `space_id` via background rebuild /
    // the deferred SetBlockPageId task, which this op-log-only seed skips.
    // `resolve_block_space` reads `blocks.space_id` directly (#533), so set
    // it inline for every seeded block; without it AddTag falls back.
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id IN (?, ?, ?)")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(PARENT_ID)
        .bind(CHILD_ID)
        .bind(TAG_ID)
        .execute(&pool)
        .await
        .expect("set page_id/space_id");

    // Count fallbacks BEFORE the two tag ops; assert no delta after.
    let fallback_before = super::sql_only_fallback::count();

    // --- AddTag(parent) through the real pipeline ---
    let add = OpPayload::AddTag(AddTagPayload {
        block_id: BlockId::from_trusted(PARENT_ID),
        tag_id: BlockId::from_trusted(TAG_ID),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, add)
        .await
        .expect("append add");
    let mut tx = pool.begin().await.expect("begin add");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply add");
    tx.commit().await.expect("commit add");

    let after_add_tags = snapshot_block_tags(&pool).await;
    let after_add_inherited = snapshot_inherited(&pool).await;

    // --- RemoveTag(parent) through the real pipeline ---
    let remove = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: BlockId::from_trusted(PARENT_ID),
        tag_id: BlockId::from_trusted(TAG_ID),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, remove)
        .await
        .expect("append remove");
    let mut tx = pool.begin().await.expect("begin remove");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply remove");
    tx.commit().await.expect("commit remove");

    let after_remove_tags = snapshot_block_tags(&pool).await;
    let after_remove_inherited = snapshot_inherited(&pool).await;

    // #891: the engine path must have run for BOTH tag ops — no SQL-only
    // fallback. If this delta is nonzero, the engine arm silently degraded
    // to the fallback and the conformance comparison below would be
    // vacuously "identical" (both arms ran the same fallback).
    let fallback_after = super::sql_only_fallback::count();
    assert_eq!(
        fallback_after - fallback_before,
        0,
        "engine arm must NOT take the sql_only fallback (count delta must be 0); \
         AddTag/RemoveTag silently degraded to the fallback path"
    );

    (
        after_add_tags,
        after_add_inherited,
        after_remove_tags,
        after_remove_inherited,
    )
}

/// Fallback arm: NO engine. Seed the identical hierarchy directly in SQL,
/// drive the `apply_add_tag_sql_only` then `apply_remove_tag_sql_only`
/// fns directly (the exact code the via_loro routing dispatches to on
/// `shared::get() == None`), snapshot after each.
async fn run_fallback_arm() -> (
    Vec<TagRow>,
    Vec<InheritedRow>,
    Vec<TagRow>,
    Vec<InheritedRow>,
) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("fallback_arm.db"))
        .await
        .expect("init_pool");

    seed_blocks_sql(&pool).await;

    let mut conn = pool.acquire().await.expect("acquire");

    // --- AddTag(parent) via the sql_only fallback ---
    apply_add_tag_sql_only(
        &mut conn,
        AddTagPayload {
            block_id: BlockId::from_trusted(PARENT_ID),
            tag_id: BlockId::from_trusted(TAG_ID),
        },
    )
    .await
    .expect("apply_add_tag_sql_only");
    drop(conn);

    let after_add_tags = snapshot_block_tags(&pool).await;
    let after_add_inherited = snapshot_inherited(&pool).await;

    let mut conn = pool.acquire().await.expect("acquire");
    // --- RemoveTag(parent) via the sql_only fallback ---
    apply_remove_tag_sql_only(
        &mut conn,
        RemoveTagPayload {
            block_id: BlockId::from_trusted(PARENT_ID),
            tag_id: BlockId::from_trusted(TAG_ID),
        },
    )
    .await
    .expect("apply_remove_tag_sql_only");
    drop(conn);

    let after_remove_tags = snapshot_block_tags(&pool).await;
    let after_remove_inherited = snapshot_inherited(&pool).await;

    (
        after_add_tags,
        after_add_inherited,
        after_remove_tags,
        after_remove_inherited,
    )
}

/// The load-bearing #1323 (Step 1) conformance assertion: the engine arm
/// and the sql_only fallback arm project IDENTICAL `block_tags` +
/// `block_tag_inherited` rows for the same AddTag → RemoveTag sequence,
/// at every settle point. A divergence here is a real convergence bug.
#[tokio::test]
async fn tag_sql_only_fallback_converges_with_engine_arm() {
    let (eng_add_tags, eng_add_inh, eng_rm_tags, eng_rm_inh) = run_engine_arm().await;
    let (fb_add_tags, fb_add_inh, fb_rm_tags, fb_rm_inh) = run_fallback_arm().await;

    // After AddTag(parent): both arms must have the direct (parent, tag)
    // `block_tags` row AND the inherited (child, tag, parent)
    // `block_tag_inherited` row.
    assert_eq!(
        eng_add_tags, fb_add_tags,
        "block_tags diverge after AddTag: engine={eng_add_tags:?} fallback={fb_add_tags:?}"
    );
    assert_eq!(
        eng_add_inh, fb_add_inh,
        "block_tag_inherited diverge after AddTag: engine={eng_add_inh:?} fallback={fb_add_inh:?}"
    );

    // Sanity: the fixture actually exercised inheritance (else the test
    // would pass vacuously even if the fan-out were dropped from one arm).
    assert_eq!(
        eng_add_tags,
        vec![(PARENT_ID.to_string(), TAG_ID.to_string())],
        "engine arm must hold exactly the direct parent tag after AddTag"
    );
    assert_eq!(
        eng_add_inh,
        vec![(
            CHILD_ID.to_string(),
            TAG_ID.to_string(),
            PARENT_ID.to_string()
        )],
        "AddTag(parent) must propagate an inherited row to the child"
    );

    // After RemoveTag(parent): both arms must be back to empty for this tag.
    assert_eq!(
        eng_rm_tags, fb_rm_tags,
        "block_tags diverge after RemoveTag: engine={eng_rm_tags:?} fallback={fb_rm_tags:?}"
    );
    assert_eq!(
        eng_rm_inh, fb_rm_inh,
        "block_tag_inherited diverge after RemoveTag: engine={eng_rm_inh:?} fallback={fb_rm_inh:?}"
    );
    assert!(
        eng_rm_tags.is_empty() && eng_rm_inh.is_empty(),
        "RemoveTag must clear both the direct and inherited rows; \
         tags={eng_rm_tags:?} inherited={eng_rm_inh:?}"
    );
}
