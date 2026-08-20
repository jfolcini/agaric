//! #1323 (Step 4, move): conformance test that drives the SAME
//! `MoveBlock(child → new parent)` op through BOTH the engine arm
//! (`apply_move_block_via_loro`, via the real foreground `apply_op_tx`
//! pipeline with a real `&LoroState`) AND the sql_only fallback arm
//! (`apply_move_block_sql_only`, called directly — the same fn the engine
//! arm's own routing falls back to when space resolution fails or the
//! engine tree is missing the block), then asserts the
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
//! #891 lesson: a test that never checks whether the engine path actually ran
//! can silently pass on the FALLBACK instead of production. The engine arm
//! asserts `sql_only_fallback::count()` did NOT increment across its move
//! (delta == 0), proving the engine path ran.
//!
//! #2249: `LoroState` is an ordinary per-instance value, not a process
//! global, so the two arms' engine states (where the engine arm has one at
//! all) cannot interfere with each other. The fallback arm drives
//! `apply_move_block_sql_only` directly (the established pattern).
//!
//! HOWEVER, the `count() == delta` guard above reads the process-global
//! `sql_only_fallback::count()` counter, a monotonic `AtomicU64` shared by
//! every test running in the SAME process. For why that read is still
//! sound under `cargo nextest run` and NOT under concurrent plain
//! `cargo test` — and why `[test-groups.spy-counter-serial]`'s
//! `max-threads = 1` is not what supplies that — see
//! `agaric_engine::loro::shared`'s module docs (the canonical statement,
//! #3983); this file does not restate the mechanism.

use super::*;
use crate::db::init_pool;
use agaric_core::ulid::BlockId;
use agaric_store::op::{CreateBlockPayload, DeleteBlockPayload, MoveBlockPayload, OpPayload};
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
/// via_loro routing falls back to when space resolution fails or the engine
/// tree is missing the block). Returns `(c1a_parent, c1a_position)`.
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

// ---------------------------------------------------------------------------
// #4112 — a replayed MoveBlock that lands a LIVE block under a TOMBSTONE.
//
// The local command path cannot produce this state: `validate_move_in_tx`
// probes `SELECT 1 FROM blocks WHERE id = ? AND deleted_at IS NULL` for BOTH
// the subject and the target parent and returns `AppError::NotFound`. The
// replay path has no such probe, and — critically — must not grow one: by the
// time it runs the op EXISTS, authored on a peer against a state where the
// parent was still live, so refusing it drops a peer's op on ONE device and
// diverges the vault.
//
// `move_under_tombstoned_parent_converges_across_replay_orders_4112` below is
// the test that decides the design question #4112 filed rather than patched.
// It replays the SAME two op records — literally the same `OpRecord` values,
// so the delete's `created_at` (and hence the cohort timestamp) is shared — in
// both orders and demands identical `(parent_id, deleted_at)`. Of the
// candidate behaviours only the sweep passes it:
//
//   | behaviour on a move under a tombstone | delete-first | move-first  |
//   |---------------------------------------|--------------|-------------|
//   | reject / no-op (mirror the local path)| B live, old parent | B trashed under P2 |
//   | apply unguarded (pre-#4112)           | B LIVE under tombstoned P2 | B trashed under P2 |
//   | reparent to topmost live ancestor     | B live under PAGE  | B trashed under P2 |
//   | **sweep into the ancestor's cohort**  | **B trashed under P2** | **B trashed under P2** |
//
// The sweep is also not a new rule: `project_move_block_to_sql`'s sibling
// `reproject_block_deleted_at_from_engine` already resolves this exact merge
// on the SNAPSHOT-import path and already calls it the R9 "live block under a
// tombstoned ancestor" sweep. #4112 is the same rule missing on the OP path.
//
// **Scope of "same state".** These tests compare `(parent_id, deleted_at)` —
// the columns the merge decides. `position` is excluded for the reason the
// module header already gives (#1245 / #1257: the dense reproject is an
// engine-arm-only pass). The per-space ENGINE state is likewise out of scope
// here: this harness drives `apply_op_tx` without the post-commit
// `dispatch_delete_descendants` fan-out, so the delete-first and move-first
// orders legitimately differ in how much of the cohort reached the engine —
// pinning that would be pinning the harness, not the merge.
// ---------------------------------------------------------------------------

/// A grandchild under C1A, so the sweep has a descendant to cascade over (the
/// delete-first and move-first orders must agree about IT too, not just about
/// the moved block itself).
const G1A_ID: &str = "01HZ0000000000000000MVG1AA";

/// Deterministic tombstone timestamp for the ENGINE-LESS fallback arm, which
/// has no op record to take a `created_at` from.
const FALLBACK_TOMBSTONE_TS: i64 = 1_735_689_600_000;

/// `(parent_id, deleted_at)` — the pair #4112 must converge.
async fn shape_of(pool: &SqlitePool, id: &str) -> (Option<String>, Option<i64>) {
    sqlx::query_as::<_, (Option<String>, Option<i64>)>(
        "SELECT parent_id, deleted_at FROM blocks WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("shape_of")
}

/// Seed a full engine-backed world: page → {P1 → (C1A → G1A, C1B),
/// P2 → (C2A, C2B)}, every block present in BOTH SQL and the per-space engine
/// tree so the MoveBlock under test genuinely takes `apply_move_block_via_loro`
/// (#891: an arm that silently degrades to the fallback tests the wrong code).
///
/// The `TempDir` is returned so the caller can keep the SQLite file alive.
async fn seed_engine_world(
    db_name: &str,
) -> (TempDir, SqlitePool, agaric_engine::loro::shared::LoroState) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join(db_name))
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
    // #2250: the page create legitimately fell back to SQL-only (no space at
    // create time), so seed it into the engine directly — otherwise every
    // descendant create and the MoveBlock take the parent-absent fallback.
    seed_block_into_engine(&state, SPACE_ID, PAGE_ID, "page", None, 0);

    for (id, parent, pos) in [
        (P1_ID, PAGE_ID, 0),
        (P2_ID, PAGE_ID, 1),
        (C1A_ID, P1_ID, 0),
        (C1B_ID, P1_ID, 1),
        (G1A_ID, C1A_ID, 0),
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

    (dir, pool, state)
}

/// Append a `DeleteBlock` op WITHOUT applying it, so the caller can choose the
/// replay order (and reuse the identical record — same `created_at`, hence the
/// same cohort timestamp — on more than one device).
async fn append_delete(pool: &SqlitePool, block_id: &str) -> agaric_store::op_log::OpRecord {
    agaric_store::op_log::append_local_op(
        pool,
        DEVICE_ID,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::from_trusted(block_id),
        }),
    )
    .await
    .expect("append delete")
}

/// Append a `MoveBlock` op WITHOUT applying it. Companion to [`append_delete`].
async fn append_move(
    pool: &SqlitePool,
    block_id: &str,
    new_parent: &str,
    new_index: i64,
) -> agaric_store::op_log::OpRecord {
    agaric_store::op_log::append_local_op(
        pool,
        DEVICE_ID,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            new_parent_id: Some(BlockId::from_trusted(new_parent)),
            new_position: agaric_store::pagination::index_to_provisional_position(new_index),
            new_index: Some(new_index),
        }),
    )
    .await
    .expect("append move")
}

/// Drive one already-appended record through the real `apply_op_tx` pipeline.
async fn replay(
    pool: &SqlitePool,
    state: &agaric_engine::loro::shared::LoroState,
    record: &agaric_store::op_log::OpRecord,
) {
    let mut tx = pool.begin().await.expect("begin replay");
    super::apply_op_tx(&mut tx, record, None, state)
        .await
        .expect("apply record");
    tx.commit().await.expect("commit replay");
}

/// Engine arm: delete P2, then replay `MoveBlock(C1A → P2)`. Returns the shapes
/// of the moved block, its grandchild, and the tombstoned target parent.
async fn run_engine_sweep_arm() -> (
    (Option<String>, Option<i64>),
    (Option<String>, Option<i64>),
    (Option<String>, Option<i64>),
) {
    let (_dir, pool, state) = seed_engine_world("engine_sweep.db").await;

    let del = append_delete(&pool, P2_ID).await;
    replay(&pool, &state, &del).await;

    let fallback_before = super::sql_only_fallback::count();
    let mv = append_move(&pool, C1A_ID, P2_ID, MOVE_INDEX).await;
    replay(&pool, &state, &mv).await;
    // #891: the sweep must be exercised on the ENGINE arm, not silently on the
    // fallback. A soft-deleted target parent is still a live NODE in the engine
    // tree (`read_block` is soft-delete agnostic), so the routing must stay on
    // `apply_move_block_via_loro`.
    assert_eq!(
        super::sql_only_fallback::count() - fallback_before,
        0,
        "engine sweep arm must NOT take the sql_only fallback (count delta must be 0)"
    );

    (
        shape_of(&pool, C1A_ID).await,
        shape_of(&pool, G1A_ID).await,
        shape_of(&pool, P2_ID).await,
    )
}

/// Fallback arm: NO engine. Seed the identical hierarchy in SQL, soft-delete P2
/// directly, and call `apply_move_block_sql_only` — the exact fn the engine
/// arm's routing degrades to.
async fn run_fallback_sweep_arm() -> (
    (Option<String>, Option<i64>),
    (Option<String>, Option<i64>),
    (Option<String>, Option<i64>),
) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("fallback_sweep.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    seed_hierarchy_sql(&pool).await;
    insert_block_row(
        &pool,
        G1A_ID,
        "content",
        Some(C1A_ID),
        0,
        Some(PAGE_ID),
        Some(SPACE_ID),
    )
    .await;
    // The delete cascade the mover peer never saw: P2 and its own children.
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id IN (?, ?, ?)")
        .bind(FALLBACK_TOMBSTONE_TS)
        .bind(P2_ID)
        .bind(C2A_ID)
        .bind(C2B_ID)
        .execute(&pool)
        .await
        .expect("tombstone P2 subtree");

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
        shape_of(&pool, C1A_ID).await,
        shape_of(&pool, G1A_ID).await,
        shape_of(&pool, P2_ID).await,
    )
}

/// #4112 — a replayed `MoveBlock` into a tombstoned subtree sweeps the moved
/// block AND its live descendants into that tombstone's cohort, on BOTH
/// materializer arms.
///
/// The cohort timestamp is the load-bearing part: it is the TARGET PARENT's
/// `deleted_at`, not `now`, because that is what makes the result identical to
/// the state the reverse replay order produces (where the delete cascade did
/// the stamping) — and it is what keeps the swept blocks restorable as one
/// unit, since `RestoreBlock` keys the cohort on a shared `deleted_at`.
///
/// Reverting `sweep_move_under_tombstoned_ancestor`'s call in
/// `apply_move_block_via_loro` / `apply_move_block_sql_only` reddens this test:
/// the moved subtree stays LIVE under the tombstone — an invisible orphan,
/// absent from the tree (its ancestor is trashed) and absent from the trash
/// (it is not).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_under_tombstoned_parent_sweeps_into_the_trash_cohort_4112() {
    let (eng_c1a, eng_g1a, eng_p2) = run_engine_sweep_arm().await;
    let (fb_c1a, fb_g1a, fb_p2) = run_fallback_sweep_arm().await;

    for (arm, c1a, g1a, p2) in [
        ("engine", &eng_c1a, &eng_g1a, &eng_p2),
        ("fallback", &fb_c1a, &fb_g1a, &fb_p2),
    ] {
        assert_eq!(
            c1a.0.as_deref(),
            Some(P2_ID),
            "{arm} arm: the move must still be APPLIED — the block belongs under \
             P2, the peer's op is not dropped; got {c1a:?}"
        );
        assert!(
            p2.1.is_some(),
            "{arm} arm precondition: P2 is tombstoned; got {p2:?}"
        );
        assert_eq!(
            c1a.1, p2.1,
            "#4112: {arm} arm must sweep the moved block into P2's EXACT cohort \
             timestamp (not `now`, not left live); c1a={c1a:?} p2={p2:?}"
        );
        assert_eq!(
            g1a.1, p2.1,
            "#4112: {arm} arm must cascade the sweep over the moved block's live \
             descendants too; g1a={g1a:?} p2={p2:?}"
        );
        assert_eq!(
            g1a.0.as_deref(),
            Some(C1A_ID),
            "{arm} arm: the sweep must not reparent anything; got {g1a:?}"
        );
    }

    // Cross-arm: the CONVERGED column. (The two arms' absolute timestamps
    // differ by construction — the engine arm takes the delete op's
    // `created_at`, the engine-less arm a fixed constant — so what converges is
    // the parent and the "swept into the parent's cohort" relation, both
    // asserted per-arm above.)
    assert_eq!(
        eng_c1a.0, fb_c1a.0,
        "parent_id diverges between the arms after a move into a tombstone: \
         engine={eng_c1a:?} fallback={fb_c1a:?}"
    );
}

/// #4112, THE convergence test: two devices replay the SAME two op records in
/// opposite orders and must reach the same state.
///
/// Both devices are handed the identical `OpRecord` values (appended once), so
/// the delete carries one `created_at` — the cohort timestamp — across both
/// replays. Device A sees `Delete(P2)` then `Move(C1A → P2)`; device B sees the
/// move first and the delete's cascade catches C1A. Every op-set-derived column
/// must match.
///
/// This is the assertion that rules out the alternatives: a guard that REJECTED
/// the move (mirroring the local command path) leaves C1A live under P1 on
/// device A and trashed under P2 on device B, and the pre-#4112 unguarded apply
/// leaves it LIVE under a tombstone on device A. Both redden here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_under_tombstoned_parent_converges_across_replay_orders_4112() {
    // Device A owns the op log; both devices replay ITS records, which is what
    // makes this one op SET rather than two similar ones.
    let (_dir_a, pool_a, state_a) = seed_engine_world("converge_delete_first.db").await;
    let (_dir_b, pool_b, state_b) = seed_engine_world("converge_move_first.db").await;

    let del = append_delete(&pool_a, P2_ID).await;
    let mv = append_move(&pool_a, C1A_ID, P2_ID, MOVE_INDEX).await;

    // Device A: delete lands first — the move must sweep.
    replay(&pool_a, &state_a, &del).await;
    replay(&pool_a, &state_a, &mv).await;

    // Device B: move lands first — the delete's own cascade does the work.
    replay(&pool_b, &state_b, &mv).await;
    replay(&pool_b, &state_b, &del).await;

    for id in [C1A_ID, G1A_ID, C1B_ID, C2A_ID, C2B_ID, P1_ID, P2_ID] {
        let a = shape_of(&pool_a, id).await;
        let b = shape_of(&pool_b, id).await;
        assert_eq!(
            a, b,
            "#4112: block {id} diverges between replay orders — \
             delete-first={a:?} move-first={b:?}"
        );
    }

    // Non-vacuity: pin the CONVERGED value, so the equality above cannot pass
    // by both devices doing nothing.
    let p2 = shape_of(&pool_a, P2_ID).await;
    let c1a = shape_of(&pool_a, C1A_ID).await;
    assert_eq!(
        c1a,
        (Some(P2_ID.to_string()), p2.1),
        "#4112: the converged answer is `moved AND trashed in P2's cohort`; \
         got {c1a:?} against P2 {p2:?}"
    );
    assert!(
        p2.1.is_some(),
        "precondition: P2 is tombstoned on both devices; got {p2:?}"
    );
}

/// #4112, the half of the local guard that must NOT be mirrored: a replayed
/// `MoveBlock` whose SUBJECT is already tombstoned is APPLIED, not dropped.
///
/// `validate_move_in_tx` refuses it too, but as a UI affordance — do not let a
/// user drag a trashed block — not as a state invariant: a tombstoned block
/// under a LIVE parent is exactly what `delete_block` produces, and it is the
/// shape R9's own resurrection-guard arm preserves. Applying it is also what
/// CONVERGES, which this test pins the same way as the sibling above: the two
/// replay orders of `{Delete(C1A), Move(C1A → P2)}` must agree, and they only
/// do if the move is applied on the tombstoned subject.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn move_of_a_tombstoned_block_is_applied_not_dropped_4112() {
    let (_dir_a, pool_a, state_a) = seed_engine_world("subject_delete_first.db").await;
    let (_dir_b, pool_b, state_b) = seed_engine_world("subject_move_first.db").await;

    let del = append_delete(&pool_a, C1A_ID).await;
    let mv = append_move(&pool_a, C1A_ID, P2_ID, MOVE_INDEX).await;

    // Device A: the subject is a tombstone by the time the move replays.
    replay(&pool_a, &state_a, &del).await;
    replay(&pool_a, &state_a, &mv).await;

    // Device B: the move lands first, then the block is deleted where it now is.
    replay(&pool_b, &state_b, &mv).await;
    replay(&pool_b, &state_b, &del).await;

    for id in [C1A_ID, G1A_ID, C1B_ID, P1_ID, P2_ID] {
        let a = shape_of(&pool_a, id).await;
        let b = shape_of(&pool_b, id).await;
        assert_eq!(
            a, b,
            "#4112: block {id} diverges between replay orders on the \
             tombstoned-SUBJECT arm — delete-first={a:?} move-first={b:?}"
        );
    }

    let c1a = shape_of(&pool_a, C1A_ID).await;
    assert_eq!(
        c1a.0.as_deref(),
        Some(P2_ID),
        "#4112: a tombstoned subject's move must still be APPLIED (dropping it \
         is the divergence); got {c1a:?}"
    );
    assert!(
        c1a.1.is_some(),
        "#4112: and the block stays trashed — the move must not resurrect it; \
         got {c1a:?}"
    );
    assert_eq!(
        shape_of(&pool_a, P2_ID).await.1,
        None,
        "precondition: the target parent P2 is LIVE on this arm, so nothing may \
         be swept"
    );
}

// ---------------------------------------------------------------------------
// #4112 review — the orderings and shapes the original three tests did not
// cover. Each of these was derived independently of the sweep implementation
// and asserts a property the design claims rather than a value it happens to
// produce.
// ---------------------------------------------------------------------------

/// The INNER tombstone's cohort in `sweep_takes_the_nearest_tombstoned_ancestor_4112`
/// (an older trash cohort that a later, higher delete's cascade skips because
/// its rows are already stamped).
const TS_INNER_COHORT: i64 = 1_600_000_000_000;
/// The OUTER tombstone's cohort — a DIFFERENT timestamp on an ancestor further
/// up, so "nearest" and "topmost" give different answers.
const TS_OUTER_COHORT: i64 = 1_700_000_000_000;

/// Append a `RestoreBlock` op WITHOUT applying it. Companion to
/// [`append_delete`]; `deleted_at_ref` is the delete op's `created_at`, which
/// is the cohort key `RestoreBlock` matches descendants on.
async fn append_restore(
    pool: &SqlitePool,
    block_id: &str,
    deleted_at_ref: i64,
) -> agaric_store::op_log::OpRecord {
    agaric_store::op_log::append_local_op(
        pool,
        DEVICE_ID,
        OpPayload::RestoreBlock(agaric_store::op::RestoreBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            deleted_at_ref,
        }),
    )
    .await
    .expect("append restore")
}

/// The `(parent_id, deleted_at)` shape of every block the #4112 fixtures touch.
async fn world_shape(pool: &SqlitePool) -> Vec<(&'static str, (Option<String>, Option<i64>))> {
    let mut out = Vec::new();
    for id in [
        PAGE_ID, P1_ID, P2_ID, C1A_ID, C1B_ID, G1A_ID, C2A_ID, C2B_ID,
    ] {
        out.push((id, shape_of(pool, id).await));
    }
    out
}

/// #4112 — the load-bearing consequence of stamping the ANCESTOR's `deleted_at`
/// rather than `now`: the swept subtree restores as ONE cohort with the
/// ancestor.
///
/// `RestoreBlock` keys its cohort structurally *and* by value
/// (`descendants_cte_cohort!`: descend only into a child whose `deleted_at`
/// equals the seed's `deleted_at_ref`). A sweep that stamped `now` would put
/// the moved subtree in a cohort of its own, so restoring the tombstoned target
/// parent would bring back the parent and its original children while leaving
/// the moved-in subtree trashed under a LIVE parent — a state the delete-last
/// replay order never produces. This test replays `{Delete(P2),
/// Move(C1A → P2), Restore(P2)}` in both delete/move orders and demands the
/// same end state, which is only reachable if the two devices agree on the
/// cohort timestamp.
///
/// Changing `sweep_move_under_tombstoned_ancestor`'s
/// `project_delete_block_to_sql(.., ancestor_ts)` to any other timestamp
/// reddens this.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn swept_subtree_restores_with_the_ancestor_cohort_4112() {
    let (_dir_a, pool_a, state_a) = seed_engine_world("restore_after_sweep_a.db").await;
    let (_dir_b, pool_b, state_b) = seed_engine_world("restore_after_sweep_b.db").await;

    // One op SET, appended once, replayed by both devices.
    let del = append_delete(&pool_a, P2_ID).await;
    let mv = append_move(&pool_a, C1A_ID, P2_ID, MOVE_INDEX).await;
    let restore = append_restore(&pool_a, P2_ID, del.created_at).await;

    // Device A: the delete lands first, so the MOVE has to sweep.
    replay(&pool_a, &state_a, &del).await;
    replay(&pool_a, &state_a, &mv).await;

    // Device B: the move lands first, so the DELETE's own cascade stamps C1A.
    replay(&pool_b, &state_b, &mv).await;
    replay(&pool_b, &state_b, &del).await;

    // Converged BEFORE the restore. Asserted separately because a restore of
    // the whole cohort is precisely the operation that can wash the difference
    // out: with no sweep at all, device A leaves C1A live and device B trashes
    // it, and restoring P2 makes both fully live again. The restore assertion
    // below therefore pins the cohort TIMESTAMP; this one pins that there was
    // a cohort to share in the first place.
    assert_eq!(
        world_shape(&pool_a).await,
        world_shape(&pool_b).await,
        "#4112: the two replay orders must already agree before the restore"
    );

    replay(&pool_a, &state_a, &restore).await;
    replay(&pool_b, &state_b, &restore).await;

    assert_eq!(
        world_shape(&pool_a).await,
        world_shape(&pool_b).await,
        "#4112: a restore after a sweep must land on the same state as a \
         restore after the equivalent delete cascade"
    );

    // Non-vacuity: the restore actually brought the swept pair BACK — the
    // whole point of sharing the ancestor's cohort timestamp.
    for id in [P2_ID, C1A_ID, G1A_ID] {
        assert_eq!(
            shape_of(&pool_a, id).await.1,
            None,
            "#4112: {id} must be restored as part of P2's cohort (the sweep \
             stamped the ancestor's `deleted_at`, not `now`)"
        );
    }
    assert_eq!(
        shape_of(&pool_a, C1A_ID).await.0.as_deref(),
        Some(P2_ID),
        "#4112: the restored block stays where the peer's move put it"
    );
}

/// #4112 — THREE concurrent ops, all six replay orders. The two-op test proves
/// the sweep converges when the delete is the only tombstone source; this one
/// adds a SECOND move that lands under the block the first move just got swept
/// into, so a device can have to sweep a block whose tombstoned ancestor was
/// itself created by an earlier sweep rather than by a delete cascade.
///
/// `{Delete(P2), Move(C1A → P2), Move(C1B → C1A)}` — six worlds, six orders,
/// one required end state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_and_two_moves_converge_across_all_six_orders_4112() {
    // World 0 doubles as the op-log owner; every world replays ITS records, so
    // the delete carries one `created_at` (hence one cohort ts) throughout.
    let mut worlds = Vec::new();
    for n in 0..6u8 {
        worlds.push(seed_engine_world(&format!("three_op_{n}.db")).await);
    }
    let records = [
        append_delete(&worlds[0].1, P2_ID).await,
        append_move(&worlds[0].1, C1A_ID, P2_ID, MOVE_INDEX).await,
        append_move(&worlds[0].1, C1B_ID, C1A_ID, 0).await,
    ];

    const ORDERS: [[usize; 3]; 6] = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ];
    let mut shapes = Vec::new();
    for (order, (_dir, pool, state)) in ORDERS.iter().zip(worlds.iter()) {
        for &i in order {
            replay(pool, state, &records[i]).await;
        }
        shapes.push(world_shape(pool).await);
    }

    for (order, shape) in ORDERS.iter().zip(shapes.iter()).skip(1) {
        assert_eq!(
            &shapes[0], shape,
            "#4112: replay order {order:?} diverges from {:?}",
            ORDERS[0]
        );
    }

    // Non-vacuity: pin the converged answer rather than letting six identical
    // no-ops satisfy the equality above.
    let (_dir, pool, _state) = &worlds[0];
    let p2 = shape_of(pool, P2_ID).await;
    assert!(p2.1.is_some(), "precondition: P2 is tombstoned");
    for (id, parent) in [(C1A_ID, P2_ID), (C1B_ID, C1A_ID), (G1A_ID, C1A_ID)] {
        let s = shape_of(pool, id).await;
        assert_eq!(
            s,
            (Some(parent.to_string()), p2.1),
            "#4112: {id} must end under {parent}, trashed in P2's cohort"
        );
    }
}

/// #4112 — replaying the SAME `MoveBlock` record twice must be a no-op the
/// second time. The sweep's own guard is `deleted_at IS NULL` on the subject,
/// so the second pass takes the `None` (healthy) branch and hands the block to
/// `recompute_subtree_inheritance` instead; this pins that the observable
/// `(parent_id, deleted_at)` state does not move — in particular that the
/// second pass does not re-stamp the cohort at a fresh timestamp, which would
/// split the block out of the ancestor's restore cohort.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replayed_move_into_a_tombstone_is_idempotent_4112() {
    let (_dir, pool, state) = seed_engine_world("idempotent_sweep.db").await;

    let del = append_delete(&pool, P2_ID).await;
    let mv = append_move(&pool, C1A_ID, P2_ID, MOVE_INDEX).await;
    replay(&pool, &state, &del).await;
    replay(&pool, &state, &mv).await;
    let after_first = world_shape(&pool).await;

    replay(&pool, &state, &mv).await;
    assert_eq!(
        after_first,
        world_shape(&pool).await,
        "#4112: re-applying the same MoveBlock record must not change the \
         swept state (a second sweep at a fresh timestamp would strand the \
         block outside its ancestor's restore cohort)"
    );
    // Precondition, so the equality above is not comparing two healthy worlds.
    let p2 = shape_of(&pool, P2_ID).await;
    assert_eq!(
        shape_of(&pool, C1A_ID).await,
        (Some(P2_ID.to_string()), p2.1),
        "precondition: the first replay swept C1A into P2's cohort"
    );
}

/// #4112 — with NESTED tombstoned ancestors carrying DIFFERENT cohort
/// timestamps, the sweep must take the NEAREST one.
///
/// The state is ordinary: trash `C1A`'s subtree, then trash `P1`. `P1`'s
/// cascade only stamps rows that are still `deleted_at IS NULL`, so `C1A` keeps
/// its own, older cohort. A block moved under `C1A` therefore has two
/// tombstoned ancestors with two different stamps, and only the nearest one
/// keeps it restorable with the subtree it now lives in — `RestoreBlock(C1A)`
/// matches descendants on `C1A`'s `deleted_at`, so inheriting `P1`'s stamp
/// would leave the moved-in block trashed under a restored parent.
///
/// Reddens if `sweep_move_under_tombstoned_ancestor` climbs to the topmost
/// tombstoned ancestor, or stamps `now`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sweep_takes_the_nearest_tombstoned_ancestor_4112() {
    let (_dir, pool, state) = seed_engine_world("nested_tombstones.db").await;

    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id IN (?, ?)")
        .bind(TS_INNER_COHORT)
        .bind(C1A_ID)
        .bind(G1A_ID)
        .execute(&pool)
        .await
        .expect("stamp the inner cohort");
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id IN (?, ?)")
        .bind(TS_OUTER_COHORT)
        .bind(P1_ID)
        .bind(C1B_ID)
        .execute(&pool)
        .await
        .expect("stamp the outer cohort");

    let mv = append_move(&pool, C2A_ID, C1A_ID, 0).await;
    replay(&pool, &state, &mv).await;

    let c2a = shape_of(&pool, C2A_ID).await;
    assert_eq!(
        c2a.0.as_deref(),
        Some(C1A_ID),
        "#4112: the peer's move is applied, not dropped; got {c2a:?}"
    );
    assert_eq!(
        c2a.1,
        Some(TS_INNER_COHORT),
        "#4112: the sweep must inherit the NEAREST tombstoned ancestor's \
         cohort ({TS_INNER_COHORT}), not the outer P1 cohort \
         ({TS_OUTER_COHORT}) and not `now`; got {c2a:?}"
    );

    // And the cohort is genuinely coherent: restoring C1A brings the moved-in
    // block back with it.
    let restore = append_restore(&pool, C1A_ID, TS_INNER_COHORT).await;
    replay(&pool, &state, &restore).await;
    assert_eq!(
        shape_of(&pool, C2A_ID).await,
        (Some(C1A_ID.to_string()), None),
        "#4112: the swept block restores as part of the nearest ancestor's cohort"
    );
}

/// Tag id for the inherited-tag convergence fixture below.
const TAG_ID_4112: &str = "01HZ0000000000000000MVTAG1";

/// Give `P1` a direct tag so `C1A` / `G1A` inherit it, and seed the cache from
/// the arbiter (`rebuild_all`) so the fixture starts converged.
async fn seed_inherited_tag(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'tag', 'mv-tag', NULL, 0)",
    )
    .bind(TAG_ID_4112)
    .execute(pool)
    .await
    .expect("insert tag block");
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(P1_ID)
        .bind(TAG_ID_4112)
        .execute(pool)
        .await
        .expect("tag P1");
    agaric_store::tag_inheritance::rebuild_all(pool)
        .await
        .expect("seed the inherited cache from the arbiter");
}

/// Every `(block_id, tag_id, inherited_from)` row, ordered — the tag-cache
/// state the two replay orders must agree on.
async fn inherited_rows(pool: &SqlitePool) -> Vec<(String, String, String)> {
    sqlx::query_as::<_, (String, String, String)>(
        "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
         ORDER BY block_id, tag_id, inherited_from",
    )
    .fetch_all(pool)
    .await
    .expect("inherited_rows")
}

/// #4112 — the sweep replaces the move's `recompute_subtree_inheritance` with
/// `remove_subtree_inherited`, so the TAG CACHE has to converge too, and has to
/// agree with `rebuild_all` (the arbiter the whole #3919/#3926/#3944/#4121
/// family is measured against).
///
/// `P1[#T] > C1A > G1A`, so `C1A` and `G1A` start out inheriting `T`. Both
/// replay orders of `{Delete(P2), Move(C1A → P2)}` end with that subtree
/// tombstoned, and the arbiter emits nothing for a tombstoned block — so both
/// devices must end with the same (tag-free) cache, and a fresh `rebuild_all`
/// must not change it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sweep_converges_the_inherited_tag_cache_with_the_arbiter_4112() {
    let (_dir_a, pool_a, state_a) = seed_engine_world("tag_sweep_a.db").await;
    let (_dir_b, pool_b, state_b) = seed_engine_world("tag_sweep_b.db").await;
    seed_inherited_tag(&pool_a).await;
    seed_inherited_tag(&pool_b).await;

    // Precondition: the fixture really does have inherited rows to lose.
    assert!(
        inherited_rows(&pool_a)
            .await
            .iter()
            .any(|(b, _, from)| b == C1A_ID && from == P1_ID),
        "precondition: C1A inherits the tag from P1 before the ops replay"
    );

    let del = append_delete(&pool_a, P2_ID).await;
    let mv = append_move(&pool_a, C1A_ID, P2_ID, MOVE_INDEX).await;

    replay(&pool_a, &state_a, &del).await;
    replay(&pool_a, &state_a, &mv).await;

    replay(&pool_b, &state_b, &mv).await;
    replay(&pool_b, &state_b, &del).await;

    let incremental_a = inherited_rows(&pool_a).await;
    assert_eq!(
        incremental_a,
        inherited_rows(&pool_b).await,
        "#4112: the inherited-tag cache diverges between the replay orders"
    );

    // The arbiter's answer, on each device. `rebuild_all` refuses to emit a row
    // for a tombstoned block, so the sweep's `remove_subtree_inherited` wipe is
    // exactly right — and any row the sweep FAILED to wipe shows up here.
    for (name, pool) in [("delete-first", &pool_a), ("move-first", &pool_b)] {
        let before = inherited_rows(pool).await;
        agaric_store::tag_inheritance::rebuild_all(pool)
            .await
            .expect("rebuild_all");
        assert_eq!(
            before,
            inherited_rows(pool).await,
            "#4112: the {name} order's incremental tag cache disagrees with \
             `rebuild_all`"
        );
    }
}

/// Tag id for the `tags_cache.usage_count` fixture below.
const TAG_ID_4200: &str = "01HZ0000000000000000MVTAG2";

/// `tags_cache.usage_count` for one tag, or `None` when the tag has no cache
/// row.
async fn cached_usage_count(pool: &SqlitePool, tag_id: &str) -> Option<i64> {
    sqlx::query_scalar::<_, i64>("SELECT usage_count FROM tags_cache WHERE tag_id = ?")
        .bind(tag_id)
        .fetch_optional(pool)
        .await
        .expect("tags_cache read-back")
}

/// #4200 — a tagged block that the #4112 sweep turns into a TOMBSTONE must not
/// leave `tags_cache.usage_count` over-counting.
///
/// `DESIRED_TAGS_SQL` (`agaric-store/src/cache/tags.rs`) derives `usage_count`
/// through `JOIN blocks blk … WHERE blk.deleted_at IS NULL` on both the
/// `block_tags` and the `block_tag_refs` half, so a holder the sweep tombstones
/// stops counting. The `DeleteBlock` arm of
/// `materializer::dispatch::invalidations_for_op` carries `RebuildTagsCache`
/// for exactly that reason; before #4200 the `MoveBlock` arm did not, and
/// #4112 made a move able to tombstone a subtree. The affected tags then
/// over-counted until an unrelated lifecycle/tag op or a full rebuild healed
/// them.
///
/// The driver runs PRODUCTION's own fan-out table for the move record — every
/// task `invalidations_for_op` returns, through the real background handler —
/// rather than a hand-picked task list, so a task the table forgets is a task
/// this test does not run. Dropping the `RebuildTagsCache` push from the
/// `MoveBlock` arm therefore leaves the stale count in place and reddens the
/// final assertion.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sweep_does_not_leave_the_tags_cache_over_counting_4200() {
    let (_dir, pool, state) = seed_engine_world("tags_cache_sweep.db").await;

    // A live tag, held DIRECTLY by two blocks that the sweep will tombstone
    // together (C1A is the move subject, G1A its child — the sweep stamps the
    // whole cohort, so both leave the count).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'tag', 'sweep-count-tag', NULL, 0)",
    )
    .bind(TAG_ID_4200)
    .execute(&pool)
    .await
    .expect("insert tag block");
    for holder in [C1A_ID, G1A_ID] {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(holder)
            .bind(TAG_ID_4200)
            .execute(&pool)
            .await
            .expect("tag a soon-to-be-swept block");
    }
    agaric_store::cache::rebuild_tags_cache(&pool)
        .await
        .expect("seed tags_cache from the arbiter");
    assert_eq!(
        cached_usage_count(&pool, TAG_ID_4200).await,
        Some(2),
        "fixture precondition: both live holders must be counted before the sweep"
    );

    // The #4112 shape: delete the target parent, then replay the peer's move
    // INTO it. The move is applied, and the sweep stamps C1A + G1A with P2's
    // cohort timestamp.
    let del = append_delete(&pool, P2_ID).await;
    replay(&pool, &state, &del).await;
    let mv = append_move(&pool, C1A_ID, P2_ID, MOVE_INDEX).await;
    replay(&pool, &state, &mv).await;
    assert!(
        shape_of(&pool, C1A_ID).await.1.is_some() && shape_of(&pool, G1A_ID).await.1.is_some(),
        "fixture precondition: the sweep must actually have fired (both holders \
         tombstoned)"
    );

    // Nothing in the apply tx repairs the count — the cache is genuinely stale
    // at commit, which is why the invalidation matrix has to carry the repair.
    assert_eq!(
        cached_usage_count(&pool, TAG_ID_4200).await,
        Some(2),
        "the sweep does not (and should not) write tags_cache in-tx; the repair \
         belongs to the background fan-out"
    );

    // Production's fan-out for this exact op record. `None` for both hints is
    // the remote-replay / inbound-sync / boot path — the one that actually
    // replays a peer's move.
    for task in
        crate::materializer::invalidations_for_op(&mv, None, None).expect("invalidations_for_op")
    {
        handle_background_task(&pool, &task, None, None)
            .await
            .unwrap_or_else(|e| panic!("background task {task:?} failed: {e}"));
    }

    assert_eq!(
        cached_usage_count(&pool, TAG_ID_4200).await,
        Some(0),
        "#4200: after the sweep tombstoned both holders, the move's own \
         invalidation fan-out must bring tags_cache.usage_count back to the \
         live-holder count; a stale 2 means the MoveBlock arm never enqueued \
         RebuildTagsCache"
    );
}
