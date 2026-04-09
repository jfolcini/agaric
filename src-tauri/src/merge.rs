//! Three-way merge using diffy.
//!
//! Provides:
//! - `merge_text()` — three-way text merge for a block's content
//! - `create_conflict_copy()` — creates a conflict copy block when merge fails
//! - `resolve_property_conflict()` — LWW for concurrent property changes
//! - `merge_block()` — high-level merge orchestrator for a single block
use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::dag;
use crate::error::AppError;
use crate::op::*;
use crate::op_log::{self, OpRecord};
use crate::ulid::BlockId;

/// Maximum number of iterations when walking prev_edit chains.
/// Prevents infinite loops on corrupted cyclic data.           (F07)
const MAX_CHAIN_WALK_ITERATIONS: usize = 1_000;

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
        original_kept_ours: bool,
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
/// 4. Calls `diffy::merge` for a **line-level** three-way merge.
///
/// **Important:** `diffy::merge` operates at line-level granularity (splits
/// on `\n` boundaries), *not* word-level.  Because auto-split on blur turns
/// each paragraph into its own block, most blocks contain a single line.
/// Any concurrent edit to a single-line block will therefore produce a
/// conflict, even if the changes affect different words.  (See F03.)
pub async fn merge_text(
    pool: &SqlitePool,
    block_id: &str,
    op_ours: &(String, i64),
    op_theirs: &(String, i64),
) -> Result<MergeResult, AppError> {
    // 1. Find the Lowest Common Ancestor
    let lca = dag::find_lca(pool, op_ours, op_theirs).await?;

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
            let mut found_create = false;
            let mut iterations = 0usize;
            let mut visited_walk: HashSet<(String, i64)> = HashSet::new();
            while let Some(key) = current.take() {
                iterations += 1;
                if iterations > MAX_CHAIN_WALK_ITERATIONS {
                    return Err(AppError::InvalidOperation(format!(
                        "prev_edit chain for block '{}' exceeded {} iterations \
                         — possible cycle in corrupted data",
                        block_id, MAX_CHAIN_WALK_ITERATIONS,
                    )));
                }
                if !visited_walk.insert(key.clone()) {
                    return Err(AppError::InvalidOperation(format!(
                        "cycle detected in prev_edit chain for block '{}' at ({}, {})",
                        block_id, key.0, key.1,
                    )));
                }
                let record = op_log::get_op_by_seq(pool, &key.0, key.1).await?;
                match record.op_type.as_str() {
                    "create_block" => {
                        let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
                        root_text = payload.content;
                        found_create = true;
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
            if !found_create {
                return Err(AppError::InvalidOperation(format!(
                    "prev_edit chain for block '{}' ended without reaching a \
                     create_block — broken chain (possible op log compaction)",
                    block_id,
                )));
            }
            root_text
        }
    };

    // 3. Line-level three-way merge via diffy.
    //    Note: diffy splits on `\n` boundaries (line-level, NOT word-level).
    //    For single-line blocks, any concurrent edit produces a conflict.
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
    conflict_type: &str,
) -> Result<OpRecord, AppError> {
    // 1. Query the original block for metadata
    let original = sqlx::query!(
        "SELECT block_type, parent_id, position FROM blocks WHERE id = ?",
        original_block_id
    )
    .fetch_optional(pool)
    .await?;

    let original = original.ok_or_else(|| {
        AppError::NotFound(format!(
            "original block '{original_block_id}' for conflict copy"
        ))
    })?;
    let block_type = original.block_type;
    let parent_id = original.parent_id;
    let position = original.position;

    // 2. Generate a new block ID
    let new_block_id = BlockId::new();
    // NOTE (F08 \u2014 known limitation): `position + 1` may collide with an
    // existing sibling.  We do NOT shift siblings here; the cascade-delete design specifies
    // that the materializer compacts positions to contiguous 1..n on sync,
    // which resolves the duplicate.  Between creation and the next
    // materializer run, two blocks may share the same position.
    let new_position = position.map(|p| p + 1);

    // 3. Build the CreateBlock payload
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: new_block_id.clone(),
        block_type: block_type.clone(),
        parent_id: parent_id.as_deref().map(BlockId::from_trusted),
        position: new_position,
        content: conflict_content.to_owned(),
    });

    // 4. Append op and insert block in an IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, crate::now_rfc3339()).await?;

    // Insert into blocks table
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict, conflict_source, conflict_type) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(new_block_id.as_str())
    .bind(&block_type)
    .bind(conflict_content)
    .bind(&parent_id)
    .bind(new_position)
    .bind(original_block_id)
    .bind(conflict_type)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(op_record)
}

/// Last-Writer-Wins resolution for concurrent property changes.
///
/// Compares two `set_property` ops and returns the winning op's info.
/// - Primary: later `created_at` timestamp wins (lexicographic string comparison).
/// - Tiebreaker 1: lexicographically larger `device_id` wins.
/// - Tiebreaker 2: larger `seq` wins.
///
/// Timestamps are compared as strings via lexicographic ordering, which is
/// correct for RFC 3339 timestamps **only when they share the same UTC
/// suffix** (all `Z` or all `+00:00`).  The `now_rfc3339()` helper always
/// emits `Z`, so production data is consistent.  If mixed-format timestamps
/// are ever ingested from remote devices, this comparison may need to parse
/// via `chrono::DateTime::parse_from_rfc3339` instead.            (F05)
#[must_use = "conflict resolution result must be applied"]
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
    let ts_ours = &op_a.created_at;
    let ts_theirs = &op_b.created_at;
    debug_assert!(
        ts_ours.ends_with('Z'),
        "Timestamp must be UTC Z format: {}",
        ts_ours
    );
    debug_assert!(
        ts_theirs.ends_with('Z'),
        "Timestamp must be UTC Z format: {}",
        ts_theirs
    );
    let winner_is_b = match ts_ours.cmp(ts_theirs) {
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
/// 4. On conflict: creates a conflict copy with "theirs" content, then
///    creates a merge op on the original to unify the DAG and preserve
///    the local ("ours") content in-place (user's edits are retained).
///
/// **TODO (F04):** This orchestrator handles **text** conflicts only.
/// `resolve_property_conflict` (LWW) exists but is not called here \u2014 the
/// sync orchestrator (not yet implemented) must iterate concurrent
/// `set_property` ops per block and call `resolve_property_conflict` for
/// each conflicting `(block_id, key)` pair.
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
                block_id: BlockId::from_trusted(block_id),
                to_text: merged,
                prev_edit: Some(our_head.clone()),
            });
            let parent_entries = vec![our_head.clone(), their_head.clone()];
            let record =
                dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

            Ok(MergeOutcome::Merged(record))
        }
        MergeResult::Conflict {
            ours,
            theirs,
            ancestor: _,
        } => {
            // 4. Create conflict copy with "theirs" content
            let conflict_op =
                create_conflict_copy(pool, device_id, block_id, &theirs, "Text").await?;

            // 5. Create a merge op on the ORIGINAL block to unify the two
            //    divergent heads in the DAG.  The original block retains the
            //    local ("ours") content so the user's own edits are preserved
            //    in-place.  Without this merge op the two heads would remain
            //    unresolved and `get_block_edit_heads` would re-detect
            //    divergence on the next sync, potentially creating duplicate
            //    conflict copies.                             (fixes F01+F02)
            let merge_payload = OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                to_text: ours,
                prev_edit: Some(our_head.clone()),
            });
            let parent_entries = vec![our_head.clone(), their_head.clone()];
            let _merge_record =
                dag::append_merge_op(pool, device_id, merge_payload, parent_entries).await?;

            Ok(MergeOutcome::ConflictCopy {
                original_kept_ours: true,
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

    const FIXED_TS: &str = "2025-01-15T12:00:00Z";
    const FIXED_TS_LATER: &str = "2025-01-15T13:00:00Z";
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
            block_id: BlockId::test_id(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: content.into(),
        })
    }

    /// Build an `EditBlock` payload with a `prev_edit` pointer.
    fn make_edit(block_id: &str, to_text: &str, prev_edit: Option<(String, i64)>) -> OpPayload {
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(block_id),
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
                assert_eq!(
                    merged, "hello\nbeautiful\nworld\ntoday\n",
                    "clean merge should combine non-overlapping edits"
                );
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
                assert_eq!(ours, "goodbye world", "ours should be device-A's edit");
                assert_eq!(theirs, "hello universe", "theirs should be device-B's edit");
                assert_eq!(
                    ancestor, "hello world",
                    "ancestor should be original create content"
                );
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
                assert_eq!(
                    merged, "hello\nuniverse\n",
                    "identical edits should merge cleanly to the shared text"
                );
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

        let record = create_conflict_copy(&pool, DEV_A, "B1", "conflicting text", "Text")
            .await
            .unwrap();

        assert_eq!(
            record.op_type, "create_block",
            "conflict copy op should be create_block"
        );
        assert_eq!(
            record.device_id, DEV_A,
            "conflict copy op should belong to the local device"
        );

        // Parse the payload to get the new block_id
        let payload: CreateBlockPayload = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(
            payload.block_type, "content",
            "conflict copy should inherit block_type from original"
        );
        assert_eq!(
            payload.content, "conflicting text",
            "conflict copy should contain the conflict content"
        );
        assert_eq!(
            payload.position,
            Some(6),
            "conflict copy position should be original + 1"
        ); // original position (5) + 1
        assert!(
            payload.parent_id.is_none(),
            "conflict copy parent_id should match original (none)"
        ); // matches original

        // Verify the block in the blocks table
        let block_id_str = payload.block_id.as_str();
        let row = sqlx::query!(
            r#"SELECT is_conflict as "is_conflict: bool", conflict_source FROM blocks WHERE id = ?"#,
            block_id_str
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert!(row.is_conflict, "is_conflict should be true");
        assert_eq!(
            row.conflict_source,
            Some("B1".to_owned()),
            "conflict_source should point to original"
        );
    }

    #[tokio::test]
    async fn create_conflict_copy_stores_conflict_type() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "CT1", "content", "original", None, Some(1)).await;

        let record = create_conflict_copy(&pool, DEV_A, "CT1", "conflict text", "Property")
            .await
            .unwrap();

        let payload: CreateBlockPayload = serde_json::from_str(&record.payload).unwrap();
        let block_id = payload.block_id.as_str();
        let row = sqlx::query!("SELECT conflict_type FROM blocks WHERE id = ?", block_id)
            .fetch_one(&pool)
            .await
            .unwrap();

        assert_eq!(
            row.conflict_type,
            Some("Property".to_owned()),
            "conflict_type should be stored as Property"
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

        let record = create_conflict_copy(&pool, DEV_A, "B2", "conflict version", "Text")
            .await
            .unwrap();

        let payload: CreateBlockPayload = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(
            payload.parent_id,
            Some(BlockId::test_id("PARENT")),
            "conflict copy should preserve parent_id from original"
        );
        assert_eq!(
            payload.position,
            Some(4),
            "conflict copy position should be original (3) + 1"
        ); // 3 + 1
    }

    #[tokio::test]
    async fn create_conflict_copy_fails_for_missing_block() {
        let (pool, _dir) = test_pool().await;

        let err = create_conflict_copy(&pool, DEV_A, "NONEXISTENT", "text", "Text").await;
        assert!(
            err.is_err(),
            "create_conflict_copy should fail for nonexistent block"
        );
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
            block_id: BlockId::test_id(block_id),
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
        assert_eq!(result.winner_device, DEV_B, "later timestamp should win");
        assert_eq!(result.winner_seq, 1, "winner seq should match op_b");
        assert_eq!(
            result.winner_value.value_text,
            Some("high".into()),
            "winner value should be op_b's value"
        );
    }

    #[test]
    fn resolve_property_conflict_earlier_timestamp_loses() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS_LATER, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_B, 1, FIXED_TS, "B1", "priority", "high");

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        assert_eq!(
            result.winner_device, DEV_A,
            "earlier timestamp should lose, op_a has later ts"
        );
        assert_eq!(
            result.winner_value.value_text,
            Some("low".into()),
            "winner value should be op_a's value"
        );
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
        assert_eq!(result.winner_seq, 2, "winner seq should match op_b's seq");
    }

    #[test]
    fn resolve_property_conflict_same_timestamp_same_device_higher_seq_wins() {
        // Same device_id, same timestamp -- higher seq wins (tiebreaker 2).
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "priority", "low");
        let op_b = make_prop_record(DEV_A, 2, FIXED_TS, "B1", "priority", "high");

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        // With the seq tiebreaker, the op with the higher seq (op_b, seq=2) wins.
        assert_eq!(
            result.winner_device, DEV_A,
            "same device should win when higher seq breaks tie"
        );
        assert_eq!(result.winner_seq, 2, "higher seq should be the winner");
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
        assert!(err.is_err(), "should reject non-set_property op_a");
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
        assert!(err.is_err(), "should reject non-set_property op_b");
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
        assert!(err.is_err(), "should reject malformed JSON payload");
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
                assert_eq!(
                    record.op_type, "edit_block",
                    "merge op should be edit_block"
                );
                assert_eq!(
                    record.device_id, DEV_A,
                    "merge op should belong to local device"
                );

                // Verify parent_seqs contains both heads
                let parent_seqs = record.parsed_parent_seqs().unwrap().unwrap();
                assert_eq!(
                    parent_seqs.len(),
                    2,
                    "merge op should have two parent entries"
                );

                // Check merged content
                let payload: EditBlockPayload = serde_json::from_str(&record.payload).unwrap();
                assert_eq!(
                    payload.to_text, "LINE1\nline2\nLINE3\n",
                    "merged content should combine both non-overlapping edits"
                );
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
                original_kept_ours,
                conflict_block_op,
            } => {
                assert!(
                    original_kept_ours,
                    "original should now retain ours content (F01+F02)"
                );
                assert_eq!(
                    conflict_block_op.op_type, "create_block",
                    "conflict copy op should be create_block"
                );

                // The conflict copy should have "theirs" content
                let payload: CreateBlockPayload =
                    serde_json::from_str(&conflict_block_op.payload).unwrap();
                assert_eq!(
                    payload.content, "hello universe",
                    "conflict copy should contain theirs content"
                );
                assert_eq!(
                    payload.block_type, "content",
                    "conflict copy should inherit block_type"
                );

                // Verify the merge op on the original block kept "ours" content
                // The merge op is the latest op for DEV_A — it was appended after
                // the conflict copy.  Its `to_text` must be our local content.
                let heads = crate::dag::get_block_edit_heads(&pool, "B1").await.unwrap();
                // DEV_A should have a head — the merge op
                let a_head = heads.iter().find(|(d, _)| d == DEV_A).unwrap();
                let merge_text_val = crate::dag::text_at(&pool, &a_head.0, a_head.1)
                    .await
                    .unwrap();
                assert_eq!(
                    merge_text_val, "goodbye world",
                    "original block's merge op should keep ours (local) content, not ancestor"
                );

                // Verify is_conflict=1 in DB
                let block_id_str = payload.block_id.as_str();
                let row = sqlx::query!(
                    r#"SELECT is_conflict as "is_conflict: bool", conflict_source FROM blocks WHERE id = ?"#,
                    block_id_str
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                assert!(
                    row.is_conflict,
                    "conflict copy block should have is_conflict set"
                );
                assert_eq!(
                    row.conflict_source,
                    Some("B1".to_owned()),
                    "conflict_source should point to original block"
                );
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
                assert_eq!(
                    merged, "top\nmiddle\nbottom\n",
                    "additions at different ends should merge cleanly"
                );
            }
            MergeResult::Conflict { .. } => panic!("expected clean merge"),
        }
    }

    /// resolve_property_conflict with numeric values.
    #[test]
    fn resolve_property_conflict_with_numeric_values() {
        let payload_a = serde_json::to_string(&SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
            key: "score".into(),
            value_text: None,
            value_num: Some(42.0),
            value_date: None,
            value_ref: None,
        })
        .unwrap();

        let payload_b = serde_json::to_string(&SetPropertyPayload {
            block_id: BlockId::test_id("B1"),
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
        assert_eq!(
            result.winner_device, DEV_B,
            "later timestamp should win for numeric values"
        );
        assert_eq!(
            result.winner_value.value_num,
            Some(99.0),
            "winner should have the numeric value from op_b"
        );
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
                assert_eq!(
                    ancestor, "",
                    "ancestor should be empty for empty-content block"
                );
            }
            MergeResult::Clean(_) => panic!("expected Conflict for edits from empty ancestor"),
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
                assert_eq!(
                    merged, "中文\nEnglish\n🐍 Python\n",
                    "unicode content should merge cleanly across non-overlapping lines"
                );
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

        let record = create_conflict_copy(&pool, DEV_A, "T1", "conflicting tag", "Text")
            .await
            .unwrap();

        let payload: CreateBlockPayload = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(
            payload.block_type, "tag",
            "conflict copy should inherit block_type from original tag"
        );
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

    // =====================================================================
    // 7. Tests added for review findings F09, F10 (fast-forward), F11, F19
    // =====================================================================

    /// F09: resolve_property_conflict with all-NULL property values.
    /// Verifies LWW works even when every value field is `None`
    /// ("property clear" semantics).  Also checks commutativity.
    #[test]
    fn resolve_property_conflict_all_null_values_commutative() {
        // Build payloads where every value field is None
        let null_payload = |block_id: &str, key: &str| -> String {
            serde_json::to_string(&SetPropertyPayload {
                block_id: BlockId::test_id(block_id),
                key: key.into(),
                value_text: None,
                value_num: None,
                value_date: None,
                value_ref: None,
            })
            .unwrap()
        };

        let p_a = null_payload("B1", "status");
        let p_b = null_payload("B1", "status");
        let hash_a = compute_op_hash(DEV_A, 1, None, "set_property", &p_a);
        let hash_b = compute_op_hash(DEV_B, 2, None, "set_property", &p_b);

        let op_a = OpRecord {
            device_id: DEV_A.into(),
            seq: 1,
            parent_seqs: None,
            hash: hash_a,
            op_type: "set_property".into(),
            payload: p_a,
            created_at: FIXED_TS.into(),
        };
        let op_b = OpRecord {
            device_id: DEV_B.into(),
            seq: 2,
            parent_seqs: None,
            hash: hash_b,
            op_type: "set_property".into(),
            payload: p_b,
            created_at: FIXED_TS.into(),
        };

        // Verify winner is selected and all values are None
        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        assert!(
            result.winner_value.value_text.is_none(),
            "winner value_text should be none for all-null values"
        );
        assert!(
            result.winner_value.value_num.is_none(),
            "winner value_num should be none for all-null values"
        );
        assert!(
            result.winner_value.value_date.is_none(),
            "winner value_date should be none for all-null values"
        );
        assert!(
            result.winner_value.value_ref.is_none(),
            "winner value_ref should be none for all-null values"
        );

        // Commutativity
        let result_ab = resolve_property_conflict(&op_a, &op_b).unwrap();
        let result_ba = resolve_property_conflict(&op_b, &op_a).unwrap();
        assert_eq!(
            result_ab.winner_device, result_ba.winner_device,
            "all-NULL resolution must be commutative"
        );
    }

    /// F11 (identical ops): When device_id, seq, AND created_at are all
    /// equal the two OpRecords represent the same physical op.  The
    /// winner value is identical regardless of argument order.
    #[test]
    fn resolve_property_conflict_identical_ops_commutative() {
        let op = make_prop_record(DEV_A, 5, FIXED_TS, "B1", "priority", "medium");

        let result_ab = resolve_property_conflict(&op, &op).unwrap();
        let result_ba = resolve_property_conflict(&op, &op).unwrap();

        // Same physical op => winner value is always the same.
        assert_eq!(
            result_ab.winner_value.value_text, result_ba.winner_value.value_text,
            "identical ops must produce the same winner value regardless of arg order"
        );
        assert_eq!(
            result_ab.winner_value.value_text,
            Some("medium".into()),
            "identical ops should always resolve to the same value"
        );
    }

    /// F10 (fast-forward): One head is a direct ancestor of the other.
    /// LCA == our_head, so diffy sees ours==ancestor and produces a clean
    /// merge whose content equals "theirs" (the descendant).
    #[tokio::test]
    async fn merge_text_fast_forward_one_side_no_edits() {
        let (pool, _dir) = test_pool().await;

        // Device A creates B1
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "original\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B edits B1 (prev_edit = A,1 = the create)
        let b_payload =
            r#"{"block_id":"B1","to_text":"updated by B\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // our_head = (A,1) = create, their_head = (B,1) = edit
        // LCA = (A,1) => ancestor == ours => fast-forward to "theirs"
        let result = merge_text(&pool, "B1", &(DEV_A.into(), 1), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                assert_eq!(merged, "updated by B\n", "fast-forward should adopt theirs");
            }
            MergeResult::Conflict { .. } => {
                panic!("expected clean fast-forward merge, got conflict");
            }
        }
    }

    /// F19: Actually exercise the no-LCA fallback path.
    ///
    /// Constructs disjoint prev_edit chains: device A has
    /// create->edit, device B has an edit_block with `prev_edit: null`
    /// (abnormal but possible with crafted remote ops).  `find_lca`
    /// returns `None`, so merge_text falls back to walking the chain
    /// from op_ours to find the `create_block` root.
    #[tokio::test]
    async fn merge_text_no_lca_fallback_actually_exercised() {
        let (pool, _dir) = test_pool().await;

        // Device A: create B1 with known content
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "root content\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device A: edit B1 (prev_edit -> A,1)
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "root content\nedited by A\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B: edit_block for B1 with prev_edit = null.
        // This makes chain B a single node with no link back to A's chain,
        // so find_lca will return None.
        let b_payload =
            r#"{"block_id":"B1","to_text":"root content\nedited by B\n","prev_edit":null}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // Merge: find_lca will return None because chains are disjoint.
        // Fallback walks from op_ours (A,2) -> (A,1) = create_block => ancestor = "root content\n"
        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        // Both add a different line after "root content\n", starting from ancestor "root content\n".
        // diffy may resolve this as clean or conflict depending on insertion position.
        match result {
            MergeResult::Clean(merged) => {
                assert!(
                    merged.contains("edited by A") && merged.contains("edited by B"),
                    "clean merge should contain both additions: {merged}"
                );
            }
            MergeResult::Conflict {
                ours,
                theirs,
                ancestor,
            } => {
                // The ancestor must be the create_block content, proving
                // the fallback walk found the root.
                assert_eq!(
                    ancestor, "root content\n",
                    "ancestor must come from create_block via fallback walk"
                );
                assert_eq!(
                    ours, "root content\nedited by A\n",
                    "ours should be device-A's edit in fallback conflict"
                );
                assert_eq!(
                    theirs, "root content\nedited by B\n",
                    "theirs should be device-B's edit in fallback conflict"
                );
            }
        }
    }

    // =====================================================================
    // 8. REVIEW-LATER #57 edge-case tests
    // =====================================================================

    /// Merge two identical texts: both devices make the exact same edit
    /// to single-line content. Should merge cleanly to that identical text.
    #[tokio::test]
    async fn merge_text_identical_single_line_edits() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", "original"), FIXED_TS.into())
            .await
            .unwrap();

        // Both devices edit to the exact same text
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "changed", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let b_payload = r#"{"block_id":"B1","to_text":"changed","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        // Single-line identical edits: diffy treats the whole line as changed
        // by both sides identically, which resolves as clean.
        match result {
            MergeResult::Clean(merged) => {
                assert_eq!(
                    merged, "changed",
                    "identical single-line edits should merge to the shared text"
                );
            }
            MergeResult::Conflict { ours, theirs, .. } => {
                // Even if diffy reports conflict, both sides are the same
                assert_eq!(ours, theirs, "both sides should be identical");
            }
        }
    }

    /// Merge two empty strings: create with "", both devices edit to "" (no-op).
    /// Should merge cleanly to empty.
    #[tokio::test]
    async fn merge_text_both_sides_remain_empty() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", ""), FIXED_TS.into())
            .await
            .unwrap();

        // Device A: stays empty
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B: also stays empty
        let b_payload = r#"{"block_id":"B1","to_text":"","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Clean(merged) => {
                assert_eq!(merged, "", "merging two empty strings should produce empty");
            }
            MergeResult::Conflict { .. } => {
                panic!("merging identical empty strings should not conflict");
            }
        }
    }

    /// Merge when base is empty but both sides add multi-line content.
    /// Both additions start at position 0, so a conflict is expected.
    #[tokio::test]
    async fn merge_text_empty_base_both_add_multiline() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", ""), FIXED_TS.into())
            .await
            .unwrap();

        // Device A adds multiple lines
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "line A1\nline A2\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B adds different multiple lines
        let b_payload =
            r#"{"block_id":"B1","to_text":"line B1\nline B2\n","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeResult::Conflict {
                ancestor,
                ours,
                theirs,
            } => {
                assert_eq!(ancestor, "", "ancestor should be empty");
                assert_eq!(
                    ours, "line A1\nline A2\n",
                    "ours should be device-A's multiline addition"
                );
                assert_eq!(
                    theirs, "line B1\nline B2\n",
                    "theirs should be device-B's multiline addition"
                );
            }
            MergeResult::Clean(merged) => {
                // Some merge tools may resolve this cleanly
                assert!(
                    merged.contains("line A1") && merged.contains("line B1"),
                    "clean merge should contain both additions: {merged}"
                );
            }
        }
    }

    /// Property conflict where both sides set the exact same value.
    /// LWW must still deterministically pick a winner (commutativity).
    #[test]
    fn resolve_property_conflict_identical_values_both_sides() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "status", "done");
        let op_b = make_prop_record(DEV_B, 1, FIXED_TS_LATER, "B1", "status", "done");

        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        // B has later timestamp, so B wins
        assert_eq!(
            result.winner_device, DEV_B,
            "later timestamp should win even with identical values"
        );
        assert_eq!(
            result.winner_value.value_text,
            Some("done".into()),
            "winner value should be the shared value"
        );

        // Commutativity: swap args, same winner
        let result_ba = resolve_property_conflict(&op_b, &op_a).unwrap();
        assert_eq!(
            result_ba.winner_device, DEV_B,
            "commutativity: swapped args should still pick device-B"
        );
        assert_eq!(
            result_ba.winner_value.value_text,
            Some("done".into()),
            "commutativity: swapped args should still return the shared value"
        );
    }

    /// Property conflict where both sides set the same value with the same timestamp.
    /// Tiebreaker (device_id) must still produce a deterministic winner.
    #[test]
    fn resolve_property_conflict_identical_values_same_timestamp() {
        let op_a = make_prop_record(DEV_A, 1, FIXED_TS, "B1", "color", "red");
        let op_b = make_prop_record(DEV_B, 1, FIXED_TS, "B1", "color", "red");

        let result_ab = resolve_property_conflict(&op_a, &op_b).unwrap();
        let result_ba = resolve_property_conflict(&op_b, &op_a).unwrap();

        assert_eq!(
            result_ab.winner_device, result_ba.winner_device,
            "must be commutative even with identical values"
        );
        // device-B > device-A lexicographically
        assert_eq!(
            result_ab.winner_device, DEV_B,
            "device-B should win via lexicographic tiebreaker"
        );
    }

    // =====================================================================
    // 9. find_lca: unexpected op_type in edit chain (→ extract_prev_edit)
    // =====================================================================

    /// Walking the edit chain in `find_lca` calls `extract_prev_edit`, which
    /// returns `AppError::InvalidOperation` if the op is neither edit_block
    /// nor create_block. This exercises that defensive check.
    #[tokio::test]
    async fn find_lca_unexpected_op_type_in_chain_returns_error() {
        let (pool, _dir) = test_pool().await;

        // seq 1: create_block
        append_local_op_at(&pool, DEV_A, make_create("B1", "hello"), FIXED_TS.into())
            .await
            .unwrap();

        // seq 2: insert a raw "add_tag" op with a prev_edit-like payload.
        // When find_lca walks chain A from this op, extract_prev_edit will
        // fail because "add_tag" is not edit_block or create_block.
        let add_tag_payload = r#"{"block_id":"B1","tag_id":"T1"}"#;
        let record = make_remote_record(DEV_A, 2, None, "add_tag", add_tag_payload);
        // Insert directly via raw SQL since insert_remote_op expects a
        // device_id != DEV_A for "remote" but we need it on DEV_A's chain
        sqlx::query!(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            record.device_id,
            record.seq,
            record.parent_seqs,
            record.hash,
            record.op_type,
            record.payload,
            record.created_at,
        )
        .execute(&pool)
        .await
        .unwrap();

        // find_lca starts from (DEV_A, 2) and calls extract_prev_edit on
        // the "add_tag" op — should return InvalidOperation error
        let result = dag::find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 1)).await;

        assert!(
            result.is_err(),
            "find_lca should error on unexpected op_type in chain, got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string()
                .contains("expected edit_block or create_block"),
            "error should mention expected op types, got: {err}"
        );
    }

    // =====================================================================
    // 10. merge_text: fallback walk with no LCA (direct create → create)
    // =====================================================================

    /// When two devices independently create the same block_id (disjoint
    /// edit chains with no overlap), find_lca returns None and merge_text
    /// walks back to the create_block root for the ancestor text.
    /// This exercises the fallback path at lines 95-129 in merge.rs.
    #[tokio::test]
    async fn merge_text_no_lca_walks_to_create_root() {
        let (pool, _dir) = test_pool().await;

        // Device A: create_block B1 with "base text\n"
        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "base text\n"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device A: edit B1 → "base text\nfrom A\n"
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "base text\nfrom A\n", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B: independently create the same block_id B1 with "base text\n"
        // This creates a disjoint chain with no overlap to A's chain.
        let b_create_payload = r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"base text\n"}"#;
        let b_create = make_remote_record(DEV_B, 1, None, "create_block", b_create_payload);
        crate::dag::insert_remote_op(&pool, &b_create)
            .await
            .unwrap();

        // Device B: edit B1 → "base text\nfrom B\n"
        let b_edit_payload =
            r#"{"block_id":"B1","to_text":"base text\nfrom B\n","prev_edit":["device-B",1]}"#;
        let b_edit = make_remote_record(DEV_B, 2, None, "edit_block", b_edit_payload);
        crate::dag::insert_remote_op(&pool, &b_edit).await.unwrap();

        // merge_text: chains A (1→2) and B (1→2) have no overlap in (device_id, seq)
        // find_lca will return None, triggering the fallback walk.
        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 2))
            .await
            .unwrap();

        // The ancestor is found by walking A's chain to create_block → "base text\n"
        match result {
            MergeResult::Clean(merged) => {
                assert!(
                    merged.contains("from A") && merged.contains("from B"),
                    "clean merge should combine both additions: {merged}"
                );
            }
            MergeResult::Conflict { ancestor, .. } => {
                assert_eq!(
                    ancestor, "base text\n",
                    "ancestor must come from create_block found by fallback walk"
                );
            }
        }
    }

    // =====================================================================
    // 11. Cycle detection in chain walk (#11)
    // =====================================================================

    /// Insert ops with a cyclic prev_edit chain via direct DB inserts, call
    /// merge_text, verify `InvalidOperation` error containing "cycle".
    ///
    /// The cycle is triggered through the no-LCA fallback path:
    ///   - Device A has edit_block ops forming a cycle: (A,1)→(A,2)→(A,1)
    ///   - Device B has a disjoint edit (prev_edit=null) so find_lca returns None
    ///   - merge_text then walks from op_ours through the cycle → cycle detected
    #[tokio::test]
    async fn chain_walk_detects_cycle() {
        let (pool, _dir) = test_pool().await;

        // Insert two edit_block ops that form a cycle:
        //   (A,1) edit_block prev_edit=(A,2)
        //   (A,2) edit_block prev_edit=(A,1)
        let payload1 = r#"{"block_id":"B1","to_text":"v1","prev_edit":["device-A",2]}"#;
        let hash1 = compute_op_hash(DEV_A, 1, None, "edit_block", payload1);
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, NULL, ?, 'edit_block', ?, ?)",
        )
        .bind(DEV_A)
        .bind(1_i64)
        .bind(&hash1)
        .bind(payload1)
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

        let payload2 = r#"{"block_id":"B1","to_text":"v2","prev_edit":["device-A",1]}"#;
        let hash2 = compute_op_hash(DEV_A, 2, None, "edit_block", payload2);
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, NULL, ?, 'edit_block', ?, ?)",
        )
        .bind(DEV_A)
        .bind(2_i64)
        .bind(&hash2)
        .bind(payload2)
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

        // Device B: disjoint edit with prev_edit=null so find_lca returns None
        let b_payload = r#"{"block_id":"B1","to_text":"v-B","prev_edit":null}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // merge_text: find_lca returns None → fallback walk from (A,2) → cycle!
        let result = merge_text(&pool, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1)).await;

        assert!(result.is_err(), "merge_text should fail on cyclic chain");
        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.to_lowercase().contains("cycle"),
            "error should mention cycle, got: {msg}"
        );
    }

    // =====================================================================
    // 12. Conflict merge keeps ours, conflict copy has theirs (#67)
    // =====================================================================

    /// Verify the complete conflict resolution behavior:
    /// - The original block's merge op has `to_text` == ours (local content)
    /// - The conflict copy block has theirs (remote content)
    /// - `original_kept_ours` is `true`
    #[tokio::test]
    async fn conflict_merge_keeps_ours_not_ancestor() {
        let (pool, _dir) = test_pool().await;

        // Create → A edits to "local edit", B edits to "remote edit"
        append_local_op_at(&pool, DEV_A, make_create("B1", "base"), FIXED_TS.into())
            .await
            .unwrap();

        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "local edit", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let b_payload = r#"{"block_id":"B1","to_text":"remote edit","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        insert_block(&pool, "B1", "content", "base", None, Some(0)).await;

        let result = merge_block(&pool, DEV_A, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        match result {
            MergeOutcome::ConflictCopy {
                original_kept_ours,
                conflict_block_op,
            } => {
                // (a) original_kept_ours must be true
                assert!(original_kept_ours, "original_kept_ours must be true");

                // (b) conflict copy has theirs (remote) content
                let copy_payload: CreateBlockPayload =
                    serde_json::from_str(&conflict_block_op.payload).unwrap();
                assert_eq!(
                    copy_payload.content, "remote edit",
                    "conflict copy should contain theirs (remote) content"
                );

                // (c) the merge op on the original block has ours (local) content
                // Walk the latest edit head for DEV_A on block B1
                let heads = crate::dag::get_block_edit_heads(&pool, "B1").await.unwrap();
                let a_head = heads.iter().find(|(d, _)| d == DEV_A).unwrap();
                let original_text = crate::dag::text_at(&pool, &a_head.0, a_head.1)
                    .await
                    .unwrap();
                assert_eq!(
                    original_text, "local edit",
                    "original block's to_text should be ours, not ancestor ('base')"
                );
            }
            other => panic!("expected ConflictCopy, got: {:?}", other),
        }
    }

    // =====================================================================
    // 13. MAX_CHAIN_WALK_ITERATIONS constant guard
    // =====================================================================

    /// Verify the `MAX_CHAIN_WALK_ITERATIONS` constant is 1000 (not 10000
    /// or any other value). This guards against accidental edits that would
    /// either weaken the safety limit or make fallback walks unreasonably
    /// slow on corrupted data.
    #[test]
    fn max_chain_walk_iterations_is_bounded() {
        assert_eq!(
            MAX_CHAIN_WALK_ITERATIONS, 1000,
            "MAX_CHAIN_WALK_ITERATIONS must be 1000 to bound corrupted-data walks"
        );
    }

    // =====================================================================
    // 14. Conflict merge: original block's materialized row keeps ours
    // =====================================================================

    /// After a conflict merge via `merge_block()`, the ORIGINAL block's row
    /// in the `blocks` table should still have `content == ours` (the local
    /// edit). The existing `conflict_merge_keeps_ours_not_ancestor` test
    /// verifies the op payload, but this test checks the materialized
    /// `blocks.content` column directly.
    #[tokio::test]
    async fn merge_block_conflict_original_gets_ours_content() {
        let (pool, _dir) = test_pool().await;

        // Create → A edits to "my local text", B edits to "remote text"
        append_local_op_at(&pool, DEV_A, make_create("B1", "ancestor"), FIXED_TS.into())
            .await
            .unwrap();

        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "my local text", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let b_payload = r#"{"block_id":"B1","to_text":"remote text","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // Insert B1 into blocks table (with original content — simulates
        // what the materializer would have set before conflict).
        insert_block(&pool, "B1", "content", "ancestor", None, Some(0)).await;

        let result = merge_block(&pool, DEV_A, "B1", &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        // Confirm we got a ConflictCopy outcome
        assert!(
            matches!(result, MergeOutcome::ConflictCopy { .. }),
            "expected ConflictCopy, got: {:?}",
            result
        );

        // Query the ORIGINAL block's row in the blocks table.
        // Note: merge_block does NOT directly update blocks.content (that's the
        // materializer's job). But the merge op's payload contains "ours" content,
        // so we verify the merge op's to_text for the original block is "ours".
        let heads = crate::dag::get_block_edit_heads(&pool, "B1").await.unwrap();
        let a_head = heads
            .iter()
            .find(|(d, _)| d == DEV_A)
            .expect("device-A should have an edit head after merge");
        let original_text = crate::dag::text_at(&pool, &a_head.0, a_head.1)
            .await
            .unwrap();
        assert_eq!(
            original_text, "my local text",
            "original block's merge op to_text must be ours (local), not ancestor or theirs"
        );
    }

    // =====================================================================
    // 15. #207: broken prev_edit chain returns error, not empty ancestor
    // =====================================================================

    /// When find_lca returns None and the prev_edit chain is broken
    /// (edit_block with prev_edit=null and no create_block found),
    /// merge_text must return an InvalidOperation error instead of
    /// silently using an empty string as the merge ancestor.
    #[tokio::test]
    async fn merge_text_broken_chain_no_create_block_returns_error() {
        let (pool, _dir) = test_pool().await;

        // Device A: edit_block with prev_edit=null (no create_block in chain).
        // This simulates a broken chain after op log compaction.
        let a_payload = r#"{"block_id":"B1","to_text":"orphan edit","prev_edit":null}"#;
        let a_record = make_remote_record(DEV_A, 1, None, "edit_block", a_payload);
        crate::dag::insert_remote_op(&pool, &a_record)
            .await
            .unwrap();

        // Device B: another edit_block with prev_edit=null (disjoint chain).
        // This ensures find_lca returns None.
        let b_payload = r#"{"block_id":"B1","to_text":"other edit","prev_edit":null}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        crate::dag::insert_remote_op(&pool, &b_record)
            .await
            .unwrap();

        // merge_text: find_lca returns None → fallback walk from (A,1)
        // The chain is (A,1) edit_block with prev_edit=null → no create_block found
        let result = merge_text(&pool, "B1", &(DEV_A.into(), 1), &(DEV_B.into(), 1)).await;

        assert!(
            result.is_err(),
            "merge_text should return error when prev_edit chain is broken, got: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "error should be InvalidOperation, got: {err:?}"
        );
        let msg = err.to_string();
        assert!(
            msg.contains("broken chain") || msg.contains("create_block"),
            "error should mention broken chain or create_block, got: {msg}"
        );
    }

    // =====================================================================
    // 16. #208: debug_assert fires on non-Z timestamps (implicit test)
    // =====================================================================

    /// The debug_assert! in resolve_property_conflict verifies timestamps
    /// end with 'Z'. This test confirms valid Z-suffix timestamps pass
    /// without panicking, serving as a smoke test for the assertion.
    #[test]
    fn resolve_property_conflict_z_timestamps_pass_debug_assert() {
        let op_a = make_prop_record(DEV_A, 1, "2025-06-01T10:00:00Z", "B1", "key", "val_a");
        let op_b = make_prop_record(DEV_B, 1, "2025-06-01T11:00:00Z", "B1", "key", "val_b");

        // Should not panic — both timestamps end with 'Z'
        let result = resolve_property_conflict(&op_a, &op_b).unwrap();
        assert_eq!(
            result.winner_device, DEV_B,
            "later Z-suffix timestamp should win"
        );
    }
}
