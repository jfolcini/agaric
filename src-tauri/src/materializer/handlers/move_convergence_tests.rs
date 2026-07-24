//! #1323 (Step 4, move): conformance test that drives the SAME
//! `MoveBlock(child → new parent)` op through BOTH the engine arm
//! (`apply_move_block_via_loro`, via the real foreground `apply_op_tx`
//! pipeline with the Loro engine installed) AND the sql_only fallback arm
//! (`apply_move_block_sql_only`, called directly — exactly the fn the routing
//! dispatches to when `agaric_engine::loro::shared::get()` is `None`), then asserts the
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
//!   `Err(AppError::validation("cycle detected"))`. It and the fallback now
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
use agaric_core::ulid::BlockId;
use agaric_store::op::{CreateBlockPayload, MoveBlockPayload, OpPayload};
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
    state: &agaric_engine::loro::shared::LoroState,
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
    let record = agaric_store::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append create");
    let mut tx = pool.begin().await.expect("begin create");
    super::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply create");
    tx.commit().await.expect("commit create");
}

/// Seed the shared `space` + `spaces` registry row (#708) in a fresh DB.
/// #2250 test helper: seed a block directly into the engine tree for
/// `space_id`, bypassing the op/create pipeline — used to place a page that
/// cannot engine-apply through a create op (no space at create time) so its
/// descendants' creates/moves take the engine path.
fn seed_block_into_engine(
    state: &agaric_engine::loro::shared::LoroState,
    space_id: &str,
    block_id: &str,
    block_type: &str,
    parent: Option<&str>,
    position: i64,
) {
    let space = agaric_store::space::SpaceId::from_trusted(space_id);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space (seed into engine)");
    guard
        .engine_mut()
        .apply_create_block(block_id, block_type, "", parent, position)
        .expect("seed apply_create_block into engine");
    drop(guard);
}

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

    let state = agaric_engine::loro::shared::LoroState::new();

    create_via_loro(&pool, &state, PAGE_ID, "page", None, 0).await;
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .expect("stamp page space");
    // #2250: the brand-new page create above legitimately fell back to
    // SQL-only (no space at create time), so the page is ABSENT from the
    // engine. Seed it directly so the child creates and the MoveBlock below
    // genuinely take the engine path instead of the parent-absent fallback.
    seed_block_into_engine(&state, SPACE_ID, PAGE_ID, "page", None, 0);

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
        create_via_loro(&pool, &state, id, "content", Some(parent), pos).await;
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
        new_position: agaric_store::pagination::index_to_provisional_position(MOVE_INDEX),
        new_index: Some(MOVE_INDEX),
    });
    let record = agaric_store::op_log::append_local_op(&pool, DEVICE_ID, mv)
        .await
        .expect("append move");
    let mut tx = pool.begin().await.expect("begin move");
    super::apply_op_tx(&mut tx, &record, None, &state)
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
            new_position: agaric_store::pagination::index_to_provisional_position(MOVE_INDEX),
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
        agaric_store::pagination::index_to_provisional_position(MOVE_INDEX),
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

    let state = agaric_engine::loro::shared::LoroState::new();

    create_via_loro(&pool, &state, PAGE_ID, "page", None, 0).await;
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .execute(&pool)
        .await
        .expect("stamp page space");
    // #2250: the brand-new page create above legitimately fell back to
    // SQL-only (no space at create time), so the page is ABSENT from the
    // engine. Seed it directly so the P1/C1A creates AND the cyclic MoveBlock
    // below genuinely take the engine path — otherwise the parent-absent
    // fallback would silently route this whole arm through
    // `apply_move_block_sql_only`, making it a duplicate of the fallback arm
    // rather than a test of the engine's `LoroTree::mov_to` cycle rejection
    // (the #891 false-green class this refactor removes).
    seed_block_into_engine(&state, SPACE_ID, PAGE_ID, "page", None, 0);
    for (id, parent) in [(P1_ID, PAGE_ID), (C1A_ID, P1_ID)] {
        create_via_loro(&pool, &state, id, "content", Some(parent), 0).await;
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
    // P1's parent (P1 is parented under PAGE in the engine tree by the seeded
    // create above); capture it BEFORE the cyclic move so we can assert the
    // move left it untouched, rather than hard-coding a value.
    let pre = parent_of(&pool, P1_ID).await;

    let fallback_before = super::sql_only_fallback::count();

    // Cycle: move P1 under C1A (C1A is P1's child → descendant).
    let mv = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(P1_ID),
        new_parent_id: Some(BlockId::from_trusted(C1A_ID)),
        new_position: agaric_store::pagination::index_to_provisional_position(0),
        new_index: Some(0),
    });
    let record = agaric_store::op_log::append_local_op(&pool, DEVICE_ID, mv)
        .await
        .expect("append cycle move");
    let mut tx = pool.begin().await.expect("begin cycle move");
    super::apply_op_tx(&mut tx, &record, None, &state)
        .await
        .expect("engine cycle move returns Ok (deterministic skip, not error)");
    tx.commit().await.expect("commit cycle move");

    // The cyclic move must take the ENGINE path (block + target parent both
    // live in the engine tree): the deterministic cycle rejection is the
    // engine's `LoroTree::mov_to`, NOT the SQL fallback's `move_would_cycle`
    // probe. A nonzero delta here means the arm silently degraded to SQL-only.
    assert_eq!(
        super::sql_only_fallback::count() - fallback_before,
        0,
        "engine cycle arm must NOT sql_only fallback (count delta must be 0); \
         the cyclic MoveBlock silently degraded to apply_move_block_sql_only"
    );

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
            new_position: agaric_store::pagination::index_to_provisional_position(0),
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
        agaric_store::block_descendants::move_would_cycle(&mut *conn, P1_ID, C1A_ID)
            .await
            .expect("probe"),
        "shared move_would_cycle must flag P1→under-C1A as a cycle (the command path errs on it)"
    );
    // Self-parent → true.
    assert!(
        agaric_store::block_descendants::move_would_cycle(&mut *conn, P1_ID, P1_ID)
            .await
            .expect("probe self"),
        "shared move_would_cycle must flag a self-parent move as a cycle"
    );
    // Non-cycle (C1A under nothing-related, e.g. C1A → page) → false.
    assert!(
        !agaric_store::block_descendants::move_would_cycle(&mut *conn, C1A_ID, P1_ID)
            .await
            .expect("probe non-cycle"),
        "shared move_would_cycle must NOT flag a legitimate move (C1A already under P1)"
    );
}

// ---------------------------------------------------------------------------
// #2344 (PR 1/2) — REMOTE MoveBlock cache maintenance parity with LOCAL.
//
// These pin the unified `apply_op_tx` Move-arm maintenance
// (`maintain_pages_cache_counts_after_op`'s `PreOpState::Move`):
//   * (fix b) `space_id` is re-derived for the moved subtree via the SHARED
//     `block_cleanup::rederive_page_and_space_ids` helper — the old
//     page_id-only reparent did NO `space_id` maintenance, so a cross-space
//     move left `space_id` stale until the background rebuild ran;
//   * (fix a) the moved subtree's outbound-link TARGET pages are added to the
//     recompute set, so their `inbound_link_count` is refreshed in-tx — the
//     old affected set was only `src ∪ dest`, leaving targets stale;
//   * (fix c, #2200) a pure same-parent reorder skips ALL maintenance.
//
// Each drives a REAL `apply_op_tx` MoveBlock (the REMOTE/sync entry point) and
// asserts the COMMITTED (in-tx) state WITHOUT running any background settle,
// then runs the canonical vault-wide rebuilds (the eventual "settle") and
// asserts the columns are UNCHANGED — i.e. the in-tx maintenance already
// converged (idempotent, convergence-safe: all touched columns are pure
// SQL-derived caches, absent from the op-log / engine / sync payload).
// ---------------------------------------------------------------------------

const SPACE_A: &str = SPACE_ID;
const SPACE_B: &str = "01ARZ3NDEKTSV4RRFFQ69G5FBW";

/// Insert a block row directly (engine-less: the moves below legitimately take
/// the SQL-only fallback — cross-space / not-in-engine — but STILL route
/// through `apply_op_tx`, so the Move-arm maintenance under test runs).
#[allow(clippy::too_many_arguments)]
async fn insert_block_row(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    parent: Option<&str>,
    position: i64,
    page_id: Option<&str>,
    space_id: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, ?, 'seed', ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(parent)
    .bind(position)
    .bind(page_id)
    .bind(space_id)
    .execute(pool)
    .await
    .expect("insert block row");
}

async fn seed_spaces_registry(pool: &SqlitePool) {
    // `spaces.id` REFERENCES `blocks.id`, and `blocks.space_id` REFERENCES
    // `spaces.id`, so the space BLOCK must exist before the registry row.
    for space in [SPACE_A, SPACE_B] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'tag', 'space', NULL, 0)",
        )
        .bind(space)
        .execute(pool)
        .await
        .expect("insert space block");
        sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
            .bind(space)
            .execute(pool)
            .await
            .expect("insert space registry row");
    }
}

async fn page_and_space(pool: &SqlitePool, id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT page_id, space_id FROM blocks WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("page_and_space")
}

async fn cache_counts(pool: &SqlitePool, page_id: &str) -> (i64, i64) {
    sqlx::query_as::<_, (i64, i64)>(
        "SELECT inbound_link_count, child_block_count FROM pages_cache WHERE page_id = ?",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await
    .expect("cache_counts")
}

/// Append a MoveBlock op and drive it through the real `apply_op_tx` pipeline,
/// committing. No background settle runs, so the returned committed state is
/// exactly the in-tx maintenance under test.
async fn move_via_apply_op_tx(
    pool: &SqlitePool,
    state: &agaric_engine::loro::shared::LoroState,
    block_id: &str,
    new_parent: Option<&str>,
    new_index: i64,
) {
    let mv = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        new_parent_id: new_parent.map(BlockId::from_trusted),
        new_position: agaric_store::pagination::index_to_provisional_position(new_index),
        new_index: Some(new_index),
    });
    let record = agaric_store::op_log::append_local_op(pool, DEVICE_ID, mv)
        .await
        .expect("append move");
    let mut tx = pool.begin().await.expect("begin move");
    super::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply move");
    tx.commit().await.expect("commit move");
}

/// The canonical background convergence (the eventual "settle"): vault-wide
/// `page_id` / `space_id` rebuilds + full `pages_cache` count recompute.
async fn settle_rebuilds(pool: &SqlitePool) {
    agaric_store::cache::rebuild_page_ids(pool)
        .await
        .expect("rebuild_page_ids");
    agaric_store::cache::rebuild_space_ids(pool)
        .await
        .expect("rebuild_space_ids");
    agaric_store::cache::rebuild_pages_cache(pool)
        .await
        .expect("rebuild_pages_cache");
    agaric_store::cache::rebuild_pages_cache_counts(pool)
        .await
        .expect("rebuild_pages_cache_counts");
}

/// #2344 (fix b + machinery for fix a): a CROSS-SPACE MoveBlock re-derives the
/// moved subtree's `space_id` AND `page_id` in-tx and recomputes the affected
/// pages' counts — the moved subtree links to the destination page, so the
/// destination page's `inbound_link_count` correctly drops to 0 (the link
/// became same-page). The `space_id` re-derivation is the load-bearing REMOTE
/// bug fix: the old page_id-only reparent left `space_id = SPACE_A` stale.
#[tokio::test]
async fn remote_apply_op_move_rederives_space_id_and_counts_in_tx_2344() {
    const PA: &str = "01HZ0000000000000000MVPGAA";
    const PB: &str = "01HZ0000000000000000MVPGBB";
    const M: &str = "01HZ0000000000000000MVMMMM";
    const MC: &str = "01HZ0000000000000000MVMCMC";

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("cross_space_move.db"))
        .await
        .expect("init_pool");
    seed_spaces_registry(&pool).await;
    let state = agaric_engine::loro::shared::LoroState::new();

    // Space A: page PA -> content M -> content MC. Space B: page PB.
    insert_block_row(&pool, PA, "page", None, 0, Some(PA), Some(SPACE_A)).await;
    insert_block_row(&pool, PB, "page", None, 1, Some(PB), Some(SPACE_B)).await;
    insert_block_row(&pool, M, "content", Some(PA), 0, Some(PA), Some(SPACE_A)).await;
    insert_block_row(&pool, MC, "content", Some(M), 0, Some(PA), Some(SPACE_A)).await;
    // MC links to the destination page PB (a cross-page link before the move).
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(MC)
        .bind(PB)
        .execute(&pool)
        .await
        .expect("insert block_link MC->PB");

    // Build the pre-move pages_cache: PA owns {M, MC} (2), PB owns {} (0) and
    // MC's cross-page link into PB gives PB inbound_link_count = 1.
    settle_rebuilds(&pool).await;
    assert_eq!(cache_counts(&pool, PA).await, (0, 2), "pre: PA counts");
    assert_eq!(cache_counts(&pool, PB).await, (1, 0), "pre: PB counts");

    // --- REMOTE cross-space MoveBlock: M (space A) -> under page PB (space B) ---
    move_via_apply_op_tx(&pool, &state, M, Some(PB), 0).await;

    // (fix b) space_id re-derived to the NEW space for the whole moved subtree
    // (previously STALE at SPACE_A on REMOTE — no space_id maintenance ran).
    assert_eq!(
        page_and_space(&pool, M).await,
        (Some(PB.to_owned()), Some(SPACE_B.to_owned())),
        "M page_id/space_id re-derived to destination in-tx"
    );
    assert_eq!(
        page_and_space(&pool, MC).await,
        (Some(PB.to_owned()), Some(SPACE_B.to_owned())),
        "MC (descendant) page_id/space_id re-derived to destination in-tx"
    );
    // (fix a machinery) counts recomputed in-tx: PA emptied, PB gained the
    // subtree, and MC's link to PB is now SAME-page so PB.inbound drops to 0.
    assert_eq!(cache_counts(&pool, PA).await, (0, 0), "post: PA emptied");
    assert_eq!(
        cache_counts(&pool, PB).await,
        (0, 2),
        "post: PB gains subtree; same-page link no longer counts inbound"
    );

    // Settle (canonical vault-wide rebuilds) and assert the in-tx state already
    // converged — nothing changes (idempotent / convergence-safe).
    settle_rebuilds(&pool).await;
    assert_eq!(
        page_and_space(&pool, M).await,
        (Some(PB.to_owned()), Some(SPACE_B.to_owned())),
        "M unchanged after settle (in-tx maintenance already converged)"
    );
    assert_eq!(
        page_and_space(&pool, MC).await,
        (Some(PB.to_owned()), Some(SPACE_B.to_owned())),
        "MC unchanged after settle"
    );
    assert_eq!(
        cache_counts(&pool, PA).await,
        (0, 0),
        "PA unchanged after settle"
    );
    assert_eq!(
        cache_counts(&pool, PB).await,
        (0, 2),
        "PB unchanged after settle"
    );
}

/// #2344 (fix a, isolated): a move that makes a source block's `page_id` NULL
/// (move to top level) must refresh its outbound-link TARGET page's
/// `inbound_link_count`. The target is NEITHER the source page NOR the (null)
/// destination page, so the OLD REMOTE affected set (`src ∪ dest`) missed it
/// and left the count STALE — this is the crisp regression guard for the
/// ported outbound-target UNION term.
#[tokio::test]
async fn remote_apply_op_move_to_top_level_refreshes_outbound_target_inbound_2344() {
    const PA: &str = "01HZ0000000000000000MVPGAA";
    const PT: &str = "01HZ0000000000000000MVPGTT";
    const MC: &str = "01HZ0000000000000000MVMCMC";

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("toplevel_move.db"))
        .await
        .expect("init_pool");
    seed_spaces_registry(&pool).await;
    let state = agaric_engine::loro::shared::LoroState::new();

    // Page PA owns content MC; separate page PT is MC's link target.
    insert_block_row(&pool, PA, "page", None, 0, Some(PA), Some(SPACE_A)).await;
    insert_block_row(&pool, PT, "page", None, 1, Some(PT), Some(SPACE_A)).await;
    insert_block_row(&pool, MC, "content", Some(PA), 0, Some(PA), Some(SPACE_A)).await;
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(MC)
        .bind(PT)
        .execute(&pool)
        .await
        .expect("insert block_link MC->PT");

    settle_rebuilds(&pool).await;
    // PT is a THIRD page (not PA, not the move destination): its inbound count
    // is 1 (MC links into it from a different page).
    assert_eq!(cache_counts(&pool, PT).await, (1, 0), "pre: PT inbound = 1");

    // --- REMOTE MoveBlock: MC -> top level (new_parent = None) ---
    move_via_apply_op_tx(&pool, &state, MC, None, 0).await;

    // MC's page_id is now NULL, so its link into PT no longer has a source
    // page → PT.inbound_link_count must drop to 0 IN-TX. Under the old
    // src∪dest affected set PT was never recomputed and stayed stale at 1.
    // (space_id retains its last value SPACE_A: an orphaned/top-level block
    // has no owning page to re-derive space from, so the shared rederive
    // helper — like `rebuild_space_ids` — leaves it authoritative. The
    // page_id → NULL is what drops PT's inbound.)
    assert_eq!(
        page_and_space(&pool, MC).await,
        (None, Some(SPACE_A.to_owned())),
        "MC page_id re-derived to NULL in-tx (space_id retained as orphan)"
    );
    assert_eq!(
        cache_counts(&pool, PT).await,
        (0, 0),
        "post: outbound-target PT inbound refreshed to 0 (fix a)"
    );

    // Idempotent with the canonical rebuild.
    settle_rebuilds(&pool).await;
    assert_eq!(
        cache_counts(&pool, PT).await,
        (0, 0),
        "PT inbound unchanged after settle"
    );
}

/// #2344 (fix c, #2200): a PURE same-parent reorder skips ALL Move-arm
/// maintenance — `page_id` / `space_id` / counts are provably unchanged, so the
/// committed state is byte-identical before and after.
#[tokio::test]
async fn remote_apply_op_move_same_parent_reorder_skips_maintenance_2344() {
    const PA: &str = "01HZ0000000000000000MVPGAA";
    const A: &str = "01HZ0000000000000000MVAAAA";
    const B: &str = "01HZ0000000000000000MVBBBB";

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("reorder_move.db"))
        .await
        .expect("init_pool");
    seed_spaces_registry(&pool).await;
    let state = agaric_engine::loro::shared::LoroState::new();

    // Page PA with two content children A, B (same parent).
    insert_block_row(&pool, PA, "page", None, 0, Some(PA), Some(SPACE_A)).await;
    insert_block_row(&pool, A, "content", Some(PA), 0, Some(PA), Some(SPACE_A)).await;
    insert_block_row(&pool, B, "content", Some(PA), 1, Some(PA), Some(SPACE_A)).await;

    settle_rebuilds(&pool).await;
    let counts_before = cache_counts(&pool, PA).await;
    let a_before = page_and_space(&pool, A).await;

    // --- REMOTE same-parent reorder: A stays under PA, moves to slot 1 ---
    move_via_apply_op_tx(&pool, &state, A, Some(PA), 1).await;

    // The #2200 early-out fired: no re-derive, no count recompute.
    assert_eq!(
        page_and_space(&pool, A).await,
        a_before,
        "same-parent reorder leaves page_id/space_id unchanged"
    );
    assert_eq!(
        cache_counts(&pool, PA).await,
        counts_before,
        "same-parent reorder leaves pages_cache counts unchanged"
    );
    // And it agrees with the canonical rebuild (the skip was CORRECT).
    settle_rebuilds(&pool).await;
    assert_eq!(
        cache_counts(&pool, PA).await,
        counts_before,
        "counts still match canonical rebuild after a same-parent reorder"
    );
}
