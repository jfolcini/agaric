//! Reverse functions for property ops (set, delete) and property definition
//! ops, and the key an undo of a set or delete writes under.

use agaric_core::error::AppError;
use agaric_store::op::{
    DeletePropertyPayload, OpPayload, PropertyDefWrite, PropertyValueFields, PropertyValueWrite,
    RenamePropertyKeyPayload, RewritePropertiesPayload, SetPropertyDefPayload, SetPropertyPayload,
};
use agaric_store::op_log::OpRecord;
use sqlx::{SqliteConnection, SqlitePool};

/// A definition op records the definition it replaced, so its reverse is
/// the swap (#5841).
pub fn reverse_set_property_def(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: SetPropertyDefPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::SetPropertyDef(SetPropertyDefPayload {
        def: payload.prior,
        prior: payload.def,
        ..payload
    }))
}

/// A rename's reverse renames back (#5841).
pub fn reverse_rename_property_key(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RenamePropertyKeyPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RenamePropertyKey(RenamePropertyKeyPayload {
        old_key: payload.new_key,
        new_key: payload.old_key,
        ..payload
    }))
}

/// A rewrite records what each write replaced, so its reverse swaps every
/// write's new and prior state (#5841).
pub fn reverse_rewrite_properties(record: &OpRecord) -> Result<OpPayload, AppError> {
    let payload: RewritePropertiesPayload = serde_json::from_str(&record.payload)?;
    Ok(OpPayload::RewriteProperties(RewritePropertiesPayload {
        defs: payload
            .defs
            .into_iter()
            .map(|w| PropertyDefWrite {
                def: w.prior,
                prior: w.def,
                ..w
            })
            .collect(),
        values: payload
            .values
            .into_iter()
            .map(|w| PropertyValueWrite {
                value: w.prior,
                prior: w.value,
                ..w
            })
            .collect(),
        ..payload
    }))
}

/// The key `block_id`'s value of `key` lives under now (#5841): `key` followed
/// through each rename and merge of the block's space after the op at `after`
/// (`created_at`, `seq`, `device_id`), in log order. A peer's rename or merge
/// counts as this device's own does.
///
/// A rename moves `old_key` to `new_key`. A rewrite moves the block's value
/// out of `key` when it removes it there and writes the block a value under
/// another key: a merge's moved value, or the undo of one. A merge moves a
/// value in only where the block held none, so a value moved into `key` is
/// another key's, and its moving out again (the merge's undo) leaves `key`
/// where it is. A value the merge dropped stays under its key, and so does one
/// an undo brought back.
pub async fn forward_property_key(
    conn: &mut SqliteConnection,
    block_id: &str,
    key: &str,
    after: (i64, i64, &str),
) -> Result<String, AppError> {
    let (created_at, seq, device_id) = after;
    // A space's own block names no space: its renames are its own.
    let space = sqlx::query_scalar!(
        r#"SELECT COALESCE(space_id, id) AS "space!: String" FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut *conn)
    .await?;
    let Some(space) = space else {
        return Ok(key.to_owned());
    };
    let rows = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND op_type IN ('rename_property_key', 'rewrite_properties') \
           AND (created_at > ?2 \
                OR (created_at = ?2 AND (seq > ?3 OR (seq = ?3 AND device_id > ?4)))) \
         ORDER BY created_at, seq, device_id",
        space,
        created_at,
        seq,
        device_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut key = key.to_owned();
    let mut moved_in = false;
    for row in rows {
        if row.op_type == "rename_property_key" {
            let p: RenamePropertyKeyPayload = serde_json::from_str(&row.payload)?;
            if key == p.old_key {
                key = p.new_key;
            }
            continue;
        }
        let p: RewritePropertiesPayload = serde_json::from_str(&row.payload)?;
        match value_move(&p.values, block_id, &key) {
            Some(ValueMove::Out(to)) => {
                if !moved_in {
                    key = to.to_owned();
                }
                moved_in = false;
            }
            Some(ValueMove::In) => moved_in = true,
            None => {}
        }
    }
    Ok(key)
}

/// How a rewrite moved `block_id`'s value of a key.
enum ValueMove<'a> {
    /// Out of the key, to this one.
    Out(&'a str),
    /// Another key's value, into the key.
    In,
}

/// A move is two writes of one block: the value removed under one key and
/// written under another. A rewrite writes a key once per block.
fn value_move<'a>(
    writes: &'a [PropertyValueWrite],
    block_id: &str,
    key: &str,
) -> Option<ValueMove<'a>> {
    let (here, elsewhere): (Vec<_>, Vec<_>) = writes
        .iter()
        .filter(|w| w.block_id.as_str() == block_id)
        .partition(|w| w.key == key);
    let here = here.first()?;
    let other = elsewhere
        .into_iter()
        .find(|w| w.value.is_some() != here.value.is_some())?;
    Some(if here.value.is_none() {
        ValueMove::Out(&other.key)
    } else {
        ValueMove::In
    })
}

pub async fn reverse_set_property(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: SetPropertyPayload = serde_json::from_str(&record.payload)?;
    let prior = match &payload.prior {
        Some(prior) => prior.clone().into_held(),
        // An op written before #6014 records nothing.
        None => {
            find_prior_property(
                pool,
                payload.block_id.as_str(),
                &payload.key,
                record.created_at,
                record.seq,
                &record.device_id,
            )
            .await?
        }
    };
    match prior {
        Some(p) => Ok(OpPayload::SetProperty(SetPropertyPayload::with_value(
            payload.block_id,
            payload.key,
            p,
        ))),
        None => {
            let prior = Some(payload.value());
            Ok(OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: payload.block_id,
                key: payload.key,
                prior,
            }))
        }
    }
}

pub async fn reverse_delete_property(
    pool: &SqlitePool,
    record: &OpRecord,
) -> Result<OpPayload, AppError> {
    let payload: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
    let prior = match payload.prior {
        Some(prior) => prior,
        // An op written before #5918 records no value.
        None => find_prior_property(
            pool,
            payload.block_id.as_str(),
            &payload.key,
            record.created_at,
            record.seq,
            &record.device_id,
        )
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "no prior set_property found for block '{}' key '{}' — cannot reverse delete_property",
                payload.block_id, payload.key
            ))
        })?,
    };
    Ok(OpPayload::SetProperty(SetPropertyPayload::with_value(
        payload.block_id,
        payload.key,
        prior,
    )))
}

async fn find_prior_property(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
    created_at: i64,
    seq: i64,
    device_id: &str,
) -> Result<Option<PropertyValueFields>, AppError> {
    // Switch the block_id predicate from `json_extract(payload, '$.block_id')`
    // to the indexed `block_id` column added by migration 0030 (idx_op_log_block_id).
    // The key predicate stays on `json_extract` — there is no covering index for
    // (block_id, key), but the block_id filter alone narrows the scan dramatically.
    //
    // Per AGENTS.md invariant #8 (ULID uppercase normalization for blake3
    // determinism), uppercase the bound parameter before binding so it matches
    // The canonical form stored in the indexed column. Mirrors the fix in
    // block_ops.rs and recovery/draft_recovery.rs:84.
    let bid_upper = block_id.to_ascii_uppercase();
    // #181: the prior value of a property is whatever the MOST RECENT op
    // touching (block, key) left it as — which may be a `delete_property`,
    // not just a `set_property`. Querying only `set_property` rows ignores
    // an intervening delete, so for `Set(K="A"); Delete(K); Set(K="a")` the
    // prior state of the final Set is ABSENT (the property had been deleted),
    // and its reverse must be `DeleteProperty(K)` — not a resurrected
    // `SetProperty(K="A")`. So consider BOTH op types and inspect the single
    // most-recent one: if it is a `delete_property`, the prior state is None.
    // #382: the op_log PK is `(device_id, seq)` and `seq` is a PER-DEVICE
    // counter, so the "strictly before" predicate must tie-break on the
    // full canonical `(created_at, seq, device_id)` total order (the same
    // order used by `commands/history.rs` and `pagination/history.rs`).
    // Omitting `device_id` leaves the bound ambiguous when two devices
    // share a `(created_at, seq)` pair.
    // #3646 seeded that collision (`reverse_set_property_tie_breaks_on_device_id_3646`)
    // and found this one scan's `ORDER BY … device_id DESC` to be an
    // EQUIVALENT MUTANT today: the plan is
    // `SEARCH op_log USING INDEX idx_op_log_block_key_created`, whose key is
    // `(block_id, json_extract(payload,'$.key'), created_at, seq, device_id)`,
    // so the index already yields the `device_id` tie-break and deleting the
    // clause returns the same row (verified with `EXPLAIN QUERY PLAN`). Do
    // NOT read that as "the clause is dead code": the index is free to change,
    // and the ORDER BY is what states the required order independently of it.
    // The three sibling scans (block text, block position, attachment) have no
    // such covering index and DO redden when the tie-break is removed.
    // #2549: `AND is_replicated = 0` — the prior value of a property must be
    // reconstructed from locally-applied set/delete ops only. #2495 audit-only
    // replicated rows (`is_replicated = 1`) were never applied to local state,
    // so honouring one here would resurrect a property value this device never
    // held. Mirrors `block_ops::find_prior_text` / `find_prior_position`.
    // #5262: `space` is the one key whose replicated rows count. A peer's
    // `space` assignment is what placed the page in the space doc this device
    // received it through, so this device DID hold that value; barring it made
    // the reverse of a peer-born page's first local move `DeleteProperty(space)`
    // — a page in no space — instead of the move back.
    // `batch::fetch_prior_property_batch` mirrors this clause.
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE block_id = ?1 \
           AND json_extract(payload, '$.key') = ?2 \
           AND op_type IN ('set_property', 'delete_property') \
           AND (is_replicated = 0 OR json_extract(payload, '$.key') = 'space') \
           AND (created_at < ?3 \
                OR (created_at = ?3 AND (seq < ?4 OR (seq = ?4 AND device_id < ?5)))) \
         ORDER BY created_at DESC, seq DESC, device_id DESC \
         LIMIT 1",
        bid_upper,
        key,
        created_at,
        seq,
        device_id,
    )
    .fetch_optional(pool)
    .await?;
    match row {
        // Most recent prior op was a set — its value is the prior state.
        Some(r) if r.op_type == "set_property" => {
            let p: SetPropertyPayload = serde_json::from_str(&r.payload)?;
            Ok(Some(p.value()))
        }
        // Most recent prior op was a delete (or there is no prior op at all):
        // the property was ABSENT immediately before the op being reversed.
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Inline tests for the indexed `block_id` predicate switch.
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
    use agaric_core::ulid::BlockId;
    use agaric_store::op::{DeletePropertyPayload, OpPayload, SetPropertyPayload};
    use agaric_store::op_log::{OpRecord, append_local_op_at};
    use agaric_store::test_support::test_pool;

    const TEST_DEVICE: &str = "test-device";

    async fn append_op(pool: &SqlitePool, payload: OpPayload, ts: i64) -> OpRecord {
        append_local_op_at(pool, TEST_DEVICE, payload, ts)
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
                value_bool: None,
                prior: None,
            }),
            1_736_942_400_000,
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
                value_bool: None,
                prior: None,
            }),
            1_736_942_430_000,
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
                value_bool: None,
                prior: None,
            }),
            1_736_942_460_000,
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
                value_bool: None,
                prior: None,
            }),
            1_736_942_400_000,
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
                value_bool: None,
                prior: None,
            }),
            1_736_942_430_000,
        )
        .await;

        // The op we are reversing: delete color from block A.
        let rec = append_op(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::test_id("BLK_M64C"),
                key: "color".into(),
                prior: None,
            }),
            1_736_942_460_000,
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
                value_bool: None,
                prior: None,
            }),
            1_736_942_400_000,
        )
        .await;

        // Reference call with the canonical (uppercase) form.
        let upper = find_prior_property(
            &pool,
            "BLK_M64E_NORM",
            "status",
            1_736_942_460_000,
            i64::MAX,
            TEST_DEVICE,
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
            1_736_942_460_000,
            i64::MAX,
            TEST_DEVICE,
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

    /// #2201 Tier-3 item 6: the reverse lookup gained an expression index
    /// `idx_op_log_block_key_created` on
    /// `(block_id, json_extract(payload,'$.key'), created_at, seq, device_id)`
    /// (migration 0098). The index is purely additive — it must not change
    /// which prior row `find_prior_property` selects. This drives a
    /// `Set -> Delete -> Set` history for a single key and asserts the reverse
    /// of every op is byte-identical to the pre-index semantics:
    ///   * reverse of the FINAL set  -> DeleteProperty (property was absent,
    ///     having been deleted before the final set),
    ///   * reverse of the delete     -> SetProperty("A") (the first set),
    ///   * reverse of the FIRST set  -> DeleteProperty (no prior op at all).
    /// A decoy op on a different key at a later timestamp guards against the
    /// index widening the equality seek past the `$.key` predicate.
    #[tokio::test]
    async fn reverse_across_set_delete_set_history_is_index_stable() {
        let (pool, _dir) = test_pool().await;
        let blk = || BlockId::test_id("BLK_2201_IDX");

        // 1) Set space="A".
        let first_set = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: blk(),
                key: "space".into(),
                value_text: Some("A".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
                prior: None,
            }),
            1_736_942_400_000,
        )
        .await;

        // 2) Delete space.
        let delete = append_op(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: blk(),
                key: "space".into(),
                prior: None,
            }),
            1_736_942_430_000,
        )
        .await;

        // Decoy: a DIFFERENT key on the SAME block at a later ts. If the
        // expression index let the `$.key` equality leak, this row could be
        // surfaced by the ORDER BY for the `space` lookups below.
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: blk(),
                key: "title".into(),
                value_text: Some("decoy".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
                prior: None,
            }),
            1_736_942_445_000,
        )
        .await;

        // 3) Set space="a" (final).
        let final_set = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: blk(),
                key: "space".into(),
                value_text: Some("a".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
                prior: None,
            }),
            1_736_942_460_000,
        )
        .await;

        // Reverse of the final set: prior state is ABSENT (deleted), so the
        // reverse must be a DeleteProperty, NOT a resurrected SetProperty("A").
        match reverse_set_property(&pool, &final_set).await.unwrap() {
            OpPayload::DeleteProperty(p) => {
                assert_eq!(p.block_id, "BLK_2201_IDX");
                assert_eq!(p.key, "space");
            }
            other => panic!("expected DeleteProperty for final set, got {other:?}"),
        }

        // Reverse of the delete: prior is the first set, value "A".
        match reverse_delete_property(&pool, &delete).await.unwrap() {
            OpPayload::SetProperty(p) => {
                assert_eq!(p.block_id, "BLK_2201_IDX");
                assert_eq!(p.key, "space");
                assert_eq!(p.value_text, Some("A".into()));
            }
            other => panic!("expected SetProperty for delete, got {other:?}"),
        }

        // Reverse of the first set: no prior op -> DeleteProperty.
        match reverse_set_property(&pool, &first_set).await.unwrap() {
            OpPayload::DeleteProperty(p) => {
                assert_eq!(p.block_id, "BLK_2201_IDX");
                assert_eq!(p.key, "space");
            }
            other => panic!("expected DeleteProperty for first set, got {other:?}"),
        }
    }
}
