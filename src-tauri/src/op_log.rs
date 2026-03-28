//! Op log writer — appends local operations to the `op_log` table (ADR-07).
//!
//! Phase 1 implementation: single-device, linear chain. Each new op references
//! the immediately preceding op from the same device as its sole parent.

#![allow(dead_code)]

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::hash::compute_op_hash;
use crate::op::OpPayload;

/// A fully-materialised op log row, returned after a successful append.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpRecord {
    pub device_id: String,
    pub seq: i64,
    pub parent_seqs: Option<String>,
    pub hash: String,
    pub op_type: String,
    pub payload: String,
    pub created_at: String,
}

/// Append a local operation to the op log inside a transaction.
///
/// 1. Determines the next `seq` for this device.
/// 2. Computes `parent_seqs` (Phase 1: single linear chain).
/// 3. Serializes the payload to canonical JSON.
/// 4. Computes the blake3 content hash.
/// 5. Inserts the row and returns the full [`OpRecord`].
pub async fn append_local_op(
    pool: &SqlitePool,
    device_id: &str,
    op_payload: OpPayload,
) -> Result<OpRecord, AppError> {
    let op_type = op_payload.op_type_str().to_owned();

    // Serialize the payload to canonical JSON.
    // We serialize the inner payload struct (without the `op_type` tag) so that
    // the op_log.payload column contains only the operation-specific fields.
    let payload_json = serialize_inner_payload(&op_payload)?;

    let created_at = Utc::now().to_rfc3339();

    let mut tx = pool.begin().await?;

    // Get next sequence number for this device
    let row: (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(seq), 0) + 1 FROM op_log WHERE device_id = ?")
            .bind(device_id)
            .fetch_one(&mut *tx)
            .await?;
    let seq = row.0;

    // Phase 1: linear chain — parent is the previous op from this device,
    // or null for the genesis op.
    let parent_seqs: Option<String> = if seq > 1 {
        let prev_seq = seq - 1;
        Some(serde_json::to_string(&vec![(device_id, prev_seq)])?)
    } else {
        None
    };

    let hash = compute_op_hash(
        device_id,
        seq,
        parent_seqs.as_deref(),
        &op_type,
        &payload_json,
    );

    sqlx::query(
        "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(device_id)
    .bind(seq)
    .bind(&parent_seqs)
    .bind(&hash)
    .bind(&op_type)
    .bind(&payload_json)
    .bind(&created_at)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(OpRecord {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs,
        hash,
        op_type,
        payload: payload_json,
        created_at,
    })
}

/// Serialize only the inner payload fields (without the `op_type` serde tag).
///
/// Since [`OpPayload`] uses `#[serde(tag = "op_type")]`, serializing it directly
/// embeds the tag. We want the `op_log.payload` column to store *only* the
/// operation-specific data — the `op_type` is already in its own column.
fn serialize_inner_payload(op_payload: &OpPayload) -> Result<String, AppError> {
    match op_payload {
        OpPayload::CreateBlock(p) => Ok(serde_json::to_string(p)?),
        OpPayload::EditBlock(p) => Ok(serde_json::to_string(p)?),
        OpPayload::DeleteBlock(p) => Ok(serde_json::to_string(p)?),
        OpPayload::RestoreBlock(p) => Ok(serde_json::to_string(p)?),
        OpPayload::PurgeBlock(p) => Ok(serde_json::to_string(p)?),
        OpPayload::MoveBlock(p) => Ok(serde_json::to_string(p)?),
        OpPayload::AddTag(p) => Ok(serde_json::to_string(p)?),
        OpPayload::RemoveTag(p) => Ok(serde_json::to_string(p)?),
        OpPayload::SetProperty(p) => Ok(serde_json::to_string(p)?),
        OpPayload::DeleteProperty(p) => Ok(serde_json::to_string(p)?),
        OpPayload::AddAttachment(p) => Ok(serde_json::to_string(p)?),
        OpPayload::DeleteAttachment(p) => Ok(serde_json::to_string(p)?),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::{CreateBlockPayload, EditBlockPayload};
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Helper: create an in-memory-like SQLite pool backed by a temp file so
    /// migrations run properly.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    #[tokio::test]
    async fn append_first_op_has_seq_1_and_null_parents() {
        let (pool, _dir) = test_pool().await;

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "hello".into(),
        });

        let record = append_local_op(&pool, "test-device", payload)
            .await
            .unwrap();

        assert_eq!(record.seq, 1);
        assert!(record.parent_seqs.is_none());
        assert_eq!(record.op_type, "create_block");
        assert_eq!(record.device_id, "test-device");
        assert!(!record.hash.is_empty());
        assert_eq!(record.hash.len(), 64);
    }

    #[tokio::test]
    async fn second_op_references_first_as_parent() {
        let (pool, _dir) = test_pool().await;

        let p1 = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "hello".into(),
        });
        let r1 = append_local_op(&pool, "test-device", p1).await.unwrap();
        assert_eq!(r1.seq, 1);

        let p2 = OpPayload::EditBlock(EditBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            to_text: "world".into(),
            prev_edit: None,
        });
        let r2 = append_local_op(&pool, "test-device", p2).await.unwrap();

        assert_eq!(r2.seq, 2);
        let parent_seqs: Vec<(String, i64)> =
            serde_json::from_str(r2.parent_seqs.as_ref().unwrap()).unwrap();
        assert_eq!(parent_seqs.len(), 1);
        assert_eq!(parent_seqs[0].0, "test-device");
        assert_eq!(parent_seqs[0].1, 1);
    }

    #[tokio::test]
    async fn separate_devices_have_independent_seqs() {
        let (pool, _dir) = test_pool().await;

        let p1 = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "a".into(),
        });
        let p2 = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "01HZ00000000000000000000CD".into(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "b".into(),
        });

        let r1 = append_local_op(&pool, "device-A", p1).await.unwrap();
        let r2 = append_local_op(&pool, "device-B", p2).await.unwrap();

        assert_eq!(r1.seq, 1);
        assert_eq!(r2.seq, 1);
    }

    #[tokio::test]
    async fn hash_is_consistent_with_stored_fields() {
        let (pool, _dir) = test_pool().await;

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "01HZ00000000000000000000AB".into(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "test".into(),
        });
        let record = append_local_op(&pool, "dev-1", payload).await.unwrap();

        // Recompute the hash from the stored fields and verify it matches
        let recomputed = crate::hash::compute_op_hash(
            &record.device_id,
            record.seq,
            record.parent_seqs.as_deref(),
            &record.op_type,
            &record.payload,
        );
        assert_eq!(record.hash, recomputed);
    }
}
