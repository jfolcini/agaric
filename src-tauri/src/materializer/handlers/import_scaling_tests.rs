//! #2200 Tier-2 import scaling: end-of-chunk deferral of the two per-block
//! O(N) maintenance passes (dense-position reprojection + `pages_cache` count
//! recompute) into a single per-chunk O(N) flush.
//!
//! A "chunk" is one `BatchApplyOps` transaction (the import path). These tests
//! drive a multi-sibling / multi-block CreateBlock batch through the REAL
//! `handle_foreground_task(BatchApplyOps)` pipeline (engine arm, Loro state
//! installed) and assert:
//!
//! - (a) the final dense ranks are exactly the sequential `1..=N` insertion
//!   order — identical to what per-block reprojection would have produced;
//! - (b) the page's `child_block_count` equals `N` (per-block-identical);
//! - (c) the observable that both deferred passes ran ONCE per parent/page
//!   (via the `reproject_call_spy` / `recompute_call_spy` invocation counters)
//!   rather than once per imported block — and that the equivalent single-op
//!   path (a chunk-of-one each) produces the SAME final state, proving the
//!   deferral changed only WHEN the work runs, not its result.
//!
//! Run under `cargo nextest run` (one process per test): the Loro `OnceLock`
//! and the two spy counters are process-global.

// The assertions below cast small compile-time `const N: usize` fixtures (≤ 12)
// and loop indices to `i64` for rank/count comparisons; the values are tiny, so
// `clippy::cast_possible_wrap` is a non-issue in this test-only module.
#![allow(clippy::cast_possible_wrap)]

use crate::db::init_pool;
use agaric_core::ulid::BlockId;
use agaric_store::op::{CreateBlockPayload, DeleteBlockPayload, MoveBlockPayload, OpPayload};
use sqlx::SqlitePool;
use std::sync::Arc;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ0000000000000000IMPAGE";
const DEVICE_ID: &str = "device-import-scaling";

/// Deterministic child id `i` (0-based). ULID-shaped, lexicographically
/// ascending in `i` so a mis-sorted assertion would show.
fn child_id(i: usize) -> String {
    format!("01HZ0000000000000000IMC{i:03}")
}

/// Seed the `space` block + registry row + the owning page, all through raw
/// SQL (the engine tree gets the page via `seed_page_via_loro`). Mirrors the
/// established engine-arm fixtures.
async fn seed_space_and_page(pool: &SqlitePool) {
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
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'page-content', NULL, 0, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .execute(pool)
    .await
    .expect("seed page block");
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(SPACE_ID)
        .bind(PAGE_ID)
        .bind(PAGE_ID)
        .execute(pool)
        .await
        .expect("stamp space_id");
    // A `pages_cache` row so the count recompute has a target to UPDATE.
    let now = crate::db::now_ms();
    sqlx::query(
        "INSERT OR IGNORE INTO pages_cache \
             (page_id, title, updated_at, inbound_link_count, child_block_count) \
         VALUES (?, 'page-content', ?, 0, 0)",
    )
    .bind(PAGE_ID)
    .bind(now)
    .execute(pool)
    .await
    .expect("seed pages_cache row");
}

/// Push the page into the per-space engine tree (single-op create) so later
/// child creates resolve the space and take the engine arm.
async fn seed_page_via_loro(pool: &SqlitePool, state: &agaric_engine::loro::shared::LoroState) {
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(PAGE_ID),
        block_type: "page".into(),
        parent_id: None,
        position: Some(0),
        index: None,
        content: "page-content".into(),
    });
    let record = agaric_store::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append page create");
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply page create");
    tx.commit().await.expect("commit");
}

/// Build an N-child CreateBlock batch (all children of PAGE_ID, appended to the
/// op_log so `handle_foreground_task` can apply them) and return the records.
async fn build_child_batch(pool: &SqlitePool, n: usize) -> Vec<agaric_store::op_log::OpRecord> {
    let mut records = Vec::with_capacity(n);
    for i in 0..n {
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(&child_id(i)),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            // Append each at the end (index = i) so the final tree order is the
            // insertion order — the ranks must come out 1..=N.
            position: None,
            index: Some(i as i64),
            content: format!("child-{i}"),
        });
        let record = agaric_store::op_log::append_local_op(pool, DEVICE_ID, payload)
            .await
            .expect("append child create");
        records.push(record);
    }
    records
}

/// Append a single `CreateBlock` op (child of `PAGE_ID` at `index`) and return
/// the record. Shared by the mixed-op parity tests.
async fn build_one_create(
    pool: &SqlitePool,
    block_id: &str,
    index: i64,
) -> agaric_store::op_log::OpRecord {
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: None,
        index: Some(index),
        content: format!("child-{block_id}"),
    });
    agaric_store::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append child create")
}

/// Read the dense `position` ranks for the N children, ordered by insertion
/// index (child_id ascending == insertion order here).
async fn child_ranks(pool: &SqlitePool, n: usize) -> Vec<i64> {
    let mut ranks = Vec::with_capacity(n);
    for i in 0..n {
        let pos: i64 = sqlx::query_scalar("SELECT position FROM blocks WHERE id = ?")
            .bind(child_id(i))
            .fetch_one(pool)
            .await
            .expect("fetch position");
        ranks.push(pos);
    }
    ranks
}

async fn child_block_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT child_block_count FROM pages_cache WHERE page_id = ?")
        .bind(PAGE_ID)
        .fetch_one(pool)
        .await
        .expect("fetch child_block_count")
}

/// The count recompute keys on `blocks.page_id`, which the create projection
/// leaves NULL for content children (a background `RebuildPageIds` task stamps
/// it later). Stamp it here to the owning page — exactly what that task does —
/// then recompute the page's counts once, so we can assert the FINAL page
/// descendant count is correct (N) on realistic page-membership state.
async fn stamp_page_ids_and_recompute(pool: &SqlitePool, n: usize) {
    for i in 0..n {
        sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
            .bind(PAGE_ID)
            .bind(child_id(i))
            .execute(pool)
            .await
            .expect("stamp child page_id");
    }
    let mut tx = pool.begin().await.expect("begin recompute");
    super::recompute_pages_cache_counts_for_pages(&mut tx, &[PAGE_ID.to_owned()])
        .await
        .expect("recompute counts");
    tx.commit().await.expect("commit recompute");
}

/// Stamp `page_id` + `space_id` on a freshly-created content child, mimicking
/// the background `SetBlockPageId` materialize task. Without this a mid-batch
/// `MoveBlock`/`DeleteBlock` on the block cannot resolve its space and falls to
/// the SQL-only path; stamping keeps the op on the engine path (the realistic
/// post-import steady state).
async fn stamp_child_page_and_space(pool: &SqlitePool, block_id: &str) {
    sqlx::query("UPDATE blocks SET page_id = ?, space_id = ? WHERE id = ?")
        .bind(PAGE_ID)
        .bind(SPACE_ID)
        .bind(block_id)
        .execute(pool)
        .await
        .expect("stamp child page_id + space_id");
}

/// Create a content child under `PAGE_ID` at `index` via the single-op path
/// (committed) and stamp its page_id/space_id so later moves/deletes resolve the
/// engine. Used to establish pre-existing siblings before a mixed-op batch.
async fn seed_committed_child(
    pool: &SqlitePool,
    state: &agaric_engine::loro::shared::LoroState,
    block_id: &str,
    index: i64,
) {
    let record = build_one_create(pool, block_id, index).await;
    let mut tx = pool.begin().await.expect("begin");
    super::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply seed child");
    tx.commit().await.expect("commit seed child");
    stamp_child_page_and_space(pool, block_id).await;
}

/// (a)+(b)+(c): a `BatchApplyOps` chunk of N sibling creates reprojects the
/// parent group ONCE and recomputes the page counts ONCE at end-of-chunk, and
/// the final dense ranks (1..=N) and `child_block_count` (N) are exactly what
/// the per-block behaviour would produce.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_import_defers_reproject_and_counts_to_end_of_chunk() {
    const N: usize = 12;
    let state = agaric_engine::loro::shared::LoroState::new();

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("import_chunk.db"))
        .await
        .expect("init_pool");
    seed_space_and_page(&pool).await;
    seed_page_via_loro(&pool, &state).await;

    let records = build_child_batch(&pool, N).await;

    // Reset the spies immediately before the measured chunk so only the chunk's
    // deferred flush is counted.
    agaric_engine::loro::projection::reproject_call_spy::reset();
    super::recompute_call_spy::reset();

    let task = crate::materializer::MaterializeTask::BatchApplyOps(Arc::new(records));
    super::handle_foreground_task(&pool, &task, &state)
        .await
        .expect("batch apply");

    // (c) observable: ONE reproject (single touched parent group) + ONE count
    // recompute for the whole N-block chunk, not N of each.
    assert_eq!(
        agaric_engine::loro::projection::reproject_call_spy::count(),
        1,
        "chunk must reproject the single touched parent group ONCE, not once per block"
    );
    assert_eq!(
        super::recompute_call_spy::count(),
        1,
        "chunk must recompute the affected page's counts ONCE, not once per block"
    );

    // (a) final dense ranks are the sequential insertion order 1..=N.
    let ranks = child_ranks(&pool, N).await;
    let expected: Vec<i64> = (1..=N as i64).collect();
    assert_eq!(ranks, expected, "deferred reproject must yield 1..=N ranks");

    // (b) once the children's `page_id` is stamped (as the background
    // `RebuildPageIds` task does post-import) and the page's counts are
    // recomputed, `child_block_count` equals N — the correct final count.
    stamp_page_ids_and_recompute(&pool, N).await;
    assert_eq!(
        child_block_count(&pool).await,
        N as i64,
        "deferred count recompute must equal per-block child_block_count"
    );
}

/// Build an N-child CreateBlock batch where every child is inserted at index 0
/// (PREPEND) so the final tree order is the REVERSE of the insertion order.
/// This is the discriminating shape for #2200: with append-only monotonic
/// inserts (the `build_child_batch` fixture) EVERY intermediate sibling
/// snapshot is already a correctly-ordered prefix, so a stale-snapshot /
/// wrong-order deferral bug would still coincidentally yield 1..=N. With
/// prepends, only the FINAL engine order (last-writer-wins, complete list)
/// gives the correct ranks — an early/incomplete snapshot would mis-rank.
async fn build_prepended_child_batch(
    pool: &SqlitePool,
    n: usize,
) -> Vec<agaric_store::op_log::OpRecord> {
    let mut records = Vec::with_capacity(n);
    for i in 0..n {
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(&child_id(i)),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(PAGE_ID)),
            // Prepend each new child at slot 0: the final tree order is the
            // reverse of insertion order, so child(i) must land at rank N - i.
            position: None,
            index: Some(0),
            content: format!("child-{i}"),
        });
        let record = agaric_store::op_log::append_local_op(pool, DEVICE_ID, payload)
            .await
            .expect("append prepended child create");
        records.push(record);
    }
    records
}

/// #2200 Item 1 discriminator: prepend N children in a single chunk (final tree
/// order = REVERSE of insertion order) and assert the deferred end-of-chunk
/// reproject — which fires ONCE — writes the ranks derived from the FINAL engine
/// order, not from any stale/early sibling snapshot. child(i) must land at rank
/// `N - i`. This is the case the monotonic-append tests cannot distinguish:
/// recording anything other than the last, complete sibling ordering would
/// mis-rank here while still passing the append fixtures.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_import_prepend_defers_to_final_order_not_stale_snapshot() {
    const N: usize = 8;
    let state = agaric_engine::loro::shared::LoroState::new();

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("import_prepend.db"))
        .await
        .expect("init_pool");
    seed_space_and_page(&pool).await;
    seed_page_via_loro(&pool, &state).await;

    let records = build_prepended_child_batch(&pool, N).await;

    agaric_engine::loro::projection::reproject_call_spy::reset();
    super::recompute_call_spy::reset();

    let task = crate::materializer::MaterializeTask::BatchApplyOps(Arc::new(records));
    super::handle_foreground_task(&pool, &task, &state)
        .await
        .expect("batch apply");

    // Still ONCE per touched parent/page — the deferral holds regardless of slot.
    assert_eq!(
        agaric_engine::loro::projection::reproject_call_spy::count(),
        1,
        "prepend chunk must still reproject the parent group ONCE"
    );
    assert_eq!(
        super::recompute_call_spy::count(),
        1,
        "prepend chunk must still recompute the page counts ONCE"
    );

    // The load-bearing assertion: child(i)'s rank is `N - i` (reverse order),
    // which is ONLY correct if the flush reprojected the FINAL engine ordering.
    // A stale/incomplete recorded snapshot would produce a different mapping.
    let ranks = child_ranks(&pool, N).await;
    let expected: Vec<i64> = (0..N).map(|i| (N - i) as i64).collect();
    assert_eq!(
        ranks, expected,
        "deferred reproject must use the FINAL engine order (child(i) -> rank N-i), \
         not a stale sibling snapshot"
    );
    // Ranks are still a dense 1..=N permutation (no gaps / dups).
    let mut sorted = ranks.clone();
    sorted.sort_unstable();
    assert_eq!(
        sorted,
        (1..=N as i64).collect::<Vec<_>>(),
        "ranks must be a dense 1..=N permutation"
    );

    stamp_page_ids_and_recompute(&pool, N).await;
    assert_eq!(
        child_block_count(&pool).await,
        N as i64,
        "deferred count recompute must equal N under prepend too"
    );
}

/// The single-op path (a chunk-of-one each) produces the IDENTICAL final ranks
/// and count as the deferred batch path — proving the #2200 deferral changed
/// only WHEN the work runs, not the result. Here the reproject/recompute spies
/// fire once PER op (N each), the pre-refactor cadence.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn single_op_path_matches_batch_final_state() {
    const N: usize = 12;
    let state = agaric_engine::loro::shared::LoroState::new();

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("import_single.db"))
        .await
        .expect("init_pool");
    seed_space_and_page(&pool).await;
    seed_page_via_loro(&pool, &state).await;

    let records = build_child_batch(&pool, N).await;

    agaric_engine::loro::projection::reproject_call_spy::reset();
    super::recompute_call_spy::reset();

    // Apply each op as its own single-op "chunk of one" (None accumulator ⇒
    // inline reproject + inline recompute), committing between ops.
    for record in &records {
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, record, None, &state)
            .await
            .expect("apply single op");
        tx.commit().await.expect("commit");
    }

    // The single-op path reprojects + recomputes once PER op (N each) — the
    // O(N)-per-block cadence the batch path collapses to one.
    assert_eq!(
        agaric_engine::loro::projection::reproject_call_spy::count(),
        N,
        "single-op path reprojects inline once per op"
    );
    assert_eq!(
        super::recompute_call_spy::count(),
        N,
        "single-op path recomputes inline once per op"
    );

    // …yet the FINAL state is identical to the deferred batch path: the same
    // 1..=N ranks, and the same N child_block_count once page_id is stamped.
    let ranks = child_ranks(&pool, N).await;
    let expected: Vec<i64> = (1..=N as i64).collect();
    assert_eq!(ranks, expected, "single-op final ranks must be 1..=N");
    stamp_page_ids_and_recompute(&pool, N).await;
    assert_eq!(
        child_block_count(&pool).await,
        N as i64,
        "single-op child_block_count must equal N"
    );
}

// ---------------------------------------------------------------------------
// #2208 / #2200 correctness: the reprojection deferral is GATED to all-create
// chunks. A mixed-op batch (create + move/delete of a sibling) must produce the
// SAME final dense ranks as applying those ops one-at-a-time INLINE — proving
// the stale-snapshot clobbering the deferral would cause cannot happen.
// ---------------------------------------------------------------------------

/// Append a single `MoveBlock` op (move `block` to `new_index` under `PAGE_ID`)
/// to the op_log and return the record.
async fn move_child_record(
    pool: &SqlitePool,
    block_id: &str,
    new_index: i64,
) -> agaric_store::op_log::OpRecord {
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        new_parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        new_position: new_index,
        new_index: Some(new_index),
    });
    agaric_store::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append move")
}

/// Append a single `DeleteBlock` op for `block_id` to the op_log and return the
/// record.
async fn delete_child_record(pool: &SqlitePool, block_id: &str) -> agaric_store::op_log::OpRecord {
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(block_id),
    });
    agaric_store::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append delete")
}

/// Dense `position` rank of a single child by id.
async fn rank_of(pool: &SqlitePool, block_id: &str) -> i64 {
    sqlx::query_scalar("SELECT position FROM blocks WHERE id = ?")
        .bind(block_id)
        .fetch_one(pool)
        .await
        .expect("fetch position")
}

/// Apply a slice of records as one `BatchApplyOps` chunk through the REAL
/// pipeline.
async fn apply_as_batch(
    pool: &SqlitePool,
    state: &agaric_engine::loro::shared::LoroState,
    records: Vec<agaric_store::op_log::OpRecord>,
) {
    let task = crate::materializer::MaterializeTask::BatchApplyOps(Arc::new(records));
    super::handle_foreground_task(pool, &task, state)
        .await
        .expect("batch apply");
}

/// #2208: a mixed-op batch containing a create AND a move of an existing sibling
/// must leave the SAME final dense ranks as applying those ops one-at-a-time
/// INLINE.
///
/// Setup: a (rank 1) and b (rank 2) already exist under P (committed, space
/// stamped). The batch is `[Create(c→P at end), Move(b to front)]`. The correct
/// final tree order is `[b, a, c]` ⇒ dense ranks b=1, a=2, c=3.
///
/// This is the discriminating case for the deferral gate. If the accumulator
/// were (wrongly) used for this mixed batch, the `Create(c)` would snapshot the
/// sibling order `[a, b, c]`, then the inline `Move(b to front)` would correctly
/// reproject to `[b, a, c]` (b=1,a=2,c=3), and finally the end-of-chunk flush
/// would REPLAY the stale `[a, b, c]` snapshot — clobbering the move back to
/// a=1,b=2,c=3. The gate forces `None` for any non-all-create batch, so every op
/// (create included) reprojects inline and the move survives.
///
/// MUTATION CHECK: removing the `all_create` gate in `task_handlers.rs` (always
/// passing `Some(&mut chunk)`) makes this FAIL with b=2,a=1 — confirming the
/// test actually exercises the stale-snapshot clobber.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_create_and_move_matches_inline_path() {
    let state = agaric_engine::loro::shared::LoroState::new();

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("mixed_move.db"))
        .await
        .expect("init_pool");
    seed_space_and_page(&pool).await;
    seed_page_via_loro(&pool, &state).await;

    let a = child_id(0);
    let b = child_id(1);
    let c = child_id(2);

    // Pre-existing siblings a (rank 1) and b (rank 2), space-stamped so the
    // in-batch move resolves the engine (not the SQL-only fallback).
    seed_committed_child(&pool, &state, &a, 0).await;
    seed_committed_child(&pool, &state, &b, 1).await;

    // Mixed batch: create c at the end, then move b to the front.
    let create_c = build_one_create(&pool, &c, 2).await;
    let move_b = move_child_record(&pool, &b, 0).await;
    apply_as_batch(&pool, &state, vec![create_c, move_b]).await;

    // Correct final order [b, a, c]. A stale-snapshot flush would clobber this
    // back to [a, b, c].
    assert_eq!(rank_of(&pool, &b).await, 1, "moved b must land at rank 1");
    assert_eq!(rank_of(&pool, &a).await, 2, "a must be pushed to rank 2");
    assert_eq!(rank_of(&pool, &c).await, 3, "appended c stays at rank 3");
}

/// Inline-parity control for [`mixed_create_and_move_matches_inline_path`]:
/// apply the SAME `Create(c), Move(b)` sequence one-at-a-time (single-op inline
/// path, `None` accumulator) and assert the identical final ranks. The batch
/// gate must not change the outcome relative to the known-correct inline path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_create_and_move_single_op_parity() {
    let state = agaric_engine::loro::shared::LoroState::new();

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("mixed_move_single.db"))
        .await
        .expect("init_pool");
    seed_space_and_page(&pool).await;
    seed_page_via_loro(&pool, &state).await;

    let a = child_id(0);
    let b = child_id(1);
    let c = child_id(2);

    seed_committed_child(&pool, &state, &a, 0).await;
    seed_committed_child(&pool, &state, &b, 1).await;

    for record in [
        build_one_create(&pool, &c, 2).await,
        move_child_record(&pool, &b, 0).await,
    ] {
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record, None, &state)
            .await
            .expect("apply single op");
        tx.commit().await.expect("commit");
    }

    assert_eq!(rank_of(&pool, &b).await, 1, "inline: b at rank 1");
    assert_eq!(rank_of(&pool, &a).await, 2, "inline: a at rank 2");
    assert_eq!(rank_of(&pool, &c).await, 3, "inline: c at rank 3");
}

/// #2208 (Create + Delete-of-sibling hazard): a mixed batch containing a create
/// AND a delete of an existing sibling must produce the SAME final ranks as the
/// inline single-op path. The delete removes a live sibling; the surviving group
/// must be reprojected inline (by the create's own inline reproject on the
/// non-all-create batch), not from a stale end-of-chunk snapshot that would
/// re-rank the now-deleted sibling.
///
/// Setup: a (rank 1) and b (rank 2) exist. Batch `[Create(c→P at end),
/// Delete(a)]`. a is soft-deleted; live siblings are b and c. The batch result
/// must byte-match the inline result (asserted below by running both and
/// comparing) — proving the gate keeps the mixed batch on the inline path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_create_and_delete_sibling_matches_inline_path() {
    let state = agaric_engine::loro::shared::LoroState::new();

    // Batch path.
    let dir_b = TempDir::new().expect("tempdir");
    let pool_b = init_pool(&dir_b.path().join("mixed_delete_batch.db"))
        .await
        .expect("init_pool");
    seed_space_and_page(&pool_b).await;
    seed_page_via_loro(&pool_b, &state).await;
    let a = child_id(0);
    let b = child_id(1);
    let c = child_id(2);
    seed_committed_child(&pool_b, &state, &a, 0).await;
    seed_committed_child(&pool_b, &state, &b, 1).await;
    let create_c = build_one_create(&pool_b, &c, 2).await;
    let delete_a = delete_child_record(&pool_b, &a).await;
    apply_as_batch(&pool_b, &state, vec![create_c, delete_a]).await;

    // Inline path (fresh DB), same op sequence one-at-a-time.
    let dir_i = TempDir::new().expect("tempdir");
    let pool_i = init_pool(&dir_i.path().join("mixed_delete_inline.db"))
        .await
        .expect("init_pool");
    seed_space_and_page(&pool_i).await;
    seed_page_via_loro(&pool_i, &state).await;
    seed_committed_child(&pool_i, &state, &a, 0).await;
    seed_committed_child(&pool_i, &state, &b, 1).await;
    for record in [
        build_one_create(&pool_i, &c, 2).await,
        delete_child_record(&pool_i, &a).await,
    ] {
        let mut tx = pool_i.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record, None, &state)
            .await
            .expect("apply single op");
        tx.commit().await.expect("commit");
    }

    // a is soft-deleted on both paths; the surviving b/c ranks must match the
    // inline path exactly.
    for id in [&a, &b, &c] {
        let batch_pos: Option<i64> = sqlx::query_scalar("SELECT position FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(&pool_b)
            .await
            .expect("batch pos");
        let inline_pos: Option<i64> =
            sqlx::query_scalar("SELECT position FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool_i)
                .await
                .expect("inline pos");
        assert_eq!(
            batch_pos, inline_pos,
            "mixed create+delete batch rank for {id} must match the inline path",
        );
    }
    let a_deleted: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(&a)
        .fetch_one(&pool_b)
        .await
        .expect("fetch a deleted_at");
    assert!(
        a_deleted.is_some(),
        "a must be soft-deleted on the batch path"
    );
}

/// #2208 multi-space all-create batch: creates in DIFFERENT spaces within one
/// all-create batch must each get a correct dense rank in their OWN space's
/// sibling group. The accumulator's reproject key is space-qualified
/// (`(space_id, Option<parent>)`), so cross-space sibling groups never clobber
/// one another at the end-of-chunk flush — the concrete guard behind the #2208
/// secondary finding (an unqualified key could let one space's ordering
/// overwrite another's, most sharply for the shared top-level `None` key).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn multi_space_all_create_batch_does_not_collide_across_spaces() {
    let state = agaric_engine::loro::shared::LoroState::new();

    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("multi_space.db"))
        .await
        .expect("init_pool");

    // Two independent spaces, each with a top-level block that IS its own space
    // root (parent_id NULL) so a create under it resolves that space.
    const SPACE_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const SPACE_B: &str = "01ARZ3NDEKTSV4RRFFQ69G5FBW";
    for sid in [SPACE_A, SPACE_B] {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'tag', 'space', NULL, 0)",
        )
        .bind(sid)
        .execute(&pool)
        .await
        .expect("seed space block");
        sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
            .bind(sid)
            .execute(&pool)
            .await
            .expect("register space");
        sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ?")
            .bind(sid)
            .bind(sid)
            .execute(&pool)
            .await
            .expect("stamp space root space_id");
        // Push the space root into the engine tree so children resolve it.
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(sid),
            block_type: "tag".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "space".into(),
        });
        let record = agaric_store::op_log::append_local_op(&pool, DEVICE_ID, payload)
            .await
            .expect("append space root create");
        let mut tx = pool.begin().await.expect("begin");
        super::apply_op_tx(&mut tx, &record, None, &state)
            .await
            .expect("apply space root");
        tx.commit().await.expect("commit");
    }

    // One top-level (parent = the space root) create in each space, in one batch.
    let child_a = "01HZ0000000000000000IMCSPA".to_owned();
    let child_b = "01HZ0000000000000000IMCSPB".to_owned();
    let mut records = Vec::new();
    for (sid, cid) in [(SPACE_A, &child_a), (SPACE_B, &child_b)] {
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_trusted(cid),
            block_type: "content".into(),
            parent_id: Some(BlockId::from_trusted(sid)),
            position: None,
            index: Some(0),
            content: "child".into(),
        });
        records.push(
            agaric_store::op_log::append_local_op(&pool, DEVICE_ID, payload)
                .await
                .expect("append child"),
        );
    }
    apply_as_batch(&pool, &state, records).await;

    // Each space's lone child is dense rank 1 in its OWN space. A collision on
    // the top-level key would have dropped one space's reproject.
    assert_eq!(
        rank_of(&pool, &child_a).await,
        1,
        "space A child must be rank 1"
    );
    assert_eq!(
        rank_of(&pool, &child_b).await,
        1,
        "space B child must be rank 1"
    );
}
