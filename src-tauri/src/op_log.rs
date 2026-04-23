//! Op log writer — appends local operations to the `op_log` table.
//!
//! Phase 1 implementation: single-device, linear chain. Each new op references
//! the immediately preceding op from the same device as its sole parent.
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

impl OpRecord {
    /// Parse `parent_seqs` JSON into typed tuples.
    ///
    /// Returns `None` for genesis ops (where `parent_seqs` is NULL).
    ///
    /// # Errors
    /// Returns `serde_json::Error` if the JSON is malformed.
    pub fn parsed_parent_seqs(&self) -> Result<Option<Vec<(String, i64)>>, serde_json::Error> {
        match &self.parent_seqs {
            None => Ok(None),
            Some(json) => serde_json::from_str(json).map(Some),
        }
    }
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
            $(OpPayload::$variant(p) => {
                // Serialize to Value first for canonical key ordering (BTreeMap).
                // serde_json::to_string on derive(Serialize) uses declaration
                // order — deterministic within a serde version but not across
                // versions.  Going through Value ensures alphabetical key order.
                let value = serde_json::to_value(p)?;
                Ok(serde_json::to_string(&value)?)
            },)+
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
    append_local_op_at(pool, device_id, op_payload, crate::now_rfc3339()).await
}

/// Append a local operation within an existing transaction.
///
/// The caller is responsible for committing the transaction.
/// This is used by command handlers to wrap both the op_log append
/// and the blocks-table write in a single atomic transaction.
pub async fn append_local_op_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    mut op_payload: OpPayload,
    created_at: String,
) -> Result<OpRecord, AppError> {
    // Validate SetProperty invariant: exactly one value field must be set.
    if let OpPayload::SetProperty(ref p) = op_payload {
        crate::op::validate_set_property(p)?;
    }

    // Normalize all ULID fields to uppercase Crockford base32 before
    // serialization.  This ensures deterministic blake3 hashes regardless of
    // the casing supplied by the caller (critical for Phase 4 cross-device
    // sync — see ULID case normalization rule).
    op_payload.normalize_block_ids();

    let op_type = op_payload.op_type_str().to_owned();

    // Serialize the payload to canonical JSON.
    // We serialize the inner payload struct (without the `op_type` tag) so that
    // the op_log.payload column contains only the operation-specific fields.
    let payload_json = serialize_inner_payload(&op_payload)?;

    // PERF-26: extract block_id for the indexed column (added in migration
    // 0030). Reads from the typed enum — O(1), no JSON re-parse. Returns
    // None for `delete_attachment` which targets an attachment_id only.
    let block_id: Option<&str> = op_payload.block_id();

    // NOTE: `COALESCE(MAX(seq), 0) + 1` is efficient here because the
    // PRIMARY KEY (device_id, seq) gives SQLite a B-tree index that makes
    // `MAX(seq) WHERE device_id = ?` an O(log n) seek, not a table scan.
    let row = sqlx::query!(
        r#"SELECT COALESCE(MAX(seq), 0) + 1 as "next_seq!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(&mut **tx)
    .await?;
    let seq = row.next_seq;

    // Phase 1: linear chain — parent is the previous op from this device,
    // or null for the genesis op.
    let parent_seqs: Option<String> = if seq > 1 {
        let prev_seq = seq - 1;
        // Phase 1 has exactly one parent; Phase 4 multi-parent DAG will
        // extend this to multiple entries with proper sorting.
        // Construct JSON directly to avoid Vec allocation + sort overhead.
        Some(format!(r#"[["{}",{}]]"#, device_id, prev_seq))
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

    // FEAT-4h slice 1: stamp the op with the initiating actor's origin tag
    // (migration 0033). Outside an MCP `ACTOR.scope(...)` — i.e. every
    // frontend-invoked command — `current_actor()` returns `Actor::User`,
    // which yields `"user"` and matches the column default. Inside an MCP
    // tool dispatch the dispatcher in `mcp::server` wraps the call in
    // `ACTOR.scope(...)` with `Actor::Agent { name }` from the handshake;
    // that yields `"agent:<name>"`, attributing the row in `op_log` and
    // unblocking the activity-feed Undo + bulk-revert UX in slice 2/3.
    //
    // `origin` is intentionally NOT part of `compute_op_hash`'s preimage —
    // it is local-attribution metadata, not part of the cross-device
    // identity of the op. Two devices receiving the same logical op but
    // tagged with different origins must still hash-match for sync.
    let origin = crate::mcp::actor::current_actor().origin_tag();

    sqlx::query!(
        "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id, origin) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        device_id,
        seq,
        parent_seqs,
        hash,
        op_type,
        payload_json,
        created_at,
        block_id,
        origin,
    )
    .execute(&mut **tx)
    .await?;

    // FEAT-4h slice 3: populate the task-local `LAST_APPEND` cell so the
    // MCP dispatch layer can attach an `OpRef` to the emitted
    // `mcp:activity` entry for per-entry Undo. Silent no-op outside an
    // `mcp::last_append::LAST_APPEND` scope — i.e. every frontend-invoked
    // command.
    crate::mcp::last_append::record_append(crate::op::OpRef {
        device_id: device_id.to_string(),
        seq,
    });

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
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT when a concurrent background cache rebuild
    // commits between our first read and first write inside the tx.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let record = append_local_op_in_tx(&mut tx, device_id, op_payload, created_at).await?;
    tx.commit().await?;
    Ok(record)
}

/// Serialize only the inner payload fields (without the `op_type` serde tag).
///
/// Since [`OpPayload`] uses `#[serde(tag = "op_type")]`, serializing it directly
/// embeds the tag. We want the `op_log.payload` column to store *only* the
/// operation-specific data — the `op_type` is already in its own column.
pub(crate) fn serialize_inner_payload(op_payload: &OpPayload) -> Result<String, AppError> {
    serialize_variant!(op_payload;
        CreateBlock, EditBlock, DeleteBlock, RestoreBlock,
        PurgeBlock, MoveBlock, AddTag, RemoveTag,
        SetProperty, DeleteProperty, AddAttachment, DeleteAttachment,
    )
}

/// Extract the `block_id` from a serialized payload JSON string.
///
/// Used by [`crate::dag::insert_remote_op`] to populate the indexed
/// `op_log.block_id` column (added in migration 0030) when the caller
/// only has the payload as a JSON string rather than a typed [`OpPayload`].
///
/// Returns `None` if the payload has no `block_id` field (the
/// `delete_attachment` op targets an attachment_id only) or if the JSON
/// cannot be parsed.
pub(crate) fn extract_block_id_from_payload(payload_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(payload_json).ok()?;
    value.get("block_id")?.as_str().map(str::to_owned)
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
    sqlx::query_as!(
        OpRecord,
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
         FROM op_log WHERE device_id = ? AND seq = ?",
        device_id,
        seq,
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("op_log ({device_id}, {seq})")))
}

/// Return the latest sequence number for a device, or 0 if none exist.
pub async fn get_latest_seq(pool: &SqlitePool, device_id: &str) -> Result<i64, AppError> {
    let row = sqlx::query!(
        r#"SELECT COALESCE(MAX(seq), 0) as "latest_seq!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(pool)
    .await?;
    Ok(row.latest_seq)
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
    let rows = sqlx::query_as!(
        OpRecord,
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
         FROM op_log WHERE device_id = ? AND seq > ? ORDER BY seq ASC",
        device_id,
        after_seq,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// =========================================================================
// Tests
// =========================================================================

/// Tests for `append_local_op`, `append_local_op_at`, `get_op_by_seq`,
/// `get_latest_seq`, `get_ops_since`, and `serialize_inner_payload`.
///
/// Covers sequential appending, parent-chain linking, per-device isolation,
/// hash integrity, all 12 op types, concurrent writes, DB round-trips,
/// read helpers, and timestamp determinism.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::*;
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ── Test fixture constants ──────────────────────────────────────────

    const FIXED_TS: &str = "2025-01-15T12:00:00+00:00";
    const TEST_DEVICE: &str = "test-device";

    // ── Helpers ─────────────────────────────────────────────────────────

    /// Create a temp-file-backed SQLite pool with migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Build a minimal `CreateBlock` payload with the given block ID.
    fn make_create_payload(block_id: &str) -> OpPayload {
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "test".into(),
        })
    }

    /// Build a minimal [`OpPayload`] for each of the 12 variants.
    fn all_op_payloads() -> Vec<(&'static str, OpPayload)> {
        vec![
            (
                "create_block",
                OpPayload::CreateBlock(CreateBlockPayload {
                    block_id: BlockId::test_id("BLK001"),
                    block_type: "content".into(),
                    parent_id: None,
                    position: Some(1),
                    content: "hello".into(),
                }),
            ),
            (
                "edit_block",
                OpPayload::EditBlock(EditBlockPayload {
                    block_id: BlockId::test_id("BLK001"),
                    to_text: "updated".into(),
                    prev_edit: None,
                }),
            ),
            (
                "delete_block",
                OpPayload::DeleteBlock(DeleteBlockPayload {
                    block_id: BlockId::test_id("BLK001"),
                }),
            ),
            (
                "restore_block",
                OpPayload::RestoreBlock(RestoreBlockPayload {
                    block_id: BlockId::test_id("BLK001"),
                    deleted_at_ref: "2025-01-01T00:00:00Z".into(),
                }),
            ),
            (
                "purge_block",
                OpPayload::PurgeBlock(PurgeBlockPayload {
                    block_id: BlockId::test_id("BLK001"),
                }),
            ),
            (
                "move_block",
                OpPayload::MoveBlock(MoveBlockPayload {
                    block_id: BlockId::test_id("BLK001"),
                    new_parent_id: Some(BlockId::test_id("BLK000")),
                    new_position: 3,
                }),
            ),
            (
                "add_tag",
                OpPayload::AddTag(AddTagPayload {
                    block_id: BlockId::test_id("BLK001"),
                    tag_id: BlockId::test_id("TAG01"),
                }),
            ),
            (
                "remove_tag",
                OpPayload::RemoveTag(RemoveTagPayload {
                    block_id: BlockId::test_id("BLK001"),
                    tag_id: BlockId::test_id("TAG01"),
                }),
            ),
            (
                "set_property",
                OpPayload::SetProperty(SetPropertyPayload {
                    block_id: BlockId::test_id("BLK001"),
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
                    block_id: BlockId::test_id("BLK001"),
                    key: "priority".into(),
                }),
            ),
            (
                "add_attachment",
                OpPayload::AddAttachment(AddAttachmentPayload {
                    attachment_id: "ATT01".into(),
                    block_id: BlockId::test_id("BLK001"),
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

    // ── Append basics ────────────────────────────────────────────────────

    #[tokio::test]
    async fn append_first_op_has_seq_1_and_null_parents() {
        let (pool, _dir) = test_pool().await;

        let record = append_local_op_at(
            &pool,
            TEST_DEVICE,
            make_create_payload("BLK-FIRST"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        assert_eq!(record.seq, 1, "first op must have seq 1");
        assert!(
            record.parent_seqs.is_none(),
            "genesis op must have null parent_seqs"
        );
        assert_eq!(
            record.op_type, "create_block",
            "op_type should be create_block"
        );
        assert_eq!(
            record.device_id, TEST_DEVICE,
            "device_id should match test device"
        );
        assert_eq!(record.hash.len(), 64, "hash must be 64 hex chars");
    }

    #[tokio::test]
    async fn second_op_references_first_as_parent() {
        let (pool, _dir) = test_pool().await;

        let r1 = append_local_op_at(
            &pool,
            TEST_DEVICE,
            make_create_payload("BLK-PARENT"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        assert_eq!(r1.seq, 1, "first op should have seq 1");

        let p2 = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK-PARENT"),
            to_text: "world".into(),
            prev_edit: None,
        });
        let r2 = append_local_op_at(&pool, TEST_DEVICE, p2, FIXED_TS.into())
            .await
            .unwrap();

        assert_eq!(r2.seq, 2, "second op must have seq 2");
        let parent_seqs = r2.parsed_parent_seqs().unwrap().unwrap();
        assert_eq!(parent_seqs.len(), 1, "should reference exactly one parent");
        assert_eq!(parent_seqs[0].0, TEST_DEVICE, "parent device must match");
        assert_eq!(parent_seqs[0].1, 1, "parent seq must be 1");
    }

    #[tokio::test]
    async fn separate_devices_have_independent_seqs() {
        let (pool, _dir) = test_pool().await;

        let r1 = append_local_op_at(
            &pool,
            "device-A",
            make_create_payload("BLK-A"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();
        let r2 = append_local_op_at(
            &pool,
            "device-B",
            make_create_payload("BLK-B"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        assert_eq!(r1.seq, 1, "device-A first op must be seq 1");
        assert_eq!(r2.seq, 1, "device-B first op must also be seq 1");
    }

    // ── All op types ──────────────────────────────────────────────────────

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

    /// Appending 10 ops sequentially must yield seq numbers 1..=10 with no
    /// gaps and each `parent_seqs` referencing the previous.
    #[tokio::test]
    async fn sequential_ops_produce_consecutive_seqs() {
        let (pool, _dir) = test_pool().await;

        for i in 1..=10_i64 {
            let payload = make_create_payload(&format!("BLK{i:04}"));
            let rec = append_local_op_at(&pool, "seq-dev", payload, FIXED_TS.into())
                .await
                .unwrap();
            assert_eq!(rec.seq, i, "expected seq {i}");

            if i == 1 {
                assert!(
                    rec.parent_seqs.is_none(),
                    "genesis op must have null parents"
                );
            } else {
                let parents = rec.parsed_parent_seqs().unwrap().unwrap();
                assert_eq!(
                    parents,
                    vec![("seq-dev".to_string(), i - 1)],
                    "parent_seqs mismatch at seq {i}"
                );
            }
        }
    }

    /// Append an op, read it back via `get_op_by_seq`, and verify the payload
    /// JSON deserializes to the same inner struct.
    #[tokio::test]
    async fn payload_json_roundtrips_via_db() {
        let (pool, _dir) = test_pool().await;

        let original = CreateBlockPayload {
            block_id: BlockId::test_id("BLK-RT"),
            block_type: "heading".into(),
            parent_id: Some(BlockId::test_id("ROOT")),
            position: Some(42),
            content: "round-trip test".into(),
        };
        let record = append_local_op(&pool, "dev-rt", OpPayload::CreateBlock(original.clone()))
            .await
            .unwrap();

        // Read back from DB
        let fetched = get_op_by_seq(&pool, "dev-rt", 1).await.unwrap();
        assert_eq!(
            fetched.payload, record.payload,
            "DB payload should match appended payload"
        );

        // Deserialize the stored JSON back to the payload struct
        let deserialized: CreateBlockPayload = serde_json::from_str(&fetched.payload).unwrap();
        assert_eq!(
            deserialized.block_id, "BLK-RT",
            "block_id should round-trip"
        );
        assert_eq!(
            deserialized.block_type, "heading",
            "block_type should round-trip"
        );
        assert_eq!(
            deserialized.parent_id,
            Some(BlockId::test_id("ROOT")),
            "parent_id should round-trip"
        );
        assert_eq!(
            deserialized.position,
            Some(42),
            "position should round-trip"
        );
        assert_eq!(
            deserialized.content, "round-trip test",
            "content should round-trip"
        );
    }

    /// Fire 10 concurrent appends from the same device; all should succeed and
    /// produce a contiguous, duplicate-free seq range 1..=10.
    ///
    /// SQLite serialises writers, so concurrent tasks contend for the write
    /// lock. The retry loop with back-off proves the transaction logic is safe
    /// under contention — no sequence gaps or duplicates.
    #[tokio::test]
    async fn concurrent_appends_same_device_serialize_correctly() {
        let (pool, _dir) = test_pool().await;

        let mut handles = Vec::new();
        for i in 0..10 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                loop {
                    let payload = make_create_payload(&format!("BLK-C{i:03}"));
                    match append_local_op_at(&pool, "dev-conc", payload, FIXED_TS.into()).await {
                        Ok(rec) => return rec,
                        Err(AppError::Database(_)) => {
                            // Back-off and retry — SQLite busy under contention.
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
        assert_eq!(
            seqs,
            (1..=10).collect::<Vec<i64>>(),
            "concurrent appends must produce contiguous seq range"
        );
    }

    // ── Hash integrity ────────────────────────────────────────────────────

    /// Read a record from the DB with `get_op_by_seq` and recompute the blake3
    /// hash from the stored columns — it must match the stored hash.
    #[tokio::test]
    async fn hash_verification_from_db_read() {
        let (pool, _dir) = test_pool().await;

        // Insert two ops to exercise both null and non-null parent_seqs
        for payload in [
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK-H1"),
                block_type: "content".into(),
                parent_id: None,
                position: None,
                content: "first".into(),
            }),
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK-H1"),
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

    // ── Read helpers ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn get_op_by_seq_returns_correct_record() {
        let (pool, _dir) = test_pool().await;

        let appended = append_local_op_at(
            &pool,
            "dev-get",
            make_create_payload("BLK-G"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let fetched = get_op_by_seq(&pool, "dev-get", 1).await.unwrap();
        assert_eq!(fetched.device_id, appended.device_id, "device_id mismatch");
        assert_eq!(fetched.seq, appended.seq, "seq mismatch");
        assert_eq!(fetched.hash, appended.hash, "hash mismatch");
        assert_eq!(fetched.op_type, appended.op_type, "op_type mismatch");
        assert_eq!(fetched.payload, appended.payload, "payload mismatch");
        assert_eq!(
            fetched.created_at, appended.created_at,
            "created_at mismatch"
        );
    }

    #[tokio::test]
    async fn get_op_by_seq_returns_not_found_for_missing_record() {
        let (pool, _dir) = test_pool().await;

        let err = get_op_by_seq(&pool, "ghost-device", 999).await;
        assert!(err.is_err(), "missing record should return an error");
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
        assert_eq!(seq, 0, "empty device must have latest seq 0");
    }

    #[tokio::test]
    async fn get_latest_seq_after_appends() {
        let (pool, _dir) = test_pool().await;

        for i in 0..5 {
            let payload = make_create_payload(&format!("BLK-LS{i}"));
            append_local_op_at(&pool, "dev-ls", payload, FIXED_TS.into())
                .await
                .unwrap();
        }
        let seq = get_latest_seq(&pool, "dev-ls").await.unwrap();
        assert_eq!(seq, 5, "latest seq after 5 appends must be 5");
    }

    #[tokio::test]
    async fn get_ops_since_returns_correct_subset() {
        let (pool, _dir) = test_pool().await;

        for i in 0..10 {
            let payload = make_create_payload(&format!("BLK-S{i:02}"));
            append_local_op_at(&pool, "dev-since", payload, FIXED_TS.into())
                .await
                .unwrap();
        }

        // Get ops after seq 7 → should be seqs 8, 9, 10 in ascending order
        let ops = get_ops_since(&pool, "dev-since", 7).await.unwrap();
        assert_eq!(ops.len(), 3, "expected 3 ops after seq 7");
        assert_eq!(ops[0].seq, 8, "first returned op should be seq 8");
        assert_eq!(ops[1].seq, 9, "second returned op should be seq 9");
        assert_eq!(ops[2].seq, 10, "third returned op should be seq 10");

        // Get ops after seq 0 → all 10
        let all = get_ops_since(&pool, "dev-since", 0).await.unwrap();
        assert_eq!(all.len(), 10, "after_seq=0 should return all ops");

        // Get ops after seq 10 → empty
        let none = get_ops_since(&pool, "dev-since", 10).await.unwrap();
        assert!(none.is_empty(), "after_seq=max should return no ops");
    }

    #[tokio::test]
    async fn get_ops_since_different_device_is_isolated() {
        let (pool, _dir) = test_pool().await;

        for i in 0..3 {
            let payload = make_create_payload(&format!("BLK-A{i}"));
            append_local_op_at(&pool, "dev-A", payload, FIXED_TS.into())
                .await
                .unwrap();
        }

        let ops = get_ops_since(&pool, "dev-B", 0).await.unwrap();
        assert!(ops.is_empty(), "device-B should see no ops from device-A");
    }

    // ── Timestamp determinism ─────────────────────────────────────────────

    /// `append_local_op_at` should store the exact caller-provided timestamp
    /// rather than the current wall-clock time.
    #[tokio::test]
    async fn append_local_op_at_stores_exact_timestamp() {
        let (pool, _dir) = test_pool().await;

        let fixed_ts = "2025-06-01T12:00:00+00:00".to_string();
        let record = append_local_op_at(
            &pool,
            "dev-ts",
            make_create_payload("BLK-TS"),
            fixed_ts.clone(),
        )
        .await
        .unwrap();

        assert_eq!(
            record.created_at, fixed_ts,
            "returned record must have the exact provided timestamp"
        );

        let fetched = get_op_by_seq(&pool, "dev-ts", 1).await.unwrap();
        assert_eq!(
            fetched.created_at, fixed_ts,
            "DB-stored timestamp must match the provided value"
        );
    }

    // ── Payload serialization ───────────────────────────────────────────

    /// The `payload` column must contain only the inner payload fields,
    /// NOT the `op_type` serde tag that [`OpPayload`]'s tagged enum would add.
    #[tokio::test]
    async fn payload_column_excludes_op_type_tag() {
        let (pool, _dir) = test_pool().await;

        let record = append_local_op_at(
            &pool,
            "dev-tag",
            make_create_payload("BLK-TAG"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&record.payload).unwrap();
        assert!(
            parsed.get("op_type").is_none(),
            "payload column must not contain op_type tag, got: {}",
            record.payload
        );
        assert!(
            parsed.get("block_id").is_some(),
            "payload column must contain block_id field"
        );
    }

    // ── F-01: ULID normalization before serialization ────────────────

    /// Verify that `append_local_op_in_tx` normalizes lowercase ULIDs in
    /// payloads to uppercase before serialization and hashing.
    #[tokio::test]
    async fn append_normalizes_ulid_case_in_payload() {
        let (pool, _dir) = test_pool().await;

        // Lowercase ULID — should be uppercased before storage.
        let lower_id = "01arz3ndektsv4rrffq69g5fav";
        let upper_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

        let record = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_string(lower_id).unwrap(),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "test".into(),
            }),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // The stored payload must contain the uppercase form.
        let parsed: serde_json::Value = serde_json::from_str(&record.payload).unwrap();
        assert_eq!(
            parsed["block_id"].as_str().unwrap(),
            upper_id,
            "stored block_id should be uppercase"
        );
    }

    /// Two ops with the same logical ULID (different case) must produce
    /// identical hashes — ensuring cross-device determinism.
    #[tokio::test]
    async fn normalized_and_unnormalized_ulid_produce_same_hash() {
        let (pool, _dir) = test_pool().await;

        let lower_id = "01arz3ndektsv4rrffq69g5fav";
        let upper_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

        let rec_lower = append_local_op_at(
            &pool,
            "dev-a",
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_string(lower_id).unwrap(),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "test".into(),
            }),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        let rec_upper = append_local_op_at(
            &pool,
            "dev-a",
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_string(upper_id).unwrap(),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "test".into(),
            }),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // The payloads should be identical (both uppercased).
        assert_eq!(
            rec_lower.payload, rec_upper.payload,
            "payloads should be identical after normalization"
        );

        // Hashes differ only because seq differs (1 vs 2), but the payload
        // portion of the hash input is identical.
        let hash_lower = compute_op_hash("dev-a", 1, None, "create_block", &rec_lower.payload);
        let hash_upper = compute_op_hash("dev-a", 1, None, "create_block", &rec_upper.payload);
        assert_eq!(
            hash_lower, hash_upper,
            "same payload JSON should produce the same hash"
        );
    }

    // ── F-02: validate_set_property enforcement ────────────────────────

    /// Verify that appending a SetProperty op with zero value fields is
    /// rejected at the op_log layer.
    #[tokio::test]
    async fn append_rejects_set_property_with_zero_values() {
        let (pool, _dir) = test_pool().await;

        let result = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK001"),
                key: "status".into(),
                value_text: None,
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            FIXED_TS.into(),
        )
        .await;

        assert!(result.is_err(), "zero value fields should be rejected");
        let err = result.unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "expected Validation error, got: {err:?}"
        );
    }

    /// Verify that appending a SetProperty op with multiple value fields is
    /// rejected at the op_log layer.
    #[tokio::test]
    async fn append_rejects_set_property_with_multiple_values() {
        let (pool, _dir) = test_pool().await;

        let result = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK001"),
                key: "status".into(),
                value_text: Some("active".into()),
                value_num: Some(42.0),
                value_date: None,
                value_ref: None,
            }),
            FIXED_TS.into(),
        )
        .await;

        assert!(result.is_err(), "multiple value fields should be rejected");
    }

    /// Verify that a valid SetProperty op (exactly one value) is accepted.
    #[tokio::test]
    async fn append_accepts_valid_set_property() {
        let (pool, _dir) = test_pool().await;

        let result = append_local_op_at(
            &pool,
            TEST_DEVICE,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK001"),
                key: "status".into(),
                value_text: Some("active".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            FIXED_TS.into(),
        )
        .await;

        assert!(result.is_ok(), "valid SetProperty should be accepted");
    }

    // ── insta snapshot tests ───────────────────────────────────────────

    /// Snapshot an OpRecord after appending a create_block op.
    /// Redacts hash (blake3 is content-dependent but includes device_id/seq
    /// which are deterministic — however we redact to keep snapshots stable
    /// if the hash algorithm or input format ever changes).
    #[tokio::test]
    async fn snapshot_op_record_after_create_block() {
        let (pool, _dir) = test_pool().await;

        let record = append_local_op_at(
            &pool,
            TEST_DEVICE,
            make_create_payload("BLK-SNAP"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        insta::assert_yaml_snapshot!(record, {
            ".hash" => "[HASH]",
        });
    }

    /// Snapshot `get_ops_since` result after appending multiple ops.
    #[tokio::test]
    async fn snapshot_get_ops_since_multiple() {
        let (pool, _dir) = test_pool().await;

        // Append 3 ops
        for i in 1..=3 {
            let payload = make_create_payload(&format!("BLK-MS{i:02}"));
            append_local_op_at(&pool, TEST_DEVICE, payload, FIXED_TS.into())
                .await
                .unwrap();
        }

        let ops = get_ops_since(&pool, TEST_DEVICE, 0).await.unwrap();

        insta::assert_yaml_snapshot!(ops, {
            "[].hash" => "[HASH]",
        });
    }

    // ── parsed_parent_seqs ────────────────────────────────────────────────

    /// Helper: build a minimal OpRecord for unit tests (no DB needed).
    fn make_test_op() -> OpRecord {
        OpRecord {
            device_id: TEST_DEVICE.into(),
            seq: 1,
            parent_seqs: None,
            hash: "0".repeat(64),
            op_type: "create_block".into(),
            payload: "{}".into(),
            created_at: FIXED_TS.into(),
        }
    }

    #[test]
    fn parsed_parent_seqs_none_for_genesis() {
        let op = OpRecord {
            parent_seqs: None,
            ..make_test_op()
        };
        assert_eq!(
            op.parsed_parent_seqs().unwrap(),
            None,
            "genesis op should have no parents"
        );
    }

    #[test]
    fn parsed_parent_seqs_parses_single_parent() {
        let op = OpRecord {
            parent_seqs: Some(r#"[["device1",1]]"#.to_string()),
            ..make_test_op()
        };
        assert_eq!(
            op.parsed_parent_seqs().unwrap(),
            Some(vec![("device1".to_string(), 1)]),
            "should parse single parent entry"
        );
    }

    #[test]
    fn parsed_parent_seqs_parses_multi_parent() {
        let op = OpRecord {
            parent_seqs: Some(r#"[["device1",3],["device2",5]]"#.to_string()),
            ..make_test_op()
        };
        let parents = op.parsed_parent_seqs().unwrap().unwrap();
        assert_eq!(parents.len(), 2, "should parse both parent entries");
    }

    #[test]
    fn parsed_parent_seqs_error_on_malformed() {
        let op = OpRecord {
            parent_seqs: Some("not json".to_string()),
            ..make_test_op()
        };
        assert!(
            op.parsed_parent_seqs().is_err(),
            "malformed JSON should return error"
        );
    }

    // ── Canonical JSON ordering ─────────────────────────────────────────

    /// Verify that `serialize_inner_payload` produces keys in alphabetical
    /// order for a `CreateBlockPayload` (whose declaration order differs from
    /// alphabetical).
    #[test]
    fn canonical_json_keys_are_sorted() {
        let payload = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK001"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "hello".into(),
        });
        let json = serialize_inner_payload(&payload).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = value.as_object().unwrap();
        let keys: Vec<&String> = obj.keys().collect();
        let mut sorted_keys = keys.clone();
        sorted_keys.sort();
        assert_eq!(keys, sorted_keys, "JSON keys must be in alphabetical order");
    }

    /// Verify that all 12 payload types produce JSON with alphabetically
    /// sorted keys when serialized through `serialize_inner_payload`.
    #[test]
    fn canonical_json_deterministic_across_all_payload_types() {
        for (op_type_name, payload) in all_op_payloads() {
            let json = serialize_inner_payload(&payload).unwrap();
            let value: serde_json::Value = serde_json::from_str(&json).unwrap();
            let obj = value
                .as_object()
                .unwrap_or_else(|| panic!("{op_type_name}: expected JSON object"));
            let keys: Vec<&String> = obj.keys().collect();
            let mut sorted_keys = keys.clone();
            sorted_keys.sort();
            assert_eq!(
                keys, sorted_keys,
                "{op_type_name}: JSON keys must be in alphabetical order, got: {keys:?}"
            );
        }
    }

    // ── Immutability gap documentation ──────────────────────────────────

    /// The op_log immutability invariant is enforced by code convention,
    /// not by database triggers.  This test documents the gap: UPDATE and
    /// DELETE succeed at the SQL level even though the op_log is supposed
    /// to be strictly append-only.
    ///
    /// If a trigger is added later to enforce immutability, this test
    /// should be updated to assert that UPDATE and DELETE fail.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn op_log_update_not_blocked_by_schema() {
        let (pool, _dir) = test_pool().await;

        // Append an op so there is a row to mutate.
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            make_create_payload("BLK-IMMUT"),
            FIXED_TS.into(),
        )
        .await
        .unwrap();

        // Attempt UPDATE — currently succeeds (no trigger guards op_log).
        let update_result =
            sqlx::query("UPDATE op_log SET payload = '{}' WHERE device_id = ? AND seq = 1")
                .bind(TEST_DEVICE)
                .execute(&pool)
                .await;

        assert!(
            update_result.is_ok(),
            "UPDATE should succeed (no immutability trigger): {:?}",
            update_result.unwrap_err(),
        );
        assert_eq!(
            update_result.unwrap().rows_affected(),
            1,
            "expected exactly one row updated",
        );

        // Attempt DELETE — currently succeeds (no trigger guards op_log).
        let delete_result = sqlx::query("DELETE FROM op_log WHERE device_id = ? AND seq = 1")
            .bind(TEST_DEVICE)
            .execute(&pool)
            .await;

        assert!(
            delete_result.is_ok(),
            "DELETE should succeed (no immutability trigger): {:?}",
            delete_result.unwrap_err(),
        );
        assert_eq!(
            delete_result.unwrap().rows_affected(),
            1,
            "expected exactly one row deleted",
        );
    }

    #[tokio::test]
    async fn expression_index_on_block_id_exists() {
        let (pool, _dir) = test_pool().await;
        let row = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_op_log_payload_block_id'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row, 1,
            "expression index on json_extract block_id should exist"
        );
    }

    // =========================================================================
    // FEAT-4h slice 1 — `op_log.origin` column
    // =========================================================================

    /// Migration 0033 must have applied cleanly: the `origin` column exists,
    /// is `NOT NULL`, and has the default `'user'`.
    #[tokio::test]
    async fn origin_column_schema_is_as_specified_in_migration_0033() {
        let (pool, _dir) = test_pool().await;
        let rows = sqlx::query(
            "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('op_log') WHERE name = 'origin'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "exactly one `origin` column should exist after migration 0033",
        );
        use sqlx::Row as _;
        let row = &rows[0];
        let ty: String = row.try_get("type").unwrap();
        let notnull: i64 = row.try_get("notnull").unwrap();
        let default: Option<String> = row.try_get("dflt_value").unwrap();
        assert_eq!(ty, "TEXT", "origin column must be TEXT");
        assert_eq!(notnull, 1, "origin column must be NOT NULL");
        assert_eq!(
            default.as_deref(),
            Some("'user'"),
            "origin column default must be the literal 'user'",
        );
    }

    /// Frontend-invoked commands never enter an MCP `ACTOR.scope(...)`, so
    /// `current_actor()` falls back to `Actor::User` and
    /// `append_local_op_in_tx` must stamp `origin = 'user'`.
    #[tokio::test]
    async fn append_outside_actor_scope_stamps_origin_user() {
        let (pool, _dir) = test_pool().await;
        let record = append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_USER"))
            .await
            .unwrap();
        let origin: String = sqlx::query_scalar!(
            "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
            record.device_id,
            record.seq,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            origin, "user",
            "frontend / un-wrapped call must stamp origin='user'",
        );
    }

    /// Inside an MCP `ACTOR.scope(Actor::Agent { name })` the append path
    /// must stamp `origin = 'agent:<name>'`, wiring the
    /// `mcp::actor::current_actor` task-local all the way through to the
    /// DB row.
    #[tokio::test]
    async fn append_inside_agent_scope_stamps_origin_agent_prefix() {
        use crate::mcp::actor::{Actor, ActorContext, ACTOR};
        let (pool, _dir) = test_pool().await;

        let ctx = ActorContext {
            actor: Actor::Agent {
                name: "claude-desktop".to_string(),
            },
            request_id: "req-slice1".to_string(),
        };

        let record = ACTOR
            .scope(
                ctx,
                append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_AGENT")),
            )
            .await
            .unwrap();

        let origin: String = sqlx::query_scalar!(
            "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
            record.device_id,
            record.seq,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            origin, "agent:claude-desktop",
            "agent-scope append must stamp origin='agent:<clientInfo.name>'",
        );
    }

    /// Once the `ACTOR.scope` future resolves, subsequent appends fall back
    /// to `origin = 'user'`. This pins the scope-boundary behaviour: agent
    /// attribution must not leak into ops emitted by frontend code on the
    /// same thread after an MCP handler returns.
    #[tokio::test]
    async fn origin_falls_back_to_user_after_agent_scope_ends() {
        use crate::mcp::actor::{Actor, ActorContext, ACTOR};
        let (pool, _dir) = test_pool().await;

        // First op — inside the agent scope.
        let ctx = ActorContext {
            actor: Actor::Agent {
                name: "agent-A".to_string(),
            },
            request_id: "req-a".to_string(),
        };
        let inside = ACTOR
            .scope(
                ctx,
                append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_INSIDE")),
            )
            .await
            .unwrap();

        // Second op — outside the scope, same runtime.
        let outside = append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_OUTSIDE"))
            .await
            .unwrap();

        let inside_origin: String = sqlx::query_scalar!(
            "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
            inside.device_id,
            inside.seq,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let outside_origin: String = sqlx::query_scalar!(
            "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
            outside.device_id,
            outside.seq,
        )
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(inside_origin, "agent:agent-A");
        assert_eq!(
            outside_origin, "user",
            "origin must revert to 'user' once the ACTOR.scope future completes",
        );
    }

    /// `origin` is local-attribution metadata only — it must NOT be part of
    /// the op's content hash. Otherwise cross-device sync would split the
    /// same logical op into two different hash chains depending on whether
    /// it was agent- or user-invoked at the origin device.
    #[tokio::test]
    async fn origin_does_not_affect_op_hash() {
        use crate::mcp::actor::{Actor, ActorContext, ACTOR};
        let (pool_a, _dir_a) = test_pool().await;
        let (pool_b, _dir_b) = test_pool().await;

        // Same payload, same device, same `created_at` — but different
        // actor scope. Hashes must match because `origin` is excluded from
        // the hash preimage.
        let payload_a = make_create_payload("BLKHASH");
        let payload_b = make_create_payload("BLKHASH");
        let ts = "2025-06-01T00:00:00+00:00".to_string();

        let rec_a = append_local_op_at(&pool_a, TEST_DEVICE, payload_a, ts.clone())
            .await
            .unwrap();

        let ctx = ActorContext {
            actor: Actor::Agent {
                name: "hash-test-agent".to_string(),
            },
            request_id: "req-hash".to_string(),
        };
        let rec_b = ACTOR
            .scope(ctx, append_local_op_at(&pool_b, TEST_DEVICE, payload_b, ts))
            .await
            .unwrap();

        assert_eq!(
            rec_a.hash, rec_b.hash,
            "hash must be independent of origin: same logical op on two devices \
             with different actor scopes must sync cleanly",
        );

        // Sanity: the persisted origin does differ.
        let origin_a: String = sqlx::query_scalar!(
            "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
            rec_a.device_id,
            rec_a.seq,
        )
        .fetch_one(&pool_a)
        .await
        .unwrap();
        let origin_b: String = sqlx::query_scalar!(
            "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
            rec_b.device_id,
            rec_b.seq,
        )
        .fetch_one(&pool_b)
        .await
        .unwrap();
        assert_eq!(origin_a, "user");
        assert_eq!(origin_b, "agent:hash-test-agent");
    }

    /// Rows inserted through paths that do NOT go through
    /// `append_local_op_in_tx` (remote ops via `dag::insert_remote_op`,
    /// merge ops via `dag::append_merge_op`, snapshot / compaction writes)
    /// don't include `origin` in their INSERT column list; the column
    /// default from migration 0033 must take over. This regression-test
    /// pins the invariant so a future refactor that adds `origin` to the
    /// INSERT list of one path but not the others can't silently ship.
    #[tokio::test]
    async fn remote_op_insert_defaults_origin_to_user() {
        use crate::dag::insert_remote_op;
        let (pool, _dir) = test_pool().await;

        // Produce a real valid op on device A, then deliver it to device B's
        // pool as a remote op.
        let (pool_src, _dir_src) = test_pool().await;
        let record = append_local_op(&pool_src, "device-A", make_create_payload("BLKREM"))
            .await
            .unwrap();

        let inserted = insert_remote_op(&pool, &record).await.unwrap();
        assert!(inserted, "fresh remote op must insert");

        let origin: String = sqlx::query_scalar!(
            "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
            record.device_id,
            record.seq,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            origin, "user",
            "remote op inserted via dag::insert_remote_op must pick up the \
             'user' column default from migration 0033",
        );
    }

    /// FEAT-4h slice 3: `append_local_op_in_tx` must populate the
    /// `LAST_APPEND` task-local with the freshly-inserted `(device_id,
    /// seq)` pair when a scope is active. Outside a scope (the
    /// frontend-invoked path) the call is a silent no-op — that path is
    /// covered in `mcp::last_append::tests::record_append_outside_scope_is_silent_noop`.
    #[tokio::test]
    async fn append_local_op_in_tx_populates_last_append_inside_scope() {
        use crate::mcp::last_append::LAST_APPEND;
        use std::cell::Cell;

        let (pool, _dir) = test_pool().await;

        let got = LAST_APPEND
            .scope(Cell::new(None), async {
                let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
                let record = append_local_op_in_tx(
                    &mut tx,
                    TEST_DEVICE,
                    make_create_payload("BLKLAPPEND"),
                    FIXED_TS.into(),
                )
                .await
                .unwrap();
                tx.commit().await.unwrap();

                let captured = LAST_APPEND.with(|c| c.take());
                (record, captured)
            })
            .await;

        let (record, captured) = got;
        let captured = captured.expect("LAST_APPEND must be populated after append_local_op_in_tx");
        assert_eq!(
            captured.device_id, record.device_id,
            "LAST_APPEND.device_id must match the inserted row",
        );
        assert_eq!(
            captured.seq, record.seq,
            "LAST_APPEND.seq must match the inserted row",
        );
    }
}
