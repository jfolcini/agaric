// B-3 batch builder uses `i as i64` / `i as usize` to round-trip its
// per-op input-position index between Rust `usize` (Vec index) and
// SQLite `INTEGER`. Batch sizes are bounded by the caller
// (`MAX_REVERT_OPS = 1000` in `commands::history`, C5/#344) so the casts
// cannot wrap, truncate, or lose sign in practice — annotate at module
// scope instead of every site.
#![allow(
    clippy::cast_possible_wrap,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]

//! Batched reverse-op computation — SQL-review B-3.
//!
//! `compute_reverse` (the single-op entry point in `super`) runs three
//! sequential queries per op: one `get_op_by_seq` plus a per-op-type
//! `find_prior_*` lookup. For a 50-op undo batch that fans out to 150
//! round-trips, even though each `find_prior_*` is itself an indexed
//! lookup on `op_log.block_id` (migration 0030) /
//! `op_log.attachment_id` (migration 0064).
//!
//! This module collapses the per-op-type prior-context fetches into a
//! single UNION-ALL query per op-type group: one query per op-type
//! present in the batch, each returning one row per input op tagged
//! with its input-position index so results can be mapped back. For a
//! homogeneous 50-op `edit_block` batch this is 1 query (vs 50); for
//! a mixed batch covering the five context-bearing op-types
//! (`edit_block`, `move_block`, `set_property`, `delete_property`,
//! `delete_attachment`) it is at most 5 queries.
//!
//! # Parity contract
//!
//! The output of [`compute_reverse_batch`] MUST equal the per-op
//! [`super::compute_reverse`] loop output for the same input order.
//! `compute_reverse_batch_matches_per_op_loop` in `super::tests` is
//! the regression oracle that locks this contract.

use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use std::str::FromStr;

use super::{attachment_ops, block_ops, tag_ops};
use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use crate::op::{
    CreateBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    OpType, SetPropertyPayload,
};
use crate::op_log::OpRecord;
use crate::ulid::BlockId;

// C5 (#344): per-op bind-parameter widths. Each batch helper builds a
// UNION-ALL with one subquery per op; to keep every executed statement
// under SQLite's `SQLITE_MAX_VARIABLE_NUMBER` we process `idxs` in
// chunks of `MAX_SQL_PARAMS / BINDS_PER_OP`. The widths below count the
// `push_bind` calls in each helper's per-op subquery:
//   * text / position: idx, block_id, created_at, created_at, seq      → 5
//   * property:        idx, block_id, key, created_at, created_at, seq → 6
//   * attachment:      idx, attachment_id, created_at, created_at, seq → 5
//   * op-record fetch: idx, device_id, seq                             → 3
// `MAX_SQL_PARAMS` is the crate-wide 999 bound from `crate::db` (the
// same conservative `SQLITE_MAX_VARIABLE_NUMBER` floor the snapshot
// `batch_insert_snapshot_rows!` chunker uses) — well under the real
// 3.32+ limit of 32766, so the chunked statements never overflow.
const TEXT_BINDS_PER_OP: usize = 5;
const POSITION_BINDS_PER_OP: usize = 5;
const PROPERTY_BINDS_PER_OP: usize = 6;
const ATTACHMENT_BINDS_PER_OP: usize = 5;
const OP_RECORD_BINDS_PER_OP: usize = 3;

/// Batch-compute reverse payloads for a sequence of [`OpRecord`]s.
///
/// Returns reverses in the same order as the input. Mirrors the
/// match-arm dispatch of [`super::compute_reverse`] but folds the
/// per-op `find_prior_*` lookups into at most one UNION-ALL query per
/// op-type group.
///
/// # Errors
///
/// Propagates the same errors as [`super::compute_reverse`]:
///   * `AppError::Validation` on unknown `op_type` strings.
///   * `AppError::NotFound` when an `edit_block` / `move_block` /
///     `delete_property` lookup finds no prior context.
///   * `AppError::NonReversible` for `purge_block`, an attachment
///     restore whose `add_attachment` is gone, or a move-of-create
///     where the create lacks `position` (BUG-26).
///   * `serde_json::Error` (via `From`) for malformed payloads.
pub async fn compute_reverse_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
) -> Result<Vec<OpPayload>, AppError> {
    if ops.is_empty() {
        return Ok(Vec::new());
    }

    // Parse op types once. `OpType::from_str` is a manual match — no
    // serde overhead — so this is cheap and lets the dispatch below
    // be a typed match against `OpType` instead of a string compare.
    let mut parsed_types: Vec<OpType> = Vec::with_capacity(ops.len());
    for r in ops {
        let t = OpType::from_str(&r.op_type)
            .map_err(|e| AppError::Validation(format!("unknown op_type in record: {e}")))?;
        parsed_types.push(t);
    }

    // Bucket op indices by the prior-context query they need. Op
    // types whose reverse is a pure payload transform (CreateBlock,
    // DeleteBlock, AddTag, RemoveTag, AddAttachment, RestoreBlock,
    // PurgeBlock) do not appear in any bucket — they are handled by
    // the synchronous fallback at the bottom.
    let mut edit_idxs: Vec<usize> = Vec::new();
    let mut move_idxs: Vec<usize> = Vec::new();
    let mut set_prop_idxs: Vec<usize> = Vec::new();
    let mut del_prop_idxs: Vec<usize> = Vec::new();
    let mut del_att_idxs: Vec<usize> = Vec::new();

    for (idx, ty) in parsed_types.iter().enumerate() {
        match ty {
            OpType::EditBlock => edit_idxs.push(idx),
            OpType::MoveBlock => move_idxs.push(idx),
            OpType::SetProperty => set_prop_idxs.push(idx),
            OpType::DeleteProperty => del_prop_idxs.push(idx),
            OpType::DeleteAttachment => del_att_idxs.push(idx),
            _ => {}
        }
    }

    // ----- block_id / attachment_id-keyed prior fetches ---------------
    //
    // For each context-bearing op-type, build a UNION-ALL of per-op
    // `LIMIT 1` subqueries tagged with the input-position index. The
    // predicate shape mirrors `block_ops::find_prior_text`,
    // `block_ops::find_prior_position`, `property_ops::find_prior_property`,
    // and `attachment_ops::reverse_delete_attachment` byte-for-byte
    // so the batched output round-trips against the per-op oracle.

    let edit_prior: Vec<Option<(String, String)>> =
        fetch_prior_text_batch(pool, ops, &edit_idxs).await?;
    let move_prior: Vec<Option<(String, String)>> =
        fetch_prior_position_batch(pool, ops, &move_idxs).await?;
    let set_prior: Vec<Option<String>> =
        fetch_prior_property_batch(pool, ops, &set_prop_idxs).await?;
    let del_prior: Vec<Option<String>> =
        fetch_prior_property_batch(pool, ops, &del_prop_idxs).await?;
    let att_prior: Vec<Option<String>> =
        fetch_prior_attachment_batch(pool, ops, &del_att_idxs).await?;

    // ----- assemble per-op reverse payloads in input order ------------
    let mut result: Vec<OpPayload> = Vec::with_capacity(ops.len());
    let mut edit_cursor = 0usize;
    let mut move_cursor = 0usize;
    let mut set_cursor = 0usize;
    let mut del_cursor = 0usize;
    let mut att_cursor = 0usize;

    for (idx, ty) in parsed_types.iter().enumerate() {
        let record = &ops[idx];
        let reverse = match ty {
            OpType::CreateBlock => block_ops::reverse_create_block(record)?,
            OpType::DeleteBlock => block_ops::reverse_delete_block(pool, record)?,
            OpType::EditBlock => {
                let prior = edit_prior[edit_cursor].as_ref();
                edit_cursor += 1;
                build_reverse_edit_block(record, prior)?
            }
            OpType::MoveBlock => {
                let prior = move_prior[move_cursor].as_ref();
                move_cursor += 1;
                build_reverse_move_block(record, prior)?
            }
            OpType::AddTag => tag_ops::reverse_add_tag(record)?,
            OpType::RemoveTag => tag_ops::reverse_remove_tag(record)?,
            OpType::SetProperty => {
                let prior = set_prior[set_cursor].as_deref();
                set_cursor += 1;
                build_reverse_set_property(record, prior)?
            }
            OpType::DeleteProperty => {
                let prior = del_prior[del_cursor].as_deref();
                del_cursor += 1;
                build_reverse_delete_property(record, prior)?
            }
            OpType::AddAttachment => attachment_ops::reverse_add_attachment(record)?,
            OpType::RestoreBlock => block_ops::reverse_restore_block(record)?,
            OpType::DeleteAttachment => {
                let prior = att_prior[att_cursor].as_deref();
                att_cursor += 1;
                build_reverse_delete_attachment(record, prior)?
            }
            OpType::PurgeBlock => {
                return Err(AppError::NonReversible {
                    op_type: record.op_type.clone(),
                });
            }
        };
        result.push(reverse);
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// Per-op-type batch prior-context fetches.
//
// Each helper returns a Vec<Option<…>> aligned with the input `idxs`
// slice: position `i` in the return vec corresponds to the op at
// `ops[idxs[i]]`. None means "no prior row matched" — the assembly
// loop converts that to the same error shape the single-op
// `find_prior_*` helpers produce.
// ---------------------------------------------------------------------------

/// Batched `find_prior_text`: one UNION-ALL with one subquery per
/// op, returning (op_type, payload) of the most-recent matching row
/// strictly before `(created_at, seq)` for each block_id.
async fn fetch_prior_text_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
    idxs: &[usize],
) -> Result<Vec<Option<(String, String)>>, AppError> {
    if idxs.is_empty() {
        return Ok(Vec::new());
    }
    // Predicate per op (mirrors block_ops::find_prior_text):
    //   block_id = ?bid
    //   AND op_type IN ('edit_block','create_block')
    //   AND (created_at < ?ts OR (created_at = ?ts AND seq < ?seq))
    //   ORDER BY created_at DESC, seq DESC
    //   LIMIT 1
    // SQLite parses an `ORDER BY … LIMIT …` immediately after a
    // `UNION ALL` as belonging to the whole compound query, not to
    // the right-hand SELECT. Each per-op subquery is therefore
    // wrapped in `(SELECT … ORDER BY … LIMIT 1)` and lifted into a
    // surrounding `SELECT ? AS idx, op_type, payload FROM (…)` so the
    // ordering binds locally. Same shape applies to every per-type
    // batch fetch below.
    // C5 (#344): chunk so each UNION-ALL statement binds at most
    // `chunk_size * TEXT_BINDS_PER_OP ≤ MAX_SQL_PARAMS`. The bound `idx`
    // is the GLOBAL output position (`base + j`) so results map straight
    // back into `out` regardless of chunk boundaries.
    let chunk_size = MAX_SQL_PARAMS / TEXT_BINDS_PER_OP;
    let mut out: Vec<Option<(String, String)>> = vec![None; idxs.len()];
    for (chunk_no, chunk) in idxs.chunks(chunk_size).enumerate() {
        let base = chunk_no * chunk_size;
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("");
        for (j, &op_idx) in chunk.iter().enumerate() {
            let payload: EditBlockPayload = serde_json::from_str(&ops[op_idx].payload)?;
            let bid_upper = payload.block_id.as_str().to_ascii_uppercase();
            if j == 0 {
                qb.push("SELECT ");
            } else {
                qb.push(" UNION ALL SELECT ");
            }
            qb.push_bind((base + j) as i64);
            qb.push(
                " AS idx, op_type, payload FROM (SELECT op_type, payload FROM op_log WHERE block_id = ",
            );
            qb.push_bind(bid_upper);
            qb.push(" AND op_type IN ('edit_block','create_block') AND (created_at < ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" AND seq < ");
            qb.push_bind(ops[op_idx].seq);
            qb.push(")) ORDER BY created_at DESC, seq DESC LIMIT 1)");
        }
        let rows: Vec<(i64, String, String)> = qb.build_query_as().fetch_all(pool).await?;
        for (i, op_type, payload) in rows {
            let i = i as usize;
            if i < out.len() {
                out[i] = Some((op_type, payload));
            }
        }
    }
    Ok(out)
}

/// Batched `find_prior_position`: shape mirrors
/// [`fetch_prior_text_batch`] but filters
/// `op_type IN ('move_block','create_block')`.
async fn fetch_prior_position_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
    idxs: &[usize],
) -> Result<Vec<Option<(String, String)>>, AppError> {
    if idxs.is_empty() {
        return Ok(Vec::new());
    }
    // C5 (#344): chunked identically to `fetch_prior_text_batch`.
    let chunk_size = MAX_SQL_PARAMS / POSITION_BINDS_PER_OP;
    let mut out: Vec<Option<(String, String)>> = vec![None; idxs.len()];
    for (chunk_no, chunk) in idxs.chunks(chunk_size).enumerate() {
        let base = chunk_no * chunk_size;
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("");
        for (j, &op_idx) in chunk.iter().enumerate() {
            let payload: MoveBlockPayload = serde_json::from_str(&ops[op_idx].payload)?;
            let bid_upper = payload.block_id.as_str().to_ascii_uppercase();
            if j == 0 {
                qb.push("SELECT ");
            } else {
                qb.push(" UNION ALL SELECT ");
            }
            qb.push_bind((base + j) as i64);
            qb.push(
                " AS idx, op_type, payload FROM (SELECT op_type, payload FROM op_log WHERE block_id = ",
            );
            qb.push_bind(bid_upper);
            qb.push(" AND op_type IN ('move_block','create_block') AND (created_at < ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" AND seq < ");
            qb.push_bind(ops[op_idx].seq);
            qb.push(")) ORDER BY created_at DESC, seq DESC LIMIT 1)");
        }
        let rows: Vec<(i64, String, String)> = qb.build_query_as().fetch_all(pool).await?;
        for (i, op_type, payload) in rows {
            let i = i as usize;
            if i < out.len() {
                out[i] = Some((op_type, payload));
            }
        }
    }
    Ok(out)
}

/// Batched `find_prior_property`: scopes by (block_id, key) and the
/// strictly-before (ts, seq) predicate, inspecting the SINGLE
/// most-recent op touching (block, key) across BOTH the
/// `set_property` and `delete_property` op-types.
///
/// #181: the prior value of a property is whatever the most-recent op
/// touching (block, key) left it as — which may be a `delete_property`,
/// not just a `set_property`. Filtering on `set_property` alone ignores
/// an intervening delete. So this considers `op_type IN ('set_property',
/// 'delete_property')`, takes the single most-recent matching op, and:
///   * returns `Some(payload)` only when that op is a `set_property`
///     (the property's prior value);
///   * returns `None` when it is a `delete_property` (the property was
///     ABSENT immediately before the op being reversed) or when there is
///     no prior op at all.
///
/// This mirrors `property_ops::find_prior_property` byte-for-byte in
/// semantics; `None` means "prior absent" for both consumers.
///
/// The `key` is extracted from each op's payload — either an
/// `EditBlock`-style `SetPropertyPayload` (for the `set_property` op
/// type) or a `DeletePropertyPayload` (for `delete_property`); both
/// carry a `block_id` + `key` shape.
async fn fetch_prior_property_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
    idxs: &[usize],
) -> Result<Vec<Option<String>>, AppError> {
    if idxs.is_empty() {
        return Ok(Vec::new());
    }
    // C5 (#344): chunked so each UNION-ALL statement binds at most
    // `chunk_size * PROPERTY_BINDS_PER_OP ≤ MAX_SQL_PARAMS`. Only the
    // chunk loop is C5; the per-op predicate and the #181 set/delete
    // result interpretation below are the C4 (#343) logic, unchanged.
    let chunk_size = MAX_SQL_PARAMS / PROPERTY_BINDS_PER_OP;
    let mut out: Vec<Option<String>> = vec![None; idxs.len()];
    for (chunk_no, chunk) in idxs.chunks(chunk_size).enumerate() {
        let base = chunk_no * chunk_size;
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("");
        for (j, &op_idx) in chunk.iter().enumerate() {
            let record = &ops[op_idx];
            // Both SetPropertyPayload and DeletePropertyPayload carry a
            // (block_id, key) prefix; the cheaper path is to deserialize
            // into the smaller of the two (DeleteProperty) which ignores
            // the extra `value_*` fields under serde's default
            // behaviour. That keeps one shared helper across the two
            // op-types instead of two near-identical paths.
            let payload: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
            let bid_upper = payload.block_id.as_str().to_ascii_uppercase();
            if j == 0 {
                qb.push("SELECT ");
            } else {
                qb.push(" UNION ALL SELECT ");
            }
            qb.push_bind((base + j) as i64);
            qb.push(" AS idx, op_type, payload FROM (SELECT op_type, payload FROM op_log WHERE block_id = ");
            qb.push_bind(bid_upper);
            qb.push(" AND json_extract(payload, '$.key') = ");
            qb.push_bind(payload.key);
            qb.push(" AND op_type IN ('set_property', 'delete_property') AND (created_at < ");
            qb.push_bind(record.created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(record.created_at);
            qb.push(" AND seq < ");
            qb.push_bind(record.seq);
            qb.push(")) ORDER BY created_at DESC, seq DESC LIMIT 1)");
        }
        let rows: Vec<(i64, String, String)> = qb.build_query_as().fetch_all(pool).await?;
        for (i, op_type, payload) in rows {
            let i = i as usize;
            if i < out.len() {
                // #181: only a `set_property` carries a prior value; a
                // `delete_property` means the property was absent → None.
                if op_type == "set_property" {
                    out[i] = Some(payload);
                }
            }
        }
    }
    Ok(out)
}

/// Batched lookup for `reverse_delete_attachment`: scopes by
/// `attachment_id` (migration 0064 native column), filters
/// `op_type = 'add_attachment'`, and uses the same
/// strictly-before-(ts, seq) ordering as the rest.
async fn fetch_prior_attachment_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
    idxs: &[usize],
) -> Result<Vec<Option<String>>, AppError> {
    if idxs.is_empty() {
        return Ok(Vec::new());
    }
    // C5 (#344): chunked identically to the other prior-fetch helpers.
    let chunk_size = MAX_SQL_PARAMS / ATTACHMENT_BINDS_PER_OP;
    let mut out: Vec<Option<String>> = vec![None; idxs.len()];
    for (chunk_no, chunk) in idxs.chunks(chunk_size).enumerate() {
        let base = chunk_no * chunk_size;
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("");
        for (j, &op_idx) in chunk.iter().enumerate() {
            let record = &ops[op_idx];
            let payload: crate::op::DeleteAttachmentPayload =
                serde_json::from_str(&record.payload)?;
            let att_id = payload.attachment_id.as_str().to_string();
            if j == 0 {
                qb.push("SELECT ");
            } else {
                qb.push(" UNION ALL SELECT ");
            }
            qb.push_bind((base + j) as i64);
            qb.push(" AS idx, payload FROM (SELECT payload FROM op_log WHERE op_type = 'add_attachment' AND attachment_id = ");
            qb.push_bind(att_id);
            qb.push(" AND (created_at < ");
            qb.push_bind(record.created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(record.created_at);
            qb.push(" AND seq < ");
            qb.push_bind(record.seq);
            qb.push(")) ORDER BY created_at DESC, seq DESC LIMIT 1)");
        }
        let rows: Vec<(i64, String)> = qb.build_query_as().fetch_all(pool).await?;
        for (i, payload) in rows {
            let i = i as usize;
            if i < out.len() {
                out[i] = Some(payload);
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Reverse-payload assembly — these mirror the bodies of the per-op
// reverse fns in `block_ops`, `property_ops`, `attachment_ops` but
// take the prior context as a parameter instead of fetching it from
// the DB inline. Keep their behaviour byte-identical to the single-op
// paths; the parity test in `super::tests` is the regression oracle.
// ---------------------------------------------------------------------------

fn build_reverse_edit_block(
    record: &OpRecord,
    prior: Option<&(String, String)>,
) -> Result<OpPayload, AppError> {
    let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
    let (prior_op_type, prior_payload) = prior.ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior text found for block '{}' before ({}, {})",
            payload.block_id, record.device_id, record.seq
        ))
    })?;
    let prior_text = if prior_op_type == "edit_block" {
        let p: EditBlockPayload = serde_json::from_str(prior_payload)?;
        p.to_text
    } else {
        let p: CreateBlockPayload = serde_json::from_str(prior_payload)?;
        p.content
    };
    Ok(OpPayload::EditBlock(EditBlockPayload {
        block_id: payload.block_id,
        to_text: prior_text,
        prev_edit: Some((record.device_id.clone(), record.seq)),
    }))
}

fn build_reverse_move_block(
    record: &OpRecord,
    prior: Option<&(String, String)>,
) -> Result<OpPayload, AppError> {
    let payload: MoveBlockPayload = serde_json::from_str(&record.payload)?;
    let (prior_op_type, prior_payload) = prior.ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior position found for block '{}' before ({}, {})",
            payload.block_id, record.device_id, record.seq
        ))
    })?;
    let (old_parent, old_pos): (Option<BlockId>, i64) = if prior_op_type == "move_block" {
        let p: MoveBlockPayload = serde_json::from_str(prior_payload)?;
        (p.new_parent_id, p.new_position)
    } else {
        let p: CreateBlockPayload = serde_json::from_str(prior_payload)?;
        // BUG-26: positions are 1-based and `move_block_inner` rejects
        // 0. Ancient `create_block` payloads with `position = None`
        // cannot mint a valid reverse-move; mirror the per-op fallback
        // in `block_ops::find_prior_position` and surface
        // `NonReversible`.
        match p.position {
            Some(pos) => (p.parent_id, pos),
            None => {
                return Err(AppError::NonReversible {
                    op_type: "move_block".into(),
                });
            }
        }
    };
    Ok(OpPayload::MoveBlock(MoveBlockPayload {
        block_id: payload.block_id,
        new_parent_id: old_parent,
        new_position: old_pos,
    }))
}

fn build_reverse_set_property(
    record: &OpRecord,
    prior_payload: Option<&str>,
) -> Result<OpPayload, AppError> {
    let payload: SetPropertyPayload = serde_json::from_str(&record.payload)?;
    match prior_payload {
        Some(p_json) => {
            let p: SetPropertyPayload = serde_json::from_str(p_json)?;
            Ok(OpPayload::SetProperty(SetPropertyPayload {
                block_id: payload.block_id,
                key: payload.key,
                value_text: p.value_text,
                value_num: p.value_num,
                value_date: p.value_date,
                value_ref: p.value_ref,
                value_bool: p.value_bool,
            }))
        }
        None => Ok(OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: payload.block_id,
            key: payload.key,
        })),
    }
}

fn build_reverse_delete_property(
    record: &OpRecord,
    prior_payload: Option<&str>,
) -> Result<OpPayload, AppError> {
    let payload: DeletePropertyPayload = serde_json::from_str(&record.payload)?;
    let p_json = prior_payload.ok_or_else(|| {
        AppError::NotFound(format!(
            "no prior set_property found for block '{}' key '{}' — cannot reverse delete_property",
            payload.block_id, payload.key
        ))
    })?;
    let prior: SetPropertyPayload = serde_json::from_str(p_json)?;
    Ok(OpPayload::SetProperty(SetPropertyPayload {
        block_id: payload.block_id,
        key: payload.key,
        value_text: prior.value_text,
        value_num: prior.value_num,
        value_date: prior.value_date,
        value_ref: prior.value_ref,
        value_bool: prior.value_bool,
    }))
}

fn build_reverse_delete_attachment(
    _record: &OpRecord,
    prior_payload: Option<&str>,
) -> Result<OpPayload, AppError> {
    let p_json = prior_payload.ok_or(AppError::NonReversible {
        op_type: "delete_attachment".into(),
    })?;
    let add_payload: crate::op::AddAttachmentPayload = serde_json::from_str(p_json)?;
    Ok(OpPayload::AddAttachment(add_payload))
}

/// Batch-fetch op records by `(device_id, seq)` pairs in a single
/// UNION-ALL query. Returns records in the same order as the input
/// `refs` slice; missing rows surface as `AppError::NotFound` —
/// mirroring [`crate::op_log::get_op_by_seq`].
///
/// Used by `revert_ops_inner` so the batch undo path makes exactly
/// one round-trip to fetch all op records, replacing the prior
/// `for op in ops { get_op_by_seq(...) }` loop.
pub async fn get_op_records_batch(
    pool: &SqlitePool,
    refs: &[crate::op::OpRef],
) -> Result<Vec<OpRecord>, AppError> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    type Row = (
        i64,
        String,
        i64,
        Option<String>,
        String,
        String,
        String,
        i64,
        Option<String>,
    );
    // C5 (#344): chunk so each statement binds at most
    // `chunk_size * OP_RECORD_BINDS_PER_OP ≤ MAX_SQL_PARAMS`. The bound
    // `idx` is the GLOBAL `refs` position (`base + j`) so rows map back
    // into `out` regardless of chunk boundaries.
    let chunk_size = MAX_SQL_PARAMS / OP_RECORD_BINDS_PER_OP;
    let mut out: Vec<Option<OpRecord>> = vec![None; refs.len()];
    for (chunk_no, chunk) in refs.chunks(chunk_size).enumerate() {
        let base = chunk_no * chunk_size;
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("");
        for (j, r) in chunk.iter().enumerate() {
            if j == 0 {
                qb.push("SELECT ");
            } else {
                qb.push(" UNION ALL SELECT ");
            }
            qb.push_bind((base + j) as i64);
            qb.push(
                " AS idx, device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id FROM op_log WHERE device_id = ",
            );
            qb.push_bind(r.device_id.clone());
            qb.push(" AND seq = ");
            qb.push_bind(r.seq);
        }
        let rows: Vec<Row> = qb.build_query_as().fetch_all(pool).await?;
        for (idx, device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) in rows
        {
            let i = idx as usize;
            if i < out.len() {
                out[i] = Some(OpRecord {
                    device_id,
                    seq,
                    parent_seqs,
                    hash,
                    op_type,
                    payload,
                    created_at,
                    block_id,
                });
            }
        }
    }
    let mut result: Vec<OpRecord> = Vec::with_capacity(refs.len());
    for (i, slot) in out.into_iter().enumerate() {
        let r = slot.ok_or_else(|| {
            AppError::NotFound(format!("op_log ({}, {})", refs[i].device_id, refs[i].seq))
        })?;
        result.push(r);
    }
    Ok(result)
}
