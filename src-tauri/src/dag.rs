//! DAG traversal primitives for the op log (ADR-07, Phase 4).
//!
//! Building blocks for the merge system (Wave 1B). Provides:
//! - Remote op insertion with hash verification
//! - Merge op creation with multi-parent parent_seqs
//! - Lowest Common Ancestor (LCA) for edit chains
//! - Text extraction at a given op
//! - Edit head discovery across devices

#![allow(dead_code)]

use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::hash::{compute_op_hash, verify_op_hash};
use crate::op::*;
use crate::op_log::{get_op_by_seq, serialize_inner_payload, OpRecord};

/// Extract the `prev_edit` pointer from an op record's payload.
///
/// - `edit_block` → returns `payload.prev_edit` (may be `None`)
/// - `create_block` → returns `None` (root of the edit chain)
/// - anything else → `AppError::InvalidOperation`
fn extract_prev_edit(record: &OpRecord) -> Result<Option<(String, i64)>, AppError> {
    match record.op_type.as_str() {
        "edit_block" => {
            let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
            Ok(payload.prev_edit)
        }
        "create_block" => Ok(None),
        _ => Err(AppError::InvalidOperation(format!(
            "expected edit_block or create_block, got {}",
            record.op_type
        ))),
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Insert an op received from a remote device into the op_log.
///
/// Uses `INSERT OR IGNORE` on the composite PK `(device_id, seq)` so that
/// duplicate delivery is idempotent (ADR-09). Rejects ops whose hash does
/// not match the recomputed hash of the record fields.
pub async fn insert_remote_op(pool: &SqlitePool, record: &OpRecord) -> Result<bool, AppError> {
    // Verify the hash matches the record contents
    if !verify_op_hash(
        &record.hash,
        &record.device_id,
        record.seq,
        record.parent_seqs.as_deref(),
        &record.op_type,
        &record.payload,
    ) {
        return Err(AppError::InvalidOperation(
            "hash mismatch on remote op".into(),
        ));
    }

    // INSERT OR IGNORE — duplicate delivery is a no-op.
    // Returns true if a row was inserted, false if it was a duplicate.
    let result = sqlx::query!(
        "INSERT OR IGNORE INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        record.device_id,
        record.seq,
        record.parent_seqs,
        record.hash,
        record.op_type,
        record.payload,
        record.created_at,
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

/// Create a merge op whose `parent_seqs` contains entries from multiple
/// devices (one per syncing device at the merge point).
///
/// `parent_entries` must contain at least 2 entries. They are sorted
/// lexicographically by `(device_id, seq)` for deterministic hashing.
pub async fn append_merge_op(
    pool: &SqlitePool,
    device_id: &str,
    op_payload: OpPayload,
    parent_entries: Vec<(String, i64)>,
) -> Result<OpRecord, AppError> {
    if parent_entries.len() < 2 {
        return Err(AppError::InvalidOperation(
            "merge op requires at least 2 parent entries".into(),
        ));
    }

    // Sort lexicographically for deterministic hashing
    let mut sorted_parents = parent_entries;
    sorted_parents.sort();

    let parent_seqs_json = serde_json::to_string(&sorted_parents)?;
    let op_type = op_payload.op_type_str().to_owned();
    let payload_json = serialize_inner_payload(&op_payload)?;
    let created_at = crate::now_rfc3339();

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let row = sqlx::query!(
        r#"SELECT COALESCE(MAX(seq), 0) + 1 as "next_seq!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(&mut *tx)
    .await?;
    let seq = row.next_seq;

    let hash = compute_op_hash(
        device_id,
        seq,
        Some(&parent_seqs_json),
        &op_type,
        &payload_json,
    );

    sqlx::query!(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        device_id,
        seq,
        parent_seqs_json,
        hash,
        op_type,
        payload_json,
        created_at,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(OpRecord {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs: Some(parent_seqs_json),
        hash,
        op_type,
        payload: payload_json,
        created_at,
    })
}

/// Find the Lowest Common Ancestor of two edit chains for a specific block.
///
/// Walks backward from `op_a` and `op_b` following `prev_edit` pointers in
/// `EditBlockPayload`. For `create_block` ops the chain terminates (no
/// `prev_edit`).
///
/// Algorithm: build a visited set from chain A, then walk chain B until
/// finding a match.
///
/// Returns `None` if both chains trace back to their roots with no overlap
/// (should not happen for ops targeting the same block).
///
/// # Compaction limitation
///
/// If historical ops in the edit chain have been purged by
/// [`crate::snapshot::compact_op_log`], the chain walk will encounter
/// `AppError::NotFound` for the missing op and propagate the error.
/// **Callers must ensure both ops' chains are fully intact** (i.e., no
/// compaction has purged ops between the roots and the given heads).
pub async fn find_lca(
    pool: &SqlitePool,
    op_a: &(String, i64),
    op_b: &(String, i64),
) -> Result<Option<(String, i64)>, AppError> {
    // Check if compaction has occurred (snapshots exist)
    let has_snapshots: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(pool)
            .await?;

    // Build visited set from chain A (including op_a itself)
    let mut visited: HashSet<(String, i64)> = HashSet::new();
    let mut current: Option<(String, i64)> = Some(op_a.clone());
    while let Some(key) = current.take() {
        if !visited.insert(key.clone()) {
            break; // cycle detected — stop walking
        }
        match get_op_by_seq(pool, &key.0, key.1).await {
            Ok(record) => current = extract_prev_edit(&record)?,
            Err(AppError::NotFound(_)) if has_snapshots > 0 => {
                return Err(AppError::InvalidOperation(format!(
                    "edit chain broken at ({}, {}) — likely due to op log compaction; \
                     LCA requires intact chains",
                    key.0, key.1
                )));
            }
            Err(e) => return Err(e),
        }
    }

    // Walk chain B, checking each step against the visited set
    let mut visited_b: HashSet<(String, i64)> = HashSet::new();
    let mut current: Option<(String, i64)> = Some(op_b.clone());
    while let Some(key) = current.take() {
        if visited.contains(&key) {
            return Ok(Some(key));
        }
        if !visited_b.insert(key.clone()) {
            break; // cycle detected — stop walking
        }
        match get_op_by_seq(pool, &key.0, key.1).await {
            Ok(record) => current = extract_prev_edit(&record)?,
            Err(AppError::NotFound(_)) if has_snapshots > 0 => {
                return Err(AppError::InvalidOperation(format!(
                    "edit chain broken at ({}, {}) — likely due to op log compaction; \
                     LCA requires intact chains",
                    key.0, key.1
                )));
            }
            Err(e) => return Err(e),
        }
    }

    Ok(None)
}

/// Extract the text content at a given op.
///
/// - `edit_block` → `to_text`
/// - `create_block` → `content`
/// - anything else → `AppError::InvalidOperation`
pub async fn text_at(pool: &SqlitePool, device_id: &str, seq: i64) -> Result<String, AppError> {
    let record = get_op_by_seq(pool, device_id, seq).await?;
    match record.op_type.as_str() {
        "edit_block" => {
            let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
            Ok(payload.to_text)
        }
        "create_block" => {
            let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
            Ok(payload.content)
        }
        _ => Err(AppError::InvalidOperation(format!(
            "text_at only works for content-producing ops, got {}",
            record.op_type
        ))),
    }
}

/// Get the latest `edit_block` ops for a block across all devices.
///
/// Returns the `(device_id, seq)` of the highest-seq `edit_block` op per
/// device for the given `block_id`. These are the "heads" of the edit DAG —
/// useful for detecting divergence that requires merging.
pub async fn get_block_edit_heads(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Vec<(String, i64)>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT device_id as "device_id!: String", MAX(seq) AS "seq!: i64"
         FROM op_log
         WHERE op_type = 'edit_block'
           AND json_extract(payload, '$.block_id') = ?
         GROUP BY device_id
         ORDER BY device_id"#,
        block_id,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|r| (r.device_id, r.seq)).collect())
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::hash::compute_op_hash;
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Test fixture constants ──────────────────────────────────────────

    const FIXED_TS: &str = "2025-01-15T12:00:00+00:00";
    const DEV_A: &str = "device-A";
    const DEV_B: &str = "device-B";

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Create a temp-file-backed SQLite pool with migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
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

    /// Build a `DeleteBlock` payload.
    fn make_delete(block_id: &str) -> OpPayload {
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id(block_id),
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

    // =====================================================================
    // 1. insert_remote_op
    // =====================================================================

    #[tokio::test]
    async fn insert_remote_op_happy_path() {
        let (pool, _dir) = test_pool().await;

        let record = make_remote_record(
            "remote-dev",
            1,
            None,
            "create_block",
            r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
        );

        insert_remote_op(&pool, &record).await.unwrap();

        // Verify it landed in the DB
        let fetched = get_op_by_seq(&pool, "remote-dev", 1).await.unwrap();
        assert_eq!(fetched.device_id, "remote-dev");
        assert_eq!(fetched.seq, 1);
        assert_eq!(fetched.hash, record.hash);
        assert_eq!(fetched.op_type, "create_block");
    }

    #[tokio::test]
    async fn insert_remote_op_duplicate_is_ignored() {
        let (pool, _dir) = test_pool().await;

        let record = make_remote_record(
            "remote-dev",
            1,
            None,
            "create_block",
            r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
        );

        // Insert twice — second should be silently ignored
        insert_remote_op(&pool, &record).await.unwrap();
        insert_remote_op(&pool, &record).await.unwrap();

        // Verify only one row exists
        let fetched = get_op_by_seq(&pool, "remote-dev", 1).await.unwrap();
        assert_eq!(fetched.hash, record.hash);
    }

    #[tokio::test]
    async fn insert_remote_op_hash_mismatch_rejected() {
        let (pool, _dir) = test_pool().await;

        let mut record = make_remote_record(
            "remote-dev",
            1,
            None,
            "create_block",
            r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#,
        );
        // Tamper with the hash
        record.hash = "0".repeat(64);

        let err = insert_remote_op(&pool, &record).await;
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("hash mismatch"),
            "expected hash mismatch error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn insert_remote_op_with_parent_seqs() {
        let (pool, _dir) = test_pool().await;

        // First insert the genesis op
        let r1 = make_remote_record(
            "remote-dev",
            1,
            None,
            "create_block",
            r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"v1"}"#,
        );
        insert_remote_op(&pool, &r1).await.unwrap();

        // Then insert an op that references the first as parent
        let parent_seqs = Some(r#"[["remote-dev",1]]"#.to_owned());
        let r2 = make_remote_record(
            "remote-dev",
            2,
            parent_seqs.clone(),
            "edit_block",
            r#"{"block_id":"B1","to_text":"v2","prev_edit":["remote-dev",1]}"#,
        );
        insert_remote_op(&pool, &r2).await.unwrap();

        let fetched = get_op_by_seq(&pool, "remote-dev", 2).await.unwrap();
        assert_eq!(fetched.parent_seqs, parent_seqs);
    }

    // =====================================================================
    // 2. append_merge_op
    // =====================================================================

    #[tokio::test]
    async fn append_merge_op_creates_multi_parent_op() {
        let (pool, _dir) = test_pool().await;

        // Set up some prior ops so the local device has a seq
        append_local_op_at(&pool, DEV_A, make_create("B1", "hello"), FIXED_TS.into())
            .await
            .unwrap();

        let merge_payload = make_edit("B1", "merged text", None);
        let parents = vec![(DEV_A.to_owned(), 1), (DEV_B.to_owned(), 3)];

        let record = append_merge_op(&pool, DEV_A, merge_payload, parents)
            .await
            .unwrap();

        // seq should be 2 (after the create at seq 1)
        assert_eq!(record.seq, 2);
        assert_eq!(record.device_id, DEV_A);
        assert_eq!(record.op_type, "edit_block");

        // parent_seqs should be sorted and contain both entries
        let parent_seqs = record.parsed_parent_seqs().unwrap().unwrap();
        assert_eq!(parent_seqs.len(), 2);
        // Sorted lexicographically: device-A < device-B
        assert_eq!(parent_seqs[0], (DEV_A.to_owned(), 1));
        assert_eq!(parent_seqs[1], (DEV_B.to_owned(), 3));
    }

    #[tokio::test]
    async fn append_merge_op_sorts_parents_deterministically() {
        let (pool, _dir) = test_pool().await;

        let merge_payload = make_edit("B1", "merged", None);
        // Pass parents in reverse order
        let parents = vec![("zzz-device".to_owned(), 5), ("aaa-device".to_owned(), 10)];

        let record = append_merge_op(&pool, "local", merge_payload, parents)
            .await
            .unwrap();

        let parent_seqs = record.parsed_parent_seqs().unwrap().unwrap();
        // Must be sorted: aaa < zzz
        assert_eq!(parent_seqs[0].0, "aaa-device");
        assert_eq!(parent_seqs[1].0, "zzz-device");
    }

    #[tokio::test]
    async fn append_merge_op_rejects_fewer_than_2_parents() {
        let (pool, _dir) = test_pool().await;

        let payload = make_edit("B1", "text", None);
        let err = append_merge_op(&pool, DEV_A, payload, vec![(DEV_A.to_owned(), 1)]).await;

        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("at least 2"),
            "expected 'at least 2' error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn append_merge_op_rejects_empty_parents() {
        let (pool, _dir) = test_pool().await;

        let payload = make_edit("B1", "text", None);
        let err = append_merge_op(&pool, DEV_A, payload, vec![]).await;

        assert!(err.is_err());
    }

    #[tokio::test]
    async fn append_merge_op_hash_verifies() {
        let (pool, _dir) = test_pool().await;

        let payload = make_edit("B1", "merged", None);
        let parents = vec![(DEV_A.to_owned(), 1), (DEV_B.to_owned(), 2)];

        let record = append_merge_op(&pool, DEV_A, payload, parents)
            .await
            .unwrap();

        // Recompute hash and verify
        let recomputed = compute_op_hash(
            &record.device_id,
            record.seq,
            record.parent_seqs.as_deref(),
            &record.op_type,
            &record.payload,
        );
        assert_eq!(record.hash, recomputed);
    }

    // =====================================================================
    // 3. find_lca
    // =====================================================================

    /// Two edits diverge from the same create.
    ///
    /// ```text
    /// (A,1) create_block B1
    ///   ├── (A,2) edit_block B1, prev_edit=(A,1)
    ///   └── (B,1) edit_block B1, prev_edit=(A,1)
    /// ```
    ///
    /// LCA of (A,2) and (B,1) should be (A,1).
    #[tokio::test]
    async fn find_lca_two_edits_diverge_from_create() {
        let (pool, _dir) = test_pool().await;

        // Device A: create B1
        append_local_op_at(&pool, DEV_A, make_create("B1", "initial"), FIXED_TS.into())
            .await
            .unwrap();

        // Device A: edit B1 with prev_edit pointing to the create
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "edit-A", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B: edit B1 also pointing to (A,1) as prev_edit
        // Insert as remote op since it's a different device
        let b_edit_payload = r#"{"block_id":"B1","to_text":"edit-B","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(
            DEV_B,
            1,
            None, // genesis for device B
            "edit_block",
            b_edit_payload,
        );
        insert_remote_op(&pool, &b_record).await.unwrap();

        let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_B.into(), 1))
            .await
            .unwrap();

        assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
    }

    /// Linear chain: A creates, then edits twice.
    ///
    /// ```text
    /// (A,1) create → (A,2) edit → (A,3) edit
    /// ```
    ///
    /// LCA of (A,2) and (A,3) is (A,2).
    #[tokio::test]
    async fn find_lca_linear_chain() {
        let (pool, _dir) = test_pool().await;

        // create
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        // edit 1
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        // edit 2
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v2", Some((DEV_A.into(), 2))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 3))
            .await
            .unwrap();
        assert_eq!(lca, Some((DEV_A.to_owned(), 2)));
    }

    /// Divergent edits from a common edit (not the create).
    ///
    /// ```text
    /// (A,1) create → (A,2) edit
    ///                  ├── (A,3) edit, prev_edit=(A,2)
    ///                  └── (B,1) edit, prev_edit=(A,2)
    /// ```
    ///
    /// LCA of (A,3) and (B,1) is (A,2).
    #[tokio::test]
    async fn find_lca_divergent_from_common_edit() {
        let (pool, _dir) = test_pool().await;

        // create
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        // edit 1
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        // edit 2 (continues on A)
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v2-A", Some((DEV_A.into(), 2))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B diverges from (A,2)
        let b_payload = r#"{"block_id":"B1","to_text":"v2-B","prev_edit":["device-A",2]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        insert_remote_op(&pool, &b_record).await.unwrap();

        let lca = find_lca(&pool, &(DEV_A.into(), 3), &(DEV_B.into(), 1))
            .await
            .unwrap();
        assert_eq!(lca, Some((DEV_A.to_owned(), 2)));
    }

    /// Edge case: LCA of an op with itself.
    #[tokio::test]
    async fn find_lca_same_op() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 2))
            .await
            .unwrap();
        assert_eq!(lca, Some((DEV_A.to_owned(), 2)));
    }

    /// Edge case: find_lca with only the create_block (no edits).
    /// Both ops point to the same create.
    #[tokio::test]
    async fn find_lca_only_create_block() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();

        let lca = find_lca(&pool, &(DEV_A.into(), 1), &(DEV_A.into(), 1))
            .await
            .unwrap();
        assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
    }

    /// Edge case: op_a is a `create_block` and op_b is an `edit_block`
    /// whose chain traces back to that create.
    ///
    /// ```text
    /// (A,1) create_block B1
    ///   └── (A,2) edit_block B1, prev_edit=(A,1)
    /// ```
    ///
    /// LCA of (A,1) and (A,2) should be (A,1).
    #[tokio::test]
    async fn find_lca_op_a_is_create_block() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // op_a is create, op_b is edit
        let lca = find_lca(&pool, &(DEV_A.into(), 1), &(DEV_A.into(), 2))
            .await
            .unwrap();
        assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
    }

    /// Edge case: op_b is a `create_block` and op_a is an `edit_block`.
    /// Mirror of the above — ensures B-chain handling is correct for creates.
    ///
    /// LCA of (A,2) and (A,1) should be (A,1).
    #[tokio::test]
    async fn find_lca_op_b_is_create_block() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // op_a is edit, op_b is create
        let lca = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 1))
            .await
            .unwrap();
        assert_eq!(lca, Some((DEV_A.to_owned(), 1)));
    }

    // =====================================================================
    // 4. text_at
    // =====================================================================

    #[tokio::test]
    async fn text_at_returns_content_from_create_block() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(
            &pool,
            DEV_A,
            make_create("B1", "hello world"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let text = text_at(&pool, DEV_A, 1).await.unwrap();
        assert_eq!(text, "hello world");
    }

    #[tokio::test]
    async fn text_at_returns_to_text_from_edit_block() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "updated text", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let text = text_at(&pool, DEV_A, 2).await.unwrap();
        assert_eq!(text, "updated text");
    }

    #[tokio::test]
    async fn text_at_rejects_delete_block() {
        let (pool, _dir) = test_pool().await;

        append_local_op_at(&pool, DEV_A, make_delete("B1"), FIXED_TS.into())
            .await
            .unwrap();

        let err = text_at(&pool, DEV_A, 1).await;
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("content-producing"),
            "expected 'content-producing' error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn text_at_not_found_for_missing_op() {
        let (pool, _dir) = test_pool().await;

        let err = text_at(&pool, DEV_A, 999).await;
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("Not found"),
            "expected NotFound error, got: {msg}"
        );
    }

    // =====================================================================
    // 5. get_block_edit_heads
    // =====================================================================

    #[tokio::test]
    async fn get_block_edit_heads_single_device() {
        let (pool, _dir) = test_pool().await;

        // create block
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        // two edits
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v2", Some((DEV_A.into(), 2))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let heads = get_block_edit_heads(&pool, "B1").await.unwrap();
        assert_eq!(heads.len(), 1, "single device should have 1 head");
        assert_eq!(heads[0], (DEV_A.to_owned(), 3));
    }

    #[tokio::test]
    async fn get_block_edit_heads_multiple_devices() {
        let (pool, _dir) = test_pool().await;

        // Device A: create + edit
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1-A", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Device B: edit (inserted as remote)
        let b_payload = r#"{"block_id":"B1","to_text":"v1-B","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        insert_remote_op(&pool, &b_record).await.unwrap();

        let heads = get_block_edit_heads(&pool, "B1").await.unwrap();
        assert_eq!(heads.len(), 2, "two devices should have 2 heads");
        // Sorted by device_id: device-A < device-B
        assert_eq!(heads[0], (DEV_A.to_owned(), 2));
        assert_eq!(heads[1], (DEV_B.to_owned(), 1));
    }

    #[tokio::test]
    async fn get_block_edit_heads_no_edits() {
        let (pool, _dir) = test_pool().await;

        // Only a create, no edits
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();

        let heads = get_block_edit_heads(&pool, "B1").await.unwrap();
        assert!(heads.is_empty(), "no edits means no heads");
    }

    #[tokio::test]
    async fn get_block_edit_heads_different_blocks_isolated() {
        let (pool, _dir) = test_pool().await;

        // Edits for B1
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Edits for B2
        append_local_op_at(&pool, DEV_A, make_create("B2", "other"), FIXED_TS.into())
            .await
            .unwrap();
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B2", "other-v1", Some((DEV_A.into(), 3))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let heads_b1 = get_block_edit_heads(&pool, "B1").await.unwrap();
        assert_eq!(heads_b1.len(), 1);
        assert_eq!(heads_b1[0], (DEV_A.to_owned(), 2));

        let heads_b2 = get_block_edit_heads(&pool, "B2").await.unwrap();
        assert_eq!(heads_b2.len(), 1);
        assert_eq!(heads_b2[0], (DEV_A.to_owned(), 4));
    }

    #[tokio::test]
    async fn get_block_edit_heads_nonexistent_block() {
        let (pool, _dir) = test_pool().await;

        let heads = get_block_edit_heads(&pool, "nonexistent").await.unwrap();
        assert!(heads.is_empty());
    }

    // ── F15: find_lca after compaction (ops purged from chain) ──────────

    /// When historical ops have been purged by compaction, `find_lca` should
    /// return `AppError::InvalidOperation` with a clear message mentioning
    /// compaction (snapshots exist, so the guard detects the broken chain).
    #[tokio::test]
    async fn find_lca_after_compaction_produces_not_found() {
        use crate::snapshot::compact_op_log;

        let (pool, _dir) = test_pool().await;

        // Insert block into blocks table (needed for snapshot collection)
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, is_conflict) \
             VALUES ('B1', 'content', 'v1', 1, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Old create_block op (200 days ago)
        let _create = append_local_op_at(
            &pool,
            DEV_A,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("B1"),
                block_type: "content".to_owned(),
                parent_id: None,
                position: Some(0),
                content: "v1".to_owned(),
            }),
            "2024-01-01T00:00:00Z".to_owned(),
        )
        .await
        .unwrap();

        // Old edit (also 200 days ago) with prev_edit pointing to seq 1
        let _edit1 = append_local_op_at(
            &pool,
            DEV_A,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("B1"),
                prev_edit: Some((DEV_A.to_owned(), 1)),
                to_text: "v2".to_owned(),
            }),
            "2024-01-01T00:01:00Z".to_owned(),
        )
        .await
        .unwrap();

        // Recent edit (now) with prev_edit pointing to seq 2
        let now = crate::now_rfc3339();
        let edit2 = append_local_op_at(
            &pool,
            DEV_A,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("B1"),
                prev_edit: Some((DEV_A.to_owned(), 2)),
                to_text: "v3".to_owned(),
            }),
            now,
        )
        .await
        .unwrap();

        // Compact with 90-day retention → purges seq 1 and 2 (old), keeps seq 3
        compact_op_log(&pool, DEV_A, 90).await.unwrap();

        // Verify seq 3 survived
        assert_eq!(edit2.seq, 3);
        let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 1, "only the recent op should survive");

        // find_lca with seq 3 (recent) should fail because it tries to walk
        // the prev_edit chain to seq 2 which was purged.
        let result = find_lca(&pool, &(DEV_A.into(), 3), &(DEV_A.into(), 3)).await;
        assert!(
            result.is_err(),
            "find_lca should fail when chain walk hits purged ops"
        );

        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.to_lowercase().contains("compaction"),
            "expected InvalidOperation mentioning compaction, got: {msg}"
        );
    }

    /// Dedicated test: set up two ops, create a snapshot, delete the
    /// intermediate op from op_log, call find_lca, verify it returns
    /// `AppError::InvalidOperation` containing "compaction".
    #[tokio::test]
    async fn find_lca_after_compaction_returns_clear_error() {
        let (pool, _dir) = test_pool().await;

        // Create block
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();

        // Edit pointing back to create
        append_local_op_at(
            &pool,
            DEV_A,
            make_edit("B1", "v1", Some((DEV_A.into(), 1))),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Simulate compaction: insert a snapshot row then delete seq 1
        sqlx::query(
            "INSERT INTO log_snapshots (id, status, up_to_hash, up_to_seqs, data) \
             VALUES ('SNAP01', 'complete', 'fakehash', '{\"device-A\":1}', X'00')",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("DELETE FROM op_log WHERE device_id = ? AND seq = 1")
            .bind(DEV_A)
            .execute(&pool)
            .await
            .unwrap();

        // find_lca walks from (A,2), follows prev_edit to (A,1) which is
        // missing → should return InvalidOperation mentioning compaction
        let result = find_lca(&pool, &(DEV_A.into(), 2), &(DEV_A.into(), 2)).await;
        assert!(result.is_err(), "find_lca should fail on broken chain");

        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.to_lowercase().contains("compaction"),
            "error should mention compaction, got: {msg}"
        );
        assert!(
            msg.contains("edit chain broken"),
            "error should mention broken chain, got: {msg}"
        );
    }

    // =====================================================================
    // extract_prev_edit: unexpected op_type
    // =====================================================================

    /// `extract_prev_edit` returns `AppError::InvalidOperation` when the
    /// `OpRecord` has an op_type other than "edit_block" or "create_block".
    #[test]
    fn extract_prev_edit_unexpected_op_type_returns_error() {
        let payload = r#"{"block_id":"B1","tag_id":"T1"}"#;
        let hash = compute_op_hash("dev-test", 1, None, "delete_block", payload);
        let record = OpRecord {
            device_id: "dev-test".to_owned(),
            seq: 1,
            parent_seqs: None,
            hash,
            op_type: "delete_block".to_owned(),
            payload: payload.to_owned(),
            created_at: FIXED_TS.to_owned(),
        };

        let result = extract_prev_edit(&record);
        assert!(
            result.is_err(),
            "extract_prev_edit should error on delete_block op_type"
        );
        let err = result.unwrap_err();
        assert!(
            err.to_string()
                .contains("expected edit_block or create_block"),
            "error should mention expected types, got: {err}"
        );
    }

    /// `extract_prev_edit` returns `Ok(None)` for `create_block` ops.
    #[test]
    fn extract_prev_edit_create_block_returns_none() {
        let payload = r#"{"block_id":"B1","block_type":"content","parent_id":null,"position":0,"content":"hello"}"#;
        let hash = compute_op_hash("dev-test", 1, None, "create_block", payload);
        let record = OpRecord {
            device_id: "dev-test".to_owned(),
            seq: 1,
            parent_seqs: None,
            hash,
            op_type: "create_block".to_owned(),
            payload: payload.to_owned(),
            created_at: FIXED_TS.to_owned(),
        };

        let result = extract_prev_edit(&record).unwrap();
        assert!(result.is_none(), "create_block should have no prev_edit");
    }

    /// `extract_prev_edit` returns the `prev_edit` pointer for `edit_block` ops.
    #[test]
    fn extract_prev_edit_edit_block_returns_prev_edit() {
        let payload = r#"{"block_id":"B1","to_text":"updated","prev_edit":["device-A",1]}"#;
        let hash = compute_op_hash("dev-test", 2, None, "edit_block", payload);
        let record = OpRecord {
            device_id: "dev-test".to_owned(),
            seq: 2,
            parent_seqs: None,
            hash,
            op_type: "edit_block".to_owned(),
            payload: payload.to_owned(),
            created_at: FIXED_TS.to_owned(),
        };

        let result = extract_prev_edit(&record).unwrap();
        assert_eq!(
            result,
            Some(("device-A".to_owned(), 1)),
            "edit_block should return its prev_edit"
        );
    }

    // =====================================================================
    // find_lca: cycle detection in prev_edit chain
    // =====================================================================

    /// Create a cyclic prev_edit chain via raw SQL and verify that
    /// `find_lca` terminates gracefully (returns `Ok(None)` because the
    /// cycle-break `visited.insert` check stops the walk before it can
    /// loop forever).
    ///
    /// ```text
    /// (A,1) create_block B1
    /// (A,2) edit_block B1, prev_edit=(A,3)  ←── cycle
    /// (A,3) edit_block B1, prev_edit=(A,2)  ←── cycle
    /// (B,1) edit_block B1, prev_edit=(A,1)      (divergent)
    /// ```
    #[tokio::test]
    async fn find_lca_detects_cycle_in_chain() {
        let (pool, _dir) = test_pool().await;

        // (A,1) create_block B1 — normal op
        append_local_op_at(&pool, DEV_A, make_create("B1", "v0"), FIXED_TS.into())
            .await
            .unwrap();

        // (A,2) edit_block with prev_edit pointing FORWARD to (A,3) — forms cycle
        let payload2 = r#"{"block_id":"B1","to_text":"v2","prev_edit":["device-A",3]}"#;
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

        // (A,3) edit_block with prev_edit pointing back to (A,2) — completes the cycle
        let payload3 = r#"{"block_id":"B1","to_text":"v3","prev_edit":["device-A",2]}"#;
        let hash3 = compute_op_hash(DEV_A, 3, None, "edit_block", payload3);
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, NULL, ?, 'edit_block', ?, ?)",
        )
        .bind(DEV_A)
        .bind(3_i64)
        .bind(&hash3)
        .bind(payload3)
        .bind(FIXED_TS)
        .execute(&pool)
        .await
        .unwrap();

        // (B,1) edit_block divergent from (A,1) — normal chain
        let b_payload = r#"{"block_id":"B1","to_text":"v-B","prev_edit":["device-A",1]}"#;
        let b_record = make_remote_record(DEV_B, 1, None, "edit_block", b_payload);
        insert_remote_op(&pool, &b_record).await.unwrap();

        // find_lca between the cyclic chain head (A,3) and the divergent (B,1).
        // Chain A: (A,3)→(A,2)→(A,3) cycle — visited set breaks the loop.
        // Chain B: (B,1)→(A,1) = create_block — terminates normally.
        // The cycle prevents chain A from ever reaching (A,1), so no common
        // ancestor is found. find_lca should return Ok(None), proving the
        // cycle was detected and didn't cause an infinite loop.
        let result = find_lca(&pool, &(DEV_A.into(), 3), &(DEV_B.into(), 1)).await;

        assert!(
            result.is_ok(),
            "find_lca should not hang or error on cycle — it should break via visited set, got: {:?}",
            result
        );
        assert_eq!(
            result.unwrap(),
            None,
            "cyclic chain A never reaches (A,1), so no LCA with chain B"
        );
    }
}
