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
//! for what that costs.
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

/// **A CONFIRMED, UNFIXED DIVERGENCE — this test documents a production bug.**
///
/// `purge_blocks_by_ids_inner` filters its input to actually-soft-deleted rows
/// when it picks the ROOTS it appends `PurgeBlock` ops for:
///
/// ```sql
/// SELECT b.id, b.block_type FROM blocks b
///  WHERE b.id IN (SELECT value FROM json_each(?1)) AND b.deleted_at IS NOT NULL
/// ```
///
/// …and then seeds the MEMBER-SET CTE it hands to the physical cascade from the
/// RAW input list instead, `SELECT id, 0 FROM blocks WHERE id IN (SELECT value
/// FROM json_each(?1))`, with no `deleted_at` predicate anywhere. A LIVE block
/// id in the input is therefore physically erased — it and its whole subtree,
/// out of every satellite table — while contributing NO `PurgeBlock` op, no
/// engine fan-out, and nothing to the returned count's provenance. The doc
/// comment's claim that "non-deleted or missing ids in the input are silently
/// dropped" holds for the op log only; the cascade does not drop them.
///
/// `purge_block_inner` refuses the same id outright
/// (`AppError::InvalidOperation`, "must be soft-deleted before purging"), which
/// is what makes this a batch-vs-fold divergence and not a product decision.
///
/// The consequence is unsynced local data loss: the rows are gone from SQL, no
/// op describes their removal, so no peer ever learns of it and the next sync
/// re-materialises a tree the local device no longer has. The command is an IPC
/// entry point; "the TrashView only surfaces deleted rows" is a caller-side
/// convention, and a TrashView holding a selection while the block is restored
/// in another window (or by an inbound sync) hands it exactly this input.
///
/// It is `#[ignore]`d because it FAILS against current `main` — it is a
/// reproducer for a production bug, filed out of #3346, not a regression guard.
/// Do not "fix" it by relaxing the comparison; un-ignore it once the batch
/// path's member-set CTE is seeded from the same filtered root set its op log
/// is.
///
/// Run with: `cargo nextest run -E 'test(purge_blocks_by_ids_purges_a_live)' \
///            --run-ignored all`
#[tokio::test]
#[ignore = "#3346: reproduces a REAL divergence — bulk purge hard-deletes a LIVE input id the single path refuses"]
async fn purge_blocks_by_ids_purges_a_live_block_the_single_path_refuses() {
    // R1 is soft-deleted by the seed; R3 is the untouched CONTROL block and is
    // still LIVE. Both are handed to the batch call.
    let inputs = [R1, R3];
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

/// **A CONFIRMED, UNFIXED DIVERGENCE — this test documents a production bug.**
///
/// `restore_block_inner` calls
/// `block_descendants::restore_deleted_ancestor_chain` (#1884): after clearing
/// the target's own subtree it walks UP the contiguous soft-deleted ancestor
/// chain and restores that too. Without it, restoring a child whose parent is
/// separately tombstoned makes the child LIVE under an invisible parent —
/// absent from the tree AND from trash.
///
/// `restore_blocks_by_ids_inner` does not call it. It also skips the
/// `rederive_page_and_space_ids` refresh the single path runs in-tx. The
/// batch's doc comment claims it "mirrors `restore_all_deleted_inner`'s body";
/// nothing claims it mirrors `restore_block_inner`, and the #2325-style
/// "documented deliberate exception" comment that delete's fork carries is
/// absent here.
///
/// This test drives the shape that separates them: delete the CHILD first,
/// then delete the PARENT (whose cascade skips the already-tombstoned child,
/// making the child its own trash root), then restore the CHILD.
///
/// It is `#[ignore]`d because it FAILS against current `main` — it is a
/// reproducer for a production bug, filed out of #3346, not a regression
/// guard. Do not "fix" it by relaxing the comparison; un-ignore it once
/// `restore_blocks_by_ids_inner` restores its ancestor chain.
///
/// Run with: `cargo nextest run -E 'test(restore_blocks_by_ids_omits)' \
///            --run-ignored all`
#[tokio::test]
#[ignore = "#3346: reproduces a REAL divergence — bulk restore skips the #1884 ancestor-chain restore"]
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
