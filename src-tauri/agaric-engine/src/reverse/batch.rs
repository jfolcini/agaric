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
//!
//! #3280: that contract was false on the `edit_block` arm for a long time,
//! and the oracle could not see it because every seeded payload used
//! `prev_edit: None` — the one shape where the pointer-first and
//! timestamp-scan kernels trivially agree, and a shape production never
//! produces. The DECISION now lives in exactly one place,
//! [`block_ops::resolve_prior_text`], which both kernels call; only the
//! plumbing that feeds it (per-op queries vs. prefetched UNION-ALL batches)
//! differs. When adding a new context-bearing op-type here, prefer sharing
//! the decision function with `block_ops`/`property_ops`/`attachment_ops`
//! over hand-copying it — and seed the oracle with a fixture that can
//! actually tell the two apart.
//!
//! The prior-state SQL predicates below are hand-copied from
//! [`agaric_store::op_log::latest_block_edit_before`] because batching N
//! lookups into one statement is this module's entire reason to exist; that
//! primitive is the source of truth for the per-variant provenance policy
//! (#2549/#3281/#3644) and the canonical `(created_at, seq, device_id)`
//! order (#382). Note the asymmetry it encodes and do NOT "tidy" it here:
//! the blind `fetch_prior_text_batch` walk carries `is_replicated = 0`,
//! while the anchored `fetch_prev_edit_rows_batch` pointer lookup carries
//! no provenance predicate at all.
//!
//! What actually holds the `edit_block` copies to the primitive — stated
//! precisely, because a vague "the oracle covers it" claim is the sin #3280
//! was filed about:
//!   * ABSENCE of an `is_replicated` predicate on
//!     `fetch_prev_edit_rows_batch` — the parity oracle (B3_PEER's edit
//!     points at a replicated audit row) and
//!     `undo_page_op_restores_peer_content_for_synced_block_3644`.
//!   * `is_replicated = 0` on `fetch_prior_text_batch` — the parity oracle
//!     (B3_BLK1 carries a replicated audit row that is the timestamp-newest
//!     candidate) and `revert_ops_restores_local_content_over_replicated_prior_2549`.
//!   * `ORDER BY created_at DESC, seq DESC` on `fetch_prior_text_batch` —
//!     the parity oracle (B3_BLK1 has two local candidates) and
//!     `compute_reverse_batch_chunks_large_edit_batch_c5`.
//!   * the `, device_id DESC` tie-break (#382) —
//!     `reverse_*_tie_breaks_on_device_id_3646` in `super::tests`, one per
//!     copy. Each seeds two op_log rows from different devices colliding on
//!     an identical `(created_at, seq)` and asserts BOTH kernels return the
//!     higher-`device_id` row, under BOTH write orders. Until #3646 seeded
//!     that collision no fixture anywhere produced one, so dropping
//!     `, device_id DESC` was invisible to the entire suite. Deleting it now
//!     reddens `fetch_prior_text_batch`, `fetch_prior_position_batch` and
//!     `fetch_prior_attachment_batch` (verified by mutation).
//!     `fetch_prior_property_batch` is the exception and NOT a gap: its
//!     predicate is served by `idx_op_log_block_key_created`
//!     (`block_id, json_extract(payload,'$.key'), created_at, seq,
//!     device_id`), whose own key order already ends in `device_id`, so the
//!     mutated statement returns the identical row — an equivalent mutant
//!     under today's schema, confirmed by `EXPLAIN QUERY PLAN`. The clause
//!     stays because it is the SPECIFICATION: change or drop that index and
//!     it becomes the only thing keeping the property scan deterministic.

use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use std::str::FromStr;

use super::{attachment_ops, block_ops, tag_ops};
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::MAX_SQL_PARAMS;
use agaric_store::op::{
    CreateBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    OpType, SetPropertyPayload,
};
use agaric_store::op_log::OpRecord;

// C5 (#344): per-op bind-parameter widths. Each batch helper builds a
// UNION-ALL with one subquery per op; to keep every executed statement
// under SQLite's `SQLITE_MAX_VARIABLE_NUMBER` we process `idxs` in
// chunks of `MAX_SQL_PARAMS / BINDS_PER_OP`. The widths below count the
// `push_bind` calls in each helper's per-op subquery. #382 added a
// `device_id` bind (and a second `seq` bind) to every prior-context
// predicate so the "strictly before" bound tie-breaks on the canonical
// `(created_at, seq, device_id)` total order — each width grew by 2:
//   * text / position: idx, block_id, created_at, created_at, seq, seq, device_id      → 7
//   * property:        idx, block_id, key, created_at, created_at, seq, seq, device_id → 8
//   * attachment:      idx, attachment_id, created_at, created_at, seq, seq, device_id → 7
//   * op-record fetch: idx, device_id, seq                                             → 3
// `MAX_SQL_PARAMS` is the crate-wide 999 bound from `agaric_store::db` (the
// same conservative `SQLITE_MAX_VARIABLE_NUMBER` floor the snapshot
// `batch_insert_snapshot_rows!` chunker uses) — well under the real
// 3.32+ limit of 32766, so the chunked statements never overflow.
const TEXT_BINDS_PER_OP: usize = 7;
const POSITION_BINDS_PER_OP: usize = 7;
const PROPERTY_BINDS_PER_OP: usize = 8;
const ATTACHMENT_BINDS_PER_OP: usize = 7;
const OP_RECORD_BINDS_PER_OP: usize = 3;
// #4259's live-row fetch is the one helper that is NOT a per-op UNION-ALL of
// `LIMIT 1` subqueries: it is a single PRIMARY-KEY `IN (...)` over
// `attachments`, so it binds exactly ONE parameter per op and maps rows back
// by `id` rather than by a bound input index. Declared AFTER the five widths
// above rather than between the bind-width block and the `MAX_SQL_PARAMS`
// paragraph, so that paragraph introduces the consts it actually describes
// (#4346).
const LIVE_ATTACHMENT_BINDS_PER_OP: usize = 1;

/// Op-types that a point-in-time restore treats as non-reversible
/// UNCONDITIONALLY, regardless of whether a per-op inverse could be
/// reconstructed.
///
/// `purge_block` has no inverse at all. `delete_attachment` is listed
/// here deliberately: even when its paired `add_attachment` still exists
/// (so `compute_reverse_batch` *could* synthesize an `AddAttachment`
/// inverse), a point-in-time restore must NOT resurrect attachment rows —
/// the established restore contract (pinned by
/// `restore_page_to_op_skips_delete_attachment` /
/// `restore_page_to_op_finds_delete_attachment_in_page_scope`) is to skip
/// and count them. This static set is the restore-scoped half of the
/// unified non-reversible contract; the dynamic half is
/// [`is_skippable_non_reversible`].
const STATIC_NON_REVERSIBLE_OP_TYPES: [&str; 2] = ["purge_block", "delete_attachment"];

/// Whether `op_type` is in [`STATIC_NON_REVERSIBLE_OP_TYPES`] — the
/// op-types a point-in-time restore skips on sight (#2020).
#[must_use]
pub fn is_statically_non_reversible(op_type: &str) -> bool {
    STATIC_NON_REVERSIBLE_OP_TYPES.contains(&op_type)
}

/// Classify whether an [`AppError`] surfaced by per-op reverse
/// computation means "this op cannot be reversed, but the batch may
/// continue without it" — as opposed to a fatal batch-level failure
/// (SQL error, malformed payload, unknown op type) that must abort.
///
/// This is the dynamic half of the shared non-reversible contract
/// between the reverse engine and its callers (`commands::history`): a
/// point-in-time restore SKIPS and COUNTS exactly the ops this returns
/// `true` for, while an interactive batch undo propagates them. Today
/// only [`AppError::NonReversible`] is skippable — it is emitted at
/// RUNTIME (not statically by op-type) by:
///   * the `purge_block` arm (no inverse exists at all),
///   * `delete_attachment` whose paired `add_attachment` is gone, and
///   * `move_block` whose only prior placement is an ancient
///     `create_block` with neither `index` nor `position`.
///
/// Centralizing the predicate here is what lets a restore skip the
/// dynamically-discovered non-reversible ops (a position-less
/// `move_block`, a `delete_attachment` with a missing add) that the old
/// static op-type list could never have caught — the bug behind #2020,
/// where the first such op aborted the entire restore.
#[must_use]
pub fn is_skippable_non_reversible(err: &AppError) -> bool {
    matches!(err, AppError::NonReversible { .. })
}

/// Batch-compute reverse payloads for a sequence of [`OpRecord`]s.
///
/// Returns reverses in the same order as the input. Mirrors the
/// match-arm dispatch of [`super::compute_reverse`] but folds the
/// per-op `find_prior_*` lookups into at most one UNION-ALL query per
/// op-type group.
///
/// # Per-op results vs. batch-level errors
///
/// Each output element is itself a `Result<OpPayload, AppError>`:
///   * `Ok(payload)` — the op's reverse payload.
///   * `Err(AppError::NonReversible { .. })` — the op has no inverse
///     (purge_block, an attachment restore whose `add_attachment` is
///     gone, a move-of-create missing position, or — #3280 — an
///     `edit_block` whose prior text cannot be reconstructed from either
///     its causal `prev_edit` pointer or the local timestamp scan).
///     Callers decide whether to SKIP (point-in-time restore) or abort
///     (interactive undo); see [`is_skippable_non_reversible`].
///
/// The OUTER `Result` is reserved for fatal batch-level failures that
/// abort the whole computation regardless of caller policy:
///   * `AppError::Validation` on unknown `op_type` strings.
///   * `AppError::NotFound` when an op's prior context is missing
///     (move_block, set_property, delete_property arms). #3280 moved the
///     `edit_block` arm OFF this list: a peer-originated block has no
///     local prior text at all, so a fatal error there aborted entire
///     restores that had explicitly asked to skip non-reversible ops.
///   * `serde_json::Error` (via `From`) for malformed payloads, and any
///     SQL error from the prior-context prefetch.
///
/// An empty input slice returns `Ok(Vec::new())`.
pub async fn compute_reverse_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
) -> Result<Vec<Result<OpPayload, AppError>>, AppError> {
    if ops.is_empty() {
        return Ok(Vec::new());
    }

    // Parse op types once. `OpType::from_str` is a manual match — no
    // serde overhead — so this is cheap and lets the dispatch below
    // be a typed match against `OpType` instead of a string compare.
    let mut parsed_types: Vec<OpType> = Vec::with_capacity(ops.len());
    for r in ops {
        let t = OpType::from_str(&r.op_type)
            .map_err(|e| AppError::validation(format!("unknown op_type in record: {e}")))?;
        parsed_types.push(t);
    }

    // Bucket op indices by the prior-context query they need. Op
    // types whose reverse is a pure payload transform (CreateBlock,
    // DeleteBlock, AddTag, RemoveTag, RestoreBlock, PurgeBlock) do not
    // appear in any bucket — they are handled by the synchronous
    // fallback at the bottom. #4259 moved `AddAttachment` OFF that list:
    // its reverse now describes the LIVE `attachments` row, so it needs
    // a DB read like the context-bearing types do.
    let mut edit_idxs: Vec<usize> = Vec::new();
    let mut move_idxs: Vec<usize> = Vec::new();
    let mut set_prop_idxs: Vec<usize> = Vec::new();
    let mut del_prop_idxs: Vec<usize> = Vec::new();
    let mut del_att_idxs: Vec<usize> = Vec::new();
    let mut add_att_idxs: Vec<usize> = Vec::new();

    for (idx, ty) in parsed_types.iter().enumerate() {
        match ty {
            OpType::EditBlock => edit_idxs.push(idx),
            OpType::MoveBlock => move_idxs.push(idx),
            OpType::SetProperty => set_prop_idxs.push(idx),
            OpType::DeleteProperty => del_prop_idxs.push(idx),
            OpType::DeleteAttachment => del_att_idxs.push(idx),
            OpType::AddAttachment => add_att_idxs.push(idx),
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

    // #3280: resolve every `edit_block`'s CAUSAL pointer
    // (`payload.prev_edit`) in one additional PK-keyed fetch, so the batch
    // kernel can honour the same #1526 precedence as the single-op kernel
    // instead of implementing only the timestamp fallback. `edit_prior`
    // stays: it IS that fallback, used whenever the pointer does not
    // resolve — and #3650 made the pointer fetch run FIRST so the fallback
    // scan can be narrowed to the ops that actually need it.
    let edit_prev: Vec<Option<(String, String)>> =
        fetch_prev_edit_rows_batch(pool, ops, &edit_idxs).await?;
    let edit_prior: Vec<Option<(String, String)>> =
        fetch_prior_text_fallback_only(pool, ops, &edit_idxs, &edit_prev).await?;
    let move_prior: Vec<Option<(String, String)>> =
        fetch_prior_position_batch(pool, ops, &move_idxs).await?;
    let set_prior: Vec<Option<String>> =
        fetch_prior_property_batch(pool, ops, &set_prop_idxs).await?;
    let del_prior: Vec<Option<String>> =
        fetch_prior_property_batch(pool, ops, &del_prop_idxs).await?;
    let att_prior: Vec<Option<String>> =
        fetch_prior_attachment_batch(pool, ops, &del_att_idxs).await?;
    // #4259: the LIVE `attachments` row behind each `add_attachment`, so the
    // batch twin mints the same synthetic `delete_attachment` the single-op
    // kernel does. Both go through `attachment_ops::build_reverse_add_attachment`,
    // so there is one implementation to keep correct rather than two.
    let add_att_live: Vec<Option<attachment_ops::LiveAttachmentState>> =
        fetch_live_attachment_state_batch(pool, ops, &add_att_idxs).await?;

    // ----- assemble per-op reverse payloads in input order ------------
    //
    // Each arm yields a `Result<OpPayload, AppError>`. A skippable
    // `NonReversible` (per `is_skippable_non_reversible`) is pushed as an
    // inner `Err` so the caller can SKIP+COUNT that single op; every
    // other error (serde, NotFound prior-context, unknown variant) is a
    // fatal batch-level failure surfaced via `?` to abort the whole
    // computation — matching the single-op `super::compute_reverse`
    // contract for those cases.
    let mut result: Vec<Result<OpPayload, AppError>> = Vec::with_capacity(ops.len());
    let mut edit_cursor = 0usize;
    let mut move_cursor = 0usize;
    let mut set_cursor = 0usize;
    let mut del_cursor = 0usize;
    let mut att_cursor = 0usize;
    let mut add_att_cursor = 0usize;

    for (idx, ty) in parsed_types.iter().enumerate() {
        let record = &ops[idx];
        let reverse: Result<OpPayload, AppError> = match ty {
            OpType::CreateBlock => block_ops::reverse_create_block(record),
            OpType::DeleteBlock => block_ops::reverse_delete_block(record),
            OpType::EditBlock => {
                let prev_row = edit_prev[edit_cursor].as_ref();
                let prior = edit_prior[edit_cursor].as_ref();
                edit_cursor += 1;
                build_reverse_edit_block(record, prev_row, prior)
            }
            OpType::MoveBlock => {
                let prior = move_prior[move_cursor].as_ref();
                move_cursor += 1;
                build_reverse_move_block(record, prior)
            }
            OpType::AddTag => tag_ops::reverse_add_tag(record),
            OpType::RemoveTag => tag_ops::reverse_remove_tag(record),
            OpType::SetProperty => {
                let prior = set_prior[set_cursor].as_deref();
                set_cursor += 1;
                build_reverse_set_property(record, prior)
            }
            OpType::DeleteProperty => {
                let prior = del_prior[del_cursor].as_deref();
                del_cursor += 1;
                build_reverse_delete_property(record, prior)
            }
            OpType::AddAttachment => {
                let live = add_att_live[add_att_cursor].as_ref();
                add_att_cursor += 1;
                attachment_ops::build_reverse_add_attachment(record, live)
            }
            OpType::RestoreBlock => block_ops::reverse_restore_block(record),
            OpType::DeleteAttachment => {
                let prior = att_prior[att_cursor].as_deref();
                att_cursor += 1;
                build_reverse_delete_attachment(record, prior)
            }
            OpType::RenameAttachment => attachment_ops::reverse_rename_attachment(record),
            OpType::PurgeBlock => Err(AppError::NonReversible {
                op_type: record.op_type.clone(),
            }),
        };
        match reverse {
            Ok(payload) => result.push(Ok(payload)),
            // Skippable: hand the caller the per-op error to SKIP+COUNT.
            Err(e) if is_skippable_non_reversible(&e) => result.push(Err(e)),
            // Fatal: abort the whole batch (mirrors single-op `?`).
            Err(e) => return Err(e),
        }
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

/// Batched `op_log::resolve_prev_edit_target`: one UNION-ALL keyed on the
/// op_log PRIMARY KEY `(device_id, seq)`, resolving the `prev_edit` pointer
/// of every `edit_block` in the batch. #3280.
///
/// Output is aligned with `idxs`. An entry is `None` when the op carried no
/// pointer at all or when the pointed-at row is gone (op-log compaction) —
/// the two cases `block_ops::resolve_prior_text` treats alike by falling
/// back to the timestamp scan. Mirrors the single-op
/// `resolve_prev_edit_target`, INCLUDING its deliberate absence of an
/// `is_replicated` predicate (#3644 — see that function for why the pointer
/// path and the blind scan differ).
///
/// Cheaper than the sibling `fetch_prior_*` fetches: a PK lookup returns at
/// most one row, so no per-op `ORDER BY … LIMIT 1` subquery wrapper is
/// needed, and ops with no pointer are skipped entirely.
async fn fetch_prev_edit_rows_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
    idxs: &[usize],
) -> Result<Vec<Option<(String, String)>>, AppError> {
    let mut out: Vec<Option<(String, String)>> = vec![None; idxs.len()];
    if idxs.is_empty() {
        return Ok(out);
    }

    // The bound `idx` is the position within `idxs` (i.e. within `out`), so
    // rows map straight back regardless of chunk boundaries.
    let mut wanted: Vec<(usize, String, i64)> = Vec::new();
    for (j, &op_idx) in idxs.iter().enumerate() {
        let payload: EditBlockPayload = serde_json::from_str(&ops[op_idx].payload)?;
        if let Some((prev_device, prev_seq)) = payload.prev_edit {
            wanted.push((j, prev_device, prev_seq));
        }
    }
    if wanted.is_empty() {
        return Ok(out);
    }

    // C5 (#344): same (idx, device_id, seq) bind width as
    // `get_op_records_batch`, so the same chunk size applies.
    let chunk_size = MAX_SQL_PARAMS / OP_RECORD_BINDS_PER_OP;
    for chunk in wanted.chunks(chunk_size) {
        let mut qb: QueryBuilder<Sqlite> = QueryBuilder::new("");
        for (j, (pos, prev_device, prev_seq)) in chunk.iter().enumerate() {
            if j == 0 {
                qb.push("SELECT ");
            } else {
                qb.push(" UNION ALL SELECT ");
            }
            qb.push_bind(*pos as i64);
            qb.push(" AS idx, op_type, payload FROM op_log WHERE device_id = ");
            qb.push_bind(prev_device.clone());
            qb.push(" AND seq = ");
            qb.push_bind(*prev_seq);
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

/// [`fetch_prior_text_batch`], restricted to the ops whose causal
/// `prev_edit` pointer did NOT resolve. #3650.
///
/// # Perf short-circuit ONLY
///
/// [`block_ops::resolve_prior_text`] IGNORES the timestamp fallback whenever
/// the causal pointer resolved, so not fetching it for those ops cannot
/// change the answer — it just avoids a UNION-ALL round trip the batch path
/// would otherwise pay on every restore. This mirrors the identical
/// short-circuit the single-op kernel already carries in
/// [`block_ops::reverse_edit_block`], and rests on the same invariant: a
/// resolved pointer WINS, and the discarded fallback is unobservable.
///
/// If the batch fallback is ever made load-bearing when a pointer resolves —
/// e.g. a future "compare the two sources and prefer X" policy — this
/// optimisation becomes a CORRECTNESS bug, not a perf regression. Change
/// `resolve_prior_text` and this function together, and the single-op
/// short-circuit with them.
///
/// `find_prev_edit_in_tx` stamps a pointer on every local edit, so the
/// common case is that every pointer resolves, `fallback_at` is empty and
/// the query is skipped entirely. The residue is the shapes
/// `resolve_prior_text` documents: no pointer at all (pre-#1526 ops) or a
/// pointer whose target is gone to op-log compaction.
///
/// Output is aligned with `idxs`, exactly as [`fetch_prior_text_batch`]'s
/// is. The positions that were not fetched stay `None` — the value
/// `resolve_prior_text` would have discarded for them anyway.
async fn fetch_prior_text_fallback_only(
    pool: &SqlitePool,
    ops: &[OpRecord],
    idxs: &[usize],
    prev_rows: &[Option<(String, String)>],
) -> Result<Vec<Option<(String, String)>>, AppError> {
    let mut out: Vec<Option<(String, String)>> = vec![None; idxs.len()];
    // Positions WITHIN `idxs` (equivalently within `out`) whose pointer did
    // not resolve — the only ops the fallback scan is asked about.
    let fallback_at: Vec<usize> = prev_rows
        .iter()
        .enumerate()
        .filter_map(|(j, prev)| prev.is_none().then_some(j))
        .collect();
    if fallback_at.is_empty() {
        return Ok(out);
    }
    let fallback_idxs: Vec<usize> = fallback_at.iter().map(|&j| idxs[j]).collect();
    let fetched = fetch_prior_text_batch(pool, ops, &fallback_idxs).await?;
    for (&j, row) in fallback_at.iter().zip(fetched) {
        out[j] = row;
    }
    Ok(out)
}

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
    // Predicate per op (mirrors block_ops::find_prior_text). #382: the
    // tie-break is the canonical `(created_at, seq, device_id)` total
    // order, so the bound carries `device_id` too:
    //   block_id = ?bid
    //   AND op_type IN ('edit_block','create_block')
    //   AND (created_at < ?ts
    //        OR (created_at = ?ts
    //            AND (seq < ?seq OR (seq = ?seq AND device_id < ?dev))))
    //   ORDER BY created_at DESC, seq DESC, device_id DESC
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
            // #2549: `AND is_replicated = 0` — walk back only into
            // locally-applied ops; a #2495 audit-only replicated row was never
            // applied to local state (mirrors `block_ops::find_prior_text`).
            qb.push(" AND op_type IN ('edit_block','create_block') AND is_replicated = 0 AND (created_at < ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" AND (seq < ");
            qb.push_bind(ops[op_idx].seq);
            qb.push(" OR (seq = ");
            qb.push_bind(ops[op_idx].seq);
            qb.push(" AND device_id < ");
            qb.push_bind(ops[op_idx].device_id.clone());
            qb.push(")))) ORDER BY created_at DESC, seq DESC, device_id DESC LIMIT 1)");
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
            // #2549: `AND is_replicated = 0` — mirrors
            // `block_ops::find_prior_position`; never-applied audit rows (#2495)
            // must not seed a restored slot.
            qb.push(" AND op_type IN ('move_block','create_block') AND is_replicated = 0 AND (created_at < ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(ops[op_idx].created_at);
            qb.push(" AND (seq < ");
            qb.push_bind(ops[op_idx].seq);
            qb.push(" OR (seq = ");
            qb.push_bind(ops[op_idx].seq);
            qb.push(" AND device_id < ");
            qb.push_bind(ops[op_idx].device_id.clone());
            qb.push(")))) ORDER BY created_at DESC, seq DESC, device_id DESC LIMIT 1)");
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
            // #2549: `AND is_replicated = 0` — mirrors
            // `property_ops::find_prior_property`; a never-applied audit row
            // (#2495) must not resurrect a property value.
            qb.push(" AND op_type IN ('set_property', 'delete_property') AND is_replicated = 0 AND (created_at < ");
            qb.push_bind(record.created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(record.created_at);
            qb.push(" AND (seq < ");
            qb.push_bind(record.seq);
            qb.push(" OR (seq = ");
            qb.push_bind(record.seq);
            qb.push(" AND device_id < ");
            qb.push_bind(record.device_id.clone());
            qb.push(")))) ORDER BY created_at DESC, seq DESC, device_id DESC LIMIT 1)");
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
            let payload: agaric_store::op::DeleteAttachmentPayload =
                serde_json::from_str(&record.payload)?;
            let att_id = payload.attachment_id.as_str().to_string();
            if j == 0 {
                qb.push("SELECT ");
            } else {
                qb.push(" UNION ALL SELECT ");
            }
            qb.push_bind((base + j) as i64);
            // #2549: `AND is_replicated = 0` — mirrors
            // `attachment_ops::reverse_delete_attachment`; a never-applied audit
            // row (#2495) must not source the restored `add_attachment`.
            qb.push(" AS idx, payload FROM (SELECT payload FROM op_log WHERE op_type = 'add_attachment' AND is_replicated = 0 AND attachment_id = ");
            qb.push_bind(att_id);
            qb.push(" AND (created_at < ");
            qb.push_bind(record.created_at);
            qb.push(" OR (created_at = ");
            qb.push_bind(record.created_at);
            qb.push(" AND (seq < ");
            qb.push_bind(record.seq);
            qb.push(" OR (seq = ");
            qb.push_bind(record.seq);
            qb.push(" AND device_id < ");
            qb.push_bind(record.device_id.clone());
            qb.push(")))) ORDER BY created_at DESC, seq DESC, device_id DESC LIMIT 1)");
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

/// Batched live-row read for `reverse_add_attachment` (#4259): the current
/// `attachments.fs_path` / `.filename` of every `add_attachment` in the batch.
///
/// Unlike its siblings this is NOT a UNION-ALL of `LIMIT 1` prior-context
/// subqueries — there is no history to walk, only the row as it stands right
/// now — so it is one PRIMARY-KEY `IN (...)` per chunk, mapped back by `id`.
/// Mapping by `id` rather than by a bound input index is also what makes a
/// batch containing the SAME `attachment_id` twice (an add, undone and redone,
/// reverted again in one sweep) resolve every occurrence to the same row
/// instead of only the first. #4346 seeded the fixture that holds that: the
/// duplicate-id pair inside `tests/reverse_tests.rs::compute_reverse_batch_matches_per_op_loop`.
/// Until it existed, every `add_attachment` in every fixture carried a
/// DISTINCT id, so a regression from this by-id remap back to index-based
/// mapping reddened nothing in the suite.
///
/// # Two things this does twice, deliberately (#4346)
///
/// Each op's payload is deserialized here to extract its `attachment_id`, and
/// again in [`attachment_ops::build_reverse_add_attachment`] during assembly;
/// each live `fs_path` / `filename` is materialized into the id map and cloned
/// out of it per occurrence. Both are the shape every sibling prefetch in this
/// module already has — the prefetch reads what it needs to build its
/// statement, the kernel reads the record it is handed — and collapsing either
/// would mean threading a parsed payload (or a borrow of the map) through the
/// shared single-op/batch kernel boundary that exists precisely so the two
/// cannot drift. Recorded as a known cost, not a defect: the batch is capped
/// at `MAX_REVERT_OPS` (1000), so the duplicated work is bounded and small.
///
/// An entry is `None` when no row with that id exists — a legitimate,
/// reachable state, not an error; see
/// [`attachment_ops::build_reverse_add_attachment`] for the fallback it takes.
///
/// Deliberately NOT filtered on `deleted_at IS NULL`: nothing in production
/// writes `attachments.deleted_at` today, and the single-op kernel's
/// `SELECT ... WHERE id = ?` does not filter either. The two must observe the
/// same row or the B-3 parity oracle is comparing different questions.
async fn fetch_live_attachment_state_batch(
    pool: &SqlitePool,
    ops: &[OpRecord],
    idxs: &[usize],
) -> Result<Vec<Option<attachment_ops::LiveAttachmentState>>, AppError> {
    if idxs.is_empty() {
        return Ok(Vec::new());
    }
    // Parse each op's attachment id once, in input order.
    let mut att_ids: Vec<String> = Vec::with_capacity(idxs.len());
    for &op_idx in idxs {
        let payload: agaric_store::op::AddAttachmentPayload =
            serde_json::from_str(&ops[op_idx].payload)?;
        att_ids.push(payload.attachment_id.as_str().to_string());
    }

    // C5 (#344): chunked like every other batch helper, at this helper's own
    // (narrower) per-op bind width.
    let chunk_size = MAX_SQL_PARAMS / LIVE_ATTACHMENT_BINDS_PER_OP;
    let mut by_id: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();
    for chunk in att_ids.chunks(chunk_size) {
        let mut qb: QueryBuilder<Sqlite> =
            QueryBuilder::new("SELECT id, fs_path, filename FROM attachments WHERE id IN (");
        let mut separated = qb.separated(", ");
        for id in chunk {
            separated.push_bind(id.clone());
        }
        qb.push(")");
        let rows: Vec<(String, String, String)> = qb.build_query_as().fetch_all(pool).await?;
        for (id, fs_path, filename) in rows {
            by_id.insert(id, (fs_path, filename));
        }
    }

    Ok(att_ids
        .iter()
        .map(|id| {
            by_id
                .get(id)
                .map(|(fs_path, filename)| attachment_ops::LiveAttachmentState {
                    fs_path: fs_path.clone(),
                    filename: filename.clone(),
                })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Reverse-payload assembly — these mirror the bodies of the per-op
// reverse fns in `block_ops`, `property_ops`, `attachment_ops` but
// take the prior context as a parameter instead of fetching it from
// the DB inline. Keep their behaviour byte-identical to the single-op
// paths; the parity test in `super::tests` is the regression oracle.
// ---------------------------------------------------------------------------

/// #3280: goes through the SAME [`block_ops::resolve_prior_text`] decision as
/// the single-op kernel. `prev_row` is this op's resolved `prev_edit` target
/// (prefetched by [`fetch_prev_edit_rows_batch`]); `prior` is the
/// timestamp-ordered fallback. Previously this arm implemented the fallback
/// only — it never read `payload.prev_edit`, though it still wrote one onto
/// the reverse it produced.
fn build_reverse_edit_block(
    record: &OpRecord,
    prev_row: Option<&(String, String)>,
    prior: Option<&(String, String)>,
) -> Result<OpPayload, AppError> {
    let payload: EditBlockPayload = serde_json::from_str(&record.payload)?;
    let prev_ptr = payload
        .prev_edit
        .as_ref()
        .map(|(device, seq)| (device.as_str(), *seq));
    let prior_text =
        block_ops::resolve_prior_text(prev_row.zip(prev_ptr), prior)?.ok_or_else(|| {
            // #3280: NOT `NotFound`. Neither source could reconstruct a prior
            // text — the normal case for the first local edit of a
            // peer-originated block, whose only op_log row is a replicated audit
            // row. `is_skippable_non_reversible` matches only `NonReversible`, so
            // a `NotFound` here took `compute_reverse_batch`'s fatal arm and
            // aborted the ENTIRE restore with no partial progress, even under
            // `skip_non_reversible = true` — exactly the #2020 failure mode that
            // predicate was written to prevent.
            AppError::NonReversible {
                op_type: record.op_type.clone(),
            }
        })?;
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
    // #400: restore the prior sibling slot. New-scheme prior ops carry a 0-based
    // index; pre-#400 ops carry a 1-based position. `(parent, index, position)`.
    let (old_parent, old_index, old_pos): (Option<BlockId>, Option<i64>, Option<i64>) =
        if prior_op_type == "move_block" {
            let p: MoveBlockPayload = serde_json::from_str(prior_payload)?;
            (p.new_parent_id, p.new_index, Some(p.new_position))
        } else {
            let p: CreateBlockPayload = serde_json::from_str(prior_payload)?;
            // Ancient `create_block` payloads predate the position wire
            // field (both `index` and `position` absent) → no valid reverse-move;
            // mirror `block_ops::find_prior_position` and surface `NonReversible`.
            match (p.index, p.position) {
                (Some(idx), _) => (p.parent_id, Some(idx), None),
                (None, Some(pos)) => (p.parent_id, None, Some(pos)),
                (None, None) => {
                    return Err(AppError::NonReversible {
                        op_type: "move_block".into(),
                    });
                }
            }
        };
    let (new_position, new_index) = match old_index {
        Some(idx) => (
            agaric_store::pagination::index_to_provisional_position(idx),
            Some(idx),
        ),
        None => (old_pos.unwrap_or(1), None),
    };
    Ok(OpPayload::MoveBlock(MoveBlockPayload {
        block_id: payload.block_id,
        new_parent_id: old_parent,
        new_position,
        new_index,
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

/// Batch twin of [`attachment_ops::reverse_delete_attachment`]. Keep the two
/// byte-identical — `compute_reverse_batch_matches_per_op_loop` in
/// `super::tests` is the oracle: its fixture seeds each `delete_attachment`
/// with BOTH a different `fs_path` (#3706 review) and a different `filename`
/// (#4262) from the matching `add_attachment`, so a twin that fails to adopt
/// the delete-time value of either field — or adopts the wrong one — makes
/// `batched` disagree with `legacy` there. Absolute pins on the batched
/// `fs_path` and `filename` in that same test additionally catch a regression
/// shared by both twins (e.g. in the `adopt_delete_time_state` helper they
/// both call), which the parity comparison alone cannot see.
///
/// `record` is the `delete_attachment` being reversed; its payload carries the
/// `fs_path` and `filename` the row held at delete time, which
/// [`attachment_ops::adopt_delete_time_state`] prefers over the original
/// `add_attachment`'s (#3706 review / #4262 — see that function for why).
/// Note it takes the whole delete payload rather than one field at a time:
/// that is what makes "both twins adopt the same set of fields" a property of
/// the type rather than of two call sites remembering to stay in step.
fn build_reverse_delete_attachment(
    record: &OpRecord,
    prior_payload: Option<&str>,
) -> Result<OpPayload, AppError> {
    let p_json = prior_payload.ok_or(AppError::NonReversible {
        op_type: "delete_attachment".into(),
    })?;
    let mut add_payload: agaric_store::op::AddAttachmentPayload = serde_json::from_str(p_json)?;
    let delete_payload: agaric_store::op::DeleteAttachmentPayload =
        serde_json::from_str(&record.payload)?;
    attachment_ops::adopt_delete_time_state(&delete_payload, &mut add_payload);
    Ok(OpPayload::AddAttachment(add_payload))
}

/// Batch-fetch op records by `(device_id, seq)` pairs in a single
/// UNION-ALL query. Returns records in the same order as the input
/// `refs` slice; missing rows surface as `AppError::NotFound` —
/// mirroring [`agaric_store::op_log::get_op_by_seq`].
///
/// Used by `revert_ops_inner` so the batch undo path makes exactly
/// one round-trip to fetch all op records, replacing the prior
/// `for op in ops { get_op_by_seq(...) }` loop.
pub async fn get_op_records_batch(
    pool: &SqlitePool,
    refs: &[agaric_store::op::OpRef],
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

/// #2549: refuse to revert a REPLICATED audit op.
///
/// Replicated rows (`is_replicated = 1`; #2481/#2495) are ingested for
/// provenance only and are NEVER applied to local state. Applying the inverse
/// of such an op would corrupt local state by "undoing" a forward effect that
/// never happened on this device — the same never-applied-row hazard the
/// `find_prior_*` prior-state walks guard against, but for the revert TARGET
/// itself. `revert_ops` accepts arbitrary `OpRef`s from the front-end, so this
/// is the choke point that rejects a replicated target with a `Validation`
/// error before any reverse is computed or applied.
///
/// Bounded by `MAX_REVERT_OPS` at the caller; chunked at
/// `MAX_SQL_PARAMS / 2` (`device_id` + `seq` per ref) so the OR-of-pairs
/// predicate never overflows SQLite's bind limit.
pub async fn reject_replicated_targets(
    pool: &SqlitePool,
    refs: &[agaric_store::op::OpRef],
) -> Result<(), AppError> {
    if refs.is_empty() {
        return Ok(());
    }
    // 2 binds per ref: (device_id, seq).
    let chunk_size = MAX_SQL_PARAMS / 2;
    for chunk in refs.chunks(chunk_size) {
        let mut qb: QueryBuilder<Sqlite> =
            QueryBuilder::new("SELECT device_id, seq FROM op_log WHERE is_replicated = 1 AND (");
        for (j, r) in chunk.iter().enumerate() {
            if j > 0 {
                qb.push(" OR ");
            }
            qb.push("(device_id = ");
            qb.push_bind(r.device_id.clone());
            qb.push(" AND seq = ");
            qb.push_bind(r.seq);
            qb.push(")");
        }
        qb.push(") LIMIT 1");
        let hit: Option<(String, i64)> = qb.build_query_as().fetch_optional(pool).await?;
        if let Some((device_id, seq)) = hit {
            return Err(AppError::validation(format!(
                "cannot revert op ({device_id}, {seq}): it is a replicated audit op \
                 (never applied to local state) and has no local forward effect to undo"
            )));
        }
    }
    Ok(())
}
