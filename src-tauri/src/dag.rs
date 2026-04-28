//! DAG traversal primitives for the op log.
//!
//! Building blocks for the merge system (Wave 1B). Provides:
//! - Remote op insertion with hash verification
//! - Merge op creation with multi-parent parent_seqs
//! - Lowest Common Ancestor (LCA) for edit chains
//! - Text extraction at a given op
//! - Edit head discovery across devices
use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::hash::{compute_op_hash, verify_op_hash};
use crate::op::*;
use crate::op_log::{
    extract_block_id_from_payload, get_op_by_seq, serialize_inner_payload, OpRecord,
};

/// M-4: hard cap on the number of `prev_edit` chain steps `find_lca` will
/// walk before giving up.  ARCHITECTURE.md §4 documents this 10,000-step
/// cap as the cycle-detection ceiling; the constant turns the
/// HashSet-only check into a true fail-fast ceiling so a pathologically
/// long acyclic chain (corruption, future schema bug) can never issue an
/// unbounded number of `get_op_by_seq` writer-pool acquires.
const MAX_LCA_STEPS: usize = 10_000;

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

/// Outcome of a single edit-chain walk.
enum WalkOutcome {
    /// Walked the chain to its root (or terminated on a local cycle).
    /// The returned `Vec` does **not** include the original `start` key —
    /// only its ancestors, in walk order.
    Completed(Vec<(String, i64)>),
    /// The `stop_at` predicate matched on this key — the walk halted
    /// before reaching the root.
    Stopped((String, i64)),
}

/// Fetch the `prev_edit` pointer of `(device_id, seq)`.
///
/// When `has_snapshots` is true and the row is missing, treat the absence
/// as compaction-induced chain breakage and surface a clear
/// [`AppError::InvalidOperation`] instead of the bare `NotFound` —
/// otherwise propagate the original error.  Used by [`walk_edit_chain`]
/// as the per-step lookup primitive so the compaction-aware error
/// message lives in exactly one place.
async fn fetch_prev_edit(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    has_snapshots: bool,
) -> Result<Option<(String, i64)>, AppError> {
    match get_op_by_seq(pool, device_id, seq).await {
        Ok(record) => extract_prev_edit(&record),
        Err(AppError::NotFound(_)) if has_snapshots => Err(AppError::InvalidOperation(format!(
            "edit chain broken at ({device_id}, {seq}) — likely due to op log compaction; \
             LCA requires intact chains"
        ))),
        Err(e) => Err(e),
    }
}

/// Walk an edit chain backwards from `start`, following `prev_edit` pointers.
///
/// The walk terminates when one of the following happens:
/// 1. `stop_at(key)` returns `true` for an ancestor — yields
///    [`WalkOutcome::Stopped`] with that key.
/// 2. A local cycle is detected (`key` already visited within this walk) —
///    yields [`WalkOutcome::Completed`] with the keys collected so far.
/// 3. The chain reaches a `create_block` op (no further `prev_edit`) —
///    yields [`WalkOutcome::Completed`].
/// 4. The chain exceeds [`MAX_LCA_STEPS`] — returns
///    [`AppError::InvalidOperation`] (true fail-fast cap).
///
/// `start` itself is never passed to `stop_at`; only its ancestors are.
async fn walk_edit_chain<F>(
    pool: &SqlitePool,
    start: &(String, i64),
    has_snapshots: bool,
    mut stop_at: F,
) -> Result<WalkOutcome, AppError>
where
    F: FnMut(&(String, i64)) -> bool,
{
    let mut chain: Vec<(String, i64)> = Vec::new();
    // Local cycle-detection set, seeded with `start` so a `prev_edit`
    // pointing back at the chain head terminates the walk immediately.
    let mut visited: HashSet<(String, i64)> = HashSet::new();
    visited.insert((start.0.clone(), start.1));

    let mut next: Option<(String, i64)> =
        fetch_prev_edit(pool, &start.0, start.1, has_snapshots).await?;
    // M-4: bound the walk so a pathologically long acyclic chain
    // cannot issue an unbounded number of writer-pool acquires.  The
    // HashSet-based cycle break still terminates true cycles, but a
    // long acyclic chain (e.g. corruption with no repeated key) must
    // also fail fast.
    let mut steps: usize = 0;
    while let Some(key) = next.take() {
        if stop_at(&key) {
            return Ok(WalkOutcome::Stopped(key));
        }
        if visited.contains(&key) {
            break; // cycle detected — stop walking
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
        next = fetch_prev_edit(pool, &last.0, last.1, has_snapshots).await?;
    }
    Ok(WalkOutcome::Completed(chain))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Insert an op received from a remote device into the op_log.
///
/// Uses `INSERT OR IGNORE` on the composite PK `(device_id, seq)` so that
/// duplicate delivery is idempotent. Rejects ops whose hash does
/// not match the recomputed hash of the record fields.
///
/// ## On `parent_seqs` ordering
///
/// `verify_op_hash` re-runs the writer's exact hash recipe against the
/// stored `parent_seqs` JSON, which makes the integrity check
/// **self-consistent under the current scheme** — any tampering with the
/// `parent_seqs` string (including reordering its entries) breaks the
/// hash and is rejected above.
///
/// We therefore do **not** re-verify that `parent_seqs` is in canonical
/// lexicographic order on the read side.  Canonical ordering is enforced
/// by the writer ([`append_merge_op`] sorts before hashing) and any
/// non-canonical ordering written by an older or bugged peer would still
/// produce a self-consistent hash that round-trips correctly through
/// `find_lca` and friends.  Adding a runtime ordering assertion here
/// would invalidate otherwise-valid existing op log rows produced under
/// earlier writer code paths.
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

    // M-5: verify every `(device_id, seq)` entry in `parent_seqs` already
    // exists in `op_log` before landing this row.  Without the check, a
    // buggy peer or a corrupted stream can insert a row whose parent
    // pointer dangles, silently breaking later DAG walks (`find_lca`,
    // history reconstruction).  The single-user threat model rules out
    // hardening against malicious peers, but data integrity is the
    // explicit defensive priority — fail fast on insert rather than
    // surface as a `NotFound` deep inside a sync log.
    if let Some(parent_seqs_json) = record.parent_seqs.as_deref() {
        let parents: Vec<(String, i64)> = serde_json::from_str(parent_seqs_json)?;
        for (parent_dev, parent_seq) in &parents {
            let exists: i64 = sqlx::query_scalar!(
                "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND seq = ?",
                parent_dev,
                parent_seq,
            )
            .fetch_one(pool)
            .await?;
            if exists == 0 {
                return Err(AppError::InvalidOperation(
                    "dag.parent_seqs.unresolved".into(),
                ));
            }
        }
    }

    // INSERT OR IGNORE — duplicate delivery is a no-op.
    // Returns true if a row was inserted, false if it was a duplicate.
    //
    // PERF-26: populate the indexed block_id column (migration 0030) from
    // the JSON payload so sync'd remote ops participate in fast block-scoped
    // lookups. Local ops use OpPayload::block_id() directly; here we only
    // have the serialized payload string.
    let block_id: Option<String> = extract_block_id_from_payload(&record.payload);

    let result = sqlx::query!(
        "INSERT OR IGNORE INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        record.device_id,
        record.seq,
        record.parent_seqs,
        record.hash,
        record.op_type,
        record.payload,
        record.created_at,
        block_id,
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

    // PERF-26: populate indexed block_id column from the typed payload.
    let block_id: Option<&str> = op_payload.block_id();

    sqlx::query!(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        device_id,
        seq,
        parent_seqs_json,
        hash,
        op_type,
        payload_json,
        created_at,
        block_id,
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
        // L-13: cache the typed payload's block_id sidecar — same
        // sidecar populated on the local-append path.
        block_id: block_id.map(str::to_owned),
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
    // Check if compaction has occurred (snapshots exist).  Drives the
    // compaction-aware error reporting inside `fetch_prev_edit`.
    let has_snapshots: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM log_snapshots WHERE status = 'complete'")
            .fetch_one(pool)
            .await?;
    let has_snapshots = has_snapshots > 0;

    // Walk chain A to its root (or local cycle) and collect every key.
    // Chain A has no early-exit predicate.
    let chain_a = match walk_edit_chain(pool, op_a, has_snapshots, |_| false).await? {
        WalkOutcome::Completed(c) => c,
        // Unreachable: predicate is constant `false`.
        WalkOutcome::Stopped(_) => unreachable!("chain A predicate never matches"),
    };

    // Build a borrowed visited set covering op_a + chain_a for O(1)
    // intersection checks during the chain-B walk.
    let mut visited: HashSet<(&str, i64)> = HashSet::with_capacity(chain_a.len() + 1);
    visited.insert((&op_a.0, op_a.1));
    for (s, n) in &chain_a {
        visited.insert((s.as_str(), *n));
    }

    // op_b itself may sit inside chain A — short-circuit before walking.
    if visited.contains(&(op_b.0.as_str(), op_b.1)) {
        return Ok(Some(op_b.clone()));
    }

    // Walk chain B with an early-exit predicate that fires on the first
    // ancestor present in chain A's visited set — that ancestor is the LCA.
    match walk_edit_chain(pool, op_b, has_snapshots, |key| {
        visited.contains(&(key.0.as_str(), key.1))
    })
    .await?
    {
        WalkOutcome::Stopped(key) => Ok(Some(key)),
        WalkOutcome::Completed(_) => Ok(None),
    }
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

/// Check whether a merge op already exists that integrates `their_head`
/// for a given block.
///
/// Used as an idempotency guard in the edit_block divergence handler to
/// prevent duplicate merge ops on repeated sync passes.  After a
/// successful merge, `append_merge_op` stores `their_head` inside the
/// merge op's `parent_seqs` JSON array.  Subsequent syncs can detect
/// that the remote head has already been integrated by searching for
/// that entry.
///
/// **I-Core-9 — Substring-match invariants.** The `instr(parent_seqs, ?)`
/// search is correct only because:
///
/// 1. `parent_seqs` is serialised by `serde_json::to_string` over a
///    `Vec<(String, i64)>`, which always emits each entry as a 2-tuple
///    closed by `]` (e.g. `["device-A",1]`). The closing `]` prevents
///    `["device-A",1]` from matching the prefix of `["device-A",10]`.
/// 2. `device_id` is a UUID v4 (`/^[0-9a-f-]+$/`), so it contains no
///    JSON-special characters that could perturb the encoded bytes.
/// 3. The integer `seq` has a single canonical decimal representation,
///    so a needle for `1` will not match the `seq=10` substring inside
///    `["device-A",10]` because the closing `]` follows immediately.
///
/// A future migration that stores a different identifier shape in
/// `parent_seqs` (peer-id rename, alphabetic device names, structured
/// hashes) would break invariant (2) and silently introduce false
/// positives. Defence-in-depth alternative: replace the substring scan
/// with `EXISTS (SELECT 1 FROM json_each(parent_seqs) WHERE value = ?)`,
/// which removes the substring assumption entirely. Optimisation,
/// not correctness — the current scan is fast on the existing UUID
/// alphabet.
pub async fn has_merge_for_heads(
    pool: &SqlitePool,
    block_id: &str,
    their_head: &(String, i64),
) -> Result<bool, AppError> {
    // Serialise their_head as a JSON tuple, e.g. `["device-B",1]`.  The
    // closing `]` is what makes the `instr` substring match safe — see
    // the function-level doc for the full invariant.
    let needle = serde_json::to_string(their_head)?;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log \
         WHERE op_type = 'edit_block' \
           AND json_extract(payload, '$.block_id') = ? \
           AND parent_seqs IS NOT NULL \
           AND instr(parent_seqs, ?) > 0",
    )
    .bind(block_id)
    .bind(&needle)
    .fetch_one(pool)
    .await?;

    Ok(count > 0)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests;
