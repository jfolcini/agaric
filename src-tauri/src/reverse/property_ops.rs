//! Reverse functions for property ops (set, delete).

use crate::error::AppError;
use crate::op::{DeletePropertyPayload, OpPayload, SetPropertyPayload};
use crate::op_log::OpRecord;
use sqlx::SqlitePool;

struct PriorPropertyRow {
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
}

pub async fn reverse_set_property(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: SetPropertyPayload = serde_json::from_str(&record.payload)?;
    let prior = find_prior_property(
        pool,
        payload.block_id.as_str(),
        &payload.key,
        &record.created_at,
        record.seq,
    )
    .await?;
    match prior {
        Some(p) => Ok(OpPayload::SetProperty(SetPropertyPayload {
            block_id: payload.block_id,
            key: payload.key,
            value_text: p.value_text,
            value_num: p.value_num,
            value_date: p.value_date,
            value_ref: p.value_ref,
        })),
        None => Ok(OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: payload.block_id,
            key: payload.key,
        })),
    }
}

pub async fn reverse_delete_property(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
    let prior = find_prior_property(
        pool,
        payload.block_id.as_str(),
        &payload.key,
        &record.created_at,
        record.seq,
    )
    .await?
    .ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior set_property found for block '{}' key '{}' — cannot reverse delete_property",
            payload.block_id, payload.key
        ))
    })?;
    Ok(OpPayload::SetProperty(SetPropertyPayload {
        block_id: payload.block_id,
        key: payload.key,
        value_text: prior.value_text,
        value_num: prior.value_num,
        value_date: prior.value_date,
        value_ref: prior.value_ref,
    }))
}

async fn find_prior_property(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
    created_at: &str,
    seq: i64,
) -> Result<Option<PriorPropertyRow>, AppError> {
    // M-64: switch the block_id predicate from `json_extract(payload, '$.block_id')`
    // to the indexed `block_id` column added by migration 0030 (idx_op_log_block_id).
    // The key predicate stays on `json_extract` — there is no covering index for
    // (block_id, key), but the block_id filter alone narrows the scan dramatically.
    //
    // Per AGENTS.md invariant #8 (ULID uppercase normalization for blake3
    // determinism), uppercase the bound parameter before binding so it matches
    // the canonical form stored in the indexed column. Mirrors the M-63 fix in
    // block_ops.rs and recovery/draft_recovery.rs:84.
    let bid_upper = block_id.to_ascii_uppercase();
    let row = sqlx::query!(
        "SELECT payload FROM op_log \
         WHERE block_id = ?1 \
           AND json_extract(payload, '$.key') = ?2 \
           AND op_type = 'set_property' \
           AND (created_at < ?3 OR (created_at = ?3 AND seq < ?4)) \
         ORDER BY created_at DESC, seq DESC \
         LIMIT 1",
        bid_upper,
        key,
        created_at,
        seq,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some(r) => {
            let p: SetPropertyPayload = serde_json::from_str(&r.payload)?;
            Ok(Some(PriorPropertyRow {
                value_text: p.value_text,
                value_num: p.value_num,
                value_date: p.value_date,
                value_ref: p.value_ref,
            }))
        }
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// M-64 — inline tests for the indexed `block_id` predicate switch.
// ---------------------------------------------------------------------------
//
// These tests verify that `reverse_set_property` / `reverse_delete_property`
// correctly use the indexed `op_log.block_id` column (added in migration
// 0030) to scope the prior-value lookup to a single block, rather than
// relying on `json_extract(payload, '$.block_id')` which performs a
// full-table JSON scan.
//
// Coverage:
//   * `reverse_set_property_uses_block_id_column` — multi-block seed,
//     correct prior is returned.
//   * `reverse_delete_property_uses_block_id_column` — analogous.
//   * `reverse_set_property_uppercase_normalization` — lowercase input
//     to the inner helper still finds prior data stored under its
//     canonical uppercase ULID form.
#[cfg(test)]
mod tests_m64 {
    use super::*;
    use crate::db::init_pool;
    use crate::op::{DeletePropertyPayload, OpPayload, SetPropertyPayload};
    use crate::op_log::{append_local_op_at, OpRecord};
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const TEST_DEVICE: &str = "test-device";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn append_op(pool: &SqlitePool, payload: OpPayload, ts: &str) -> OpRecord {
        append_local_op_at(pool, TEST_DEVICE, payload, ts.to_string())
            .await
            .unwrap()
    }

    /// Seed two blocks with `set_property` ops sharing the same key, then
    /// reverse a later `set_property` on block A. The result must reflect
    /// block A's prior value, not block B's — proving the block_id
    /// predicate actually scopes the lookup.
    #[tokio::test]
    async fn reverse_set_property_uses_block_id_column() {
        let (pool, _dir) = test_pool().await;

        // Block A: priority=low, then priority=high (the "current" op
        // we will reverse).
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_M64A"),
                key: "priority".into(),
                value_text: Some("low".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00Z",
        )
        .await;

        // Block B: priority=DECOY at a strictly later timestamp than the
        // BLK_M64A "low" op. If the query failed to scope by block_id,
        // the ORDER BY created_at DESC would surface this row instead of
        // BLK_M64A's "low".
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_M64B"),
                key: "priority".into(),
                value_text: Some("decoy".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:30Z",
        )
        .await;

        // Block A: priority=high — the op we are reversing.
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_M64A"),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00Z",
        )
        .await;

        let reverse = reverse_set_property(&pool, &rec).await.unwrap();
        match reverse {
            OpPayload::SetProperty(p) => {
                assert_eq!(p.block_id, "BLK_M64A");
                assert_eq!(
                    p.value_text,
                    Some("low".into()),
                    "prior must come from block A, not the later decoy on block B"
                );
            }
            other => panic!("expected SetProperty, got {other:?}"),
        }
    }

    /// Same shape as above but for `reverse_delete_property`: two blocks,
    /// same key, ensure we recover block A's prior text (not block B's).
    #[tokio::test]
    async fn reverse_delete_property_uses_block_id_column() {
        let (pool, _dir) = test_pool().await;

        // Block A: color=red.
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_M64C"),
                key: "color".into(),
                value_text: Some("red".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00Z",
        )
        .await;

        // Block B: color=green at a later ts. If the predicate is not
        // scoped by block_id, the ORDER BY would surface this row.
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_M64D"),
                key: "color".into(),
                value_text: Some("green".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:30Z",
        )
        .await;

        // The op we are reversing: delete color from block A.
        let rec = append_op(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::test_id("BLK_M64C"),
                key: "color".into(),
            }),
            "2025-01-15T12:01:00Z",
        )
        .await;

        let reverse = reverse_delete_property(&pool, &rec).await.unwrap();
        match reverse {
            OpPayload::SetProperty(p) => {
                assert_eq!(p.block_id, "BLK_M64C");
                assert_eq!(
                    p.value_text,
                    Some("red".into()),
                    "prior must come from block A, not block B's later set"
                );
            }
            other => panic!("expected SetProperty, got {other:?}"),
        }
    }

    /// Invariant #8 (ULID uppercase normalization): calling the inner
    /// helper with a lowercase block_id must find the same row as
    /// uppercase, because the bound parameter is uppercased before
    /// sqlx binds it. The op_log row stores `BlockId` payloads in
    /// canonical uppercase via the BlockId Deserialize impl, so
    /// without the uppercase step a lowercase caller would silently
    /// miss every prior set.
    #[tokio::test]
    async fn reverse_set_property_uppercase_normalization() {
        let (pool, _dir) = test_pool().await;

        // BlockId always stores/serializes uppercase, so the indexed
        // column in op_log holds "BLK_M64E_NORM".
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_M64E_NORM"),
                key: "status".into(),
                value_text: Some("draft".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00Z",
        )
        .await;

        // Reference call with the canonical (uppercase) form.
        let upper = find_prior_property(
            &pool,
            "BLK_M64E_NORM",
            "status",
            "2025-01-15T12:01:00Z",
            i64::MAX,
        )
        .await
        .unwrap()
        .expect("uppercase lookup must find the seeded set_property");

        // Lowercase input — the implementation must uppercase before
        // binding, otherwise the index lookup silently returns nothing.
        let lower = find_prior_property(
            &pool,
            "blk_m64e_norm",
            "status",
            "2025-01-15T12:01:00Z",
            i64::MAX,
        )
        .await
        .unwrap()
        .expect("lowercase lookup must find the same row after uppercasing");

        assert_eq!(upper.value_text, Some("draft".into()));
        assert_eq!(
            lower.value_text, upper.value_text,
            "lowercase block_id must yield the same prior as uppercase"
        );
        assert_eq!(lower.value_num, upper.value_num);
        assert_eq!(lower.value_date, upper.value_date);
        assert_eq!(lower.value_ref, upper.value_ref);
    }
}
