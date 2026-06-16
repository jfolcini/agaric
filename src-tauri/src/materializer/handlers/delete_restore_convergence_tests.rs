//! #1323 (Step 2, delete/restore): conformance test that drives the SAME
//! `DeleteBlock(parent)` then `RestoreBlock(parent)` ops through BOTH the
//! engine arm (`apply_delete_block_via_loro` / `apply_restore_block_via_loro`,
//! via the real foreground `apply_op_tx` pipeline with the Loro engine
//! installed) AND the sql_only fallback arm (`apply_delete_block_sql_only` /
//! `apply_restore_block_sql_only`, called directly — exactly the fns the
//! routing dispatches to when `crate::loro::shared::get()` is `None`), then
//! asserts the resulting `blocks` soft-delete state is IDENTICAL between the
//! two arms after each settle.
//!
//! The fixture uses a multi-level parent → child → grandchild subtree so the
//! descendant cohort cascade is actually exercised: deleting the PARENT must
//! soft-delete the CHILD and GRANDCHILD in BOTH arms (via the projection's
//! `descendants_cte_active!` CTE), and restoring the PARENT must clear all
//! three (via the cohort-contiguous `descendants_cte_cohort!` CTE).
//!
//! **Cross-arm value caveat.** The engine arm stamps the real, non-monotonic
//! `record.created_at` (epoch-ms) as `deleted_at`, which differs from the
//! fixed test timestamp the fallback arm uses, so the RAW `deleted_at`
//! integers are NOT comparable across arms. The cross-arm IDENTICAL assertion
//! therefore compares the structural soft-delete *shape* — `(id,
//! deleted_at IS NULL)` — which is the invariant that actually matters
//! (which blocks are tombstoned vs live). Each arm SEPARATELY asserts that
//! its cohort shares ONE uniform non-null `deleted_at` after delete (cohort
//! identity) and ALL-null after restore.
//!
//! #891 lesson: a test without `install_for_test` silently runs the
//! FALLBACK, not production. The engine arm therefore asserts that
//! `sql_only_fallback::count()` did NOT increment across its ops
//! (delta == 0), proving the engine path actually ran.
//!
//! Process isolation: the `GLOBAL` Loro `OnceLock` is process-wide and
//! first-write-wins (see `loro::shared::install_for_test`), so a single
//! process cannot toggle the engine off after installing it. The fallback
//! arm therefore drives the `apply_*_sql_only` fns directly (the established
//! pattern — see `tag_convergence_tests`), which is the identical code the
//! via-loro routing calls on `get() == None`. Run under `cargo nextest run`
//! (one process per test), never plain `cargo test`.

use super::*;
use crate::db::init_pool;
use crate::op::{CreateBlockPayload, DeleteBlockPayload, OpPayload, RestoreBlockPayload};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ0000000000000000DELP01";
const PARENT_ID: &str = "01HZ0000000000000000DELPAR";
const CHILD_ID: &str = "01HZ0000000000000000DELCHD";
const GRANDCHILD_ID: &str = "01HZ0000000000000000DELGCH";
const DEVICE_ID: &str = "device-delete-restore-convergence";

/// A fixed, deterministic delete timestamp for the FALLBACK arm only.
/// (The engine arm stamps the real `record.created_at` instead — see the
/// module doc on why the raw values are not cross-arm comparable.)
const FALLBACK_DELETED_AT: i64 = 1_700_000_000_000;

/// Structural soft-delete snapshot: `(block_id, deleted_at IS NULL)` for the
/// three subtree blocks, ordered by id for a stable, arm-to-arm comparable
/// shape. We compare the NULL-ness (tombstoned vs live), not the raw
/// `deleted_at` integer, since the two arms stamp different timestamps.
type DeleteShapeRow = (String, bool);

async fn snapshot_delete_shape(pool: &SqlitePool) -> Vec<DeleteShapeRow> {
    sqlx::query_as(
        "SELECT id, deleted_at IS NULL FROM blocks \
         WHERE id IN (?, ?, ?) ORDER BY id",
    )
    .bind(PARENT_ID)
    .bind(CHILD_ID)
    .bind(GRANDCHILD_ID)
    .fetch_all(pool)
    .await
    .expect("snapshot delete shape")
}

/// Distinct non-null `deleted_at` values across the three subtree blocks.
/// Used to assert cohort identity WITHIN an arm: after a cascade delete all
/// three share ONE timestamp; after restore the set is empty (all NULL).
async fn distinct_deleted_at(pool: &SqlitePool) -> Vec<i64> {
    sqlx::query_scalar(
        "SELECT DISTINCT deleted_at FROM blocks \
         WHERE id IN (?, ?, ?) AND deleted_at IS NOT NULL ORDER BY deleted_at",
    )
    .bind(PARENT_ID)
    .bind(CHILD_ID)
    .bind(GRANDCHILD_ID)
    .fetch_all(pool)
    .await
    .expect("distinct deleted_at")
}

/// Seed the shared `blocks` rows (space, page, parent → child → grandchild)
/// in a fresh DB. Used by the FALLBACK arm so the cascade CTE (a SQL
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
    // page → parent → child → grandchild, all in SPACE_ID.
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
             VALUES (?, 'content', 'grandchild', ?, 0, ?, ?)",
    )
    .bind(GRANDCHILD_ID)
    .bind(CHILD_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
}

/// Drive a CreateBlock op through the real `apply_op_tx` pipeline so the
/// Loro engine has the node (precondition for the engine-arm DeleteBlock /
/// RestoreBlock to resolve a space and route through `apply_*_via_loro`).
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

/// Engine arm: install the Loro engine, seed the subtree through the real
/// pipeline, drive DeleteBlock(parent) then RestoreBlock(parent), snapshot
/// the soft-delete shape after each. Returns
/// `(after_delete_shape, after_delete_distinct, after_restore_shape,
/// after_restore_distinct)`.
///
/// Asserts `sql_only_fallback::count()` did NOT move across the two ops —
/// proving the engine path actually ran (#891).
async fn run_engine_arm() -> (Vec<DeleteShapeRow>, Vec<i64>, Vec<DeleteShapeRow>, Vec<i64>) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("engine_arm.db"))
        .await
        .expect("init_pool");

    // The `space` block + its `spaces` registry row (#708) must exist before
    // `blocks.space_id` (FK → spaces(id)) can be stamped below.
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
    // Seed the whole subtree through the engine so every block resolves to
    // SPACE_ID and the Delete / Restore ops take the via_loro arm.
    //
    // `resolve_block_space` resolves a content block's space via its OWN
    // `space_id`, falling back to its owning page's `space_id` through
    // `blocks.page_id` (#533). The create projection does NOT stamp these
    // (production does it post-commit via the deferred SetBlockPageId /
    // space-propagation tasks, which this op-log-only seed skips), so each
    // CreateBlock would resolve `None` and silently route through the
    // sql_only fallback — leaving the block ABSENT from the engine tree and
    // making the later engine DeleteBlock fail with "block not found".
    // We therefore stamp `page_id` + `space_id` on each block immediately
    // after its create so the NEXT child's create (and the eventual
    // Delete/Restore) resolve a space and take the via_loro arm.
    create_via_loro(&pool, PAGE_ID, "page", None, 0).await;
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .expect("stamp page space");

    for (id, parent) in [
        (PARENT_ID, PAGE_ID),
        (CHILD_ID, PARENT_ID),
        (GRANDCHILD_ID, CHILD_ID),
    ] {
        create_via_loro(&pool, id, "content", Some(parent), 0).await;
        // The op-log-only create seed leaves `blocks.parent_id` NULL (the
        // engine tracks parentage in its Loro tree; the SQL `parent_id`
        // column is reconciled post-commit). Both the cascade CTE and the
        // restore-via-loro space resolver (which reads `parent_id` to find
        // a non-tombstoned anchor) need the SQL chain, so stamp it here
        // alongside page_id/space_id.
        sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
            .bind(parent)
            .bind(PAGE_ID)
            .bind(SPACE_ID)
            .bind(id)
            .execute(&pool)
            .await
            .expect("stamp child parent/space");
    }

    // Count fallbacks BEFORE the two ops; assert no delta after.
    let fallback_before = super::sql_only_fallback::count();

    // --- DeleteBlock(parent) through the real pipeline ---
    let delete = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(PARENT_ID),
    });
    let delete_record = crate::op_log::append_local_op(&pool, DEVICE_ID, delete)
        .await
        .expect("append delete");
    let mut tx = pool.begin().await.expect("begin delete");
    super::apply_op_tx(&mut tx, &delete_record)
        .await
        .expect("apply delete");
    tx.commit().await.expect("commit delete");

    let after_delete_shape = snapshot_delete_shape(&pool).await;
    let after_delete_distinct = distinct_deleted_at(&pool).await;
    // #891: localize the no-fallback invariant to the DELETE op specifically,
    // so a future regression points at the right arm rather than the
    // aggregate count at the end.
    let fallback_mid = super::sql_only_fallback::count();
    assert_eq!(
        fallback_mid - fallback_before,
        0,
        "DELETE arm must NOT take the sql_only fallback (count delta must be 0); \
         it silently degraded to apply_delete_block_sql_only"
    );

    // --- RestoreBlock(parent) through the real pipeline ---
    // `deleted_at_ref` is sourced from the delete op's `created_at` — the
    // exact value the cascade stamped (mirrors production wiring, where the
    // restore op carries the originating delete's timestamp).
    let restore = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(PARENT_ID),
        deleted_at_ref: delete_record.created_at,
    });
    let restore_record = crate::op_log::append_local_op(&pool, DEVICE_ID, restore)
        .await
        .expect("append restore");
    let mut tx = pool.begin().await.expect("begin restore");
    super::apply_op_tx(&mut tx, &restore_record)
        .await
        .expect("apply restore");
    tx.commit().await.expect("commit restore");

    let after_restore_shape = snapshot_delete_shape(&pool).await;
    let after_restore_distinct = distinct_deleted_at(&pool).await;

    // #891: the engine path must have run for BOTH ops — no SQL-only
    // fallback. If this delta is nonzero, the engine arm silently degraded to
    // the fallback and the conformance comparison below would be vacuously
    // "identical" (both arms ran the same fallback).
    let fallback_after = super::sql_only_fallback::count();
    assert_eq!(
        fallback_after - fallback_before,
        0,
        "engine arm must NOT take the sql_only fallback (count delta must be 0); \
         Delete/Restore silently degraded to the fallback path"
    );

    (
        after_delete_shape,
        after_delete_distinct,
        after_restore_shape,
        after_restore_distinct,
    )
}

/// Fallback arm: NO engine. Seed the identical subtree directly in SQL, drive
/// the `apply_delete_block_sql_only` then `apply_restore_block_sql_only` fns
/// directly (the exact code the via_loro routing dispatches to on
/// `shared::get() == None`), snapshot after each.
async fn run_fallback_arm() -> (Vec<DeleteShapeRow>, Vec<i64>, Vec<DeleteShapeRow>, Vec<i64>) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("fallback_arm.db"))
        .await
        .expect("init_pool");

    seed_blocks_sql(&pool).await;

    let mut conn = pool.acquire().await.expect("acquire");
    // --- DeleteBlock(parent) via the sql_only fallback ---
    apply_delete_block_sql_only(
        &mut conn,
        DeleteBlockPayload {
            block_id: BlockId::from_trusted(PARENT_ID),
        },
        FALLBACK_DELETED_AT,
    )
    .await
    .expect("apply_delete_block_sql_only");
    drop(conn);

    let after_delete_shape = snapshot_delete_shape(&pool).await;
    let after_delete_distinct = distinct_deleted_at(&pool).await;

    let mut conn = pool.acquire().await.expect("acquire");
    // --- RestoreBlock(parent) via the sql_only fallback ---
    apply_restore_block_sql_only(
        &mut conn,
        RestoreBlockPayload {
            block_id: BlockId::from_trusted(PARENT_ID),
            deleted_at_ref: FALLBACK_DELETED_AT,
        },
    )
    .await
    .expect("apply_restore_block_sql_only");
    drop(conn);

    let after_restore_shape = snapshot_delete_shape(&pool).await;
    let after_restore_distinct = distinct_deleted_at(&pool).await;

    (
        after_delete_shape,
        after_delete_distinct,
        after_restore_shape,
        after_restore_distinct,
    )
}

/// The load-bearing #1323 (Step 2) conformance assertion: the engine arm and
/// the sql_only fallback arm project IDENTICAL `blocks` soft-delete state for
/// the same DeleteBlock → RestoreBlock sequence over a multi-level subtree,
/// at every settle point. A divergence here is a real convergence bug.
#[tokio::test]
async fn delete_restore_sql_only_fallback_converges_with_engine_arm() {
    let (eng_del_shape, eng_del_distinct, eng_res_shape, eng_res_distinct) = run_engine_arm().await;
    let (fb_del_shape, fb_del_distinct, fb_res_shape, fb_res_distinct) = run_fallback_arm().await;

    // After DeleteBlock(parent): both arms must soft-delete the WHOLE subtree
    // (parent + child + grandchild) — the cascade CTE shape must match.
    assert_eq!(
        eng_del_shape, fb_del_shape,
        "soft-delete shape diverges after DeleteBlock: \
         engine={eng_del_shape:?} fallback={fb_del_shape:?}"
    );

    // Absolute expected rows: every block in the subtree is tombstoned
    // (deleted_at IS NULL == false). If the fan-out were dropped from one
    // arm the cross-arm compare alone could pass vacuously — pin it down.
    let all_deleted: Vec<DeleteShapeRow> = vec![
        (CHILD_ID.to_string(), false),
        (PARENT_ID.to_string(), false),
        (GRANDCHILD_ID.to_string(), false),
    ];
    // (ids sort lexicographically: ...DELCHD < ...DELGCH < ...DELPAR)
    let mut expected_deleted = all_deleted;
    expected_deleted.sort();
    assert_eq!(
        eng_del_shape, expected_deleted,
        "DeleteBlock(parent) must cascade-soft-delete the entire subtree; \
         got {eng_del_shape:?}"
    );

    // Cohort identity WITHIN each arm: all three blocks share exactly ONE
    // non-null `deleted_at` timestamp (the cascade stamps a single value).
    assert_eq!(
        eng_del_distinct.len(),
        1,
        "engine cascade must stamp ONE uniform deleted_at across the cohort; \
         got {eng_del_distinct:?}"
    );
    assert_eq!(
        fb_del_distinct,
        vec![FALLBACK_DELETED_AT],
        "fallback cascade must stamp the fixed test timestamp across the cohort; \
         got {fb_del_distinct:?}"
    );

    // After RestoreBlock(parent): both arms must clear the WHOLE cohort.
    assert_eq!(
        eng_res_shape, fb_res_shape,
        "soft-delete shape diverges after RestoreBlock: \
         engine={eng_res_shape:?} fallback={fb_res_shape:?}"
    );

    // Absolute expected rows: every block live again (deleted_at IS NULL).
    let mut expected_restored: Vec<DeleteShapeRow> = vec![
        (CHILD_ID.to_string(), true),
        (GRANDCHILD_ID.to_string(), true),
        (PARENT_ID.to_string(), true),
    ];
    expected_restored.sort();
    assert_eq!(
        eng_res_shape, expected_restored,
        "RestoreBlock(parent) must clear the soft-delete across the entire cohort; \
         got {eng_res_shape:?}"
    );
    assert!(
        eng_res_distinct.is_empty() && fb_res_distinct.is_empty(),
        "RestoreBlock must leave NO non-null deleted_at in the subtree; \
         engine={eng_res_distinct:?} fallback={fb_res_distinct:?}"
    );
}
