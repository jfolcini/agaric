use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_engine::reverse::*;
use agaric_lib::db::init_pool;
use agaric_store::op::*;
use agaric_store::op_log::append_local_op_at;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

const FIXED_TS: i64 = 1_736_942_400_000;
const TEST_DEVICE: &str = "test-device";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

async fn append_op(
    pool: &SqlitePool,
    payload: OpPayload,
    ts: i64,
) -> agaric_store::op_log::OpRecord {
    append_local_op_at(pool, TEST_DEVICE, payload, ts)
        .await
        .unwrap()
}

/// #2549: seed a REPLICATED (audit-only, `is_replicated = 1`) op — a row
/// ingested for provenance that is NEVER applied to local state (#2481/#2495).
///
/// Goes through the real sync-ingest core (`dag::insert_replicated_op`) so the
/// denormalized `block_id` column is populated and the `is_replicated = 1`
/// stamp is set exactly as a synced audit row would be. Authored by a distinct
/// (foreign) `device_id` and serialized with the same inner-payload encoding as
/// the local append path, so `find_prior_*` sees a byte-faithful candidate row.
async fn append_replicated_op(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    mut payload: OpPayload,
    ts: i64,
) -> agaric_store::op_log::OpRecord {
    // Mirror the local append path: normalize ULIDs, then serialize the inner
    // payload (no `op_type` tag) exactly as `append_local_op_at` stores it.
    payload.normalize_block_ids();
    let op_type = payload.op_type_str().to_owned();
    let payload_json = agaric_store::op_log::serialize_inner_payload(&payload).unwrap();
    let hash = agaric_core::hash::compute_op_hash(device_id, seq, None, &op_type, &payload_json);
    let transfer = agaric_sync::sync_protocol::types::OpTransfer {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs: None,
        hash,
        op_type,
        payload: payload_json,
        created_at: ts,
        origin: "agent:codex".to_owned(),
    };
    agaric_sync::sync_protocol::insert_replicated_op(pool, &transfer)
        .await
        .expect("replicated audit op must ingest");
    agaric_store::op_log::get_op_by_seq(&agaric_lib::db::ReadPool(pool.clone()), device_id, seq)
        .await
        .expect("replicated op must be readable")
}

/// Snapshot of one row in the `blocks` table. Used by the
/// `*_apply_then_reverse_round_trip_i_lifecycle_3` tests below to
/// compare the post-reverse state against the pre-original state.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockRow {
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<i64>,
}

async fn snapshot_blocks(pool: &SqlitePool) -> Vec<BlockRow> {
    use sqlx::Row;
    sqlx::query(
        "SELECT id, block_type, content, parent_id, position, deleted_at \
         FROM blocks ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| BlockRow {
        id: r.get::<String, _>("id"),
        block_type: r.get::<String, _>("block_type"),
        content: r.get::<Option<String>, _>("content"),
        parent_id: r.get::<Option<String>, _>("parent_id"),
        position: r.get::<Option<i64>, _>("position"),
        deleted_at: r.get::<Option<i64>, _>("deleted_at"),
    })
    .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockTagRow {
    block_id: String,
    tag_id: String,
}

async fn snapshot_block_tags(pool: &SqlitePool) -> Vec<BlockTagRow> {
    use sqlx::Row;
    sqlx::query("SELECT block_id, tag_id FROM block_tags ORDER BY block_id, tag_id")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| BlockTagRow {
            block_id: r.get::<String, _>("block_id"),
            tag_id: r.get::<String, _>("tag_id"),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttachmentRow {
    id: String,
    block_id: String,
    filename: String,
    fs_path: String,
    mime_type: String,
    size_bytes: i64,
}

async fn snapshot_attachments(pool: &SqlitePool) -> Vec<AttachmentRow> {
    use sqlx::Row;
    sqlx::query(
        "SELECT id, block_id, filename, fs_path, mime_type, size_bytes \
         FROM attachments ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| AttachmentRow {
        id: r.get::<String, _>("id"),
        block_id: r.get::<String, _>("block_id"),
        filename: r.get::<String, _>("filename"),
        fs_path: r.get::<String, _>("fs_path"),
        mime_type: r.get::<String, _>("mime_type"),
        size_bytes: r.get::<i64, _>("size_bytes"),
    })
    .collect()
}

// ──────────────────────────────────────────────────────────────────────
// I-Lifecycle-3 — oracle-parity round-trip tests for ops whose
// existing reverse tests only assert the returned `OpPayload` variant
// (e.g. `assert!(matches!(reverse, OpPayload::DeleteBlock(_) ...))`).
//
// Variant-only assertions cannot detect a regression that emits the
// right enum variant with wrong field values, and they never exercise
// the apply→reverse→apply round-trip against the materialized
// database. The tests below mirror the structure of
// `undo_chain_*_round_trip` (above), but extend it: they actually
// apply both the original op and its computed reverse via the
// `Materializer` and assert that the affected materialized rows
// return to the pre-original snapshot. This is the contract the
// variant-only tests miss.
// ──────────────────────────────────────────────────────────────────────

/// I-Lifecycle-3 — round-trip contract for `create_block`.
///
/// The pre-existing `reverse_create_block_produces_delete_block` test
/// only checks that `compute_reverse` returns the `DeleteBlock`
/// variant for the same `block_id`. This test extends the contract to
/// the materialized state: apply `CreateBlock` → apply
/// `compute_reverse(...)` → assert the resulting `blocks` state.
///
/// **Strict identity round-trip is a known design divergence (not a
/// code bug), and this test pins the divergent behavior.**
///
/// `compute_reverse(create_block)` returns `DeleteBlock`, and the
/// materializer's `delete_block` arm is a **soft-delete** (sets
/// `deleted_at = record.created_at` rather than removing the row).
/// After `CreateBlock` + `DeleteBlock` the block row persists in
/// `blocks` with `deleted_at IS NOT NULL`, so strict equality with
/// the pre-state (zero rows) cannot hold. A true identity round-trip
/// would require `compute_reverse(create_block)` to emit `PurgeBlock`
/// (hard delete), but `PurgeBlock` is intentionally `NonReversible`
/// and the user-facing undo contract preserves the tombstone for
/// op-log convergence (sync replays must observe a deterministic
/// sequence; a hard delete would lose the create→delete history).
///
/// This test therefore asserts the tombstone shape instead of
/// emptiness. If it ever fails because `blocks` came back EMPTY, the
/// undo semantics changed to a hard-delete round-trip — revisit the
/// op-log convergence rationale above before accepting that change.
///
/// (Historical note: this was previously an `#[ignore]`d,
/// deliberately-failing oracle. The nightly deep-checks lane runs
/// `cargo nextest run --run-ignored=only` for its perf gates, so a
/// never-passing ignored test poisoned every nightly run; pinning the
/// documented divergence keeps the oracle greppable AND every lane
/// green.)
#[tokio::test]
async fn create_block_apply_then_reverse_leaves_tombstone_i_lifecycle_3() {
    use agaric_lib::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let pre_state = snapshot_blocks(&pool).await;
    assert!(pre_state.is_empty(), "pre-state must be empty");

    let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id("BLK_RT_CB"),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        index: None,
        content: "round-trip create".into(),
    });
    let create_rec = append_op(&pool, create_payload, 1_736_942_400_000).await;
    mat.dispatch_op(&create_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_blocks(&pool).await;
    assert_eq!(post_original.len(), 1, "block must exist after CreateBlock");

    let reverse = compute_reverse(&pool, TEST_DEVICE, create_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_blocks(&pool).await;
    assert_eq!(
        post_reverse.len(),
        1,
        "reverse of create_block must soft-delete (tombstone), not purge; got: {post_reverse:?}"
    );
    let tombstone = &post_reverse[0];
    assert_eq!(tombstone.id, BlockId::test_id("BLK_RT_CB").to_string());
    assert_eq!(
        tombstone.deleted_at,
        Some(1_736_942_460_000),
        "tombstone must carry the reverse op's created_at as deleted_at"
    );
    assert_eq!(
        tombstone.content.as_deref(),
        Some("round-trip create"),
        "soft-delete must preserve content for op-log convergence"
    );
}

/// I-Lifecycle-3 — strict round-trip parity for `add_tag`.
///
/// The pre-existing `reverse_add_tag_produces_remove_tag` test only
/// checks that `compute_reverse` returns the `RemoveTag` variant
/// with the same `(block_id, tag_id)`. This test extends the
/// contract: pre-snapshot `block_tags` (no row) → apply `AddTag` →
/// post-original (one row) → apply `compute_reverse(...)` =
/// `RemoveTag` → post-reverse must equal pre-state (no row).
#[tokio::test]
async fn add_tag_apply_then_reverse_round_trip_i_lifecycle_3() {
    use agaric_lib::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed the target and tag blocks so foreign keys in `block_tags`
    // are satisfied. `apply_op(AddTag)` calls
    // `tag_inheritance::propagate_tag_to_descendants`; with no
    // children the only mutation is the `block_tags` row itself.
    let block_id = BlockId::test_id("BLK_RT_AT");
    let tag_id = BlockId::test_id("TAG_RT_AT");
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'b'), (?, 'tag', 't')",
    )
    .bind(block_id.as_str())
    .bind(tag_id.as_str())
    .execute(&pool)
    .await
    .unwrap();

    let pre_state = snapshot_block_tags(&pool).await;
    assert!(pre_state.is_empty(), "pre-state must have no tag links");

    let add_payload = OpPayload::AddTag(AddTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    });
    let add_rec = append_op(&pool, add_payload, 1_736_942_400_000).await;
    mat.dispatch_op(&add_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_block_tags(&pool).await;
    assert_eq!(
        post_original.len(),
        1,
        "block_tags row must exist after AddTag"
    );

    let reverse = compute_reverse(&pool, TEST_DEVICE, add_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_block_tags(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `block_tags` must equal pre-original (empty); divergence: {post_reverse:?}"
    );
}

/// I-Lifecycle-3 — strict round-trip parity for `remove_tag`.
///
/// The pre-existing `reverse_remove_tag_produces_add_tag` test only
/// checks the returned variant. This test seeds an existing tag
/// link, applies `RemoveTag`, then applies `compute_reverse(...)` =
/// `AddTag`, and asserts the original `(block_id, tag_id)` row is
/// restored verbatim.
#[tokio::test]
async fn remove_tag_apply_then_reverse_round_trip_i_lifecycle_3() {
    use agaric_lib::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block_id = BlockId::test_id("BLK_RT_RT");
    let tag_id = BlockId::test_id("TAG_RT_RT");
    // Seed both blocks and the existing tag link so RemoveTag has
    // something to delete.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'b'), (?, 'tag', 't')",
    )
    .bind(block_id.as_str())
    .bind(tag_id.as_str())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id.as_str())
        .bind(tag_id.as_str())
        .execute(&pool)
        .await
        .unwrap();

    let pre_state = snapshot_block_tags(&pool).await;
    assert_eq!(pre_state.len(), 1, "pre-state must have one tag link");

    let remove_payload = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    });
    let remove_rec = append_op(&pool, remove_payload, 1_736_942_400_000).await;
    mat.dispatch_op(&remove_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_block_tags(&pool).await;
    assert!(
        post_original.is_empty(),
        "block_tags row must be gone after RemoveTag"
    );

    let reverse = compute_reverse(&pool, TEST_DEVICE, remove_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_block_tags(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `block_tags` must equal pre-original; divergence: {post_reverse:?}"
    );
}

/// I-Lifecycle-3 — strict round-trip parity for `add_attachment`.
///
/// The pre-existing `reverse_add_attachment_produces_delete_attachment`
/// test only checks the returned variant. This test pre-snapshots
/// `attachments` (empty), applies `AddAttachment`, snapshots the
/// post-original (one row), then applies `compute_reverse(...)` =
/// `DeleteAttachment` (a hard delete in
/// `materializer::handlers::apply_op_tx`) and asserts the
/// `attachments` table returns to empty.
#[tokio::test]
async fn add_attachment_apply_then_reverse_round_trip_i_lifecycle_3() {
    use agaric_lib::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed the host block so the FK from `attachments.block_id` is
    // satisfied when `apply_op(AddAttachment)` inserts the row.
    let host_block = BlockId::test_id("BLK_RT_AA");
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'host')")
        .bind(host_block.as_str())
        .execute(&pool)
        .await
        .unwrap();

    let pre_state = snapshot_attachments(&pool).await;
    assert!(pre_state.is_empty(), "pre-state must have no attachments");

    let attachment_id = BlockId::test_id("ATT_RT_AA");
    let add_payload = OpPayload::AddAttachment(AddAttachmentPayload {
        attachment_id: attachment_id.clone(),
        block_id: host_block.clone(),
        mime_type: "image/png".into(),
        filename: "rt.png".into(),
        size_bytes: 4096,
        fs_path: "attachments/rt.png".into(),
    });
    let add_rec = append_op(&pool, add_payload, 1_736_942_400_000).await;
    mat.dispatch_op(&add_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_attachments(&pool).await;
    assert_eq!(
        post_original.len(),
        1,
        "attachments row must exist after AddAttachment"
    );

    let reverse = compute_reverse(&pool, TEST_DEVICE, add_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_attachments(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `attachments` must equal pre-original (empty); divergence: {post_reverse:?}"
    );
}

/// Pinning test: `compute_reverse(restore_block)` discards the
/// original `RestoreBlockPayload::deleted_at_ref` and produces a bare
/// `DeleteBlock(block_id)`. A subsequent `cascade_soft_delete`
/// therefore mints a fresh `deleted_at` distinct from the original
/// cascade group's timestamp.
///
/// This pins the current behaviour described in the doc comment on
/// `reverse_restore_block` in `reverse/block_ops.rs`. If a future
/// contributor extends the op payload to carry `deleted_at_ref`
/// through the reverse (with explicit user approval per
/// Architectural Stability), the `assert_ne!` below will need to flip
/// to `assert_eq!`, and the doc comment must be updated in lockstep.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_reverse_restore_discards_deleted_at_ref_m71() {
    let (pool, _dir) = test_pool().await;
    // SQL-review `cascade_soft_delete` / `restore_block` now take
    // `&Materializer` so cache-invalidation dispatch is type-system-
    // enforced. The dispatched tasks are background fire-and-forget;
    // we don't await them here because this test only asserts the
    // op-log shape, not cache state.
    let mat = agaric_lib::materializer::Materializer::new(pool.clone());

    // Seed a block in the `blocks` table so cascade_soft_delete /
    // restore_block have a target. Direct SQL mirrors the inline
    // pattern used by `add_attachment_apply_then_reverse_round_trip_*`
    // earlier in this file; we are not using the materializer here.
    let block_id = "BLKM71";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'm71 fixture', NULL, 1)",
    )
    .bind(block_id)
    .execute(&pool)
    .await
    .unwrap();

    // Step 1: cascade_soft_delete records the original `deleted_at_a`.
    let (deleted_at_a, _count_a) =
        agaric_lib::soft_delete::cascade_soft_delete(&pool, &mat, TEST_DEVICE, block_id)
            .await
            .unwrap();

    // Step 2: restore so the block is alive again, then append a
    // RestoreBlock op carrying `deleted_at_a` so we have a record to
    // feed into compute_reverse.
    agaric_lib::soft_delete::restore_block(&pool, &mat, block_id, deleted_at_a)
        .await
        .unwrap();
    let restore_rec = append_op(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id(block_id),
            deleted_at_ref: deleted_at_a,
        }),
        FIXED_TS,
    )
    .await;

    // Step 3: compute the reverse. it must be bare DeleteBlock —
    // `deleted_at_ref` is intentionally NOT propagated.
    let reverse = compute_reverse(&pool, TEST_DEVICE, restore_rec.seq)
        .await
        .unwrap();
    assert!(
        matches!(&reverse, OpPayload::DeleteBlock(p) if p.block_id == block_id),
        "reverse(RestoreBlock) must be bare DeleteBlock(block_id); got: {reverse:?}"
    );

    // Sleep ≥1ms so the second cascade's millisecond-precision
    // timestamp is guaranteed to differ from `deleted_at_a` (matches
    // the pattern in `soft_delete::tests::cascade_soft_delete_skips_already_deleted_subtree`).
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    // Step 4: apply the reverse — equivalent to what the redo path
    // does in production — and capture the new `deleted_at_b`.
    let (deleted_at_b, _count_b) =
        agaric_lib::soft_delete::cascade_soft_delete(&pool, &mat, TEST_DEVICE, block_id)
            .await
            .unwrap();

    // The asymmetry: the reverse did not carry `deleted_at_ref`
    // through, so the new timestamp is distinct from the original
    // cascade group's timestamp.
    assert_ne!(
        deleted_at_a, deleted_at_b,
        "reverse(RestoreBlock) does not propagate deleted_at_ref, \
         so a subsequent cascade_soft_delete mints a fresh deleted_at. \
         If this assertion ever flips to equal, update the doc comment \
         on `reverse_restore_block` in `reverse/block_ops.rs` to match \
         the new behaviour."
    );
}

// ──────────────────────────────────────────────────────────────────────
// AGENTS.md "Undo/reverse testing" invariants
//
// Pins two contract-level properties of the batch reverse path
// (`revert_ops_inner` in `commands/history.rs` — the function the
// Undo stack actually calls; `compute_reverse` is its single-op
// building block):
//
//   (a) batch-ordering is newest-first by (created_at DESC, seq DESC)
//       — the tie-break on `seq` when `created_at` is identical must
//       hold so a local burst of ops reverses in LIFO order;
//   (b) the op_log is append-only (invariant #1): a revert appends
//       exactly one new op per input and leaves the original row
//       untouched.
//
// Both behaviours are already exercised end-to-end by tests in
// `tests/commands/undo_redo_tests.rs`, but those tests cover the
// full command stack (create_block_inner / edit_block_inner /
// Materializer). The two tests below pin the same invariants at
// this module's level using the bare-pool idioms that dominate
// `reverse/tests.rs` (`append_local_op_at` + direct `op_log` SQL),
// so a regression in the sort predicate or the append contract
// surfaces here even if the command-layer tests drift.
// ──────────────────────────────────────────────────────────────────────

/// Batch-ordering is newest-first by (created_at DESC,
/// seq DESC). Three ops on the same device share an identical
/// `created_at`, so the tie-break falls entirely on `seq`. Passing
/// them oldest-first must yield results in strict seq-descending
/// order.
#[tokio::test]
async fn revert_ops_returns_results_newest_first_by_created_at_desc_seq_desc() {
    use agaric_lib::commands::revert_ops_inner;
    use agaric_lib::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Three SetProperty ops on the same block with distinct keys
    // and the same `created_at`. Each has no prior set_property for
    // its (block, key) pair, so `compute_reverse` returns a bare
    // `DeleteProperty` — `apply_reverse_in_tx` executes an idempotent
    // DELETE with no FK dependency on `blocks`, so no seed row is
    // required.
    let block_id = BlockId::test_id("BLK_BATCH");
    let mk = |key: &str| {
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: block_id.clone(),
            key: key.into(),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        })
    };
    let rec1 = append_op(&pool, mk("k1"), FIXED_TS).await;
    let rec2 = append_op(&pool, mk("k2"), FIXED_TS).await;
    let rec3 = append_op(&pool, mk("k3"), FIXED_TS).await;

    // Sanity: all three share the timestamp (so the sort degenerates
    // to seq DESC) and the auto-assigned seqs are strictly
    // ascending (so a newest-first result is unambiguously
    // distinguishable from insertion order).
    assert_eq!(rec1.created_at, FIXED_TS);
    assert_eq!(rec2.created_at, FIXED_TS);
    assert_eq!(rec3.created_at, FIXED_TS);
    assert!(
        rec1.seq < rec2.seq && rec2.seq < rec3.seq,
        "append_local_op_at must assign ascending seqs; got {}, {}, {}",
        rec1.seq,
        rec2.seq,
        rec3.seq
    );

    // Pass the ops in oldest-first order; the batch must re-sort
    // internally before applying.
    let results = revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![
            OpRef {
                device_id: TEST_DEVICE.into(),
                seq: rec1.seq,
            },
            OpRef {
                device_id: TEST_DEVICE.into(),
                seq: rec2.seq,
            },
            OpRef {
                device_id: TEST_DEVICE.into(),
                seq: rec3.seq,
            },
        ],
    )
    .await
    .unwrap();

    assert_eq!(results.len(), 3, "one result per input op");
    assert_eq!(
        results[0].reversed_op.seq, rec3.seq,
        "newest op (highest seq with identical created_at) must be reversed first"
    );
    assert_eq!(
        results[1].reversed_op.seq, rec2.seq,
        "middle op must be reversed second"
    );
    assert_eq!(
        results[2].reversed_op.seq, rec1.seq,
        "oldest op (lowest seq) must be reversed last"
    );
}

/// Op_log is append-only (invariant #1). Reverting one
/// op must append exactly one new op to the log and leave the
/// original row untouched.
#[tokio::test]
async fn revert_ops_appends_reverse_op_without_mutating_original() {
    use agaric_lib::commands::revert_ops_inner;
    use agaric_lib::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // A single SetProperty. Its reverse is `DeleteProperty` (no
    // prior for this block/key), which applies cleanly without a
    // Seeded block row — see the (a) note above.
    let rec = append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_APPEND"),
            key: "tag".into(),
            value_text: Some("start".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        FIXED_TS,
    )
    .await;

    let count_before: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ?",
        TEST_DEVICE
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![OpRef {
            device_id: TEST_DEVICE.into(),
            seq: rec.seq,
        }],
    )
    .await
    .unwrap();

    let count_after: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ?",
        TEST_DEVICE
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count_after,
        count_before + 1,
        "revert_ops_inner must append exactly one reverse op to op_log"
    );

    // The original row (same (device_id, seq)) must still exist —
    // the op_log is strictly append-only (AGENTS.md invariant #1).
    let original_still_present: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND seq = ?",
        TEST_DEVICE,
        rec.seq,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        original_still_present, 1,
        "original op (device_id={TEST_DEVICE}, seq={}) must remain in op_log after revert",
        rec.seq
    );
}

/// C5 (#344): `revert_ops_inner` must reject a batch larger than
/// `MAX_REVERT_OPS` (1000) with a clean `Validation` error, before any
/// DB work — so a point-in-time restore that sweeps an unbounded op set
/// can never hand the batch helpers a Vec large enough to overflow the
/// SQL bind limit. 1001 refs need no seeding: the cap is checked up
/// front, ahead of the first query.
#[tokio::test]
async fn revert_ops_rejects_batch_over_max_revert_ops_c5() {
    use agaric_lib::commands::revert_ops_inner;
    use agaric_lib::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let ops: Vec<OpRef> = (1..=1001)
        .map(|seq| OpRef {
            device_id: TEST_DEVICE.into(),
            seq,
        })
        .collect();

    let err = revert_ops_inner(&pool, TEST_DEVICE, &mat, ops)
        .await
        .expect_err("C5: a 1001-op batch must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "over-cap batch must surface AppError::Validation, got {err:?}"
    );
}

// ======================================================================
// SQL-review B-3 — parity: batched vs. per-op reverse computation
// ======================================================================

/// #2549 (explicit revert, end-to-end, BATCH path): a full `revert_ops_inner`
/// of a local `edit_block` must materialize the last LOCAL content, not the
/// never-applied replicated audit content. This drives the same
/// `compute_reverse_batch` -> `fetch_prior_text_batch` walk that the real
/// `revert_ops` command uses.
#[tokio::test]
async fn revert_ops_restores_local_content_over_replicated_prior_2549() {
    use agaric_lib::commands::revert_ops_inner;
    use agaric_lib::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let blk = "BLK_2549_E2E";

    // Local create + edit A -> "local-1", both applied.
    let create_rec = append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(blk),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "local-0".into(),
        }),
        1_000,
    )
    .await;
    mat.dispatch_op(&create_rec).await.unwrap();
    let edit_a = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-1".into(),
            prev_edit: None,
        }),
        2_000,
    )
    .await;
    mat.dispatch_op(&edit_a).await.unwrap();

    // Replicated audit edit -> "foreign": lands in op_log but is NOT applied.
    append_replicated_op(
        &pool,
        "remote-dev",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        3_000,
    )
    .await;

    // Local edit B -> "local-2", applied. This is the op we explicitly revert.
    let edit_b = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-2".into(),
            prev_edit: None,
        }),
        4_000,
    )
    .await;
    mat.dispatch_op(&edit_b).await.unwrap();
    mat.flush().await.unwrap();

    // Sanity: applied state is "local-2" before the revert.
    let pre = snapshot_blocks(&pool).await;
    assert_eq!(pre.len(), 1);
    assert_eq!(pre[0].content.as_deref(), Some("local-2"));

    revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![OpRef {
            device_id: edit_b.device_id.clone(),
            seq: edit_b.seq,
        }],
    )
    .await
    .expect("explicit revert of a local edit must succeed");
    mat.flush().await.unwrap();

    let post = snapshot_blocks(&pool).await;
    assert_eq!(post.len(), 1);
    assert_eq!(
        post[0].content.as_deref(),
        Some("local-1"),
        "explicit revert must restore the last LOCAL content, not the never-applied replicated 'foreign' row (#2549)"
    );
}

/// #2549 (provenance guard): `revert_ops` must REFUSE to revert a replicated
/// audit op itself. Such a row was never applied to local state, so applying
/// its inverse would corrupt state by "undoing" a forward effect that never
/// happened on this device. The batch must be rejected with a `Validation`
/// error before any reverse is applied.
#[tokio::test]
async fn revert_ops_rejects_replicated_target_2549() {
    use agaric_lib::commands::revert_ops_inner;
    use agaric_lib::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let blk = "BLK_2549_GUARD";

    let replicated = append_replicated_op(
        &pool,
        "remote-dev",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        3_000,
    )
    .await;

    let err = revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![OpRef {
            device_id: replicated.device_id.clone(),
            seq: replicated.seq,
        }],
    )
    .await
    .expect_err("reverting a replicated audit op must be rejected");
    assert!(
        matches!(err, AppError::Validation { .. }),
        "reverting a replicated audit op must surface AppError::Validation, got {err:?}"
    );
}

// ======================================================================
// #3280 / #3281 — one prev_edit decision, honoured by BOTH reverse
// kernels, and never sourced from a replicated audit row.
// ======================================================================

/// #3644: the STAMPING site. `find_prev_edit_in_tx` picks the causal
/// predecessor that goes into `EditBlockPayload::prev_edit`, and it must be
/// able to name a REPLICATED audit row.
///
/// The scan answers "what is the live value of the block I am about to
/// overwrite". A peer's edit that arrived through Loro is part of that live
/// value even though its `op_log` row is audit-only, so an `is_replicated = 0`
/// predicate here would stamp the pointer at already-superseded text — and
/// for a block that ORIGINATED on a peer it would stamp `None`, leaving the
/// first local edit with nothing to reconstruct from at all.
#[tokio::test]
async fn find_prev_edit_in_tx_stamps_replicated_causal_predecessor_3644() {
    let (pool, _dir) = test_pool().await;
    let blk = "BLK_3281_STAMP";
    let blk_id = BlockId::test_id(blk);

    let local = append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: blk_id.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "seed".into(),
        }),
        1_000,
    )
    .await;
    // Higher `seq` than any local row, so `ORDER BY seq DESC` prefers it —
    // and it genuinely is the newer value, applied here through Loro.
    let foreign = append_replicated_op(
        &pool,
        "remote-dev",
        99,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: blk_id.clone(),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        2_000,
    )
    .await;

    let mut conn = pool.acquire().await.unwrap();
    let prev = agaric_lib::commands::blocks::find_prev_edit_in_tx(&mut conn, blk_id.as_str())
        .await
        .unwrap();
    assert_eq!(
        prev,
        Some((foreign.device_id.clone(), foreign.seq)),
        "#3644: prev_edit must be stamped at the latest edit/create in causal \
         order, replicated included — that is the value being overwritten. \
         Got the older local row {local:?} instead",
        local = (local.device_id.clone(), local.seq)
    );
}
