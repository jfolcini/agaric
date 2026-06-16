//! #1323 (Step 3, create/edit): conformance test that drives the SAME
//! `CreateBlock` + `EditBlock` ops through BOTH the engine arm
//! (`apply_create_block_via_loro` / `apply_edit_block_via_loro`, via the real
//! foreground `apply_op_tx` pipeline with the Loro engine installed) AND the
//! sql_only fallback arm (`apply_create_block_sql_only` /
//! `apply_edit_block_sql_only`, called directly — exactly the fns the routing
//! dispatches to when `crate::loro::shared::get()` is `None`), then asserts the
//! resulting `blocks` rows are IDENTICAL between the two arms on the columns the
//! INSERT/UPDATE *shape* governs: `id`, `block_type`, `content`, `parent_id`,
//! `page_id`.
//!
//! ## Why this exists
//!
//! Step 3 routes the create/edit fallbacks through the shared projections
//! (`project_create_block_to_sql` / `project_edit_block_to_sql`) so the
//! INSERT/UPDATE shape (column list, `page_id` stamping #1324, `OR IGNORE`,
//! `deleted_at IS NULL` guard) can never drift from the engine arm. This test is
//! the arbiter that the shapes converged.
//!
//! ## The `position` divergence is PINNED, not hidden (#1245 / #1257)
//!
//! The engine arm runs `reproject_dense_positions` AFTER
//! `project_create_block_to_sql` — re-ranking the whole sibling group to a
//! DENSE 1-based order over the engine's fractional tree. The sql_only fallback
//! has no engine tree, so it writes only the PROVISIONAL rank
//! (`index + 1`, capped). For an index-only insert whose provisional value does
//! not equal the dense rank, the two arms legitimately write DIFFERENT
//! `position` values. That is the known #1245 / #1257 reproject-gap and Step 3
//! converges the INSERT *shape*, not the position value. The test therefore:
//!   - EXCLUDES `position` from the cross-arm row comparison, and
//!   - asserts each arm's `position` SEPARATELY (engine = reprojected dense
//!     rank, fallback = provisional `index + 1`), so the gap is documented and
//!     pinned rather than masked by a false cross-arm equality.
//!
//! For the cases where provisional == dense rank (a first child; a same-order
//! insert) the values happen to coincide; the index-only probe (`index = 5`
//! into an already-populated sibling set) is the case that makes them diverge,
//! proving the gap is real.
//!
//! #891 lesson: a test without `install_for_test` silently runs the FALLBACK,
//! not production. The engine arm therefore asserts that
//! `sql_only_fallback::count()` did NOT increment across its ops (delta == 0),
//! proving the engine path actually ran.
//!
//! Process isolation: the `GLOBAL` Loro `OnceLock` is process-wide and
//! first-write-wins (see `loro::shared::install_for_test`), so a single process
//! cannot toggle the engine off after installing it. The fallback arm therefore
//! drives the `apply_*_sql_only` fns directly (the established pattern — see
//! `tag_convergence_tests` / `delete_restore_convergence_tests`). Run under
//! `cargo nextest run` (one process per test), never plain `cargo test`.

use super::*;
use crate::db::init_pool;
use crate::op::{CreateBlockPayload, EditBlockPayload, OpPayload};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ0000000000000000CRPAGE";
const PARENT_ID: &str = "01HZ0000000000000000CRPARN";
// A pre-existing first child of PARENT (seeded), so the later index-only
// insert lands into a NON-empty sibling set and the engine's dense rank can
// diverge from the provisional `index + 1`.
const SEED_CHILD_ID: &str = "01HZ0000000000000000CRSEED";
// The three blocks the test CREATES through both arms:
const NORMAL_CHILD_ID: &str = "01HZ0000000000000000CRNORM"; // index=1 (2nd child)
const NEW_PAGE_ID: &str = "01HZ0000000000000000CRNPAG"; // a page create (page_id parity)
const INDEX_ONLY_ID: &str = "01HZ0000000000000000CRIDXO"; // index=5 (probe position)
const DEVICE_ID: &str = "device-create-edit-convergence";

/// The `index` slot used for the index-only probe. The fallback writes
/// `index + 1 = 6` (provisional); the engine writes the DENSE rank (which,
/// given the fixture's sibling count, is 3) — they diverge, pinning the
/// #1245 / #1257 gap.
const INDEX_ONLY_SLOT: i64 = 5;

/// A row captured for the cross-arm shape comparison. `position` is
/// DELIBERATELY excluded (see module doc — it is the documented reproject-gap).
/// Ordered by id for a stable, arm-to-arm comparable shape.
type ShapeRow = (String, String, String, Option<String>, Option<String>);

/// `(id, block_type, content, parent_id, page_id)` for the created blocks,
/// ordered by id. `position` is excluded — asserted separately per arm.
async fn snapshot_shape(pool: &SqlitePool) -> Vec<ShapeRow> {
    sqlx::query_as(
        "SELECT id, block_type, content, parent_id, page_id FROM blocks \
         WHERE id IN (?, ?, ?) ORDER BY id",
    )
    .bind(NORMAL_CHILD_ID)
    .bind(NEW_PAGE_ID)
    .bind(INDEX_ONLY_ID)
    .fetch_all(pool)
    .await
    .expect("snapshot shape")
}

/// The `position` written for a single block (NULL-able). Asserted per arm
/// because the two arms legitimately diverge on it (#1245 / #1257).
async fn position_of(pool: &SqlitePool, id: &str) -> Option<i64> {
    sqlx::query_scalar("SELECT position FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("fetch position")
}

/// Content of a single block — used to assert the EditBlock landed in both arms.
async fn content_of(pool: &SqlitePool, id: &str) -> String {
    sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("fetch content")
}

/// Seed the `space` block + its `spaces` registry row (#708) — required before
/// any `blocks.space_id` can be stamped (FK → spaces(id)).
async fn seed_space(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .expect("seed space block");
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(pool)
        .await
        .expect("register space");
}

/// Drive a CreateBlock op through the real `apply_op_tx` pipeline (engine arm).
async fn create_via_loro(
    pool: &SqlitePool,
    block_id: &str,
    block_type: &str,
    parent: Option<&str>,
    position: Option<i64>,
    index: Option<i64>,
    content: &str,
) {
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: block_type.into(),
        parent_id: parent.map(BlockId::from_trusted),
        position,
        index,
        content: content.into(),
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

/// Engine arm: install the engine, seed page + parent + first child through the
/// real pipeline (stamping page_id/space_id/parent_id so each create resolves a
/// space and takes the via_loro arm), then create the normal-child, page, and
/// index-only blocks, and finally edit the normal child. Returns the shape rows
/// + per-block positions + the edited content.
///
/// Asserts `sql_only_fallback::count()` did NOT move across the create/edit ops
/// — proving the engine path actually ran (#891).
async fn run_engine_arm() -> (Vec<ShapeRow>, Option<i64>, Option<i64>, Option<i64>, String) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("engine_arm.db"))
        .await
        .expect("init_pool");

    seed_space(&pool).await;

    let _state = crate::loro::shared::install_for_test();

    // Seed page → parent → first child through the engine. The op-log-only
    // create projection does NOT stamp page_id / space_id / parent_id in SQL
    // (production fills these post-commit via deferred tasks / cache rebuild),
    // so without stamping each block would resolve `None` and silently route
    // through the sql_only fallback — leaving it ABSENT from the engine tree.
    // Stamp them immediately after each create so the NEXT op resolves a space.
    create_via_loro(&pool, PAGE_ID, "page", None, Some(0), None, "page").await;
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .expect("stamp page space");

    for id in [PARENT_ID, SEED_CHILD_ID] {
        let parent = if id == PARENT_ID { PAGE_ID } else { PARENT_ID };
        create_via_loro(&pool, id, "content", Some(parent), Some(0), None, "seed").await;
        sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
            .bind(parent)
            .bind(PAGE_ID)
            .bind(SPACE_ID)
            .bind(id)
            .execute(&pool)
            .await
            .expect("stamp child parent/space");
    }

    // (2) Page create — page_id parity. A BRAND-NEW page has no `space_id`
    // yet (production stamps it post-commit via SetProperty(space) /
    // propagation), so `resolve_block_space(self)` returns None and the engine
    // arm LEGITIMATELY routes this create through the sql_only fallback too —
    // exactly as documented on `apply_create_block_via_loro` ("fresh
    // page-create with no SetProperty(space) yet"). Both arms therefore run the
    // SAME fallback fn for the page, which still stamps `page_id = id` (#1324).
    // We create it BEFORE the no-fallback-delta window below so this expected,
    // production-faithful fallback does not trip the engine-path invariant. Its
    // PARENT-less create does not affect PARENT's child dense ranks.
    create_via_loro(&pool, NEW_PAGE_ID, "page", None, Some(0), None, "new-page").await;

    // The no-fallback-delta window covers only the space-RESOLVABLE ops (the
    // two PARENT children + the edit); the page create above is expected to
    // fall back in both arms and is intentionally outside this window.
    let fallback_before = super::sql_only_fallback::count();

    // (1) Normal child create: 2nd child of PARENT, index = 1.
    create_via_loro(
        &pool,
        NORMAL_CHILD_ID,
        "content",
        Some(PARENT_ID),
        None,
        Some(1),
        "normal-child",
    )
    .await;
    // Stamp space so the later EditBlock on this block resolves + takes via_loro.
    sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
        .bind(PARENT_ID)
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(NORMAL_CHILD_ID)
        .execute(&pool)
        .await
        .expect("stamp normal child");

    // (3) Index-only create: index = 5 into PARENT (which already has
    //     SEED_CHILD + NORMAL_CHILD), probing the position divergence.
    create_via_loro(
        &pool,
        INDEX_ONLY_ID,
        "content",
        Some(PARENT_ID),
        None,
        Some(INDEX_ONLY_SLOT),
        "index-only",
    )
    .await;

    // (4) EditBlock on the normal child.
    let edit = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(NORMAL_CHILD_ID),
        to_text: "edited-content".into(),
        prev_edit: None,
    });
    let edit_record = crate::op_log::append_local_op(&pool, DEVICE_ID, edit)
        .await
        .expect("append edit");
    let mut tx = pool.begin().await.expect("begin edit");
    super::apply_op_tx(&mut tx, &edit_record)
        .await
        .expect("apply edit");
    tx.commit().await.expect("commit edit");

    let fallback_after = super::sql_only_fallback::count();
    assert_eq!(
        fallback_after - fallback_before,
        0,
        "engine arm must NOT take the sql_only fallback (count delta must be 0); \
         a create/edit silently degraded to the fallback path"
    );

    let shape = snapshot_shape(&pool).await;
    let pos_normal = position_of(&pool, NORMAL_CHILD_ID).await;
    let pos_page = position_of(&pool, NEW_PAGE_ID).await;
    let pos_index_only = position_of(&pool, INDEX_ONLY_ID).await;
    let edited = content_of(&pool, NORMAL_CHILD_ID).await;
    (shape, pos_normal, pos_page, pos_index_only, edited)
}

/// Fallback arm: NO engine. Seed the identical page/parent/first-child directly
/// in SQL, then drive the `apply_create_block_sql_only` / `apply_edit_block_sql_only`
/// fns directly (the exact code the via_loro routing dispatches to on
/// `shared::get() == None`).
async fn run_fallback_arm() -> (Vec<ShapeRow>, Option<i64>, Option<i64>, Option<i64>, String) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("fallback_arm.db"))
        .await
        .expect("init_pool");

    seed_space(&pool).await;
    // page → parent → first child (mirrors the engine arm's seed, so the
    // created blocks land into the same shape of `blocks` rows).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'page', NULL, 1, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .expect("seed page");
    for id in [PARENT_ID, SEED_CHILD_ID] {
        let parent = if id == PARENT_ID { PAGE_ID } else { PARENT_ID };
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'content', 'seed', ?, 1, ?, ?)",
        )
        .bind(id)
        .bind(parent)
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .expect("seed child");
    }

    let mut conn = pool.acquire().await.expect("acquire");

    // (1) Normal child create: 2nd child of PARENT, index = 1.
    apply_create_block_sql_only(
        &mut conn,
        CreateBlockPayload {
            block_id: BlockId::from_trusted(NORMAL_CHILD_ID),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PARENT_ID)),
            position: None,
            index: Some(1),
            content: "normal-child".into(),
        },
    )
    .await
    .expect("create normal child");
    // Mirror the engine arm's post-create page_id/space_id stamp on the normal
    // child. In the engine arm this stamp is what lets the later EditBlock
    // resolve a space and take the via_loro path; the fallback arm needs no
    // resolution, but we stamp identically so the cross-arm `page_id`
    // comparison is apples-to-apples (the CREATE projection itself writes NULL
    // page_id for a content block in BOTH arms; this scaffolding stamp would
    // otherwise show up as a spurious cross-arm divergence).
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(NORMAL_CHILD_ID)
        .execute(&pool)
        .await
        .expect("stamp normal child");

    // (2) Page create.
    apply_create_block_sql_only(
        &mut conn,
        CreateBlockPayload {
            block_id: BlockId::from_trusted(NEW_PAGE_ID),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "new-page".into(),
        },
    )
    .await
    .expect("create page");

    // (3) Index-only create: index = 5.
    apply_create_block_sql_only(
        &mut conn,
        CreateBlockPayload {
            block_id: BlockId::from_trusted(INDEX_ONLY_ID),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PARENT_ID)),
            position: None,
            index: Some(INDEX_ONLY_SLOT),
            content: "index-only".into(),
        },
    )
    .await
    .expect("create index-only");

    // (4) EditBlock on the normal child.
    apply_edit_block_sql_only(
        &mut conn,
        EditBlockPayload {
            block_id: BlockId::from_trusted(NORMAL_CHILD_ID),
            to_text: "edited-content".into(),
            prev_edit: None,
        },
    )
    .await
    .expect("edit normal child");
    drop(conn);

    let shape = snapshot_shape(&pool).await;
    let pos_normal = position_of(&pool, NORMAL_CHILD_ID).await;
    let pos_page = position_of(&pool, NEW_PAGE_ID).await;
    let pos_index_only = position_of(&pool, INDEX_ONLY_ID).await;
    let edited = content_of(&pool, NORMAL_CHILD_ID).await;
    (shape, pos_normal, pos_page, pos_index_only, edited)
}

/// The load-bearing #1323 (Step 3) conformance assertion: the engine arm and
/// the sql_only fallback arm project IDENTICAL `blocks` rows (on the
/// INSERT/UPDATE-shape columns) for the same CreateBlock + EditBlock sequence,
/// AND match absolute expected rows. `position` is pinned per arm because it is
/// the documented #1245 / #1257 reproject-gap.
#[tokio::test]
async fn create_edit_sql_only_fallback_converges_with_engine_arm() {
    let (eng_shape, eng_pos_normal, eng_pos_page, eng_pos_idx, eng_edited) = run_engine_arm().await;
    let (fb_shape, fb_pos_normal, fb_pos_page, fb_pos_idx, fb_edited) = run_fallback_arm().await;

    // --- Cross-arm INSERT shape (id, block_type, content, parent_id, page_id) ---
    assert_eq!(
        eng_shape, fb_shape,
        "create INSERT shape diverges between arms: engine={eng_shape:?} fallback={fb_shape:?}"
    );

    // --- Absolute expected rows (pin the shape down, not just cross-arm equal) ---
    // ids sort lexicographically: ...CRIDXO < ...CRNORM < ...CRNPAG
    let expected: Vec<ShapeRow> = vec![
        // index-only child of PARENT
        (
            INDEX_ONLY_ID.to_string(),
            "content".to_string(),
            "index-only".to_string(),
            Some(PARENT_ID.to_string()),
            None, // non-page ⇒ page_id NULL (deferred task fills it)
        ),
        // normal child of PARENT, EDITED content. page_id == PAGE_ID is the
        // test's scaffolding stamp (applied identically in both arms — see the
        // fallback arm); the CREATE projection itself writes NULL page_id for a
        // content block, which the index-only child above verifies.
        (
            NORMAL_CHILD_ID.to_string(),
            "content".to_string(),
            "edited-content".to_string(),
            Some(PARENT_ID.to_string()),
            Some(PAGE_ID.to_string()),
        ),
        // page block ⇒ page_id == own id (#1324)
        (
            NEW_PAGE_ID.to_string(),
            "page".to_string(),
            "new-page".to_string(),
            None,
            Some(NEW_PAGE_ID.to_string()),
        ),
    ];
    assert_eq!(
        eng_shape, expected,
        "created blocks must match absolute expected rows; got {eng_shape:?}"
    );

    // --- EditBlock landed in BOTH arms (content UPDATE shape converged) ---
    assert_eq!(eng_edited, "edited-content", "engine edit must land");
    assert_eq!(fb_edited, "edited-content", "fallback edit must land");

    // --- #1324 page_id parity: the page block's page_id is its own id in BOTH ---
    // (already covered by the shape comparison, but assert explicitly so a
    // regression names the page_id rule.)
    let eng_page_row = eng_shape
        .iter()
        .find(|r| r.0 == NEW_PAGE_ID)
        .expect("page row");
    assert_eq!(
        eng_page_row.4.as_deref(),
        Some(NEW_PAGE_ID),
        "page block must stamp page_id = id (#1324)"
    );

    // --- position: the DOCUMENTED #1245 / #1257 reproject-gap ---
    // Cases where provisional == dense rank coincide; the index-only probe
    // diverges. We assert each arm SEPARATELY so the gap is pinned, not masked.
    //
    // Fallback writes the PROVISIONAL rank `index_to_provisional_position`:
    //   normal child: index 1 -> 2 ; page: position 0 -> 0 ; index-only: 5 -> 6.
    assert_eq!(
        fb_pos_normal,
        Some(2),
        "fallback normal-child position = provisional index+1 = 2"
    );
    assert_eq!(
        fb_pos_page,
        Some(0),
        "fallback page position = provisional (legacy position 0)"
    );
    assert_eq!(
        fb_pos_idx,
        Some(INDEX_ONLY_SLOT + 1),
        "fallback index-only position = provisional index+1 = 6 (NOT reprojected)"
    );

    // Engine writes the DENSE reprojected rank over the sibling set.
    //   PARENT's children, in engine fractional order, are:
    //     SEED_CHILD (rank 1), NORMAL_CHILD (index 1 -> rank 2),
    //     INDEX_ONLY (index 5, clamped to end -> rank 3).
    assert_eq!(
        eng_pos_normal,
        Some(2),
        "engine normal-child dense rank = 2 (SEED_CHILD precedes it)"
    );
    assert_eq!(
        eng_pos_idx,
        Some(3),
        "engine index-only dense rank = 3 (3rd child of PARENT), NOT provisional 6"
    );
    // The page create takes the sql_only fallback in BOTH arms (a fresh page
    // has no resolvable space — see the engine-arm comment), so the engine
    // arm's page position is the SAME provisional value as the fallback arm,
    // and they converge exactly (no reprojection happened for the page).
    assert_eq!(
        eng_pos_page, fb_pos_page,
        "page position converges across arms (both ran the fallback): \
         engine={eng_pos_page:?} fallback={fb_pos_page:?}"
    );

    // The load-bearing gap assertion: for the index-only insert the two arms
    // legitimately DIVERGE on position (engine 3 vs fallback 6). This is the
    // #1245 / #1257 reproject-gap — pinned here, NOT hidden behind a false
    // cross-arm equality. If a future change makes the fallback reproject (or
    // the engine stop reprojecting), this assertion fires and forces a re-think.
    assert_ne!(
        eng_pos_idx, fb_pos_idx,
        "the index-only insert's position is the documented #1245/#1257 \
         reproject-gap: engine={eng_pos_idx:?} fallback={fb_pos_idx:?} must differ"
    );
}
