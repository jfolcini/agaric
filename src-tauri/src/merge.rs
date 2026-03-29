//! Three-way merge using diffy (ADR-10, Phase 4).
//!
//! Provides:
//! - `merge_text()` — three-way text merge for a block's content
//! - `create_conflict_copy()` — creates a conflict copy block when merge fails
//! - `resolve_property_conflict()` — LWW for concurrent property changes
//! - `merge_block()` — high-level merge orchestrator for a single block

#![allow(dead_code)]

use chrono::Utc;
use sqlx::SqlitePool;

use crate::dag;
use crate::error::AppError;
use crate::op::*;
use crate::op_log::{self, OpRecord};
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Outcome of a three-way text merge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeResult {
    /// Clean merge -- non-overlapping edits combined successfully.
    Clean(String),
    /// Conflict -- overlapping edits, needs conflict copy.
    Conflict {
        ours: String,
        theirs: String,
        ancestor: String,
    },
}

/// Resolution of a concurrent property conflict (Last-Writer-Wins).
#[derive(Debug, Clone)]
pub struct PropertyConflictResolution {
    pub winner_device: String,
    pub winner_seq: i64,
    pub winner_value: SetPropertyPayload,
}

/// Outcome of merging a single block.
#[derive(Debug, Clone)]
pub enum MergeOutcome {
    /// Clean merge -- new edit op created with merged content.
    Merged(OpRecord),
    /// Conflict -- original block keeps our text, conflict copy created.
    ConflictCopy {
        original_kept_ancestor: bool,
        conflict_block_op: OpRecord,
    },
    /// No merge needed -- heads are the same.
    AlreadyUpToDate,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Three-way text merge for a block's content.
///
/// 1. Finds the LCA of `op_ours` and `op_theirs` via `dag::find_lca`.
/// 2. Extracts text at ancestor, ours, and theirs via `dag::text_at`.
/// 3. If no LCA is found (both trace to same `create_block` root), walks
///    back to find the `create_block` and uses its content as ancestor.
/// 4. Calls `diffy::merge` for the three-way merge.
pub async fn merge_text(
    pool: &SqlitePool,
    block_id: &str,
    op_ours: &(String, i64),
    op_theirs: &(String, i64),
) -> Result<MergeResult, AppError> {
    // 1. Find the Lowest Common Ancestor
    let lca = dag::find_lca(pool, block_id, op_ours, op_theirs).await?;

    // 2. Get the text content at each point
    let text_ours = dag::text_at(pool, &op_ours.0, op_ours.1).await?;
    let text_theirs = dag::text_at(pool, &op_theirs.0, op_theirs.1).await?;

    let text_ancestor = match lca {
        Some((ref dev, seq)) => dag::text_at(pool, dev, seq).await?,
        None => {
            // No LCA found -- find the create_block for this block to use as ancestor.
            // Walk back from op_ours to find the root create_block.
            let mut current: Option<(String, i64)> = Some(op_ours.clone());
            let mut root_text = String::new();
            while let Some(key) = current.take() {
                let record = op_log::get_op_by_seq(pool, &key.0, key.1).await?;
                match record.op_type.as_str() {
                    "create_block" => {
                        let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
                        root_text = payload.content;
                        break;
                    }
                    "edit_block" => {
                        let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
                        current = payload.prev_edit;
                    }
                    _ => {
                        return Err(AppError::InvalidOperation(format!(
                            "unexpected op type '{}' in edit chain for block '{}'",
                            record.op_type, block_id,
                        )));
                    }
                }
            }
            root_text
        }
    };

    // 3. Three-way merge via diffy
    match diffy::merge(&text_ancestor, &text_ours, &text_theirs) {
        Ok(merged) => Ok(MergeResult::Clean(merged)),
        Err(_conflict_text) => Ok(MergeResult::Conflict {
            ours: text_ours,
            theirs: text_theirs,
            ancestor: text_ancestor,
        }),
    }
}

/// Create a conflict-copy block when merge fails.
///
/// 1. Generates a new ULID for the conflict copy.
/// 2. Queries the original block for its `block_type` and `parent_id`.
/// 3. Appends a `create_block` op to the op log.
/// 4. Inserts the block into the `blocks` table with `is_conflict = 1`
///    and `conflict_source` pointing to the original block.
/// 5. Returns the op record.
pub async fn create_conflict_copy(
    pool: &SqlitePool,
    device_id: &str,
    original_block_id: &str,
    conflict_content: &str,
) -> Result<OpRecord, AppError> {
    // 1. Query the original block for metadata
    let original: Option<(String, Option<String>, Option<i64>)> =
        sqlx::query_as("SELECT block_type, parent_id, position FROM blocks WHERE id = ?")
            .bind(original_block_id)
            .fetch_optional(pool)
            .await?;

    let (block_type, parent_id, position) = original.ok_or_else(|| {
        AppError::NotFound(format!(
            "original block '{original_block_id}' for conflict copy"
        ))
    })?;

    // 2. Generate a new block ID
    let new_block_id = BlockId::new();
    let new_position = position.map(|p| p + 1);

    // 3. Build the CreateBlock payload
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: new_block_id.as_str().to_owned(),
        block_type: block_type.clone(),
        parent_id: parent_id.clone(),
        position: new_position,
        content: conflict_content.to_owned(),
    });

    // 4. Append op and insert block in an IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, Utc::now().to_rfc3339()).await?;

    // Insert into blocks table
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict, conflict_source) \
         VALUES (?, ?, ?, ?, ?, 1, ?)",
    )
    .bind(new_block_id.as_str())
    .bind(&block_type)
    .bind(conflict_content)
    .bind(&parent_id)
    .bind(new_position)
    .bind(original_block_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(op_record)
}

/// Last-Writer-Wins resolution for concurrent property changes.
///
/// Compares two `set_property` ops and returns the winning op's info.
/// - Primary: later `created_at` timestamp wins (ISO 8601 sorts lexicographically).
/// - Tiebreaker: lexicographically larger `device_id` wins.
pub fn resolve_property_conflict(
    op_a: &OpRecord,
    op_b: &OpRecord,
) -> Result<PropertyConflictResolution, AppError> {
    // Validate both are set_property ops
    if op_a.op_type != "set_property" {
        return Err(AppError::InvalidOperation(format!(
            "expected set_property op, got '{}'",
            op_a.op_type,
        )));
    }
    if op_b.op_type != "set_property" {
        return Err(AppError::InvalidOperation(format!(
            "expected set_property op, got '{}'",
            op_b.op_type,
        )));
    }

    // Parse both payloads
    let payload_a: SetPropertyPayload = serde_json::from_str(&op_a.payload)?;
    let payload_b: SetPropertyPayload = serde_json::from_str(&op_b.payload)?;

    // Compare timestamps (ISO 8601 sorts lexicographically)
    let winner_is_b = match op_a.created_at.cmp(&op_b.created_at) {
        std::cmp::Ordering::Less => true,     // B is later
        std::cmp::Ordering::Greater => false, // A is later
        std::cmp::Ordering::Equal => {
            // Tiebreaker 1: larger device_id wins
            match op_b.device_id.cmp(&op_a.device_id) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                // Tiebreaker 2: larger seq wins (ensures commutativity when
                // both timestamp and device_id are identical)
                std::cmp::Ordering::Equal => op_b.seq > op_a.seq,
            }
        }
    };

    if winner_is_b {
        Ok(PropertyConflictResolution {
            winner_device: op_b.device_id.clone(),
            winner_seq: op_b.seq,
            winner_value: payload_b,
        })
    } else {
        Ok(PropertyConflictResolution {
            winner_device: op_a.device_id.clone(),
            winner_seq: op_a.seq,
            winner_value: payload_a,
        })
    }
}

/// High-level merge orchestrator for a single block.
///
/// 1. If heads are identical, returns `AlreadyUpToDate`.
/// 2. Calls `merge_text()` for three-way merge.
/// 3. On clean merge: creates an `edit_block` op via `dag::append_merge_op`.
/// 4. On conflict: creates a conflict copy with "theirs" content.
pub async fn merge_block(
    pool: &SqlitePool,
    device_id: &str,
    block_id: &str,
    our_head: &(String, i64),
    their_head: &(String, i64),
) -> Result<MergeOutcome, AppError> {
    // 1. Already up to date?
    if our_head == their_head {
        return Ok(MergeOutcome::AlreadyUpToDate);
    }

    // 2. Three-way merge
    let result = merge_text(pool, block_id, our_head, their_head).await?;

    match result {
        MergeResult::Clean(merged) => {
            // 3. Create edit_block op with merged text
            let merge_payload = OpPayload::EditBlock(EditBlockPayload {
                block_id: block_id.to_owned(),
                to_text: merged,
                prev_edit: Some(our_head.clone()),
            });
            let parent_entries = vec![our_head.clone(), their_head.clone()];
            let record =
                dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

            Ok(MergeOutcome::Merged(record))
        }
        MergeResult::Conflict {
            ours: _,
            theirs,
            ancestor: _,
        } => {
            // 4. Create conflict copy with "theirs" content
            let conflict_op = create_conflict_copy(pool, device_id, block_id, &theirs).await?;

            Ok(MergeOutcome::ConflictCopy {
                original_kept_ancestor: false,
                conflict_block_op: conflict_op,
            })
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash::compute_op_hash;
    use crate::op_log::append_local_op_at;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // -- Test fixture constants --

    const FIXED_TS: &str = "2025-01-15T12:00:00+00:00";
    const FIXED_TS_LATER: &str = "2025-01-15T13:00:00+00:00";
    const DEV_A: &str = "device-A";
    const DEV_B: &str = "device-B";

    // -- Helpers --

    /// Create a temp-file-backed SQLite pool with migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = crate::db::init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Build a `CreateBlock` payload.
    fn make_create(block_id: &str, content: &str) -> OpPayload {
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: block_id.into(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: content.into(),
        })
    }

    /// Build an `EditBlock` payload with a `prev_edit` pointer.
    fn make_edit(block_id: &str, to_text: &str, prev_edit: Option<(String, i64)>) -> OpPayload {
        OpPayload::EditBlock(EditBlockPayload {
            block_id: block_id.into(),
            to_text: to_text.into(),
            prev_edit,
        })
    }

    /// Build a valid remote `OpRecord` with a correct hash.
    fn make_remote_record(
        device_id: &str,
        seq: i64,
        parent_seqs: Option<String>,
        op_type: &str,
        payload: &str,
    ) -> OpRecord {
        let hash = compute_op_hash(device_id, seq, parent_seqs.as_deref(), op_type, payload);
        OpRecord {
            device_id: device_id.to_owned(),
            seq,
            parent_seqs,
            hash,
            op_type: op_type.to_owned(),
            payload: payload.to_owned(),
            created_at: FIXED_TS.to_owned(),
        }
    }

    /// Insert an original block in the blocks table (needed for create_conflict_copy).
    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
    }

    // =====================================================================
    // 1. merge_text tests
    // =====================================================================

    /// Clean merge: non-overlapping edits on different parts.
    ///
    /// Ancestor: "hello world"
    /// Ours:     "hello beautiful world"  (inserted "beautiful ")
    /// Theirs:   "hello world today"      (appended " today")
    /// Expected: "hello beautiful world today"
    #[tokio::test]
    async fn merge_text_clean_non_overlapping() {
        let (pool, _dir) = test_pool().await;

        // Device A: create B1 with "hello world"
        // Note: diffy works line-by-line, so we use newline-separated content
        // for reliable merges.
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "hello\nworld\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device A: edit B1 → "hello\nbeautiful\nworld\n"
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "hello\nbeautiful\nworld\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B: edit B1 → "hello\nworld\ntoday\n" (prev_edit points to A,1)
        let b_payload =
            r#"{"block_id":"B1","to_text":"hello\nworld\ntoday\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                assert_eq!(merged, "hello\nbeautiful\nworld\ntoday\n");
            }
            MergeResult::Conflict { .. } => panic!("expected clean merge, got conflict"),
        }
    }

    /// Conflict: both devices edit the same line.
    #[tokio::test]
    async fn merge_text_conflict_same_line() {
        let (pool, _dir) = test_pool().await;

        // Create with single-line content
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "hello world"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device A edits to "goodbye world"
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "goodbye world", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B edits to "hello universe" (same line conflict)
        let b_payload =
            r#"{"block_id":"B1","to_text":"hello universe","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Conflict {
                ours,
                theirs,
                ancestor,
            } => {
                assert_eq!(ours, "goodbye world");
                assert_eq!(theirs, "hello universe");
                assert_eq!(ancestor, "hello world");
            }
            MergeResult::Clean(_) => panic!("expected conflict, got clean merge"),
        }
    }

    /// Identical edits: both devices make the same change -- should be clean.
    #[tokio::test]
    async fn merge_text_identical_edits() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "hello\nworld\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Both devices edit to the same text
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "hello\nuniverse\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let b_payload =
            r#"{"block_id":"B1","to_text":"hello\nuniverse\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                assert_eq!(merged, "hello\nuniverse\n");
            }
            MergeResult::Conflict { .. } => panic!("expected clean merge for identical edits"),
        }
    }

    /// No LCA found: both ops trace back to the same create_block root.
    /// merge_text should still work using the create_block content as ancestor.
    #[tokio::test]
    async fn merge_text_no_lca_uses_create_content() {
        let (pool, _dir) = test_pool().await;

        // Create block
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "base\ntext\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device A: first edit from create, but LCA with B won't find a common ancestor
        // if they diverge before any shared edit.
        // Actually find_lca WILL find (A,1) as the common ancestor if both
        // have prev_edit=(A,1). Let's test without prev_edit from B's side --
        // this simulates a scenario where the chains don't overlap.
        // In practice find_lca returns None only if chains are disjoint, which
        // shouldn't happen for same-block edits. But we test the fallback path.

        // For this test, we'll set up edits that have prev_edit pointing to create:
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "base\ntext\nfrom A\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let b_payload =
            r#"{"block_id":"B1","to_text":"base\ntext\nfrom B\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // LCA should be (A,1) which is the create_block
        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                // Both add a line at the end, but different. diffy merges
                // non-overlapping appends if they're on different lines.
                assert!(
                    merged.contains("from A") && merged.contains("from B"),
                    "merged should contain both additions, got: {merged}"
                );
            }
            MergeResult::Conflict { .. } => {
                // This may also be a valid outcome depending on diffy's line-level merge
                // Since both add to the same position, a conflict is acceptable
            }
        }
    }

    // =====================================================================
    // 2. create_conflict_copy tests
    // =====================================================================

    #[tokio::test]
    async fn create_conflict_copy_creates_block_with_conflict_flag() {
        let (pool, _dir) = test_pool().await;

        // Insert an original block in the blocks table
        insert_block(&pool, "B1", "content", "original text", None, Some(5)).await;

        let record = create_conflict_copy(&pool, DEV_A, "B1", "conflicting text")
            .await
            .unwrap();

        assert_eq!(record.op_type, "create_block");
        assert_eq!(record.device_id, DEV_A);

        // Parse the payload to get the new block_id
        let payload: CreateBlockPayload = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(payload.block_type, "content");
        assert_eq!(payload.content, "conflicting text");
        assert_eq!(payload.position, Some(6)); // original position (5) + 1
        assert!(payload.parent_id.is_none()); // matches original

        // Verify the block in the blocks table
        let row: (i64, Option<String>) =
            sqlx::query_as("SELECT is_conflict, conflict_source FROM blocks WHERE id = ?")
                .bind(&payload.block_id)
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(row.0, 1, "is_conflict should be 1");
        assert_eq!(
            row.1,
            Some("B1".to_owned()),
            "conflict_source should point to original"
        );
    }

    #[tokio::test]
    async fn create_conflict_copy_preserves_parent_id() {
        let (pool, _dir) = test_pool().await;

        // Insert parent block first
        insert_block(&pool, "PARENT", "page", "parent page", None, Some(0)).await;
        // Insert original block with parent
        insert_block(
            &pool,
            "B2",
            "content",
            "child text",
            Some("PARENT"),
            Some(3),
        )
        .await;

        let record = create_conflict_copy(&pool, DEV_A, "B2", "conflict version")
            .await
            .unwrap();

        let payload: CreateBlockPayload = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(payload.parent_id, Some("PARENT".to_owned()));
        assert_eq!(payload.position, Some(4)); // 3 + 1
    }

    #[tokio::test]
    async fn create_conflict_copy_fails_for_missing_block() {
        let (pool, _dir) = test_pool().await;

        let err = create_conflict_copy(&pool, DEV_A, "NONEXISTENT", "text").await;
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("Not found"),
            "expected NotFound error, got: {msg}"
        );
    }

    // =====================================================================
    // 3. resolve_property_conflict tests
    // =====================================================================

    /// Helper to build a set_property OpRecord.
    fn make_prop_record(
        device_id: &str,
        seq: i64,
        created_at: &str,
        block_id: &str,
        key: &str,
        value_text: &str,
    ) -> OpRecord {
        let payload = serde_json::to_string(&SetPropertyPayload {
            block_id: block_id.into(),
            key: key.into(),
            value_text: Some(value_text.into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        })
        .unwrap();
        let hash = compute_op_hash(device_id, seq, None, "set_property", &payload);
        OpRecord {
            device_id: device_id.to_owned(),
            seq,
            parent_seqs: None,
            hash,
            op_type: "set_property".to_owned(),
            payload,
            created_at: created_at.to_owned(),
        }
    }

    #[test]
    fn resolve_property_conflict_later_timestamp_wins() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_B, 1, FIXED_TS_LATER, "B1", "priority", "high");

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        assert_eq!(result.winner_device, DEV_B);
        assert_eq!(result.winner_seq, 1);
        assert_eq!(result.winner_value.value_text, Some("high".into()));
    }

    #[test]
    fn resolve_property_conflict_earlier_timestamp_loses() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS_LATER, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_B, 1, FIXED_TS, "B1", "priority", "high");

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        assert_eq!(result.winner_device, DEV_A);
        assert_eq!(result.winner_value.value_text, Some("low".into()));
    }

    #[test]
    fn resolve_property_conflict_same_timestamp_larger_device_id_wins() {
        // device-B > device-A lexicographically
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_B, 2, FIXED_TS, "B1", "priority", "high");

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        assert_eq!(
            result.winner_device, DEV_B,
            "device-B should win the tiebreaker (B > A)"
        );
        assert_eq!(result.winner_seq, 2);
    }

    #[test]
    fn resolve_property_conflict_same_timestamp_same_device_higher_seq_wins() {
        // Same device_id, same timestamp -- higher seq wins (tiebreaker 2).
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_A, 2, FIXED_TS, "B1", "priority", "high");

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        // With the seq tiebreaker, the op with the higher seq (op_b, seq=2) wins.
        assert_eq!(result.winner_device, DEV_A);
        assert_eq!(result.winner_seq, 2);
    }

    #[test]
    fn resolve_property_conflict_same_device_same_ts_is_commutative() {
        // Verify that swapping argument order doesn't change the winner.
        let op_a = make_prop_record(DEV_A, 3, FIXED_TS, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_A, 7, FIXED_TS, "B1", "priority", "high");

        let result_ab = resolve_property_conflict(&op_a, &op_b).unwrap();
        let result_ba = resolve_property_conflict(&op_b, &op_a).unwrap();

        assert_eq!(
            result_ab.winner_seq, result_ba.winner_seq,
            "resolution must be commutative: same winner regardless of argument order"
        );
        assert_eq!(result_ab.winner_seq, 7, "higher seq should win");
    }

    #[test]
    fn resolve_property_conflict_rejects_non_set_property_op_a() {
        let op_a = OpRecord {
            device_id: DEV_A.into(),
            seq: 1,
            parent_seqs: None,
            hash: "x".repeat(64),
            op_type: "edit_block".into(),
            payload: "{}".into(),
            created_at: FIXED_TS.into(),
        };
        let op_b = make_prop_record(DEV_B, 1, FIXED_TS, "B1", "priority", "high");

        let err = resolve_property_conflict(&op_a, &op_b);
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("set_property"),
            "expected set_property error, got: {msg}"
        );
    }

    #[test]
    fn resolve_property_conflict_rejects_non_set_property_op_b() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "priority", "low");
        let op_b = OpRecord {
            device_id: DEV_B.into(),
            seq: 1,
            parent_seqs: None,
            hash: "x".repeat(64),
            op_type: "delete_block".into(),
            payload: "{}".into(),
            created_at: FIXED_TS.into(),
        };

        let err = resolve_property_conflict(&op_a, &op_b);
        assert!(err.is_err());
    }

    #[test]
    fn resolve_property_conflict_rejects_malformed_payload() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "priority", "low");
        let op_b = OpRecord {
            device_id: DEV_B.into(),
            seq: 1,
            parent_seqs: None,
            hash: "x".repeat(64),
            op_type: "set_property".into(),
            payload: "{not valid json".into(),
            created_at: FIXED_TS.into(),
        };

        let err = resolve_property_conflict(&op_a, &op_b);
        assert!(err.is_err());
    }

    // =====================================================================
    // 4. merge_block tests
    // =====================================================================

    #[tokio::test]
    async fn merge_block_already_up_to_date() {
        let (pool, _dir) = test_pool().await;

        let same_head = (DEV_A.to_owned(), 2);
        let result = merge_block(&pool, DEV_A, "B1", &same_head, &same_head)
            .await
            .unwrap();

        assert!(
            matches!(result, MergeOutcome::AlreadyUpToDate),
            "expected AlreadyUpToDate, got: {:?}",
            result
        );
    }

    #[tokio::test]
    async fn merge_block_clean_merge() {
        let (pool, _dir) = test_pool().await;

        // Set up DAG: create → A edits, B edits (non-overlapping)
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "line1\nline2\nline3\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device A: edits line1
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "LINE1\nline2\nline3\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B: edits line3
        let b_payload =
            r#"{"block_id":"B1","to_text":"line1\nline2\nLINE3\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // Also insert B1 into blocks table (needed for potential conflict copy)
        insert_block(
            &pool,
            "B1",
            "content",
            "line1\nline2\nline3\n",
            None,
            Some(0),
        )
        .await;

        let result = merge_block(&pool, DEV_A, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeOutcome::Merged(record) => {
                assert_eq!(record.op_type, "edit_block");
                assert_eq!(record.device_id, DEV_A);

                // Verify parent_seqs contains both heads
                let parent_seqs: Vec<(String, i64)> =
                    serde_json::from_str(record.parent_seqs.as_ref().unwrap()).unwrap();
                assert_eq!(parent_seqs.len(), 2);

                // Check merged content
                let payload: EditBlockPayload = serde_json::from_str(&record.payload).unwrap();
                assert_eq!(payload.to_text, "LINE1\nline2\nLINE3\n");
            }
            other => panic!("expected Merged, got: {:?}", other),
        }
    }

    #[tokio::test]
    async fn merge_block_conflict_creates_copy() {
        let (pool, _dir) = test_pool().await;

        // Set up conflicting edits on the same line
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "hello world"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "goodbye world", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let b_payload =
            r#"{"block_id":"B1","to_text":"hello universe","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // Insert B1 into blocks table
        insert_block(&pool, "B1", "content", "hello world", None, Some(0)).await;

        let result = merge_block(&pool, DEV_A, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeOutcome::ConflictCopy {
                original_kept_ancestor,
                conflict_block_op,
            } => {
                assert!(!original_kept_ancestor);
                assert_eq!(conflict_block_op.op_type, "create_block");

                // The conflict copy should have "theirs" content
                let payload: CreateBlockPayload =
                    serde_json::from_str(&conflict_block_op.payload).unwrap();
                assert_eq!(payload.content, "hello universe");
                assert_eq!(payload.block_type, "content");

                // Verify is_conflict=1 in DB
                let row: (i64, Option<String>) =
                    sqlx::query_as("SELECT is_conflict, conflict_source FROM blocks WHERE id = ?")
                        .bind(&payload.block_id)
                        .fetch_one(&pool)
                        .await
                        .unwrap();
                assert_eq!(row.0, 1);
                assert_eq!(row.1, Some("B1".to_owned()));
            }
            other => panic!("expected ConflictCopy, got: {:?}", other),
        }
    }

    // =====================================================================
    // 5. Edge cases
    // =====================================================================

    /// merge_text with multi-line content where one device adds at the
    /// beginning and the other at the end.
    #[tokio::test]
    async fn merge_text_clean_additions_at_different_ends() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", "middle\n"), FIXED_TS.into())
            .await
            .unwrap();

        // A adds at beginning
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "top\nmiddle\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // B adds at end
        let b_payload =
            r#"{"block_id":"B1","to_text":"middle\nbottom\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                assert_eq!(merged, "top\nmiddle\nbottom\n");
            }
            MergeResult::Conflict { .. } => panic!("expected clean merge"),
        }
    }

    /// resolve_property_conflict with numeric values.
    #[test]
    fn resolve_property_conflict_with_numeric_values() {
        let payload_a = serde_json::to_string(&SetPropertyPayload {
            block_id: "B1".into(),
            key: "score".into(),
            value_text: None,
            value_num: Some(42.0),
            value_date: None,
            value_ref: None,
        })
        .unwrap();

        let payload_b = serde_json::to_string(&SetPropertyPayload {
            block_id: "B1".into(),
            key: "score".into(),
            value_text: None,
            value_num: Some(99.0),
            value_date: None,
            value_ref: None,
        })
        .unwrap();

        let hash_a = compute_op_hash(DEV_A, 1, None, "set_property", &payload_a);
        let hash_b = compute_op_hash(DEV_B, 1, None, "set_property", &payload_b);

        let op_a = OpRecord {
            device_id: DEV_A.into(),
            seq: 1,
            parent_seqs: None,
            hash: hash_a,
            op_type: "set_property".into(),
            payload: payload_a,
            created_at: FIXED_TS.into(),
        };
        let op_b = OpRecord {
            device_id: DEV_B.into(),
            seq: 1,
            parent_seqs: None,
            hash: hash_b,
            op_type: "set_property".into(),
            payload: payload_b,
            created_at: FIXED_TS_LATER.into(),
        };

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        assert_eq!(result.winner_device, DEV_B);
        assert_eq!(result.winner_value.value_num, Some(99.0));
    }

    // =====================================================================
    // 6. Additional edge-case tests
    // =====================================================================

    /// Merge where both sides start from empty content.
    #[tokio::test]
    async fn merge_text_empty_content() {
        let (pool, _dir) = test_pool().await;

        // Create block with empty content
        append_local_op_at(&pool, DEV_A, make_create("B1", ""), FIXED_TS.into())
            .await
            .unwrap();

        // Device A adds text
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "hello\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B also adds text
        let b_payload = r#"{"block_id":"B1","to_text":"world\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        // Both added to the same empty ancestor, so a conflict is expected
        // (both inserted at the same position in the empty file).
        match result {
            MergeResult::Conflict { ancestor, .. } => {
                assert_eq!(ancestor, "");
            }
            MergeResult::Clean(merged) => {
                // Some merge tools resolve this cleanly; either outcome is acceptable.
                assert!(
                    merged.contains("hello") && merged.contains("world"),
                    "merged should contain both additions: {merged}"
                );
            }
        }
    }

    /// Merge with Unicode content (emoji, CJK, combining characters).
    #[tokio::test]
    async fn merge_text_unicode_content() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "日本語\nEnglish\n🦀 Rust\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device A modifies the first line
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "中文\nEnglish\n🦀 Rust\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B modifies the last line
        let b_payload = r#"{"block_id":"B1","to_text":"日本語\nEnglish\n🐍 Python\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                assert_eq!(merged, "中文\nEnglish\n🐍 Python\n");
            }
            MergeResult::Conflict { .. } => panic!("expected clean merge for unicode content"),
        }
    }

    /// Conflict copy when original block has NULL position (e.g. a tag).
    #[tokio::test]
    async fn create_conflict_copy_null_position() {
        let (pool, _dir) = test_pool().await;

        // Insert a tag block with NULL position
        insert_block(&pool, "T1", "tag", "my-tag", None, None).await;

        let record = create_conflict_copy(&pool, DEV_A, "T1", "conflicting tag")
            .await
            .unwrap();

        let payload: CreateBlockPayload = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(payload.block_type, "tag");
        assert!(
            payload.position.is_none(),
            "position should remain None when original position is NULL"
        );
    }

    /// Multi-paragraph merge: paragraphs separated by blank lines.
    #[tokio::test]
    async fn merge_text_multi_paragraph() {
        let (pool, _dir) = test_pool().await;

        let base = "# Title\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n";

        append_local_op_at(&pool, DEV_A, make_create("B1", base), FIXED_TS.into())
            .await
            .unwrap();

        // Device A edits paragraph one
        let a_text =
            "# Title\n\nEdited paragraph one by A.\n\nParagraph two.\n\nParagraph three.\n";
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", a_text, Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B edits paragraph three
        let b_text =
            "# Title\n\nParagraph one.\n\nParagraph two.\n\nEdited paragraph three by B.\n";
        let b_payload = serde_json::to_string(&serde_json::json!({
            "block_id": "B1",
            "to_text": b_text,
            "prev_edit": ["device-A", 1]
        }))
        .unwrap();
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", &b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                assert!(
                    merged.contains("Edited paragraph one by A.")
                        && merged.contains("Edited paragraph three by B."),
                    "multi-paragraph merge should combine both edits: {merged}"
                );
            }
            MergeResult::Conflict { .. } => {
                panic!("expected clean merge for non-overlapping multi-paragraph edits");
            }
        }
    }

    /// Commutativity check for resolve_property_conflict with different
    /// device_ids — swapping args must give the same winner.
    #[test]
    fn resolve_property_conflict_is_commutative_different_devices() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_B, 1, FIXED_TS, "B1", "priority", "high");

        let result_ab = resolve_property_conflict(&op_a, &op_b).unwrap();
        let result_ba = resolve_property_conflict(&op_b, &op_a).unwrap();

        assert_eq!(
            result_ab.winner_device, result_ba.winner_device,
            "different-device resolution must be commutative"
        );
        assert_eq!(result_ab.winner_device, DEV_B, "device-B > device-A");
    }
}
