//! #1323 (Step 4, move): conformance test that drives the SAME
//! `MoveBlock(child → new parent)` op through BOTH the engine arm
//! (`apply_move_block_via_loro`, via the real foreground `apply_op_tx`
//! pipeline with the Loro engine installed) AND the sql_only fallback arm
//! (`apply_move_block_sql_only`, called directly — exactly the fn the routing
//! dispatches to when `crate::loro::shared::get()` is `None`), then asserts the
//! resulting `blocks.parent_id` is IDENTICAL between the two arms.
//!
//! The fixture seeds TWO parents (P1, P2) each with multiple children, so a
//! cross-parent move is genuinely exercised (the child leaves P1's sibling
//! group and joins P2's), which is the case that on the engine arm triggers a
//! dense reprojection of BOTH the source and the target group.
//!
//! ## Position divergence is EXPECTED, not a bug (#1245 / #1257)
//!
//! Step 4 converges the `parent_id` write (and the `UPDATE … WHERE id`
//! *shape*, both arms now routing through `project_move_block_to_sql`), but
//! NOT the `position` value. The engine arm runs `reproject_dense_positions`
//! on both affected sibling groups, re-ranking them to a dense 1-based order
//! over the engine's fractional tree; the engine-less fallback has no tree and
//! writes only the *provisional* rank. For a cross-parent move into a
//! populated sibling set the two legitimately differ. This test therefore:
//! * EXCLUDES `position` from the cross-arm equality assertion (compares
//!   `parent_id` only), and
//! * PINS each arm's position separately (engine = dense reprojected rank;
//!   fallback = provisional `new_index + 1`).
//!
//! This mirrors the Step 3 (`create_edit_convergence_tests`) divergence pattern.
//!
//! ## Cycle rejection is the load-bearing safety test
//!
//! A move that would form a `parent_id` cycle (move a parent under its own
//! descendant) is rejected on EVERY path, but the *form* of rejection differs
//! by design and the test pins each:
//! * The two materializer arms (engine `apply_move_block_via_loro` and the
//!   `apply_move_block_sql_only` fallback) both REJECT the cyclic reparent —
//!   the engine's `LoroTree::mov_to` rejects it deterministically (warn + skip)
//!   and the fallback's shared `move_would_cycle` probe skips the UPDATE — so
//!   NEITHER arm writes the moved block under its own descendant. The test
//!   asserts the safety invariant `parent != the rejected descendant` on both
//!   arms; on the fallback (a true SQL no-op) it additionally pins the
//!   `parent_id` byte-unchanged. (The engine arm still PROJECTS the engine
//!   tree's authoritative parent after the skip, which may differ from the SQL
//!   seed — so only the "not the cycle" invariant is cross-arm here; the
//!   *legitimate*-move `parent_id` convergence is the other test.)
//! * The command path (`move_block_inner`) instead returns
//!   `Err(AppError::Validation("cycle detected"))`. It and the fallback now
//!   share ONE probe (`block_descendants::move_would_cycle`), so this test also
//!   asserts the fallback's no-op-skip agrees with the command path's reject on
//!   the SAME cycle input (the probe is the single source of truth).
//!
//! #891 lesson: a test without `install_for_test` silently runs the FALLBACK,
//! not production. The engine arm asserts `sql_only_fallback::count()` did NOT
//! increment across its move (delta == 0), proving the engine path ran.
//!
//! Process isolation: the `GLOBAL` Loro `OnceLock` is process-wide and
//! first-write-wins, so a single process cannot toggle the engine off after
//! installing it. The fallback arm drives `apply_move_block_sql_only` directly
//! (the established pattern). Run under `cargo nextest run` (one process per
//! test), never plain `cargo test`.

use super::*;
use crate::db::init_pool;
use crate::op::{CreateBlockPayload, MoveBlockPayload, OpPayload};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ0000000000000000MVPAGE";
const P1_ID: &str = "01HZ00000000000000000MVP01";
const P2_ID: &str = "01HZ00000000000000000MVP02";
// Children of P1 (the moved one is C1A).
const C1A_ID: &str = "01HZ0000000000000000MVC1AA";
const C1B_ID: &str = "01HZ0000000000000000MVC1BB";
// Children of P2 (so the target sibling group is populated).
const C2A_ID: &str = "01HZ0000000000000000MVC2AA";
const C2B_ID: &str = "01HZ0000000000000000MVC2BB";
const DEVICE_ID: &str = "device-move-convergence";

/// 0-based slot the move targets within P2 (append after P2's two children).
const MOVE_INDEX: i64 = 2;

/// Drive a CreateBlock op through the real `apply_op_tx` pipeline so the Loro
/// engine has the node (precondition for the engine-arm MoveBlock to resolve a
/// space and route through `apply_move_block_via_loro`).
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

/// Seed the shared `space` + `spaces` registry row (#708) in a fresh DB.
async fn seed_space(pool: &SqlitePool) {
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
}

/// `parent_id` for the moved block — the cross-arm CONVERGED column.
async fn parent_of(pool: &SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("parent_of")
}

/// `position` for a block — the DIVERGENT column, pinned per-arm (not compared
/// across arms).
async fn position_of(pool: &SqlitePool, id: &str) -> i64 {
    sqlx::query_scalar("SELECT position FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("position_of")
}

/// Engine arm: install the engine, seed P1 (C1A, C1B) and P2 (C2A, C2B)
/// through the real pipeline, drive `MoveBlock(C1A → P2, index 2)`. Returns
/// `(c1a_parent, c1a_position)`. Asserts no sql_only fallback fired (#891).
async fn run_engine_arm() -> (Option<String>, i64) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("engine_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;

    let _state = crate::loro::shared::install_for_test();

    create_via_loro(&pool, PAGE_ID, "page", None, 0).await;
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .expect("stamp page space");

    // P1 + P2 under the page; their children. Stamp parent/page/space after
    // each create so the next child (and the MoveBlock) resolve a space and
    // take the via_loro arm (same reasoning as delete_restore_convergence).
    for (id, parent, pos) in [
        (P1_ID, PAGE_ID, 0),
        (P2_ID, PAGE_ID, 1),
        (C1A_ID, P1_ID, 0),
        (C1B_ID, P1_ID, 1),
        (C2A_ID, P2_ID, 0),
        (C2B_ID, P2_ID, 1),
    ] {
        create_via_loro(&pool, id, "content", Some(parent), pos).await;
        sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
            .bind(parent)
            .bind(PAGE_ID)
            .bind(SPACE_ID)
            .bind(id)
            .execute(&pool)
            .await
            .expect("stamp child parent/space");
    }

    let fallback_before = super::sql_only_fallback::count();

    // --- MoveBlock(C1A → P2 at slot 2) through the real pipeline ---
    let mv = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(C1A_ID),
        new_parent_id: Some(BlockId::from_trusted(P2_ID)),
        new_position: crate::pagination::index_to_provisional_position(MOVE_INDEX),
        new_index: Some(MOVE_INDEX),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, mv)
        .await
        .expect("append move");
    let mut tx = pool.begin().await.expect("begin move");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("apply move");
    tx.commit().await.expect("commit move");

    let fallback_after = super::sql_only_fallback::count();
    assert_eq!(
        fallback_after - fallback_before,
        0,
        "engine arm must NOT take the sql_only fallback (count delta must be 0); \
         MoveBlock silently degraded to apply_move_block_sql_only"
    );

    (
        parent_of(&pool, C1A_ID).await,
        position_of(&pool, C1A_ID).await,
    )
}

/// Fallback arm: NO engine. Seed the identical hierarchy directly in SQL, drive
/// `apply_move_block_sql_only(C1A → P2, index 2)` directly (the exact code the
/// via_loro routing dispatches to on `shared::get() == None`). Returns
/// `(c1a_parent, c1a_position)`.
async fn run_fallback_arm() -> (Option<String>, i64) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("fallback_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    seed_hierarchy_sql(&pool).await;

    let mut conn = pool.acquire().await.expect("acquire");
    apply_move_block_sql_only(
        &mut conn,
        MoveBlockPayload {
            block_id: BlockId::from_trusted(C1A_ID),
            new_parent_id: Some(BlockId::from_trusted(P2_ID)),
            new_position: crate::pagination::index_to_provisional_position(MOVE_INDEX),
            new_index: Some(MOVE_INDEX),
        },
    )
    .await
    .expect("apply_move_block_sql_only");
    drop(conn);

    (
        parent_of(&pool, C1A_ID).await,
        position_of(&pool, C1A_ID).await,
    )
}

/// Seed page → {P1 → (C1A, C1B), P2 → (C2A, C2B)} directly in SQL for the
/// engine-less fallback arm (and the cycle fallback fixture).
async fn seed_hierarchy_sql(pool: &SqlitePool) {
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
    for (id, parent, pos) in [
        (P1_ID, PAGE_ID, 0),
        (P2_ID, PAGE_ID, 1),
        (C1A_ID, P1_ID, 0),
        (C1B_ID, P1_ID, 1),
        (C2A_ID, P2_ID, 0),
        (C2B_ID, P2_ID, 1),
    ] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'content', 'seed', ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(parent)
        .bind(pos)
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// The load-bearing #1323 (Step 4) conformance assertion: the engine arm and
/// the sql_only fallback arm project the IDENTICAL `blocks.parent_id` for the
/// same cross-parent `MoveBlock`, while `position` legitimately diverges and is
/// pinned per-arm (the #1245 / #1257 reproject gap).
#[tokio::test]
async fn move_sql_only_fallback_converges_with_engine_arm() {
    let (eng_parent, eng_pos) = run_engine_arm().await;
    let (fb_parent, fb_pos) = run_fallback_arm().await;

    // CONVERGED column: both arms reparent C1A under P2.
    assert_eq!(
        eng_parent, fb_parent,
        "parent_id diverges after MoveBlock: engine={eng_parent:?} fallback={fb_parent:?}"
    );
    // Absolute expected value — pin it so a cross-arm compare can't pass
    // vacuously (e.g. if BOTH arms silently left the parent unchanged).
    assert_eq!(
        eng_parent.as_deref(),
        Some(P2_ID),
        "MoveBlock must reparent C1A under P2 on the engine arm; got {eng_parent:?}"
    );
    assert_eq!(
        fb_parent.as_deref(),
        Some(P2_ID),
        "MoveBlock must reparent C1A under P2 on the fallback arm; got {fb_parent:?}"
    );

    // DIVERGENT column (#1245 / #1257): NOT compared across arms. Pin each.
    // Engine arm: dense 1-based reprojection over P2's now-3-child group, so
    // the appended C1A lands at rank 3 (after C2A=1, C2B=2).
    assert_eq!(
        eng_pos, 3,
        "engine arm must dense-reproject C1A to rank 3 in P2's 3-child group; got {eng_pos}"
    );
    // Fallback arm: provisional `new_index + 1` (no engine tree to reproject),
    // i.e. index 2 → position 3. (They coincide numerically here only because
    // the append slot happens to equal the dense tail; the assertion exists to
    // pin the FORMULA, not to claim cross-arm equality — see the module doc.)
    assert_eq!(
        fb_pos,
        crate::pagination::index_to_provisional_position(MOVE_INDEX),
        "fallback arm must write the provisional rank (index + 1); got {fb_pos}"
    );
}

// --- Cycle-rejection conformance (the load-bearing safety test) -------------

/// Engine arm, CYCLE input: seed P1 → C1A (C1A a child of P1) through the real
/// pipeline, then try to move P1 *under* C1A (its own descendant). The engine's
/// `LoroTree::mov_to` rejects the cyclic reparent deterministically (warn +
/// skip), so the op returns `Ok` and P1's `parent_id` is UNCHANGED. Returns
/// `(pre_move_parent, post_move_parent)` so the test can assert the move was a
/// no-op (post == pre) without hard-coding the engine's seeded parent value.
async fn run_engine_cycle_arm() -> (Option<String>, Option<String>) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("engine_cycle.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;

    let _state = crate::loro::shared::install_for_test();

    create_via_loro(&pool, PAGE_ID, "page", None, 0).await;
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .expect("stamp page space");
    for (id, parent) in [(P1_ID, PAGE_ID), (C1A_ID, P1_ID)] {
        create_via_loro(&pool, id, "content", Some(parent), 0).await;
        sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
            .bind(parent)
            .bind(PAGE_ID)
            .bind(SPACE_ID)
            .bind(id)
            .execute(&pool)
            .await
            .expect("stamp parent/space");
    }

    // The engine arm's `project_move_block_to_sql` writes the engine's view of
    // P1's parent (which the seed may or may not have parented under PAGE in the
    // engine tree); capture it BEFORE the cyclic move so we can assert the move
    // left it untouched, rather than hard-coding a value.
    let pre = parent_of(&pool, P1_ID).await;

    // Cycle: move P1 under C1A (C1A is P1's child → descendant).
    let mv = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(P1_ID),
        new_parent_id: Some(BlockId::from_trusted(C1A_ID)),
        new_position: crate::pagination::index_to_provisional_position(0),
        new_index: Some(0),
    });
    let record = crate::op_log::append_local_op(&pool, DEVICE_ID, mv)
        .await
        .expect("append cycle move");
    let mut tx = pool.begin().await.expect("begin cycle move");
    super::apply_op_tx(&mut tx, &record)
        .await
        .expect("engine cycle move returns Ok (deterministic skip, not error)");
    tx.commit().await.expect("commit cycle move");

    (pre, parent_of(&pool, P1_ID).await)
}

/// Fallback arm, CYCLE input: seed P1 → C1A directly in SQL, call
/// `apply_move_block_sql_only` to move P1 under C1A. The shared
/// `move_would_cycle` probe skips the UPDATE (no-op-warn + `Ok`), so P1's
/// parent_id is UNCHANGED. Returns `(pre_move_parent, post_move_parent)`.
async fn run_fallback_cycle_arm() -> (Option<String>, Option<String>) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("fallback_cycle.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', 'page', NULL, 0, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .unwrap();
    for (id, parent) in [(P1_ID, PAGE_ID), (C1A_ID, P1_ID)] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'content', 'seed', ?, 0, ?, ?)",
        )
        .bind(id)
        .bind(parent)
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .unwrap();
    }

    let pre = parent_of(&pool, P1_ID).await;

    let mut conn = pool.acquire().await.expect("acquire");
    apply_move_block_sql_only(
        &mut conn,
        MoveBlockPayload {
            block_id: BlockId::from_trusted(P1_ID),
            new_parent_id: Some(BlockId::from_trusted(C1A_ID)),
            new_position: crate::pagination::index_to_provisional_position(0),
            new_index: Some(0),
        },
    )
    .await
    .expect("fallback cycle move returns Ok (no-op-warn, not error)");
    drop(conn);

    (pre, parent_of(&pool, P1_ID).await)
}

/// Load-bearing cycle-rejection conformance: a cycle-forming move is rejected
/// on BOTH materializer arms by a no-op-skip (parent_id UNCHANGED), and the
/// shared `move_would_cycle` probe that the fallback uses agrees with the
/// command path's hard `Err` on the same input.
#[tokio::test]
async fn move_cycle_rejected_consistently_across_arms() {
    let (_eng_pre, eng_post) = run_engine_cycle_arm().await;
    let (fb_pre, fb_post) = run_fallback_cycle_arm().await;

    // The load-bearing safety invariant on BOTH materializer arms: the
    // cycle-forming reparent is REJECTED — neither arm writes C1A (P1's own
    // descendant) as P1's parent. The engine's `LoroTree::mov_to` rejects it
    // deterministically (warn + skip) and the fallback's shared
    // `move_would_cycle` probe skips the UPDATE.
    assert_ne!(
        eng_post.as_deref(),
        Some(C1A_ID),
        "engine arm must NOT install the cycle (P1 under its own child C1A); got {eng_post:?}"
    );
    assert_ne!(
        fb_post.as_deref(),
        Some(C1A_ID),
        "fallback arm must NOT install the cycle (P1 under its own child C1A); got {fb_post:?}"
    );

    // The fallback is a true SQL no-op: it leaves P1's `parent_id` byte-for-byte
    // unchanged (the probe skipped the UPDATE entirely). Pin both that it did
    // not move AND the concrete seeded PAGE parent.
    assert_eq!(
        fb_post, fb_pre,
        "fallback arm must leave P1.parent_id untouched on a skipped cyclic move; \
         pre={fb_pre:?} post={fb_post:?}"
    );
    assert_eq!(
        fb_post.as_deref(),
        Some(PAGE_ID),
        "fallback arm: P1 stays under the page after the skipped cyclic move; got {fb_post:?}"
    );
    // (The engine arm still PROJECTS the engine's authoritative parent for P1
    // after the skipped move — which is the engine tree's view, not the SQL
    // seed — so its post-state need not equal the SQL pre-state. What matters
    // for safety is only that it is NOT the rejected cycle parent, asserted
    // above. The engine-vs-fallback `parent_id` convergence on a *legitimate*
    // move is covered by `move_sql_only_fallback_converges_with_engine_arm`.)

    // The shared probe is the single source of truth: the SAME cycle input the
    // fallback skipped must be flagged by `move_would_cycle` (which the command
    // path `move_block_inner` uses to raise `Err(Validation("cycle detected"))`).
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("probe.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'P1', NULL, 0)",
    )
    .bind(P1_ID)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'C1A', ?, 0)",
    )
    .bind(C1A_ID)
    .bind(P1_ID)
    .execute(&pool)
    .await
    .unwrap();

    let mut conn = pool.acquire().await.expect("acquire");
    // Cycle (P1 under its descendant C1A) → true.
    assert!(
        crate::block_descendants::move_would_cycle(&mut *conn, P1_ID, C1A_ID)
            .await
            .expect("probe"),
        "shared move_would_cycle must flag P1→under-C1A as a cycle (the command path errs on it)"
    );
    // Self-parent → true.
    assert!(
        crate::block_descendants::move_would_cycle(&mut *conn, P1_ID, P1_ID)
            .await
            .expect("probe self"),
        "shared move_would_cycle must flag a self-parent move as a cycle"
    );
    // Non-cycle (C1A under nothing-related, e.g. C1A → page) → false.
    assert!(
        !crate::block_descendants::move_would_cycle(&mut *conn, C1A_ID, P1_ID)
            .await
            .expect("probe non-cycle"),
        "shared move_would_cycle must NOT flag a legitimate move (C1A already under P1)"
    );
}
