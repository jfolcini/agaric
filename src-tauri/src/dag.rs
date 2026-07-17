//! DAG traversal primitives for the op log.
//!
//! ## #2621 inversion — core lives in `agaric-engine`
//!
//! The edit-chain / merge primitives over the op_log now live in
//! [`agaric_engine::dag`]: hash-verified remote-op ingest
//! ([`insert_remote_op`] + the audit-only [`ingest_replicated_record`]
//! entry), multi-parent merge-op creation ([`append_merge_op`]), the
//! recursive-CTE edit-chain walker ([`walk_edit_chain`] / [`WalkOutcome`] /
//! [`MAX_LCA_STEPS`]), Lowest-Common-Ancestor ([`find_lca`]), [`text_at`],
//! [`get_block_edit_heads`], [`has_merge_for_heads`], and the read-side
//! [`parse_parent_seqs_canonical`]. They build only on `agaric-store`
//! (`op` / `op_log` / `db`) and `agaric-core` (`hash` / `error`).
//!
//! This module keeps the two app-coupled pieces the engine cannot own:
//!
//! * [`insert_replicated_op`] — the wire-typed shim that decodes a
//!   [`crate::sync_protocol::types::OpTransfer`] (extracting the
//!   transfer-carried `origin`, which `OpRecord` does not surface) and calls
//!   the engine's [`ingest_replicated_record`] core. `sync_protocol` is an
//!   app-level module, so this thin adapter stays here while the verification
//!   core descends.
//! * The `#[cfg(test)]` CTE-oracle reference implementations
//!   ([`extract_prev_edit`], [`fetch_prev_edit_oracle`],
//!   [`walk_edit_chain_oracle`], [`find_lca_oracle`]) and the test modules
//!   (`dag/tests.rs`, `dag/proptest_b2.rs`). A `#[cfg(test)]` item in the
//!   engine crate is not visible to this crate's test build, so the oracles
//!   and the tests that pair them against the production CTE path live here,
//!   calling into the engine's `pub` surface.

pub use agaric_engine::dag::{
    MAX_LCA_STEPS, WalkOutcome, append_merge_op, find_lca, get_block_edit_heads,
    has_merge_for_heads, ingest_replicated_record, insert_remote_op, parse_parent_seqs_canonical,
    text_at, walk_edit_chain,
};

#[cfg(test)]
use std::collections::HashSet;

#[cfg(test)]
use sqlx::SqlitePool;

use crate::error::AppError;

/// #2481 phase 1 — ingest a replicated op record as append-only, hash-verified
/// **audit metadata**.
///
/// This is the app-level wire adapter for audit-only op-log replication
/// (`SyncMessage::OpLogBatch`). It decodes the [`crate::sync_protocol::types::OpTransfer`]
/// — threading the transfer-carried `origin` through explicitly, since
/// `OpRecord::from` drops it — then delegates to the engine core
/// [`ingest_replicated_record`], which reuses [`insert_remote_op`]'s exact
/// verification recipe (blake3 hash check, NUL-rejection gate, `SetProperty`
/// domain validation, idempotent `INSERT OR IGNORE` on `(device_id, seq)`,
/// divergence probe) under the audit parent-gap policy: an unresolved
/// `parent_seqs` pointer lands with a `warn!` breadcrumb instead of being
/// rejected, the row is stamped `is_replicated = 1`, and `origin` is preserved
/// verbatim.
///
/// The stored record is **never applied to state**: state flows exclusively
/// through Loro CRDT sync. The `is_replicated = 1` stamp keeps the row out of
/// boot replay (`recovery::replay`), the materializer apply pipeline, and the
/// apply-cursor bookkeeping — see migration 0099.
pub async fn insert_replicated_op(
    pool: &sqlx::SqlitePool,
    transfer: &crate::sync_protocol::types::OpTransfer,
) -> Result<bool, AppError> {
    // `OpRecord::from` drops the transfer-carried `origin` (OpRecord does not
    // surface it), so thread it through explicitly to the engine core.
    let origin = transfer.origin.clone();
    let record: crate::op_log::OpRecord = transfer.clone().into();
    ingest_replicated_record(pool, &record, &origin).await
}

// ---------------------------------------------------------------------------
// `#[cfg(test)]` CTE oracles — reference implementations paired against the
// engine's production CTE path in `dag/tests.rs`. Kept app-side because a
// `#[cfg(test)]` item in `agaric-engine` is invisible to this crate's tests.
// ---------------------------------------------------------------------------

/// Oracle: extract the `prev_edit` pointer from an op record's payload.
///
/// - `edit_block` → returns `payload.prev_edit` (may be `None`)
/// - `create_block` → returns `None` (root of the edit chain)
/// - anything else → `AppError::InvalidOperation`
#[cfg(test)]
fn extract_prev_edit(record: &crate::op_log::OpRecord) -> Result<Option<(String, i64)>, AppError> {
    match record.op_type.as_str() {
        "edit_block" => {
            let payload: crate::op::EditBlockPayload = serde_json::from_str(&record.payload)?;
            Ok(payload.prev_edit)
        }
        "create_block" => Ok(None),
        _ => Err(AppError::InvalidOperation(format!(
            "expected edit_block or create_block, got {}",
            record.op_type
        ))),
    }
}

/// Oracle: fetch the `prev_edit` pointer of `(device_id, seq)` via a fresh
/// `get_op_by_seq`, wrapping `NotFound` into the compaction-aware error
/// shape when snapshots exist.
#[cfg(test)]
async fn fetch_prev_edit_oracle(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    has_snapshots: bool,
) -> Result<Option<(String, i64)>, AppError> {
    // I-Core-8: wrap to typed read-pool — caller is in write context
    match crate::op_log::get_op_by_seq(&crate::db::ReadPool(pool.clone()), device_id, seq).await {
        Ok(record) => extract_prev_edit(&record),
        Err(AppError::NotFound(_)) if has_snapshots => Err(AppError::InvalidOperation(format!(
            "edit chain broken at ({device_id}, {seq}) — likely due to op log compaction; \
             LCA requires intact chains"
        ))),
        Err(e) => Err(e),
    }
}

/// Oracle: the original Rust walk, one `fetch_prev_edit_oracle` per step.
///
/// Retained under `#[cfg(test)]` as the reference implementation that the
/// production CTE path ([`walk_edit_chain`]) must match. Tests in
/// `dag/tests.rs::cte_oracle_*` run this alongside [`walk_edit_chain`] on the
/// same fixture and assert identical outputs.
#[cfg(test)]
async fn walk_edit_chain_oracle<F>(
    pool: &SqlitePool,
    start: &(String, i64),
    has_snapshots: bool,
    mut stop_at: F,
) -> Result<WalkOutcome, AppError>
where
    F: FnMut(&str, i64) -> bool,
{
    // Mirror the production walker's `(&str, i64)`
    // predicate signature. The oracle still walks one step at a time
    // (no batched CTE), so it cannot share the borrowed-`&str` visited
    // set without a lifetime headache for the per-iteration owned
    // payload — the `String` clones here are bounded by the oracle
    // being `#[cfg(test)]` only.
    let mut chain: Vec<(String, i64)> = Vec::new();
    let mut visited: HashSet<(String, i64)> = HashSet::new();
    visited.insert((start.0.clone(), start.1));

    let mut next: Option<(String, i64)> =
        fetch_prev_edit_oracle(pool, &start.0, start.1, has_snapshots).await?;
    let mut steps: usize = 0;
    while let Some(key) = next.take() {
        if stop_at(&key.0, key.1) {
            return Ok(WalkOutcome::Stopped(key));
        }
        if visited.contains(&key) {
            break;
        }
        steps += 1;
        if steps >= MAX_LCA_STEPS {
            return Err(AppError::InvalidOperation(format!(
                "find_lca exceeded max steps ({MAX_LCA_STEPS}) walking chain"
            )));
        }
        visited.insert(key.clone());
        chain.push(key);
        let last = chain.last().unwrap();
        next = fetch_prev_edit_oracle(pool, &last.0, last.1, has_snapshots).await?;
    }
    Ok(WalkOutcome::Completed(chain))
}

/// Oracle: `find_lca` built on the N+1 Rust walk [`walk_edit_chain_oracle`]
/// — the reference implementation replaced by the CTE-driven production
/// path for I-Core-2.
///
/// Kept under `#[cfg(test)]` per AGENTS.md "CTE oracle pattern". The
/// parity test in `dag/tests.rs::cte_oracle_*` runs this alongside
/// [`find_lca`] on the same fixture and asserts the two return identical
/// `(device_id, seq)` results across linear chains, diverging chains,
/// and genesis-edit scenarios.
#[cfg(test)]
pub async fn find_lca_oracle(
    pool: &SqlitePool,
    op_a: &(String, i64),
    op_b: &(String, i64),
) -> Result<Option<(String, i64)>, AppError> {
    let has_snapshots: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(pool)
            .await?;
    let has_snapshots = has_snapshots > 0;

    let chain_a = match walk_edit_chain_oracle(pool, op_a, has_snapshots, |_, _| false).await? {
        WalkOutcome::Completed(c) => c,
        WalkOutcome::Stopped(_) => unreachable!("chain A predicate never matches"),
    };

    let mut visited: HashSet<(&str, i64)> = HashSet::with_capacity(chain_a.len() + 1);
    visited.insert((&op_a.0, op_a.1));
    for (s, n) in &chain_a {
        visited.insert((s.as_str(), *n));
    }

    if visited.contains(&(op_b.0.as_str(), op_b.1)) {
        return Ok(Some(op_b.clone()));
    }

    match walk_edit_chain_oracle(pool, op_b, has_snapshots, |dev, seq| {
        visited.contains(&(dev, seq))
    })
    .await?
    {
        WalkOutcome::Stopped(key) => Ok(Some(key)),
        WalkOutcome::Completed(_) => Ok(None),
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests;

#[cfg(test)]
mod proptest_b2;
