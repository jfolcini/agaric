//! Integration tests exercising the full command pipeline:
//! command -> op_log -> blocks table -> pagination.
//!
//! These tests verify that modules work together correctly, not just
//! individually. Covers: op ordering, hash chains, crash recovery,
//! cascade delete, position compaction, and materializer dispatch.

use crate::commands::*;
use crate::db::init_pool;
use crate::draft;
use crate::hash;
use crate::materializer::Materializer;
use crate::op_log;
use crate::recovery;
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tempfile::TempDir;

/// Create a temporary SQLite pool with migrations applied.
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

const DEV: &str = "test-device-integration";

// ======================================================================
// Group 1: Op ordering & hash chains
// ======================================================================

/// Create a block, edit it, delete it, restore it. Verify each op in
/// op_log has correct seq, parent_seqs, and hash chain.
#[tokio::test]
async fn full_pipeline_create_edit_delete_restore() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // 1. Create a block
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "hello world".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let block_id = created.id.clone();

    // 2. Edit it
    edit_block_inner(&pool, DEV, &mat, block_id.clone(), "updated text".into())
        .await
        .unwrap();
    // Allow bg tasks (ReindexBlockLinks, RebuildPagesCache) to settle
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // 3. Delete it
    let deleted = delete_block_inner(&pool, DEV, &mat, block_id.clone())
        .await
        .unwrap();
    let deleted_at = deleted.deleted_at.clone();
    // Allow bg tasks (Rebuild 3 caches) to settle
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // 4. Restore it
    restore_block_inner(&pool, DEV, &mat, block_id.clone(), deleted_at)
        .await
        .unwrap();

    // Verify op_log has 4 ops with correct types and sequential seqs
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 4);

    assert_eq!(ops[0].seq, 1);
    assert_eq!(ops[0].op_type, "create_block");
    assert!(ops[0].parent_seqs.is_none(), "genesis op has null parents");

    assert_eq!(ops[1].seq, 2);
    assert_eq!(ops[1].op_type, "edit_block");
    let ps1: Vec<(String, i64)> =
        serde_json::from_str(ops[1].parent_seqs.as_ref().unwrap()).unwrap();
    assert_eq!(ps1, vec![(DEV.to_string(), 1)]);

    assert_eq!(ops[2].seq, 3);
    assert_eq!(ops[2].op_type, "delete_block");
    let ps2: Vec<(String, i64)> =
        serde_json::from_str(ops[2].parent_seqs.as_ref().unwrap()).unwrap();
    assert_eq!(ps2, vec![(DEV.to_string(), 2)]);

    assert_eq!(ops[3].seq, 4);
    assert_eq!(ops[3].op_type, "restore_block");
    let ps3: Vec<(String, i64)> =
        serde_json::from_str(ops[3].parent_seqs.as_ref().unwrap()).unwrap();
    assert_eq!(ps3, vec![(DEV.to_string(), 3)]);

    // Verify each hash is unique and verifiable
    let hashes: HashSet<&str> = ops.iter().map(|o| o.hash.as_str()).collect();
    assert_eq!(hashes.len(), 4, "all hashes must be unique");

    for op in &ops {
        assert_eq!(op.hash.len(), 64);
        let recomputed = hash::compute_op_hash(
            &op.device_id,
            op.seq,
            op.parent_seqs.as_deref(),
            &op.op_type,
            &op.payload,
        );
        assert_eq!(
            op.hash, recomputed,
            "hash must match recomputed for seq={}",
            op.seq
        );
    }

    // Verify block is alive after restore with edited content
    let block = get_block_inner(&pool, block_id).await.unwrap();
    assert!(block.deleted_at.is_none());
    assert_eq!(block.content, Some("updated text".into()));
}

/// Create 10 blocks, verify that each op's parent_seqs points to the
/// previous op's [device_id, seq], and each hash is unique and deterministic.
#[tokio::test]
async fn hash_chain_integrity_across_operations() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    for i in 0..10 {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some(i as i64),
        )
        .await
        .unwrap();
    }

    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 10);

    let mut seen_hashes = HashSet::new();
    for (i, op) in ops.iter().enumerate() {
        let seq = (i + 1) as i64;
        assert_eq!(op.seq, seq);

        // Verify parent_seqs chain
        if seq == 1 {
            assert!(
                op.parent_seqs.is_none(),
                "genesis op must have null parent_seqs"
            );
        } else {
            let parents: Vec<(String, i64)> =
                serde_json::from_str(op.parent_seqs.as_ref().unwrap()).unwrap();
            assert_eq!(
                parents,
                vec![(DEV.to_string(), seq - 1)],
                "op {seq} must reference op {}",
                seq - 1
            );
        }

        // Verify hash uniqueness and determinism
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

/// Create several blocks, edit some, delete others. Query op_log and
/// blocks table, verify they're consistent.
#[tokio::test]
async fn op_log_records_match_blocks_state() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 5 blocks
    let mut ids = Vec::new();
    for i in 0..5 {
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("content {i}"),
            None,
            Some(i as i64),
        )
        .await
        .unwrap();
        ids.push(resp.id);
    }

    // Edit blocks 0 and 1
    edit_block_inner(&pool, DEV, &mat, ids[0].clone(), "edited 0".into())
        .await
        .unwrap();
    // Allow background tasks (ReindexBlockLinks, RebuildPagesCache) to settle
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    edit_block_inner(&pool, DEV, &mat, ids[1].clone(), "edited 1".into())
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Delete blocks 3 and 4
    delete_block_inner(&pool, DEV, &mat, ids[3].clone())
        .await
        .unwrap();
    // Allow background tasks (RebuildTagsCache, RebuildPagesCache, RebuildAgendaCache) to settle
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    delete_block_inner(&pool, DEV, &mat, ids[4].clone())
        .await
        .unwrap();

    // Verify op_log: 5 creates + 2 edits + 2 deletes = 9 ops
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 9);

    let create_count = ops.iter().filter(|o| o.op_type == "create_block").count();
    let edit_count = ops.iter().filter(|o| o.op_type == "edit_block").count();
    let delete_count = ops.iter().filter(|o| o.op_type == "delete_block").count();
    assert_eq!(create_count, 5);
    assert_eq!(edit_count, 2);
    assert_eq!(delete_count, 2);

    // Verify blocks state matches op effects
    let b0 = get_block_inner(&pool, ids[0].clone()).await.unwrap();
    assert_eq!(b0.content, Some("edited 0".into()));
    assert!(b0.deleted_at.is_none());

    let b1 = get_block_inner(&pool, ids[1].clone()).await.unwrap();
    assert_eq!(b1.content, Some("edited 1".into()));
    assert!(b1.deleted_at.is_none());

    let b2 = get_block_inner(&pool, ids[2].clone()).await.unwrap();
    assert_eq!(b2.content, Some("content 2".into()));
    assert!(b2.deleted_at.is_none());

    let b3 = get_block_inner(&pool, ids[3].clone()).await.unwrap();
    assert!(b3.deleted_at.is_some());

    let b4 = get_block_inner(&pool, ids[4].clone()).await.unwrap();
    assert!(b4.deleted_at.is_some());
}

// ======================================================================
// Group 2: Crash recovery simulation
// ======================================================================

/// Insert a draft row manually into block_drafts, run recover_at_boot,
/// verify it becomes an edit_block op in op_log.
#[tokio::test]
async fn crash_recovery_unflushed_draft_becomes_edit_op() {
    let (pool, _dir) = test_pool().await;

    // Manually insert a draft (simulating crash before flush).
    // Use a far-future timestamp so no existing op can match it.
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("BLOCK-DRAFT-1")
        .bind("draft content")
        .bind("2099-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();

    // Run recovery
    let report = recovery::recover_at_boot(&pool, DEV).await.unwrap();

    // Verify draft was recovered
    assert_eq!(report.drafts_recovered, vec!["BLOCK-DRAFT-1"]);
    assert_eq!(report.drafts_already_flushed, 0);

    // Verify synthetic edit_block op exists in op_log
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].op_type, "edit_block");
    assert!(ops[0].payload.contains("BLOCK-DRAFT-1"));
    assert!(ops[0].payload.contains("draft content"));

    // Draft row should be deleted
    let drafts = draft::get_all_drafts(&pool).await.unwrap();
    assert!(drafts.is_empty());
}

/// Insert a draft AND a matching edit op, run recovery, verify draft
/// is deleted but no duplicate op is created.
#[tokio::test]
async fn crash_recovery_already_flushed_draft_is_deleted() {
    let (pool, _dir) = test_pool().await;

    // Insert a draft with an old timestamp
    sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
        .bind("BLOCK-FLUSHED")
        .bind("flushed content")
        .bind("2000-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();

    // Also insert a matching edit op with a newer timestamp (simulates
    // successful flush that happened after the draft was written)
    let payload = crate::op::OpPayload::EditBlock(crate::op::EditBlockPayload {
        block_id: "BLOCK-FLUSHED".into(),
        to_text: "flushed content".into(),
        prev_edit: None,
    });
    op_log::append_local_op(&pool, DEV, payload).await.unwrap();

    let ops_before = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    let count_before = ops_before.len();

    // Run recovery
    let report = recovery::recover_at_boot(&pool, DEV).await.unwrap();

    // Draft was already flushed - no new op created
    assert!(report.drafts_recovered.is_empty());
    assert_eq!(report.drafts_already_flushed, 1);

    // No duplicate op created
    let ops_after = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert_eq!(ops_after.len(), count_before);

    // Draft row should be deleted
    let drafts = draft::get_all_drafts(&pool).await.unwrap();
    assert!(drafts.is_empty());
}

/// Run recovery on empty database, verify report shows zeros.
#[tokio::test]
async fn crash_recovery_empty_database_is_noop() {
    let (pool, _dir) = test_pool().await;

    let report = recovery::recover_at_boot(&pool, DEV).await.unwrap();

    assert_eq!(report.pending_snapshots_deleted, 0);
    assert!(report.drafts_recovered.is_empty());
    assert_eq!(report.drafts_already_flushed, 0);
    assert!(report.draft_errors.is_empty());

    // op_log should be empty
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert!(ops.is_empty());
}

// ======================================================================
// Group 3: Cascade delete pipeline
// ======================================================================

/// Create parent->child->grandchild, delete parent, verify all three
/// are soft-deleted with same timestamp.
#[tokio::test]
async fn cascade_delete_three_level_tree() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create parent -> child -> grandchild.
    // Use "content" type (not "page") to avoid background RebuildPagesCache
    // tasks that race with subsequent SQLite writes.
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let grandchild = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "grandchild".into(),
        Some(child.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    // Delete parent (cascades)
    let del_resp = delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    let cascade_ts = del_resp.deleted_at.clone();

    // Verify all three are soft-deleted with same timestamp
    let p = get_block_inner(&pool, parent.id.clone()).await.unwrap();
    let c = get_block_inner(&pool, child.id.clone()).await.unwrap();
    let g = get_block_inner(&pool, grandchild.id.clone()).await.unwrap();

    assert_eq!(p.deleted_at, Some(cascade_ts.clone()));
    assert_eq!(c.deleted_at, Some(cascade_ts.clone()));
    assert_eq!(g.deleted_at, Some(cascade_ts));
}

/// Create parent->child1, child2. Delete child1 independently. Delete
/// parent (cascades to child2). Restore parent -> child2 restored,
/// child1 stays deleted.
#[tokio::test]
async fn restore_after_cascade_preserves_independent_deletes() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create parent -> child1, child2.
    // Use "content" type (not "page") to avoid background RebuildPagesCache
    // tasks that race with subsequent SQLite writes.
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    let child1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child1".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let child2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child2".into(),
        Some(parent.id.clone()),
        Some(2),
    )
    .await
    .unwrap();

    // Delete child1 independently
    let child1_del = delete_block_inner(&pool, DEV, &mat, child1.id.clone())
        .await
        .unwrap();
    let child1_ts = child1_del.deleted_at.clone();

    // Allow background cache-rebuild tasks to settle before the next write
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Delete parent (cascades to child2, but NOT child1 since already deleted)
    let parent_del = delete_block_inner(&pool, DEV, &mat, parent.id.clone())
        .await
        .unwrap();
    let cascade_ts = parent_del.deleted_at.clone();

    // Allow background tasks to settle
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // child1 keeps its own timestamp
    let c1 = get_block_inner(&pool, child1.id.clone()).await.unwrap();
    assert_eq!(c1.deleted_at, Some(child1_ts.clone()));

    // Restore parent using cascade timestamp
    restore_block_inner(&pool, DEV, &mat, parent.id.clone(), cascade_ts)
        .await
        .unwrap();

    // Parent should be restored
    let p = get_block_inner(&pool, parent.id.clone()).await.unwrap();
    assert!(p.deleted_at.is_none());

    // child2 should be restored (shared cascade timestamp)
    let c2 = get_block_inner(&pool, child2.id.clone()).await.unwrap();
    assert!(c2.deleted_at.is_none());

    // child1 should STILL be deleted (different timestamp)
    let c1_after = get_block_inner(&pool, child1.id.clone()).await.unwrap();
    assert_eq!(c1_after.deleted_at, Some(child1_ts));
}

/// Create a block, add tags, properties, attachment metadata. Purge it.
/// Verify it's gone from blocks, block_tags, block_properties, and
/// attachments. Op_log entries are preserved (append-only).
#[tokio::test]
async fn purge_removes_from_all_tables() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create the block to be purged
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "to be purged".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let bid = block.id.clone();

    // Create a tag block for the association (triggers RebuildTagsCache bg task)
    let tag = create_block_inner(&pool, DEV, &mat, "tag".into(), "my-tag".into(), None, None)
        .await
        .unwrap();
    // Allow bg task to settle before direct SQL writes
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Add tag association
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(&bid)
        .bind(&tag.id)
        .execute(&pool)
        .await
        .unwrap();

    // Add property
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(&bid)
        .bind("priority")
        .bind("high")
        .execute(&pool)
        .await
        .unwrap();

    // Add attachment metadata
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

    // Verify they exist before purge
    let tag_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
        .bind(&bid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tag_count.0, 1);

    let prop_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
            .bind(&bid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(prop_count.0, 1);

    let att_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM attachments WHERE block_id = ?")
        .bind(&bid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(att_count.0, 1);

    // Purge the block
    let purge_resp = purge_block_inner(&pool, DEV, &mat, bid.clone())
        .await
        .unwrap();
    assert_eq!(purge_resp.purged_count, 1);

    // Verify block is gone from blocks
    let block_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(&bid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(block_count.0, 0, "block should be gone from blocks table");

    // Verify tags are gone
    let tag_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
        .bind(&bid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tag_count.0, 0, "tags should be gone from block_tags");

    // Verify properties are gone
    let prop_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
            .bind(&bid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        prop_count.0, 0,
        "properties should be gone from block_properties"
    );

    // Verify attachments are gone
    let att_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM attachments WHERE block_id = ?")
        .bind(&bid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(att_count.0, 0, "attachments should be gone");

    // Op log entries are preserved (append-only log is never purged)
    let ops = op_log::get_ops_since(&pool, DEV, 0).await.unwrap();
    assert!(
        !ops.is_empty(),
        "op_log entries must be preserved after purge"
    );
    // Should have create(block) + create(tag) + purge = 3 ops
    assert_eq!(ops.len(), 3);
    assert_eq!(ops[2].op_type, "purge_block");
}

// ======================================================================
// Group 4: Pagination end-to-end
// ======================================================================

/// Create 5 blocks, delete 2. list_blocks shows 3. list_blocks with
/// show_deleted shows 2.
#[tokio::test]
async fn list_blocks_respects_soft_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 5 top-level blocks
    let mut ids = Vec::new();
    for i in 0..5 {
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some(i as i64),
        )
        .await
        .unwrap();
        ids.push(resp.id);
    }

    // Delete 2 blocks
    delete_block_inner(&pool, DEV, &mat, ids[0].clone())
        .await
        .unwrap();
    // Allow bg tasks to settle
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    delete_block_inner(&pool, DEV, &mat, ids[1].clone())
        .await
        .unwrap();

    // list_blocks without show_deleted -> 3 live blocks
    let live = list_blocks_inner(&pool, None, None, None, None, None, Some(50))
        .await
        .unwrap();
    assert_eq!(live.items.len(), 3, "should show 3 live blocks");

    // list_blocks with show_deleted -> 2 deleted blocks
    let trash = list_blocks_inner(&pool, None, None, None, Some(true), None, Some(50))
        .await
        .unwrap();
    assert_eq!(trash.items.len(), 2, "should show 2 deleted blocks");
}

/// Create 20 blocks, walk all pages via cursor. Verify we get all 20
/// with no duplicates.
#[tokio::test]
async fn pagination_across_create_and_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 20 top-level blocks
    let mut created_ids = Vec::new();
    for i in 0..20 {
        let resp = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("block {i}"),
            None,
            Some(i as i64),
        )
        .await
        .unwrap();
        created_ids.push(resp.id);
    }

    // Walk all pages via cursor with page size 5
    let mut all_ids = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = list_blocks_inner(&pool, None, None, None, None, cursor, Some(5))
            .await
            .unwrap();
        for item in &page.items {
            all_ids.push(item.id.clone());
        }
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
    }

    assert_eq!(all_ids.len(), 20, "should get all 20 blocks across pages");

    // No duplicates
    let unique: HashSet<&str> = all_ids.iter().map(|s| s.as_str()).collect();
    assert_eq!(unique.len(), 20, "no duplicate blocks across pages");
}

/// Create blocks of type 'content', 'page', 'tag'. Filter by each type,
/// verify correct counts.
#[tokio::test]
async fn list_by_type_after_creation() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 3 content blocks
    for i in 0..3 {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("content {i}"),
            None,
            Some(i as i64),
        )
        .await
        .unwrap();
    }

    // Create 2 page blocks (triggers RebuildPagesCache bg tasks)
    for i in 0..2 {
        create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            format!("page {i}"),
            None,
            Some((10 + i) as i64),
        )
        .await
        .unwrap();
        // Allow bg task to settle
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    // Create 1 tag block (triggers RebuildTagsCache bg task)
    create_block_inner(&pool, DEV, &mat, "tag".into(), "my-tag".into(), None, None)
        .await
        .unwrap();
    // Allow bg task to settle
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Filter by each type
    let content_resp = list_blocks_inner(
        &pool,
        None,
        Some("content".into()),
        None,
        None,
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert_eq!(content_resp.items.len(), 3, "should find 3 content blocks");

    let page_resp = list_blocks_inner(&pool, None, Some("page".into()), None, None, None, Some(50))
        .await
        .unwrap();
    assert_eq!(page_resp.items.len(), 2, "should find 2 page blocks");

    let tag_resp = list_blocks_inner(&pool, None, Some("tag".into()), None, None, None, Some(50))
        .await
        .unwrap();
    assert_eq!(tag_resp.items.len(), 1, "should find 1 tag block");
}

// ======================================================================
// Group 5: Position handling
// ======================================================================

/// Create blocks with positions 3, 1, 2. list_children should return
/// them in order 1, 2, 3.
#[tokio::test]
async fn blocks_ordered_by_position() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a parent.
    // Use "content" type (not "page") to avoid background RebuildPagesCache
    // tasks that race with subsequent SQLite writes.
    let parent = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "parent".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Create children with positions 3, 1, 2 (deliberately out of order)
    let c3 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "pos 3".into(),
        Some(parent.id.clone()),
        Some(3),
    )
    .await
    .unwrap();

    let c1 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "pos 1".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();

    let c2 = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "pos 2".into(),
        Some(parent.id.clone()),
        Some(2),
    )
    .await
    .unwrap();

    // list_children should return them in position order: 1, 2, 3
    let children = list_blocks_inner(
        &pool,
        Some(parent.id.clone()),
        None,
        None,
        None,
        None,
        Some(50),
    )
    .await
    .unwrap();

    assert_eq!(children.items.len(), 3);
    assert_eq!(children.items[0].id, c1.id);
    assert_eq!(children.items[1].id, c2.id);
    assert_eq!(children.items[2].id, c3.id);
    assert_eq!(children.items[0].position, Some(1));
    assert_eq!(children.items[1].position, Some(2));
    assert_eq!(children.items[2].position, Some(3));
}

/// Create block with position 5, edit content. Verify position is still 5.
#[tokio::test]
async fn edit_does_not_change_position() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create block with position 5
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        Some(5),
    )
    .await
    .unwrap();

    assert_eq!(block.position, Some(5));

    // Edit content
    let edited = edit_block_inner(&pool, DEV, &mat, block.id.clone(), "updated".into())
        .await
        .unwrap();

    assert_eq!(edited.position, Some(5), "position must not change on edit");
    assert_eq!(edited.content, Some("updated".into()));

    // Verify in DB
    let fetched = get_block_inner(&pool, block.id).await.unwrap();
    assert_eq!(fetched.position, Some(5), "DB position must be unchanged");
}

// ======================================================================
// Group 6: Materializer background dispatch
// ======================================================================

/// Create a page block, verify materializer metrics show background
/// tasks processed (pages_cache rebuild).
#[tokio::test]
async fn dispatch_background_enqueues_correct_tasks_for_create() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page block - should trigger RebuildPagesCache
    create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "my page".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Allow background consumer to process
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let bg = mat.metrics().bg_processed.load(Ordering::Relaxed);
    assert!(
        bg >= 1,
        "expected at least 1 background task processed for page creation, got {bg}"
    );
}

/// Edit a block, verify materializer metrics show background tasks
/// (block_links reindex).
#[tokio::test]
async fn dispatch_background_enqueues_correct_tasks_for_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block first
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "original".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();

    // Wait for create's background tasks to process
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let bg_before = mat.metrics().bg_processed.load(Ordering::Relaxed);

    // Edit the block - should trigger ReindexBlockLinks + RebuildPagesCache
    edit_block_inner(&pool, DEV, &mat, block.id, "edited".into())
        .await
        .unwrap();

    // Allow background consumer to process
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let bg_after = mat.metrics().bg_processed.load(Ordering::Relaxed);
    let bg_delta = bg_after - bg_before;
    assert!(
        bg_delta >= 1,
        "expected at least 1 new background task after edit, got delta {bg_delta}"
    );
}
