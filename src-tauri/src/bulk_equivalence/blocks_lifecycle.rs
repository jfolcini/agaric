//! #3346 — batch-vs-fold equivalence for the GENUINELY FORKED block
//! lifecycle bulk paths.
//!
//! * [`delete_blocks_by_ids_inner`] vs a loop of [`delete_block_inner`]
//! * [`restore_blocks_by_ids_inner`] vs a loop of [`restore_block_inner`]
//! * [`purge_blocks_by_ids_inner`] vs a loop of [`purge_block_inner`]
//!
//! The delete and restore bulk paths capture a per-root cohort and stamp the
//! UNION in one `write_cohort_deleted_at_json` call, instead of routing each
//! root through the single-entry-point apply projection the way the single-row
//! paths do. For delete that fork is a documented, permanent exception
//! (#2325/#2250 — fanning out into N `apply_op_projected` calls would lose the
//! single-pass combined cascade). For restore the SAME fork exists with no such
//! comment; see `restore_blocks_by_ids_omits_the_1884_ancestor_chain_restore`
//! and `restore_blocks_by_ids_skips_a_live_block_the_single_path_refuses` for
//! what that costs.
//!
//! Three tests at the end of this file are NOT oracle scenarios: the
//! #3834/#3856 trio asserts an ABSOLUTE invariant (the per-space Loro engine
//! agrees with SQL about the whole restored subtree — ancestor chain, seed and
//! descendant cohort — after a local restore) rather than arm equality. On
//! #3834 batch and fold were equally wrong, so `batch ≡ fold` held while both
//! diverged from the CRDT; on #3856 they were UNEQUALLY wrong (the fold left
//! the seed and its cohort tombstoned where the batch did not) and `batch ≡
//! fold` STILL held, because the divergence lives in the LoroDoc and this
//! harness snapshots SQL + op_log. They live here for the fixture, which is the
//! one that seeds every block into the engine.
//!
//! Purge is a THIRD fork, and a less obvious one. Its satellite-table DELETE
//! chain really is converged — all three purge variants call the one
//! `block_cleanup::purge_subtree_tables` helper. But the MEMBER SET that chain
//! is pointed at is not: `purge_block_inner` passes
//! `agaric_store::descendants_cte_purge!()` (`WHERE id = ?`), while
//! `purge_blocks_by_ids_inner` passes a hand-written multi-root copy of that
//! CTE seeded from `json_each(?1)`, plus a batch-only `MAX(depth) >= 99`
//! saturation guard. A shared cascade aimed at two independently-written member
//! sets is exactly the fork shape #3280 was, so it gets an oracle rather than a
//! `converged` note — see `purge_blocks_by_ids_matches_per_block_fold`, and
//! `purge_blocks_by_ids_purges_a_live_block_the_single_path_refuses` for what
//! the first run of that oracle turned up.

use std::sync::Arc;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_engine::loro::shared::LoroState;
use agaric_store::space::SpaceId;
use sqlx::SqlitePool;

use super::{ARM_DEVICE, ArmEnv, Normalisation, assert_batch_equals_fold};
use crate::commands::blocks::crud::{
    delete_block_inner, delete_blocks_by_ids_inner, purge_block_inner, purge_blocks_by_ids_inner,
    restore_block_inner, restore_blocks_by_ids_inner,
};

// ---------------------------------------------------------------------------
// Fixture ids
// ---------------------------------------------------------------------------

/// Expand a short label into a 26-char `[0-9A-Z]` id (the ULID shape the
/// `BlockId` contract and the `[[link]]` tokeniser expect), by left-padding
/// with `'0'`. Same trick the conformance runner uses for its seed labels.
fn id(label: &str) -> String {
    format!("{label:0>26}")
}

const SPACE: &str = "SPACE";
const PAGE: &str = "PAGE";
/// Roots handed to the bulk call. `R1` is a 3-level subtree, `R2` a 2-level
/// one — different depths so a cascade that truncates at one depth is visible.
const R1: &str = "R1";
const R1C1: &str = "R1C1";
const R1C1G1: &str = "R1C1G1";
const R1C2: &str = "R1C2";
const R2: &str = "R2";
const R2C1: &str = "R2C1";
/// Never named in any call — a CONTROL. If the bulk path over-reaches (a
/// cascade seeded too broadly), this row moves and the oracle says so.
const R3: &str = "R3";

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/// Register the test space (`blocks` row + `spaces` registry row).
///
/// The space block carries `space_id = NULL` — membership is itself, and a
/// self-referencing `space_id` would violate the FK at insert time. The
/// `blocks` row must precede the `spaces` row (`spaces.id REFERENCES
/// blocks(id)`).
async fn seed_space_row(pool: &SqlitePool) {
    let space = id(SPACE);
    // dynamic-sql: test-only oracle fixture seed (not a production query path)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'TestSpace', NULL, 1, ?)",
    )
    .bind(&space)
    .bind(&space)
    .execute(pool)
    .await
    .expect("seed space block");
    // dynamic-sql: test-only oracle fixture seed (not a production query path)
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(&space)
        .execute(pool)
        .await
        .expect("register space");
}

/// Insert one block into BOTH SQL and the arm's per-space Loro engine.
///
/// Seeding the engine is load-bearing, not decoration: `apply_delete_block`
/// and `apply_restore_block` route through the engine only when the target
/// block EXISTS in the resolved space's tree. A SQL-only fixture would make
/// every op record an `EngineMissingTarget` fallback, and the harness's
/// zero-fallback guard would (correctly) fail the scenario as false-green.
async fn seed_block(
    pool: &SqlitePool,
    state: &LoroState,
    label: &str,
    block_type: &str,
    parent: Option<&str>,
    position: i64,
) {
    let block_id = id(label);
    let parent_id = parent.map(id);
    let space = SpaceId::from_trusted(&id(SPACE));
    {
        let mut guard = state
            .registry
            .for_space(&space, ARM_DEVICE)
            .expect("for_space (fixture seed)");
        guard
            .engine_mut()
            .apply_create_block(&block_id, block_type, label, parent_id.as_deref(), position)
            .expect("seed block into engine");
    }
    // `page_id` points at PAGE for every content block (PAGE itself pages to
    // itself) and `space_id` at SPACE, so `resolve_block_space` succeeds
    // in-line without waiting on the deferred `SetBlockPageId` background task.
    let page_id = if block_type == "page" {
        block_id.clone()
    } else {
        id(PAGE)
    };
    let space_id = id(SPACE);
    // dynamic-sql: test-only oracle fixture seed (not a production query path)
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&block_id)
    .bind(block_type)
    .bind(label)
    .bind(&parent_id)
    .bind(position)
    .bind(&page_id)
    .bind(&space_id)
    .execute(pool)
    .await
    .expect("seed block row");
}

/// The shared tree both arms start from:
///
/// ```text
/// PAGE
///  ├─ R1 ─ R1C1 ─ R1C1G1
///  │    └─ R1C2
///  ├─ R2 ─ R2C1
///  └─ R3                (control — never named in any call)
/// ```
async fn seed_tree(env: Arc<ArmEnv>) {
    let state = env.materializer.loro_state();
    seed_space_row(&env.pool).await;
    seed_block(&env.pool, state, PAGE, "page", None, 1).await;
    seed_block(&env.pool, state, R1, "content", Some(PAGE), 1).await;
    seed_block(&env.pool, state, R1C1, "content", Some(R1), 1).await;
    seed_block(&env.pool, state, R1C1G1, "content", Some(R1C1), 1).await;
    seed_block(&env.pool, state, R1C2, "content", Some(R1), 2).await;
    seed_block(&env.pool, state, R2, "content", Some(PAGE), 2).await;
    seed_block(&env.pool, state, R2C1, "content", Some(R2), 1).await;
    seed_block(&env.pool, state, R3, "content", Some(PAGE), 3).await;
}

/// Read a block's current `deleted_at` (the `deleted_at_ref` the single-row
/// restore path demands as its optimistic-concurrency guard).
async fn deleted_at_of(pool: &SqlitePool, label: &str) -> i64 {
    // dynamic-sql: test-only oracle readback (not a production query path)
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(id(label))
        .fetch_one(pool)
        .await
        .expect("read deleted_at")
        .expect("block must be soft-deleted at this point")
}

/// Like [`deleted_at_of`], but tolerates a LIVE block instead of panicking.
///
/// Needed by the #3838 mixed-batch scenario: its fold arm feeds a LIVE id to
/// `restore_block_inner`, which demands a `deleted_at_ref` positionally but
/// checks "is this block deleted at all?" FIRST and refuses before the ref is
/// ever compared. `0` is therefore an honest stand-in — no live block can
/// carry it — and using it keeps the fold arm exercising the refusal rather
/// than the fixture's own `expect`.
async fn deleted_at_or_zero(pool: &SqlitePool, label: &str) -> i64 {
    // dynamic-sql: test-only oracle readback (not a production query path)
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(id(label))
        .fetch_one(pool)
        .await
        .expect("read deleted_at")
        .unwrap_or(0)
}

fn block_ids(labels: &[&str]) -> Vec<BlockId> {
    labels
        .iter()
        .map(|l| BlockId::from_trusted(&id(l)))
        .collect()
}

// ---------------------------------------------------------------------------
// Scenario 1 — delete
// ---------------------------------------------------------------------------

/// **Fork #1.** `delete_blocks_by_ids_inner([R1, R2])` must leave exactly the
/// state `delete_block_inner(R1); delete_block_inner(R2)` leaves.
///
/// The bulk path builds ONE combined cascade over the union of both roots'
/// pre-captured cohorts; the fold runs the shared `project_delete_block_to_sql`
/// projection twice. The #2325/#2250 comment says the two are equivalent —
/// this is the test that makes that claim falsifiable.
#[tokio::test]
async fn delete_blocks_by_ids_matches_per_block_fold() {
    let roots = [R1, R2];
    assert_batch_equals_fold(
        "delete_blocks_by_ids",
        &Normalisation::default(),
        |env| Box::pin(seed_tree(env)),
        move |env| {
            Box::pin(async move {
                let n = delete_blocks_by_ids_inner(
                    &env.pool,
                    ARM_DEVICE,
                    &env.materializer,
                    block_ids(&roots),
                )
                .await
                .expect("bulk delete");
                vec![format!("rows_soft_deleted={n}")]
            })
        },
        move |env| {
            Box::pin(async move {
                let mut total: u64 = 0;
                for root in roots {
                    total += delete_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(root)),
                    )
                    .await
                    .expect("single delete")
                    .descendants_affected;
                }
                // The bulk path returns the number of `blocks` rows whose
                // `deleted_at` flipped; the fold's per-call
                // `descendants_affected` counts the same rows (the cohort
                // INCLUDES the seed). Summing is the honest comparison, and it
                // is a real assertion: a bulk cascade that stopped short would
                // report a smaller total than the fold.
                vec![format!("rows_soft_deleted={total}")]
            })
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// Scenario 2 — restore
// ---------------------------------------------------------------------------

/// Seed the tree, then soft-delete R1 and R2 as two SEPARATE delete operations
/// (two distinct `next_delete_ms` cohorts) so the restore under test has to get
/// per-root cohort identity right rather than trivially clearing everything.
async fn seed_tree_with_two_delete_cohorts(env: Arc<ArmEnv>) {
    seed_tree(Arc::clone(&env)).await;
    for root in [R1, R2] {
        delete_block_inner(
            &env.pool,
            ARM_DEVICE,
            &env.materializer,
            BlockId::from_trusted(&id(root)),
        )
        .await
        .expect("fixture soft-delete");
    }
    env.settle().await;
}

/// **Fork #2.** `restore_blocks_by_ids_inner([R1, R2])` vs
/// `restore_block_inner(R1, ref1); restore_block_inner(R2, ref2)`.
///
/// Unlike delete's fork, this one carries no documented exception. The two
/// roots were trashed in two DIFFERENT delete operations, so each carries its
/// own `deleted_at` cohort id — a bulk path that keyed the restore on the
/// wrong root's timestamp, or that cleared the union unconditionally where the
/// single path clears `WHERE deleted_at = ref`, diverges here.
#[tokio::test]
async fn restore_blocks_by_ids_matches_per_block_fold() {
    let roots = [R1, R2];
    assert_batch_equals_fold(
        "restore_blocks_by_ids",
        &Normalisation::default(),
        |env| Box::pin(seed_tree_with_two_delete_cohorts(env)),
        move |env| {
            Box::pin(async move {
                let resp = restore_blocks_by_ids_inner(
                    &env.pool,
                    ARM_DEVICE,
                    &env.materializer,
                    block_ids(&roots),
                )
                .await
                .expect("bulk restore");
                vec![format!("rows_restored={}", resp.affected_count)]
            })
        },
        move |env| {
            Box::pin(async move {
                let mut total: u64 = 0;
                for root in roots {
                    let deleted_at_ref = deleted_at_of(&env.pool, root).await;
                    total += restore_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(root)),
                        deleted_at_ref,
                    )
                    .await
                    .expect("single restore")
                    .restored_count;
                }
                vec![format!("rows_restored={total}")]
            })
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// Scenario 3 — purge
// ---------------------------------------------------------------------------

/// Render a purge outcome into the compared surface.
///
/// Both purge paths can legitimately REFUSE (a live root, a subtree past the
/// depth cap), and a refusal on one arm against a success on the other is the
/// most interesting divergence there is — so the arms must not `expect()` the
/// happy path away. Only the error KIND is rendered, never the message: the
/// batch path deliberately cannot name the offending root ("we can't cheaply
/// name it without re-walking"), so comparing message text would report a
/// wording difference as a divergence and drown the real signal.
fn purge_outcome(count: Result<u64, AppError>) -> String {
    match count {
        Ok(n) => format!("rows_purged={n}"),
        Err(e) => format!("rows_purged=ERR({:?})", e.kind()),
    }
}

/// **Fork #3.** `purge_blocks_by_ids_inner([R1, R2])` must leave exactly the
/// state `purge_block_inner(R1); purge_block_inner(R2)` leaves.
///
/// The satellite-table DELETE chain is genuinely shared
/// (`block_cleanup::purge_subtree_tables`, one body across all three purge
/// variants) — but the MEMBER SET handed to that chain is not. The single path
/// passes `agaric_store::descendants_cte_purge!()` (`WHERE id = ?`); the batch
/// path passes an inline hand-written copy seeded from `json_each(?1)`. Two
/// independently-written recursive CTEs feeding one cascade is a fork whether or
/// not the cascade itself is shared, and this is the test that makes their
/// agreement falsifiable.
///
/// The two roots are trashed in two SEPARATE delete operations, so the fixture
/// does not accidentally reward a batch path that assumed one cohort.
#[tokio::test]
async fn purge_blocks_by_ids_matches_per_block_fold() {
    let roots = [R1, R2];
    assert_batch_equals_fold(
        "purge_blocks_by_ids",
        &Normalisation::default(),
        |env| Box::pin(seed_tree_with_two_delete_cohorts(env)),
        move |env| {
            Box::pin(async move {
                vec![purge_outcome(
                    purge_blocks_by_ids_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        block_ids(&roots),
                    )
                    .await
                    .map(|r| r.affected_count),
                )]
            })
        },
        move |env| {
            Box::pin(async move {
                let mut total: u64 = 0;
                for root in roots {
                    match purge_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(root)),
                    )
                    .await
                    {
                        Ok(r) => total += r.purged_count,
                        Err(e) => return vec![purge_outcome(Err(e))],
                    }
                }
                vec![purge_outcome(Ok(total))]
            })
        },
    )
    .await;
}

/// Root of the pathological chain used by the depth-cap scenario below.
const DEEP: &str = "DEEP";
/// Chain length under [`DEEP`]. The recursive arm is bounded by
/// `d.depth < 100`, so a 105-link chain saturates it with room to spare —
/// same shape `block_descendants::cascade_depth_saturated_fires_on_pathological_chain`
/// uses.
const DEEP_CHAIN: usize = 105;

/// Seed the ordinary tree plus a `DEEP_CHAIN`-deep chain, then soft-delete the
/// chain's root so it is purgeable.
async fn seed_tree_with_a_saturating_chain(env: Arc<ArmEnv>) {
    seed_tree(Arc::clone(&env)).await;
    let state = env.materializer.loro_state();
    seed_block(&env.pool, state, DEEP, "content", Some(PAGE), 4).await;
    let mut parent = DEEP.to_owned();
    for i in 1..=DEEP_CHAIN {
        let label = format!("D{i}");
        seed_block(
            &env.pool,
            state,
            &label,
            "content",
            Some(parent.as_str()),
            1,
        )
        .await;
        parent = label;
    }
    delete_block_inner(
        &env.pool,
        ARM_DEVICE,
        &env.materializer,
        BlockId::from_trusted(&id(DEEP)),
    )
    .await
    .expect("fixture soft-delete of the deep chain");
    env.settle().await;
}

/// The batch-ONLY `MAX(depth) >= 99` saturation guard, compared against the
/// single path's per-root `cascade_depth_saturated` probe.
///
/// These are two different implementations of one rule: the single path
/// re-walks `descendants_cte_standard!()` under ONE root and tests
/// `MAX(depth) >= DESCENDANT_DEPTH_CAP - 1`; the batch path folds the probe into
/// its own multi-root `json_each` CTE and tests `MAX(depth) >= 99` over the
/// UNION. A hard delete has to be all-or-nothing — a saturating cascade leaves
/// rows below depth 100 dangling — so a batch path that lost the guard would
/// silently orphan them.
///
/// **This scenario does discriminate**, and it was checked by mutation rather
/// than assumed: neutering the batch guard's threshold (`>= 99` → `>= i64::MAX`)
/// turns it RED with
///
/// ```text
///   [output] row index 0 column `<returned value>`
///       batch = rows_purged=ERR(Database)
///       fold  = rows_purged=ERR(Validation)
/// ```
///
/// The un-guarded batch does not silently orphan rows here — it gets as far as
/// the cascade and the deferred FK check kills the transaction, which is the
/// same dangling-descendant condition the guard exists to pre-empt, arriving as
/// an unactionable `Database` error instead of the actionable "purge in chunks"
/// one. Rendering the error KIND into the compared surface ([`purge_outcome`])
/// is what makes that visible; an arm that `expect()`ed its way to a count
/// would only have shown a panic.
///
/// What this does NOT pin is the guard's threshold in isolation. Both paths
/// test `>= 99` against a `depth < 100`-bounded walk, so a fixture seeded at
/// exactly the boundary would re-derive that arithmetic rather than test it,
/// and a batch guard mis-set to (say) `>= 98` would refuse a tree the single
/// path also refuses — equal outputs, green oracle. Off-by-one inside the
/// shared threshold is out of this scenario's reach; guard PRESENCE is not.
#[tokio::test]
async fn purge_blocks_by_ids_refuses_a_saturating_subtree_like_the_single_path() {
    let roots = [DEEP];
    assert_batch_equals_fold(
        "purge_blocks_by_ids/depth_cap",
        &Normalisation::default(),
        |env| Box::pin(seed_tree_with_a_saturating_chain(env)),
        move |env| {
            Box::pin(async move {
                vec![purge_outcome(
                    purge_blocks_by_ids_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        block_ids(&roots),
                    )
                    .await
                    .map(|r| r.affected_count),
                )]
            })
        },
        move |env| {
            Box::pin(async move {
                vec![purge_outcome(
                    purge_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(DEEP)),
                    )
                    .await
                    .map(|r| r.purged_count),
                )]
            })
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// What the purge oracle turned up
// ---------------------------------------------------------------------------

/// **#3819 — a FIXED divergence. This is now its regression guard.**
///
/// Before the fix, `purge_blocks_by_ids_inner` filtered its input to
/// actually-soft-deleted rows when it picked the ROOTS it appends
/// `PurgeBlock` ops for:
///
/// ```sql
/// SELECT b.id, b.block_type FROM blocks b
///  WHERE b.id IN (SELECT value FROM json_each(?1)) AND b.deleted_at IS NOT NULL
/// ```
///
/// …and then seeded the MEMBER-SET CTE it hands to the physical cascade from
/// the RAW input list instead, `SELECT id, 0 FROM blocks WHERE id IN (SELECT
/// value FROM json_each(?1))`, with no `deleted_at` predicate anywhere. A LIVE
/// block id in the input was therefore physically erased — it and its whole
/// subtree, out of every satellite table — while contributing NO `PurgeBlock`
/// op, no engine fan-out, and nothing to the returned count's provenance. The
/// doc comment's claim that "non-deleted or missing ids in the input are
/// silently dropped" held for the op log only; the cascade did not drop them.
///
/// `purge_block_inner` refuses the same id outright
/// (`AppError::InvalidOperation`, "must be soft-deleted before purging"), which
/// is what made this a batch-vs-fold divergence and not a product decision.
///
/// The consequence was unsynced local data loss: the rows gone from SQL, no
/// op describing their removal, so no peer ever learns of it and the next sync
/// re-materialises a tree the local device no longer has. The command is an IPC
/// entry point; "the TrashView only surfaces deleted rows" is a caller-side
/// convention, and a TrashView holding a selection while the block is restored
/// in another window (or by an inbound sync) hands it exactly this input.
///
/// **The fix, and why this scenario feeds the LIVE id FIRST.**
///
/// The batch path now REFUSES a live input id (`AppError::InvalidOperation`,
/// the same refusal `purge_block_inner` raises) instead of seeding its cascade
/// from the raw list. Seeding the cascade from the already-filtered root set
/// would have stopped the data loss too, but it could never make this oracle
/// green: the batch would then SKIP what the single path REFUSES, i.e. it
/// would trade a silent hard delete for a silent no-op and keep diverging from
/// the fold. Refusal is what makes the two agree.
///
/// The id ORDER is load-bearing and was changed with the fix. The batch is ONE
/// transaction: refusing rolls the whole call back. The fold is N transactions
/// and cannot roll back the ones that already committed — with the deleted id
/// first it purges R1's subtree, THEN refuses, so it ends in a state no atomic
/// batch can reproduce (verified: that ordering leaves 5 divergences, all of
/// them the fold's own partial commit, with both arms already agreeing on the
/// returned `ERR(InvalidOperation)`). Feeding the LIVE id first makes the
/// refusal precede any commit on BOTH arms, which is the comparison this
/// scenario is actually about. It loses no teeth: against the pre-fix code
/// this ordering diverges HARDER than the original (the batch purged all 5
/// rows and returned a count while the fold refused and purged nothing).
///
/// Run with: `cargo nextest run -E 'test(purge_blocks_by_ids_purges_a_live)'`
#[tokio::test]
async fn purge_blocks_by_ids_purges_a_live_block_the_single_path_refuses() {
    // R1 is soft-deleted by the seed; R3 is the untouched CONTROL block and is
    // still LIVE. Both are handed to the batch call, LIVE id first (see above).
    let inputs = [R3, R1];
    assert_batch_equals_fold(
        "purge_blocks_by_ids/live_input_id",
        &Normalisation::default(),
        |env| {
            Box::pin(async move {
                seed_tree(Arc::clone(&env)).await;
                delete_block_inner(
                    &env.pool,
                    ARM_DEVICE,
                    &env.materializer,
                    BlockId::from_trusted(&id(R1)),
                )
                .await
                .expect("fixture soft-delete");
                env.settle().await;
            })
        },
        move |env| {
            Box::pin(async move {
                vec![purge_outcome(
                    purge_blocks_by_ids_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        block_ids(&inputs),
                    )
                    .await
                    .map(|r| r.affected_count),
                )]
            })
        },
        move |env| {
            Box::pin(async move {
                let mut total: u64 = 0;
                for target in inputs {
                    match purge_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(target)),
                    )
                    .await
                    {
                        Ok(r) => total += r.purged_count,
                        // The single path REFUSES the live id. Rendering the
                        // refusal (rather than unwrapping it) is what puts the
                        // divergence in the compared surface.
                        Err(e) => return vec![purge_outcome(Err(e))],
                    }
                }
                vec![purge_outcome(Ok(total))]
            })
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// The undocumented half of fork #2
// ---------------------------------------------------------------------------

/// Render a restore outcome into the compared surface.
///
/// Unlike [`purge_outcome`] this renders the error MESSAGE as well as the
/// kind. That is deliberate and specific to #3838: the fix is not merely
/// "the batch also fails", it is that the batch raises `restore_block_inner`'s
/// refusal *byte-for-byte*, so the message is part of the contract under test.
/// The purge pair could not do this — the batch there explicitly declines to
/// name the offending root — but both restore paths name it, and with the LIVE
/// id fed FIRST (see below) both arms refuse on the SAME id, so the two
/// messages are comparable rather than incidentally different.
fn restore_outcome(count: Result<u64, AppError>) -> String {
    match count {
        Ok(n) => format!("rows_restored={n}"),
        Err(e) => format!("rows_restored=ERR({:?}: {e})", e.kind()),
    }
}

/// **#3838 — a FIXED divergence. This is now its regression guard.**
///
/// The mirror image of the asymmetry #3819/#3832 closed for purge, which sat
/// one function away for as long.
///
/// `restore_block_inner` REFUSES a live (non-deleted) id:
/// `AppError::InvalidOperation("block '<id>' is not deleted")`.
/// `restore_blocks_by_ids_inner` selected its roots with
///
/// ```sql
/// SELECT b.id, b.deleted_at, b.block_type FROM blocks b
///  WHERE b.id IN (SELECT value FROM json_each(?1)) AND b.deleted_at IS NOT NULL
/// ```
///
/// …so a live id simply fell out of the root set and was SILENTLY SKIPPED. The
/// batch skipped what the single path refuses: a permanent, deliberate-looking
/// output divergence between `batch` and `fold`, i.e. exactly the class of
/// drift this oracle exists to detect.
///
/// This is strictly less severe than the purge case and was filed rather than
/// hot-fixed: skipping a restore is NON-DESTRUCTIVE (the block stays
/// tombstoned) where the purge bug physically erased live rows. But the
/// argument that decided the purge fix — filtering trades a silent wrong for a
/// silent no-op and keeps diverging; only refusal makes the two agree — applies
/// verbatim, so the batch now refuses too.
///
/// **Why it was not caught before.** No committed scenario fed a live id to the
/// restore pair, so `batch ≡ fold` held over what was actually exercised, and
/// the baseline's `restore_blocks_by_ids_inner` entry listed only the
/// `rederive_page_and_space_ids` gap under "STILL UNCOVERED" — the record
/// overstated the coverage. That entry now names this asymmetry too.
///
/// **Why the LIVE id goes FIRST.** Same reason as the purge scenario: the batch
/// is ONE transaction and refusing rolls the whole call back, while the fold is
/// N transactions and cannot roll back what already committed. With the deleted
/// id first the fold would restore R1's subtree and THEN refuse, ending in a
/// state no atomic batch can reproduce — the diff would then be about
/// transactionality rather than about the refusal. Live-first makes the refusal
/// precede any commit on BOTH arms. It loses no teeth: against the pre-fix code
/// this ordering diverges on the returned value AND on every row R1's subtree
/// owns (the batch restored them; the fold refused before restoring anything).
///
/// Run with: `cargo nextest run -E 'test(restore_blocks_by_ids_skips_a_live)'`
#[tokio::test]
async fn restore_blocks_by_ids_skips_a_live_block_the_single_path_refuses() {
    // R1 is soft-deleted by the seed; R3 is the untouched CONTROL block and is
    // still LIVE. Both are handed to the batch call, LIVE id first (see above).
    let inputs = [R3, R1];
    assert_batch_equals_fold(
        "restore_blocks_by_ids/live_input_id",
        &Normalisation::default(),
        |env| {
            Box::pin(async move {
                seed_tree(Arc::clone(&env)).await;
                delete_block_inner(
                    &env.pool,
                    ARM_DEVICE,
                    &env.materializer,
                    BlockId::from_trusted(&id(R1)),
                )
                .await
                .expect("fixture soft-delete");
                env.settle().await;
            })
        },
        move |env| {
            Box::pin(async move {
                vec![restore_outcome(
                    restore_blocks_by_ids_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        block_ids(&inputs),
                    )
                    .await
                    .map(|r| r.affected_count),
                )]
            })
        },
        move |env| {
            Box::pin(async move {
                let mut total: u64 = 0;
                for label in inputs {
                    let deleted_at_ref = deleted_at_or_zero(&env.pool, label).await;
                    match restore_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(label)),
                        deleted_at_ref,
                    )
                    .await
                    {
                        Ok(r) => total += r.restored_count,
                        // The single path REFUSES the live id. Rendering the
                        // refusal (rather than unwrapping it) is what puts the
                        // divergence in the compared surface.
                        Err(e) => return vec![restore_outcome(Err(e))],
                    }
                }
                vec![restore_outcome(Ok(total))]
            })
        },
    )
    .await;
}

/// **#3818 — a FIXED divergence. This is now its regression guard.**
///
/// `restore_block_inner` calls
/// `block_descendants::restore_deleted_ancestor_chain` (#1884): after clearing
/// the target's own subtree it walks UP the contiguous soft-deleted ancestor
/// chain and restores that too. Without it, restoring a child whose parent is
/// separately tombstoned makes the child LIVE under an invisible parent —
/// absent from the tree AND from trash.
///
/// `restore_blocks_by_ids_inner` did not call it. The batch's doc comment
/// claimed it "mirrors `restore_all_deleted_inner`'s body"; nothing claimed it
/// mirrors `restore_block_inner`, and the #2325-style "documented deliberate
/// exception" comment that delete's fork carries is absent here. Mirroring the
/// *all* variant is exactly the trap: that variant restores EVERY tombstone,
/// so an upward walk is vacuous there and load-bearing here. It now calls the
/// helper once per root (idempotent + op-free, so overlapping chains collapse).
///
/// This test drives the shape that separates them: delete the CHILD first,
/// then delete the PARENT (whose cascade skips the already-tombstoned child,
/// making the child its own trash root), then restore the CHILD.
///
/// Still uncovered here, and NOT what this test asserts: the batch path also
/// skips the `rederive_page_and_space_ids` refresh the single path runs in-tx.
/// This fixture cannot see it (the seeded `page_id` / `space_id` are already
/// correct on both arms) — a scenario that moves a block while it is
/// soft-deleted would be needed.
///
/// Run with: `cargo nextest run -E 'test(restore_blocks_by_ids_omits)'`
#[tokio::test]
async fn restore_blocks_by_ids_omits_the_1884_ancestor_chain_restore() {
    let targets = [R1C1];
    assert_batch_equals_fold(
        "restore_blocks_by_ids/ancestor_chain",
        &Normalisation::default(),
        |env| {
            Box::pin(async move {
                seed_tree(Arc::clone(&env)).await;
                // Child first, THEN the parent: the parent's cascade skips the
                // already-deleted child, so R1C1 becomes its own trash root
                // under a still-tombstoned R1.
                for label in [R1C1, R1] {
                    delete_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(label)),
                    )
                    .await
                    .expect("fixture soft-delete");
                }
                env.settle().await;
            })
        },
        move |env| {
            Box::pin(async move {
                let resp = restore_blocks_by_ids_inner(
                    &env.pool,
                    ARM_DEVICE,
                    &env.materializer,
                    block_ids(&targets),
                )
                .await
                .expect("bulk restore");
                vec![format!("rows_restored={}", resp.affected_count)]
            })
        },
        move |env| {
            Box::pin(async move {
                let mut total: u64 = 0;
                for label in targets {
                    let deleted_at_ref = deleted_at_of(&env.pool, label).await;
                    total += restore_block_inner(
                        &env.pool,
                        ARM_DEVICE,
                        &env.materializer,
                        BlockId::from_trusted(&id(label)),
                        deleted_at_ref,
                    )
                    .await
                    .expect("single restore")
                    .restored_count;
                }
                vec![format!("rows_restored={total}")]
            })
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// #3834 — the restored ancestor chain must reach the ENGINE, not just SQL
// ---------------------------------------------------------------------------
//
// These two are NOT batch-vs-fold scenarios, and deliberately so. The oracle
// cannot see this defect: both arms were EQUALLY wrong, so `batch ≡ fold` held
// while the CRDT diverged from SQL on both. What is asserted instead is an
// absolute invariant — after a LOCAL restore, the per-space Loro engine and
// SQL agree about the restored ancestor chain — driven once through each
// restore path. They live here rather than in `command_integration_tests`
// because this module's fixture is the one that seeds every block into the
// per-space engine (see `seed_block`); a SQL-only fixture would make the
// engine assertions vacuous.

/// Both arms of the live-orphan shape #1884 fixed: delete the CHILD first,
/// THEN the PARENT (whose cascade skips the already-tombstoned child, so the
/// child becomes its own trash root under a still-tombstoned parent).
/// Restoring the child then has to walk UP and restore the parent chain.
async fn seed_tree_with_a_tombstoned_ancestor(env: Arc<ArmEnv>) {
    seed_tree(Arc::clone(&env)).await;
    for label in [R1C1, R1] {
        delete_block_inner(
            &env.pool,
            ARM_DEVICE,
            &env.materializer,
            BlockId::from_trusted(&id(label)),
        )
        .await
        .expect("fixture soft-delete");
    }
    env.settle().await;
}

/// This arm's per-space Loro engine's view of `label`: whether it is
/// tombstoned, and the raw `deleted_at` marker a reproject would be driven
/// from.
fn engine_deleted_state(env: &ArmEnv, label: &str) -> (bool, Option<String>) {
    let space = SpaceId::from_trusted(&id(SPACE));
    let state = env.materializer.loro_state();
    let mut guard = state
        .registry
        .for_space(&space, ARM_DEVICE)
        .expect("for_space (engine readback)");
    let engine = guard.engine_mut();
    let block_id = id(label);
    (
        engine.read_deleted(&block_id).expect("read_deleted"),
        engine.read_deleted_at(&block_id).expect("read_deleted_at"),
    )
}

/// SQL's view of `label`'s tombstone.
async fn sql_deleted_at(pool: &SqlitePool, label: &str) -> Option<i64> {
    // dynamic-sql: test-only oracle readback (not a production query path)
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(id(label))
        .fetch_one(pool)
        .await
        .expect("read deleted_at")
}

/// **The assertion #3834 / #3856 are about**, applied to ONE block of the
/// restored subtree.
///
/// `path` names the caller and `role` the block's position in the restore
/// (ancestor / seed / descendant) so a failure says which path regressed and
/// where.
///
/// Note what is NOT the point: the block being live in SQL. SQL was always
/// right — the cohort UPDATE and `restore_deleted_ancestor_chain` cleared it
/// in-tx, before and after either fix — so a test that stopped there would be
/// vacuous. It is asserted only as the precondition that makes the engine
/// assertions meaningful (with no SQL restore there would be no divergence to
/// detect).
async fn assert_member_converged(env: &ArmEnv, path: &str, role: &str, label: &str) {
    assert_eq!(
        sql_deleted_at(&env.pool, label).await,
        None,
        "precondition ({path}): the restore must clear {label} ({role}) in SQL",
    );

    // (a) THE CORE: the block is alive IN THE ENGINE, not just in SQL.
    //
    // #3834 (ancestor): nothing in either local command reached the engine for
    // the chain — the `apply_op` → `dispatch_restore_ancestors` arm the code
    // cited never runs for a locally authored op (the local path leaves the
    // apply cursor put, so the op only replays at boot, by which point the
    // chain is already live in SQL and the projection returns an empty chain).
    //
    // #3856 (seed + descendant cohort): `restore_block_inner` and
    // `restore_all_deleted_inner` performed NO engine work of their own at all —
    // they never route through `apply_op_projected` the way `delete_block_inner`
    // does — so after #3834 the ancestor came back in the CRDT while the seed
    // and its descendants stayed tombstoned: a tombstoned CHILD under a live
    // PARENT, the inverse of the #1884 live-orphan.
    let (engine_deleted, engine_deleted_at) = engine_deleted_state(env, label);
    assert!(
        !engine_deleted,
        "#3834/#3856 ({path}): restoring R1C1 must leave {label} ({role}) alive \
         IN THE ENGINE — a SQL-only restore leaves the block live in SQL and \
         tombstoned in the per-space CRDT",
    );
    assert!(
        engine_deleted_at.is_none(),
        "#3834/#3856 ({path}): the engine must report {label} ({role}) alive \
         (deleted_at None); got {engine_deleted_at:?}",
    );

    // (b) DEMONSTRATION, not independent evidence — labelled so because it
    // reads like a second check and is not one. A reproject driven by the
    // ENGINE's view must not re-delete the block in SQL; with a stale engine
    // tombstone this call re-stamps `deleted_at` on every reproject, which is
    // the self-perpetuating divergence and the user-visible symptom (a restored
    // subtree that silently reverts to deleted).
    //
    // But it CANNOT fail once (a) passes: it feeds (a)'s already-asserted
    // `None` back in, and `reproject_block_deleted_at_from_engine` only
    // re-deletes inside `if let Some(ts)`. (a) is strictly stronger. This is
    // kept because it spells out the consequence the assertion above is
    // guarding against, in the one place a reader will look for it — not
    // because it adds coverage. Do not count it as a second assertion, and do
    // not "strengthen" it by re-reading the engine: a fresh read of a value (a)
    // just proved is `None` is equally tautological.
    {
        let mut tx = env.pool.begin().await.expect("begin reproject");
        agaric_engine::loro::projection::reproject_block_deleted_at_from_engine(
            &mut tx,
            &BlockId::from_trusted(&id(label)),
            engine_deleted_at.as_deref(),
        )
        .await
        .expect("reproject from the engine");
        tx.commit().await.expect("commit reproject");
    }
    assert_eq!(
        sql_deleted_at(&env.pool, label).await,
        None,
        "#3834/#3856 GUARD ({path}): reprojecting {label} ({role}) from the \
         engine must NOT re-delete the restored block in SQL",
    );
}

/// The whole restored subtree must converge — asserted as ONE unit on every
/// restore path, deliberately.
///
/// The three roles failed independently and were fixed in separate changes
/// (`R1` the upward ancestor chain, #3834; `R1C1` the seed and `R1C1G1` its
/// descendant cohort, #3856), by two different mechanisms (an upward fan-out
/// vs a downward one). Asserting them together is what makes a fix that
/// converges one while regressing another visible: the #3856 probe found
/// exactly that shape, `R1` converged and `R1C1`/`R1C1G1` not.
async fn assert_restored_subtree_converged(env: &ArmEnv, path: &str) {
    // #3834 — the contiguous soft-deleted ANCESTOR chain the #1884 upward walk
    // un-deletes in SQL.
    assert_member_converged(env, path, "ancestor", R1).await;
    // #3856 — the SEED the caller actually named.
    assert_member_converged(env, path, "seed", R1C1).await;
    // #3856 — one DESCENDANT from the seed's delete cohort. The seed alone
    // would not catch a fan-out driven with a one-element list.
    assert_member_converged(env, path, "descendant", R1C1G1).await;
}

/// Assert every block the restore is about to un-delete starts TOMBSTONED in
/// the engine — otherwise there is no divergence for the restore to close and
/// every convergence assertion downstream is vacuous.
fn assert_subtree_tombstoned_in_engine(env: &ArmEnv) {
    for (role, label) in [("ancestor", R1), ("seed", R1C1), ("descendant", R1C1G1)] {
        let (deleted_before, _) = engine_deleted_state(env, label);
        assert!(
            deleted_before,
            "precondition: {label} ({role}) must be tombstoned in the engine \
             after the fixture delete",
        );
    }
}

/// #3834 + #3856, single path. `restore_block_inner` discarded
/// `restore_deleted_ancestor_chain`'s returned `chain`, citing an `apply_op`
/// arm that never fires locally (#3834) — and, beyond that, performed no engine
/// work of ANY kind: it never routes through `apply_op_projected` the way
/// `delete_block_inner` does, so the seed it was handed and that seed's whole
/// descendant cohort stayed tombstoned in the CRDT too (#3856).
///
/// Run with: `cargo nextest run -E 'test(restore_block_inner_fans_the_restored_subtree)'`
#[tokio::test]
async fn restore_block_inner_fans_the_restored_subtree_to_the_engine() {
    let env = Arc::new(ArmEnv::new().await);
    seed_tree_with_a_tombstoned_ancestor(Arc::clone(&env)).await;
    assert_subtree_tombstoned_in_engine(&env);

    let deleted_at_ref = deleted_at_of(&env.pool, R1C1).await;
    restore_block_inner(
        &env.pool,
        ARM_DEVICE,
        &env.materializer,
        BlockId::from_trusted(&id(R1C1)),
        deleted_at_ref,
    )
    .await
    .expect("single restore");
    env.settle().await;

    assert_restored_subtree_converged(&env, "restore_block_inner").await;
}

/// #3834 + #3856, batch path. `restore_blocks_by_ids_inner` had the ANCESTOR
/// defect too — and was internally inconsistent about it, since it already
/// hand-rolls the post-commit `dispatch_restore_descendants` fan-out for
/// exactly this reason and simply did not do the symmetric upward one.
///
/// The seed/cohort half of this assertion is a REGRESSION GUARD rather than a
/// reproducer: this path has fanned its descendant cohort out since #1257, and
/// #3856's measured probe found it already converged where the single path was
/// not. It is asserted here anyway, through the same helper — the fix for the
/// single path is the batch path's own mechanism, so a change that moved the
/// shared fan-out could converge one and break the other.
///
/// Run with: `cargo nextest run -E 'test(restore_blocks_by_ids_inner_fans_the_restored_subtree)'`
#[tokio::test]
async fn restore_blocks_by_ids_inner_fans_the_restored_subtree_to_the_engine() {
    let env = Arc::new(ArmEnv::new().await);
    seed_tree_with_a_tombstoned_ancestor(Arc::clone(&env)).await;
    assert_subtree_tombstoned_in_engine(&env);

    restore_blocks_by_ids_inner(&env.pool, ARM_DEVICE, &env.materializer, block_ids(&[R1C1]))
        .await
        .expect("bulk restore");
    env.settle().await;

    assert_restored_subtree_converged(&env, "restore_blocks_by_ids_inner").await;
}

/// #3856, restore-ALL path. `restore_all_deleted_inner` had the TOTAL gap: no
/// in-tx engine apply and no post-commit fan-out, so every block it un-deleted
/// — the whole trash — stayed tombstoned in the per-space CRDT. Measured on the
/// #3856 probe as `engine_deleted=true` for all three roles, the ancestor
/// included (the other two paths at least converged R1 via #3834's upward
/// fan-out; this one restores everything downward and had nothing at all).
///
/// It takes no arguments, so the assertion is driven through the same fixture
/// and the same helper: "empty the trash" must converge the identical subtree.
///
/// Run with: `cargo nextest run -E 'test(restore_all_deleted_inner_fans_the_restored_subtree)'`
#[tokio::test]
async fn restore_all_deleted_inner_fans_the_restored_subtree_to_the_engine() {
    let env = Arc::new(ArmEnv::new().await);
    seed_tree_with_a_tombstoned_ancestor(Arc::clone(&env)).await;
    assert_subtree_tombstoned_in_engine(&env);

    let restored = crate::commands::blocks::crud::restore_all_deleted_inner(
        &env.pool,
        ARM_DEVICE,
        &env.materializer,
    )
    .await
    .expect("restore all")
    .affected_count;
    // R1, R1C2, R1C1, R1C1G1 — the two delete cohorts the fixture leaves in the
    // trash. Pins that the call under test actually restored the subtree the
    // engine assertions below then read, rather than finding nothing to do.
    assert_eq!(restored, 4, "restore_all must clear all four tombstones");
    env.settle().await;

    assert_restored_subtree_converged(&env, "restore_all_deleted_inner").await;
}
