//! CTE oracles for the engine's op-log DAG primitives, and the tests that
//! pair them against the production path (`tests.rs`, `proptest_b2.rs`).
//!
//! The reference implementations (`extract_prev_edit`,
//! `fetch_prev_edit_oracle`, `walk_edit_chain_oracle`, `find_lca_oracle`)
//! walk one `get_op_by_seq` per step; the tests run them alongside
//! [`agaric_engine::dag::walk_edit_chain`] / [`agaric_engine::dag::find_lca`]
//! on the same fixture and assert identical outputs. They sit in this crate,
//! not the engine, because the tests also need `insert_replicated_op` (#3120).

use agaric_engine::dag::{
    MAX_LCA_STEPS, WalkOutcome, append_merge_op, find_lca, get_block_edit_heads,
    has_merge_for_heads, insert_remote_op, parse_parent_seqs_canonical, text_at, walk_edit_chain,
};

use std::collections::HashSet;

use sqlx::SqlitePool;

use agaric_core::error::AppError;

use crate::sync_protocol::insert_replicated_op;

/// Oracle: extract the `prev_edit` pointer from an op record's payload.
///
/// - `edit_block` → returns `payload.prev_edit` (may be `None`)
/// - `create_block` → returns `None` (root of the edit chain)
/// - anything else → `AppError::InvalidOperation`
fn extract_prev_edit(
    record: &agaric_store::op_log::OpRecord,
) -> Result<Option<(String, i64)>, AppError> {
    match record.op_type.as_str() {
        "edit_block" => {
            let payload: agaric_store::op::EditBlockPayload =
                serde_json::from_str(&record.payload)?;
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
async fn fetch_prev_edit_oracle(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    has_snapshots: bool,
) -> Result<Option<(String, i64)>, AppError> {
    // I-Core-8: wrap to typed read-pool — caller is in write context
    match agaric_store::op_log::get_op_by_seq(
        &agaric_store::db::ReadPool(pool.clone()),
        device_id,
        seq,
    )
    .await
    {
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
/// production CTE path ([`agaric_engine::dag::walk_edit_chain`]) must match. Tests in
/// `dag/tests.rs::cte_oracle_*` run this alongside [`agaric_engine::dag::walk_edit_chain`] on the
/// same fixture and assert identical outputs.
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
/// [`agaric_engine::dag::find_lca`] on the same fixture and asserts the two return identical
/// `(device_id, seq)` results across linear chains, diverging chains,
/// and genesis-edit scenarios.
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

mod tests;

mod proptest_b2;
