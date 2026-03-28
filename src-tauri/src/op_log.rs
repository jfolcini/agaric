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
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct OpRecord {
    pub device_id: String,
    pub seq: i64,
    pub parent_seqs: Option<String>,
    pub hash: String,
    pub op_type: String,
    pub payload: String,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Macro: reduce boilerplate in serialize_inner_payload
// ---------------------------------------------------------------------------

/// Every [`OpPayload`] variant wraps a `Serialize` struct and the match arm is
/// always `Ok(serde_json::to_string(inner)?)`.  This macro generates the full
/// match block so we don't repeat the same line 12 times.
macro_rules! serialize_variant {
    ($op:expr; $($variant:ident),+ $(,)?) => {
        match $op {
            $(OpPayload::$variant(p) => Ok(serde_json::to_string(p)?),)+
        }
    };
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/// Append a local operation to the op log inside a transaction.
///
/// Delegates to [`append_local_op_at`] with the current UTC timestamp.
pub async fn append_local_op(
    pool: &SqlitePool,
    device_id: &str,
    op_payload: OpPayload,
) -> Result<OpRecord, AppError> {
    append_local_op_at(pool, device_id, op_payload, Utc::now().to_rfc3339()).await
}

/// Append a local operation with an explicit `created_at` (RFC 3339).
///
/// Accepting the timestamp as a parameter makes tests fully deterministic —
/// callers can freeze time without mocking.
///
/// 1. Determines the next `seq` for this device.
/// 2. Computes `parent_seqs` (Phase 1: single linear chain).
/// 3. Serializes the payload to canonical JSON.
/// 4. Computes the blake3 content hash.
/// 5. Inserts the row and returns the full [`OpRecord`].
pub async fn append_local_op_at(
    pool: &SqlitePool,
    device_id: &str,
    op_payload: OpPayload,
    created_at: String,
) -> Result<OpRecord, AppError> {
    let op_type = op_payload.op_type_str().to_owned();

    // Serialize the payload to canonical JSON.
    // We serialize the inner payload struct (without the `op_type` tag) so that
    // the op_log.payload column contains only the operation-specific fields.
    let payload_json = serialize_inner_payload(&op_payload)?;

    let mut tx = pool.begin().await?;

    // NOTE: `COALESCE(MAX(seq), 0) + 1` is efficient here because the
    // PRIMARY KEY (device_id, seq) gives SQLite a B-tree index that makes
    // `MAX(seq) WHERE device_id = ?` an O(log n) seek, not a table scan.
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
    serialize_variant!(op_payload;
        CreateBlock, EditBlock, DeleteBlock, RestoreBlock,
        PurgeBlock, MoveBlock, AddTag, RemoveTag,
        SetProperty, DeleteProperty, AddAttachment, DeleteAttachment,
    )
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/// Fetch a single op log record by `(device_id, seq)`.
///
/// Returns [`AppError::NotFound`] if no such row exists.
pub async fn get_op_by_seq(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
) -> Result<OpRecord, AppError> {
    sqlx::query_as::<_, OpRecord>(
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
         FROM op_log WHERE device_id = ? AND seq = ?",
    )
    .bind(device_id)
    .bind(seq)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("op_log ({device_id}, {seq})")))
}

/// Return the latest sequence number for a device, or 0 if none exist.
pub async fn get_latest_seq(pool: &SqlitePool, device_id: &str) -> Result<i64, AppError> {
    let row: (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?")
            .bind(device_id)
            .fetch_one(pool)
            .await?;
    Ok(row.0)
}

/// Return all ops for a device with `seq > after_seq`, ordered ascending.
///
/// Useful for pagination and sync — a consumer can persist the last-seen seq
/// and call this to fetch only newer entries.
pub async fn get_ops_since(
    pool: &SqlitePool,
    device_id: &str,
    after_seq: i64,
) -> Result<Vec<OpRecord>, AppError> {
    let rows = sqlx::query_as::<_, OpRecord>(
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
         FROM op_log WHERE device_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .bind(device_id)
    .bind(after_seq)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Helper: create a temp-file-backed SQLite pool with migrations.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Helper: build a minimal [`OpPayload`] for each of the 12 variants.
    fn all_op_payloads() -> Vec<(&'static str, OpPayload)> {
        vec![
            (
                "create_block",
                OpPayload::CreateBlock(CreateBlockPayload {
                    block_id: "BLK001".into(),
                    block_type: "content".into(),
                    parent_id: None,
                    position: Some(0),
                    content: "hello".into(),
                }),
            ),
            (
                "edit_block",
                OpPayload::EditBlock(EditBlockPayload {
                    block_id: "BLK001".into(),
                    to_text: "updated".into(),
                    prev_edit: None,
                }),
            ),
            (
                "delete_block",
                OpPayload::DeleteBlock(DeleteBlockPayload {
                    block_id: "BLK001".into(),
                    cascade: false,
                }),
            ),
            (
                "restore_block",
                OpPayload::RestoreBlock(RestoreBlockPayload {
                    block_id: "BLK001".into(),
                    deleted_at_ref: "2025-01-01T00:00:00Z".into(),
                }),
            ),
            (
                "purge_block",
                OpPayload::PurgeBlock(PurgeBlockPayload {
                    block_id: "BLK001".into(),
                }),
            ),
            (
                "move_block",
                OpPayload::MoveBlock(MoveBlockPayload {
                    block_id: "BLK001".into(),
                    new_parent_id: Some("BLK000".into()),
                    new_position: 3,
                }),
            ),
            (
                "add_tag",
                OpPayload::AddTag(AddTagPayload {
                    block_id: "BLK001".into(),
                    tag_id: "TAG01".into(),
                }),
            ),
            (
                "remove_tag",
                OpPayload::RemoveTag(RemoveTagPayload {
                    block_id: "BLK001".into(),
                    tag_id: "TAG01".into(),
                }),
            ),
            (
                "set_property",
                OpPayload::SetProperty(SetPropertyPayload {
                    block_id: "BLK001".into(),
                    key: "priority".into(),
                    value_text: Some("high".into()),
                    value_num: None,
                    value_date: None,
                    value_ref: None,
                }),
            ),
            (
                "delete_property",
                OpPayload::DeleteProperty(DeletePropertyPayload {
                    block_id: "BLK001".into(),
                    key: "priority".into(),
                }),
            ),
            (
                "add_attachment",
                OpPayload::AddAttachment(AddAttachmentPayload {
                    attachment_id: "ATT01".into(),
                    block_id: "BLK001".into(),
                    mime_type: "text/plain".into(),
                    filename: "readme.txt".into(),
                    size_bytes: 256,
                    fs_path: "/tmp/readme.txt".into(),
                }),
            ),
            (
                "delete_attachment",
                OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                    attachment_id: "ATT01".into(),
                }),
            ),
        ]
    }

    // --- Original 4 tests (preserved) -----------------------------------

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

    // --- New tests -------------------------------------------------------

    /// All 12 op types should append successfully and produce the correct
    /// `op_type` string in the stored record.
    #[tokio::test]
    async fn all_12_op_types_append_successfully() {
        let (pool, _dir) = test_pool().await;

        for (expected_type, payload) in all_op_payloads() {
            let record = append_local_op(&pool, "dev-all", payload).await.unwrap();
            assert_eq!(
                record.op_type, expected_type,
                "op_type mismatch for variant {expected_type}"
            );
            assert_eq!(record.hash.len(), 64, "hash should be 64 hex chars");
        }
    }

    /// Appending 100 ops sequentially must yield seq numbers 1..=100 with no
    /// gaps and each `parent_seqs` referencing the previous.
    #[tokio::test]
    async fn sequential_100_ops_produce_consecutive_seqs() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=100_i64 {
            let payload = OpPayload::CreateBlock(CreateBlockPayload {
                block_id: format!("BLK{i:04}"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(i),
                content: format!("content #{i}"),
            });
            let rec = append_local_op(&pool, "stress-dev", payload).await.unwrap();
            assert_eq!(rec.seq, i, "expected seq {i}");

            if i == 1 {
                assert!(rec.parent_seqs.is_none());
            } else {
                let parents: Vec<(String, i64)> =
                    serde_json::from_str(rec.parent_seqs.as_ref().unwrap()).unwrap();
                assert_eq!(parents, vec![("stress-dev".to_string(), i - 1)]);
            }
        }
    }

    /// Append an op, read it back via `get_op_by_seq`, and verify the payload
    /// JSON deserializes to the same inner struct.
    #[tokio::test]
    async fn payload_json_roundtrips_via_db() {
        let (pool, _dir) = test_pool().await;

        let original = CreateBlockPayload {
            block_id: "BLK-RT".into(),
            block_type: "heading".into(),
            parent_id: Some("ROOT".into()),
            position: Some(42),
            content: "round-trip test".into(),
        };
        let record = append_local_op(&pool, "dev-rt", OpPayload::CreateBlock(original.clone()))
            .await
            .unwrap();

        // Read back from DB
        let fetched = get_op_by_seq(&pool, "dev-rt", 1).await.unwrap();
        assert_eq!(fetched.payload, record.payload);

        // Deserialize the stored JSON back to the payload struct
        let deserialized: CreateBlockPayload = serde_json::from_str(&fetched.payload).unwrap();
        assert_eq!(deserialized.block_id, "BLK-RT");
        assert_eq!(deserialized.block_type, "heading");
        assert_eq!(deserialized.parent_id, Some("ROOT".into()));
        assert_eq!(deserialized.position, Some(42));
        assert_eq!(deserialized.content, "round-trip test");
    }

    /// Fire 20 concurrent appends from the same device; all should succeed and
    /// produce a contiguous, duplicate-free seq range 1..=20.
    ///
    /// SQLite serialises writers, so concurrent tasks will contend for the
    /// write lock.  We retry on `database is locked` to prove the transaction
    /// logic is safe under contention — no sequence gaps or duplicates.
    #[tokio::test]
    async fn concurrent_appends_same_device_serialize_correctly() {
        let (pool, _dir) = test_pool().await;

        let mut handles = Vec::new();
        for i in 0..20 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                loop {
                    let payload = OpPayload::CreateBlock(CreateBlockPayload {
                        block_id: format!("BLK-C{i:03}"),
                        block_type: "content".into(),
                        parent_id: None,
                        position: Some(i),
                        content: format!("concurrent #{i}"),
                    });
                    match append_local_op(&pool, "dev-conc", payload).await {
                        Ok(rec) => return rec,
                        Err(AppError::Database(_)) => {
                            // Retry after a short back-off — SQLite busy.
                            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                        }
                        Err(e) => panic!("unexpected error: {e}"),
                    }
                }
            }));
        }

        let mut seqs: Vec<i64> = Vec::new();
        for h in handles {
            seqs.push(h.await.unwrap().seq);
        }
        seqs.sort();
        assert_eq!(seqs, (1..=20).collect::<Vec<i64>>());
    }

    /// Read a record from the DB with `get_op_by_seq` and recompute the blake3
    /// hash from the stored columns — it must match the stored hash.
    #[tokio::test]
    async fn hash_verification_from_db_read() {
        let (pool, _dir) = test_pool().await;

        // Insert two ops to exercise both null and non-null parent_seqs
        for payload in [
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: "BLK-H1".into(),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "first".into(),
            }),
            OpPayload::EditBlock(EditBlockPayload {
                block_id: "BLK-H1".into(),
                to_text: "second".into(),
                prev_edit: None,
            }),
        ] {
            append_local_op(&pool, "dev-hash", payload).await.unwrap();
        }

        for seq in 1..=2 {
            let rec = get_op_by_seq(&pool, "dev-hash", seq).await.unwrap();
            let recomputed = crate::hash::compute_op_hash(
                &rec.device_id,
                rec.seq,
                rec.parent_seqs.as_deref(),
                &rec.op_type,
                &rec.payload,
            );
            assert_eq!(rec.hash, recomputed, "hash mismatch for seq {seq}");
        }
    }

    #[tokio::test]
    async fn get_op_by_seq_returns_correct_record() {
        let (pool, _dir) = test_pool().await;

        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "BLK-G".into(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "get test".into(),
        });
        let appended = append_local_op(&pool, "dev-get", payload).await.unwrap();

        let fetched = get_op_by_seq(&pool, "dev-get", 1).await.unwrap();
        assert_eq!(fetched.device_id, appended.device_id);
        assert_eq!(fetched.seq, appended.seq);
        assert_eq!(fetched.hash, appended.hash);
        assert_eq!(fetched.op_type, appended.op_type);
        assert_eq!(fetched.payload, appended.payload);
        assert_eq!(fetched.created_at, appended.created_at);
    }

    #[tokio::test]
    async fn get_op_by_seq_not_found() {
        let (pool, _dir) = test_pool().await;

        let err = get_op_by_seq(&pool, "ghost-device", 999).await;
        assert!(err.is_err());
        let msg = err.unwrap_err().to_string();
        assert!(
            msg.contains("Not found"),
            "expected NotFound error, got: {msg}"
        );
    }

    #[tokio::test]
    async fn get_latest_seq_empty_returns_zero() {
        let (pool, _dir) = test_pool().await;

        let seq = get_latest_seq(&pool, "empty-device").await.unwrap();
        assert_eq!(seq, 0);
    }

    #[tokio::test]
    async fn get_latest_seq_after_appends() {
        let (pool, _dir) = test_pool().await;

        for i in 0..5 {
            let payload = OpPayload::CreateBlock(CreateBlockPayload {
                block_id: format!("BLK-LS{i}"),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "x".into(),
            });
            append_local_op(&pool, "dev-ls", payload).await.unwrap();
        }
        let seq = get_latest_seq(&pool, "dev-ls").await.unwrap();
        assert_eq!(seq, 5);
    }

    #[tokio::test]
    async fn get_ops_since_returns_correct_subset() {
        let (pool, _dir) = test_pool().await;

        // Insert 10 ops
        for i in 0..10 {
            let payload = OpPayload::CreateBlock(CreateBlockPayload {
                block_id: format!("BLK-S{i:02}"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(i),
                content: format!("op #{i}"),
            });
            append_local_op(&pool, "dev-since", payload).await.unwrap();
        }

        // Get ops after seq 7 → should be seqs 8, 9, 10
        let ops = get_ops_since(&pool, "dev-since", 7).await.unwrap();
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0].seq, 8);
        assert_eq!(ops[1].seq, 9);
        assert_eq!(ops[2].seq, 10);

        // Get ops after seq 0 → all 10
        let all = get_ops_since(&pool, "dev-since", 0).await.unwrap();
        assert_eq!(all.len(), 10);

        // Get ops after seq 10 → empty
        let none = get_ops_since(&pool, "dev-since", 10).await.unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn get_ops_since_different_device_is_isolated() {
        let (pool, _dir) = test_pool().await;

        // Insert on device A
        for i in 0..3 {
            let payload = OpPayload::CreateBlock(CreateBlockPayload {
                block_id: format!("BLK-A{i}"),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "a".into(),
            });
            append_local_op(&pool, "dev-A", payload).await.unwrap();
        }

        // device B should have nothing
        let ops = get_ops_since(&pool, "dev-B", 0).await.unwrap();
        assert!(ops.is_empty());
    }

    /// `append_local_op_at` should store the exact caller-provided timestamp
    /// rather than the current wall-clock time.
    #[tokio::test]
    async fn custom_timestamp_is_stored() {
        let (pool, _dir) = test_pool().await;

        let fixed_ts = "2025-06-01T12:00:00+00:00".to_string();
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: "BLK-TS".into(),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "ts test".into(),
        });
        let record = append_local_op_at(&pool, "dev-ts", payload, fixed_ts.clone())
            .await
            .unwrap();

        assert_eq!(record.created_at, fixed_ts);

        // Also verify via DB read
        let fetched = get_op_by_seq(&pool, "dev-ts", 1).await.unwrap();
        assert_eq!(fetched.created_at, fixed_ts);
    }
}
