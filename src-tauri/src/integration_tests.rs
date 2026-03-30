//! Cross-module integration tests for the full command pipeline.
//!
//! These tests exercise the complete path through the system:
//! create block → op log → materializer → cache rebuild → pagination →
//! soft-delete → restore → purge. They verify that modules work together
//! correctly, not just individually.
//!
//! # Test groups
//!
//! 1. **Op ordering & hash chains** — sequential ops, parent_seqs linkage,
//!    blake3 hash uniqueness and determinism.
//! 2. **Crash recovery** — empty DB, unflushed drafts, already-flushed drafts,
//!    drafts with prior edits.
//! 3. **Cascade delete & purge** — three-level tree delete, independent delete
//!    preservation, purge of related rows, purge of cascaded subtrees.
//! 4. **Pagination** — cursor walk, soft-delete filtering, type filtering,
//!    empty database, exact page boundaries.
//! 5. **Position handling** — ordering by position, position preservation on edit.
//! 6. **Materializer dispatch** — background task processing verification.
//! 7. **Edit sequences** — edit-then-delete content preservation.

use crate::commands::*;
use crate::db::init_pool;
use crate::draft;
use crate::hash;
use crate::materializer::Materializer;
use crate::op::{EditBlockPayload, OpPayload};
use crate::op_log;
use crate::recovery;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tempfile::TempDir;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Device ID used across all integration tests.
const DEV: &str = "test-device-integration";
const TYPE_CONTENT: &str = "content";
const TYPE_PAGE: &str = "page";
const TYPE_TAG: &str = "tag";
/// Far-future timestamp — ensures no existing op can match (used for draft simulation).
const FAR_FUTURE_TS: &str = "2099-01-01T00:00:00Z";
/// Far-past timestamp — ensures any real op will be newer (used for already-flushed drafts).
const PAST_TS: &str = "2000-01-01T00:00:00Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Create a temporary SQLite pool with all migrations applied.
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Shorthand: create a content-type block (the most common case in tests).
///
/// Content-type creates dispatch NO background materializer tasks,
/// so consecutive calls need no sleep between them.
async fn create_content(
    pool: &SqlitePool,
    mat: &Materializer,
    content: &str,
    parent_id: Option<String>,
    position: Option<i64>,
) -> BlockResponse {
    create_block_inner(
        pool,
        DEV,
        mat,
        TYPE_CONTENT.into(),
        content.into(),
        parent_id,
        position,
    )
    .await
    .unwrap()
}

/// Allow materializer background tasks to settle before the next write.
///
/// Required after operations that dispatch bg cache-rebuild tasks:
/// edit, delete, restore, purge, or create with type "page"/"tag".
/// NOT needed after creating "content" blocks (no bg tasks dispatched).
///
/// The 50 ms window is sufficient for the background consumer to process
/// its queue. Without this, the next `BEGIN IMMEDIATE` write may contend
/// with the materializer's cache-rebuild transaction under WAL mode.
async fn settle_bg_tasks() {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}

// ======================================================================
// Group 1: Op ordering & hash chains
// ======================================================================

/// The full create → edit → delete → restore pipeline produces four
/// sequential ops with correct types, parent linkage, and valid hashes.
/// The final block state reflects the edit and successful restore.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_edit_delete_restore_produces_sequential_ops_with_valid_hashes() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let created = create_content(&pool, &mat, "hello world", None, Some(1)).await;
    let block_id = created.id.clone();

    edit_block_inner(&pool, DEV, &mat, block_id.clone(), "updated text".into())
        .await
        .unwrap();
    settle_bg_tasks().await;

    let deleted = delete_block_inner(&pool, DEV, &mat, block_id.clone())
        .await
        .unwrap();
    let deleted_at = deleted.deleted_at.clone();
    settle_bg_tasks().await;

    restore_block_inner(&pool, DEV, &mat, block_id.clone(), deleted_at)
        .await
        .unwrap();

    // Verify 4 sequential ops with correct types
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 4, "pipeline should produce exactly 4 ops");

    let expected_types = [
        "create_block",
        "edit_block",
        "delete_block",
        "restore_block",
    ];
    for (i, expected_type) in expected_types.iter().enumerate() {
        assert_eq!(
            ops[i].seq,
            (i + 1) as i64,
            "op {i} should have seq {}",
            i + 1
        );
        assert_eq!(ops[i].op_type, *expected_type, "op {i} type mismatch");
    }

    // Genesis op has no parents; subsequent ops chain to predecessor
    assert!(
        ops[0].parent_seqs.is_none(),
        "genesis op has null parent_seqs"
    );
    for (idx, op) in ops.iter().enumerate().skip(1) {
        let parents = op.parsed_parent_seqs().unwrap().unwrap();
        assert_eq!(
            parents,
            vec![(DEV.to_string(), idx as i64)],
            "op {} must reference op {idx}",
            idx + 1
        );
    }

    // All hashes are unique and deterministically verifiable
    let hashes: HashSet<&str> = ops.iter().map(|o| o.hash.as_str()).collect();
    assert_eq!(hashes.len(), 4, "all 4 hashes must be unique");
    for op in &ops {
        assert_eq!(op.hash.len(), 64, "blake3 hash should be 64 hex chars");
        let recomputed = hash::compute_op_hash(
            &op.device_id,
            op.seq,
            op.parent_seqs.as_deref(),
            &op.op_type,
            &op.payload,
        );
        assert_eq!(op.hash, recomputed, "hash mismatch at seq={}", op.seq);
    }

    // Block state: alive with edited content after restore
    let block = get_block_inner(&pool, block_id).await.unwrap();
    assert!(
        block.deleted_at.is_none(),
        "block should be alive after restore"
    );
    assert_eq!(
        block.content,
        Some("updated text".into()),
        "edit should persist through delete+restore"
    );
}

/// Five sequential creates produce a hash chain where each op references
/// its predecessor via parent_seqs and each hash is unique and deterministic.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hash_chain_links_each_op_to_its_predecessor() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    for i in 0..5 {
        create_content(
            &pool,
            &mat,
            &format!("block {i}"),
            None,
            Some((i + 1) as i64),
        )
        .await;
    }

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 5, "should have 5 ops for 5 creates");

    let mut seen_hashes = HashSet::new();
    for (i, op) in ops.iter().enumerate() {
        let seq = (i + 1) as i64;
        assert_eq!(op.seq, seq, "op {i} should have seq {seq}");

        if seq == 1 {
            assert!(
                op.parent_seqs.is_none(),
                "genesis op must have null parent_seqs"
            );
        } else {
            let parents = op.parsed_parent_seqs().unwrap().unwrap();
            assert_eq!(
                parents,
                vec![(DEV.to_string(), seq - 1)],
                "op {seq} must reference op {}",
                seq - 1
            );
        }

        assert!(
            seen_hashes.insert(op.hash.clone()),
            "hash for seq {seq} must be unique"
        );
        let recomputed = hash::compute_op_hash(
            &op.device_id,
            op.seq,
            op.parent_seqs.as_deref(),
            &op.op_type,
            &op.payload,
        );
        assert_eq!(
            op.hash, recomputed,
            "hash must be deterministic for seq {seq}"
        );
    }
}

/// Creating 3 blocks, editing one, and deleting another produces the
/// correct op type counts and leaves blocks in the expected state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mixed_operations_produce_consistent_op_log_and_block_state() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let b0 = create_content(&pool, &mat, "content 0", None, Some(1)).await;
    let b1 = create_content(&pool, &mat, "content 1", None, Some(2)).await;
    let b2 = create_content(&pool, &mat, "content 2", None, Some(3)).await;

    edit_block_inner(&pool, DEV, &mat, b0.id.clone(), "edited 0".into())
        .await
        .unwrap();
    settle_bg_tasks().await;

    delete_block_inner(&pool, DEV, &mat, b2.id.clone())
        .await
        .unwrap();

    // 3 creates + 1 edit + 1 delete = 5 ops
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 5, "3 creates + 1 edit + 1 delete = 5 ops");

    let creates = ops.iter().filter(|o| o.op_type == "create_block").count();
    let edits = ops.iter().filter(|o| o.op_type == "edit_block").count();
    let deletes = ops.iter().filter(|o| o.op_type == "delete_block").count();
    assert_eq!(creates, 3, "should have 3 create ops");
    assert_eq!(edits, 1, "should have 1 edit op");
    assert_eq!(deletes, 1, "should have 1 delete op");

    // Block state matches operations
    let fetched_b0 = get_block_inner(&pool, b0.id).await.unwrap();
    assert_eq!(
        fetched_b0.content,
        Some("edited 0".into()),
        "b0 should reflect edit"
    );
    assert!(fetched_b0.deleted_at.is_none(), "b0 should be alive");

    let fetched_b1 = get_block_inner(&pool, b1.id).await.unwrap();
    assert_eq!(
        fetched_b1.content,
        Some("content 1".into()),
        "b1 should be untouched"
    );

    let fetched_b2 = get_block_inner(&pool, b2.id).await.unwrap();
    assert!(fetched_b2.deleted_at.is_some(), "b2 should be soft-deleted");
}

// ======================================================================
// Group 2: Crash recovery simulation
// ======================================================================

/// Recovery on an empty database reports zero counts and creates no ops.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_on_empty_database_is_noop() {
    let (pool, _dir) = test_pool().await;

    let report = recovery::recover_at_boot(&pool, DEV).await.unwrap();

    assert_eq!(report.pending_snapshots_deleted, 0, "no pending snapshots");
    assert!(report.drafts_recovered.is_empty(), "no drafts to recover");
    assert_eq!(report.drafts_already_flushed, 0, "no flushed drafts");
    assert!(report.draft_errors.is_empty(), "no errors");

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert!(ops.is_empty(), "op_log should remain empty");
}

/// An unflushed draft (simulating a crash before flush) is recovered as
/// a synthetic edit_block op, and the draft row is cleaned up.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_flushes_unflushed_draft_as_edit_op() {
    let (pool, _dir) = test_pool().await;

    // F07: recovery now checks that the block exists before recovering a draft
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'content', ?, 0)",
    )
    .bind("DRAFT-BLOCK-001")
    .bind("old content")
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("DRAFT-BLOCK-001")
        .bind("draft content")
        .bind(FAR_FUTURE_TS)
        .execute(&pool)
        .await
        .unwrap();

    let report = recovery::recover_at_boot(&pool, DEV).await.unwrap();

    assert_eq!(
        report.drafts_recovered,
        vec!["DRAFT-BLOCK-001"],
        "draft should be recovered"
    );
    assert_eq!(report.drafts_already_flushed, 0);

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1, "one synthetic edit op");
    assert_eq!(ops[0].op_type, "edit_block");
    assert!(
        ops[0].payload.contains("DRAFT-BLOCK-001"),
        "payload references block ID"
    );
    assert!(
        ops[0].payload.contains("draft content"),
        "payload contains draft text"
    );

    let drafts = draft::get_all_drafts(&pool).await.unwrap();
    assert!(
        drafts.is_empty(),
        "draft row should be deleted after recovery"
    );
}

/// A draft with a matching op already in op_log (already flushed before crash)
/// is deleted without creating a duplicate op.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_skips_already_flushed_draft_without_duplicate() {
    let (pool, _dir) = test_pool().await;

    // F07: recovery now checks that the block exists before recovering a draft
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) VALUES (?, 'content', ?, 0)",
    )
    .bind("FLUSHED-BLOCK")
    .bind("flushed content")
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("FLUSHED-BLOCK")
        .bind("flushed content")
        .bind(PAST_TS)
        .execute(&pool)
        .await
        .unwrap();

    // Insert a matching edit op with a timestamp after the draft's updated_at
    let payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: "FLUSHED-BLOCK".into(),
        to_text: "flushed content".into(),
        prev_edit: None,
    });
    op_log::append_local_op(&pool, DEV, payload).await.unwrap();

    let ops_before = op_log::get_ops_since(&pool, DEV, 0).await.unwrap().len();

    let report = recovery::recover_at_boot(&pool, DEV).await.unwrap();

    assert!(report.drafts_recovered.is_empty(), "no new recovery needed");
    assert_eq!(
        report.drafts_already_flushed, 1,
        "one draft already flushed"
    );

    let ops_after = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(
        ops_after.len(),
        ops_before,
        "op count unchanged — no duplicate"
    );

    let drafts = draft::get_all_drafts(&pool).await.unwrap();
    assert!(drafts.is_empty(), "draft row should be deleted");
}

/// When recovering an unflushed draft that has prior edits in op_log,
/// the synthetic edit_block op should include a prev_edit reference.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recovery_unflushed_draft_with_prior_edit_includes_prev_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block and edit it to establish prior edit history
    let block = create_content(&pool, &mat, "version 1", None, Some(1)).await;
    edit_block_inner(&pool, DEV, &mat, block.id.clone(), "version 2".into())
        .await
        .unwrap();
    settle_bg_tasks().await;

    // Simulate crash: insert draft with newer content
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind(&block.id)
        .bind("version 3 from draft")
        .bind(FAR_FUTURE_TS)
        .execute(&pool)
        .await
        .unwrap();

    let ops_before = op_log::get_ops_since(&pool, DEV, 0).await.unwrap().len();

    let report = recovery::recover_at_boot(&pool, DEV).await.unwrap();

    assert_eq!(report.drafts_recovered.len(), 1, "one draft recovered");
    assert_eq!(report.drafts_recovered[0], block.id);

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), ops_before + 1, "one new op from recovery");

    let recovery_op = ops.last().unwrap();
    assert_eq!(recovery_op.op_type, "edit_block");

    let payload: serde_json::Value = serde_json::from_str(&recovery_op.payload).unwrap();
    assert!(
        !payload["prev_edit"].is_null(),
        "recovery edit should reference the prior edit via prev_edit"
    );
    assert_eq!(
        payload["to_text"].as_str().unwrap(),
        "version 3 from draft",
        "recovery edit should contain draft content"
    );
}

// ======================================================================
// Group 3: Cascade delete & purge
// ======================================================================

/// Deleting a parent with two levels of descendants marks all three
/// blocks with the same deletion timestamp.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cascade_delete_marks_three_levels_with_same_timestamp() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_content(&pool, &mat, "parent", None, Some(1)).await;
    let child = create_content(&pool, &mat, "child", Some(parent.id.clone()), Some(1)).await;
    let grandchild =
        create_content(&pool, &mat, "grandchild", Some(child.id.clone()), Some(1)).await;

    let del = delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    let cascade_ts = del.deleted_at.clone();

    let p = get_block_inner(&pool, parent.id).await.unwrap();
    let c = get_block_inner(&pool, child.id).await.unwrap();
    let g = get_block_inner(&pool, grandchild.id).await.unwrap();

    assert_eq!(p.deleted_at, Some(cascade_ts.clone()), "parent deleted");
    assert_eq!(
        c.deleted_at,
        Some(cascade_ts.clone()),
        "child cascade-deleted"
    );
    assert_eq!(g.deleted_at, Some(cascade_ts), "grandchild cascade-deleted");
}

/// When child1 is independently deleted then the parent is cascade-deleted,
/// restoring the parent brings back child2 but leaves child1 deleted with
/// its original timestamp.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_after_cascade_preserves_independently_deleted_child() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_content(&pool, &mat, "parent", None, Some(1)).await;
    let child1 = create_content(&pool, &mat, "child1", Some(parent.id.clone()), Some(1)).await;
    let child2 = create_content(&pool, &mat, "child2", Some(parent.id.clone()), Some(2)).await;

    // Delete child1 independently
    let child1_del = delete_block_inner(&pool, DEV, &mat, child1.id.clone())
        .await
        .unwrap();
    let child1_ts = child1_del.deleted_at.clone();
    settle_bg_tasks().await;

    // Delete parent (cascades to child2 only; child1 already deleted)
    let parent_del = delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    let cascade_ts = parent_del.deleted_at.clone();
    settle_bg_tasks().await;

    // child1 keeps its own timestamp
    let c1 = get_block_inner(&pool, child1.id.clone()).await.unwrap();
    assert_eq!(
        c1.deleted_at,
        Some(child1_ts.clone()),
        "child1 retains independent delete timestamp"
    );

    // Restore parent using cascade timestamp
    restore_block_inner(&pool, DEV, &mat, parent.id.clone(), cascade_ts)
        .await
        .unwrap();

    let p = get_block_inner(&pool, parent.id).await.unwrap();
    assert!(p.deleted_at.is_none(), "parent restored");

    let c2 = get_block_inner(&pool, child2.id).await.unwrap();
    assert!(
        c2.deleted_at.is_none(),
        "child2 restored (shared cascade timestamp)"
    );

    let c1_after = get_block_inner(&pool, child1.id).await.unwrap();
    assert_eq!(
        c1_after.deleted_at,
        Some(child1_ts),
        "child1 still deleted (independent timestamp)"
    );
}

/// Purging a block physically removes it from blocks, block_tags,
/// block_properties, and attachments. Op log entries are preserved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_removes_block_tags_properties_and_attachments() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_content(&pool, &mat, "to be purged", None, Some(1)).await;
    let bid = block.id.clone();

    let tag = create_block_inner(
        &pool,
        DEV,
        &mat,
        TYPE_TAG.into(),
        "my-tag".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle_bg_tasks().await;

    // Add tag association, property, and attachment
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(&bid)
        .bind(&tag.id)
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(&bid)
        .bind("priority")
        .bind("high")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ATT-001")
    .bind(&bid)
    .bind("text/plain")
    .bind("readme.txt")
    .bind(256_i64)
    .bind("/tmp/readme.txt")
    .bind("2024-01-01T00:00:00Z")
    .execute(&pool)
    .await
    .unwrap();

    // Verify related rows exist before purge
    let count_tags: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags WHERE block_id = ?", bid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count_tags, 1, "tag association exists before purge");

    let count_props: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ?",
        bid
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count_props, 1, "property exists before purge");

    let count_atts: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM attachments WHERE block_id = ?", bid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count_atts, 1, "attachment exists before purge");

    // Soft-delete (required before purge)
    delete_block_inner(&pool, DEV, &mat, bid.clone())
        .await
        .unwrap();
    settle_bg_tasks().await;

    // Purge
    let purge = purge_block_inner(&pool, DEV, &mat, bid.clone())
        .await
        .unwrap();
    assert_eq!(purge.purged_count, 1, "one block purged");

    // Verify all related data is physically gone
    let block_gone: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", bid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(block_gone, 0, "block physically removed");

    let tags_gone: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags WHERE block_id = ?", bid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(tags_gone, 0, "tag associations removed");

    let props_gone: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = ?",
        bid
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(props_gone, 0, "properties removed");

    let atts_gone: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM attachments WHERE block_id = ?", bid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(atts_gone, 0, "attachments removed");

    // Op log preserved (append-only log is never purged)
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert!(!ops.is_empty(), "op_log entries preserved after purge");
    assert_eq!(ops.len(), 4, "create(block) + create(tag) + delete + purge");
    assert_eq!(ops[2].op_type, "delete_block");
    assert_eq!(ops[3].op_type, "purge_block");
}

/// Purging a cascade-deleted parent physically removes both parent and
/// child from the blocks table.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_after_cascade_removes_entire_subtree() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_content(&pool, &mat, "parent", None, Some(1)).await;
    let child = create_content(&pool, &mat, "child", Some(parent.id.clone()), Some(1)).await;

    // Cascade soft-delete
    delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    settle_bg_tasks().await;

    // Purge parent (recursive CTE removes child too)
    let purge = purge_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    assert_eq!(purge.purged_count, 2, "parent + child physically purged");

    let parent_gone: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", parent.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(parent_gone, 0, "parent physically removed");

    let child_gone: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", child.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(child_gone, 0, "child physically removed");
}

// ======================================================================
// Group 4: Pagination
// ======================================================================

/// Listing blocks on an empty database returns no items with has_more=false.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pagination_on_empty_database_returns_no_items() {
    let (pool, _dir) = test_pool().await;

    let resp = list_blocks_inner(&pool, None, None, None, None, None, None, Some(50))
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "empty database should return no items"
    );
    assert!(!resp.has_more, "empty database should have no more pages");
    assert!(
        resp.next_cursor.is_none(),
        "empty database should have no cursor"
    );
}

/// Live blocks are excluded from trash listing, and deleted blocks are
/// excluded from normal listing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_excludes_soft_deleted_blocks_and_trash_shows_only_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let mut ids = Vec::new();
    for i in 0..5 {
        ids.push(
            create_content(
                &pool,
                &mat,
                &format!("block {i}"),
                None,
                Some((i + 1) as i64),
            )
            .await
            .id,
        );
    }

    delete_block_inner(&pool, DEV, &mat, ids[0].clone())
        .await
        .unwrap();
    settle_bg_tasks().await;
    delete_block_inner(&pool, DEV, &mat, ids[1].clone())
        .await
        .unwrap();

    let live = list_blocks_inner(&pool, None, None, None, None, None, None, Some(50))
        .await
        .unwrap();
    assert_eq!(live.items.len(), 3, "should show 3 live blocks");

    let trash = list_blocks_inner(&pool, None, None, None, Some(true), None, None, Some(50))
        .await
        .unwrap();
    assert_eq!(
        trash.items.len(),
        2,
        "should show 2 deleted blocks in trash"
    );
}

/// Cursor-based pagination walks all blocks across multiple pages
/// without duplicates or missing items.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cursor_pagination_walks_all_blocks_without_duplicates() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    const TOTAL: usize = 12;
    const PAGE_SIZE: i64 = 5;

    let mut created_ids = Vec::new();
    for i in 0..TOTAL {
        created_ids.push(
            create_content(
                &pool,
                &mat,
                &format!("block {i}"),
                None,
                Some((i + 1) as i64),
            )
            .await
            .id,
        );
    }

    let mut all_ids = Vec::new();
    let mut cursor: Option<String> = None;
    let mut page_count = 0;
    loop {
        let page = list_blocks_inner(&pool, None, None, None, None, None, cursor, Some(PAGE_SIZE))
            .await
            .unwrap();
        for item in &page.items {
            all_ids.push(item.id.clone());
        }
        page_count += 1;
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }

    assert_eq!(all_ids.len(), TOTAL, "should collect all {TOTAL} blocks");
    assert!(page_count >= 2, "should require multiple pages");

    let unique: HashSet<&str> = all_ids.iter().map(|s| s.as_str()).collect();
    assert_eq!(unique.len(), TOTAL, "no duplicate blocks across pages");
}

/// When the total number of blocks equals exactly one page size,
/// pagination returns all items in one page with has_more=false.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pagination_with_exact_page_boundary_terminates_correctly() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    const PAGE_SIZE: i64 = 5;
    for i in 0..PAGE_SIZE {
        create_content(&pool, &mat, &format!("block {i}"), None, Some(i + 1)).await;
    }

    let page = list_blocks_inner(&pool, None, None, None, None, None, None, Some(PAGE_SIZE))
        .await
        .unwrap();

    assert_eq!(
        page.items.len(),
        PAGE_SIZE as usize,
        "all blocks fit on first page"
    );
    assert!(!page.has_more, "no extra page when count equals page size");
    assert!(
        page.next_cursor.is_none(),
        "no cursor when everything fits in one page"
    );
}

/// Filtering by block_type returns only blocks of that type.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_by_type_filters_to_matching_block_type() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // 3 content, 2 page, 1 tag
    for i in 0..3 {
        create_content(
            &pool,
            &mat,
            &format!("content {i}"),
            None,
            Some((i + 1) as i64),
        )
        .await;
    }
    for i in 0..2 {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            TYPE_PAGE.into(),
            format!("page {i}"),
            None,
            Some((10 + i) as i64),
        )
        .await
        .unwrap();
        settle_bg_tasks().await;
    }
    create_block_inner(
        &pool,
        DEV,
        &mat,
        TYPE_TAG.into(),
        "my-tag".into(),
        None,
        None,
    )
    .await
    .unwrap();
    settle_bg_tasks().await;

    let content_resp = list_blocks_inner(
        &pool,
        None,
        Some(TYPE_CONTENT.into()),
        None,
        None,
        None,
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert_eq!(content_resp.items.len(), 3, "3 content blocks");

    let page_resp = list_blocks_inner(
        &pool,
        None,
        Some(TYPE_PAGE.into()),
        None,
        None,
        None,
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert_eq!(page_resp.items.len(), 2, "2 page blocks");

    let tag_resp = list_blocks_inner(
        &pool,
        None,
        Some(TYPE_TAG.into()),
        None,
        None,
        None,
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert_eq!(tag_resp.items.len(), 1, "1 tag block");
}

// ======================================================================
// Group 5: Position handling
// ======================================================================

/// Children created with out-of-order positions are returned sorted
/// by position ascending.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn children_listed_in_position_order() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = create_content(&pool, &mat, "parent", None, Some(1)).await;

    // Create children with positions 3, 1, 2 (deliberately out of order)
    let c3 = create_content(&pool, &mat, "pos 3", Some(parent.id.clone()), Some(3)).await;
    let c1 = create_content(&pool, &mat, "pos 1", Some(parent.id.clone()), Some(1)).await;
    let c2 = create_content(&pool, &mat, "pos 2", Some(parent.id.clone()), Some(2)).await;

    let children = list_blocks_inner(
        &pool,
        Some(parent.id.clone()),
        None,
        None,
        None,
        None,
        None,
        Some(50),
    )
    .await
    .unwrap();

    assert_eq!(children.items.len(), 3, "should list all 3 children");
    assert_eq!(children.items[0].id, c1.id, "first by position");
    assert_eq!(children.items[1].id, c2.id, "second by position");
    assert_eq!(children.items[2].id, c3.id, "third by position");
    assert_eq!(children.items[0].position, Some(1));
    assert_eq!(children.items[1].position, Some(2));
    assert_eq!(children.items[2].position, Some(3));
}

/// Editing a block's content does not change its position.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_content_preserves_position() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_content(&pool, &mat, "original", None, Some(5)).await;
    assert_eq!(block.position, Some(5), "initial position");

    let edited = edit_block_inner(&pool, DEV, &mat, block.id.clone(), "updated".into())
        .await
        .unwrap();

    assert_eq!(edited.position, Some(5), "position must not change on edit");
    assert_eq!(edited.content, Some("updated".into()));

    let fetched = get_block_inner(&pool, block.id).await.unwrap();
    assert_eq!(fetched.position, Some(5), "DB position must be unchanged");
}

// ======================================================================
// Group 6: Materializer background dispatch
// ======================================================================

/// Creating a page block triggers at least one background materializer
/// task (RebuildPagesCache).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn materializer_processes_background_tasks_after_page_create() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    create_block_inner(
        &pool,
        DEV,
        &mat,
        TYPE_PAGE.into(),
        "my page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Allow 200ms for the background consumer to fully process the cache-rebuild
    // task (RebuildPagesCache). 200ms provides margin because the consumer's poll
    // interval is ~10ms, but the SQLite write + cache rebuild adds I/O latency.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let bg = mat.metrics().bg_processed.load(Ordering::Relaxed);
    assert!(
        bg >= 1,
        "expected at least 1 background task processed for page creation, got {bg}"
    );
}

/// Editing a block triggers at least one background materializer task
/// (ReindexBlockLinks + RebuildPagesCache).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn materializer_processes_background_tasks_after_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_content(&pool, &mat, "original", None, Some(1)).await;

    // Allow 100ms for create-related background tasks to settle. The consumer
    // polls every ~10ms; 100ms gives ~10 poll cycles which is sufficient for
    // the create_block cache tasks (tags/pages/links) to complete.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let bg_before = mat.metrics().bg_processed.load(Ordering::Relaxed);

    edit_block_inner(&pool, DEV, &mat, block.id, "edited".into())
        .await
        .unwrap();

    // Allow 200ms for the background consumer to fully process the edit tasks
    // (ReindexBlockLinks + potential RebuildPagesCache). 200ms provides margin
    // because the consumer processes tasks sequentially with ~10ms poll interval,
    // and each cache write involves an SQLite transaction.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let bg_after = mat.metrics().bg_processed.load(Ordering::Relaxed);
    let bg_delta = bg_after - bg_before;
    assert!(
        bg_delta >= 1,
        "expected at least 1 new background task after edit, got delta {bg_delta}"
    );
}

// ======================================================================
// Group 7: Edit sequences
// ======================================================================

/// Editing a block and then soft-deleting it preserves the edited content
/// in the deleted block row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_then_delete_preserves_edited_content_in_trash() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_content(&pool, &mat, "version 1", None, Some(1)).await;

    edit_block_inner(&pool, DEV, &mat, block.id.clone(), "version 2".into())
        .await
        .unwrap();
    settle_bg_tasks().await;

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    let fetched = get_block_inner(&pool, block.id).await.unwrap();
    assert!(fetched.deleted_at.is_some(), "block should be soft-deleted");
    assert_eq!(
        fetched.content,
        Some("version 2".into()),
        "edited content should be preserved in trash"
    );
}
