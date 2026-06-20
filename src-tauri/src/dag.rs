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

use crate::db::ReadPool;
use crate::error::AppError;
use crate::hash::{compute_op_hash, verify_op_hash};
use crate::op::*;
use crate::op_log::{
    OpRecord, extract_attachment_id_from_payload, extract_block_id_from_payload, get_op_by_seq,
    serialize_inner_payload,
};

/// Hard cap on the number of `prev_edit` chain steps `find_lca` will
/// walk before giving up.  docs/ARCHITECTURE.md §4 documents this 10,000-step
/// cap as the cycle-detection ceiling; both the CTE's `depth < MAX_LCA_STEPS`
/// recursion bound AND the Rust-side HashSet check below enforce it so a
/// pathologically long acyclic chain (corruption, future schema bug) can
/// never run unbounded.
const MAX_LCA_STEPS: usize = 10_000;

/// One row returned by the recursive CTE in [`fetch_edit_chain_rows`].
///
/// The anchor row (depth 0) is the chain head itself; successive rows
/// (depth 1, 2, …) are the `prev_edit` ancestors in walk order.
/// `prev_device_id` and `prev_seq` are both NULL when the row's payload
/// has no `prev_edit` (e.g. `create_block`, or a genesis `edit_block`
/// with `prev_edit = null`).
#[derive(sqlx::FromRow, Debug)]
struct ChainRow {
    device_id: String,
    seq: i64,
    op_type: String,
    prev_device_id: Option<String>,
    prev_seq: Option<i64>,
    // `depth` is only used to guarantee walk order via the outer ORDER BY.
    // Unused by the post-processing loop but kept for debugging clarity.
    #[expect(
        dead_code,
        reason = "selected only to drive the outer ORDER BY; never read in Rust"
    )]
    depth: i64,
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

/// Walk an edit chain backwards from `start` in a single DB round-trip via
/// a recursive CTE, returning every visited row in depth order (anchor
/// first).
///
/// I-Core-2 / CTE-oracle pattern: replaces the previous N+1
/// `get_op_by_seq`-per-step walk. The Rust implementation survives as
/// [`walk_edit_chain_oracle`] under `#[cfg(test)]`. The SQL bounds
/// recursion at `c.depth < MAX_LCA_STEPS` so a pathologically long
/// chain cannot run unbounded.
///
/// `prev_edit` is stored as a JSON array `[device_id, seq]`; the CTE
/// uses `json_extract(payload, '$.prev_edit[0]')` / `'$.prev_edit[1]'`
/// to thread the chain. Non-edit op payloads (that lack `prev_edit`)
/// yield `NULL` from `json_extract`, so the recursive `INNER JOIN`
/// naturally terminates when the chain reaches a `create_block`.
async fn fetch_edit_chain_rows(
    pool: &SqlitePool,
    start: &(String, i64),
) -> Result<Vec<ChainRow>, AppError> {
    // The bound is inlined as a format placeholder rather than a sqlx bind
    // because it's a CTE recursion depth (not per-row data) and SQLite
    // does not accept parameters inside the recursive-member WHERE clause
    // reliably. The constant lives in one place (`MAX_LCA_STEPS`).
    let sql = format!(
        "WITH RECURSIVE chain(device_id, seq, op_type, prev_device_id, prev_seq, depth) AS ( \
             SELECT device_id, seq, op_type, \
                    json_extract(payload, '$.prev_edit[0]') AS prev_device_id, \
                    json_extract(payload, '$.prev_edit[1]') AS prev_seq, \
                    0 AS depth \
             FROM op_log \
             WHERE device_id = ?1 AND seq = ?2 \
             UNION ALL \
             SELECT o.device_id, o.seq, o.op_type, \
                    json_extract(o.payload, '$.prev_edit[0]') AS prev_device_id, \
                    json_extract(o.payload, '$.prev_edit[1]') AS prev_seq, \
                    c.depth + 1 \
             FROM op_log o \
             INNER JOIN chain c \
                 ON o.device_id = c.prev_device_id AND o.seq = c.prev_seq \
             WHERE c.depth < {MAX_LCA_STEPS} \
         ) \
         SELECT device_id, seq, op_type, prev_device_id, prev_seq, depth \
         FROM chain \
         ORDER BY depth"
    );

    let rows = sqlx::query_as::<_, ChainRow>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(&start.0)
        .bind(start.1)
        .fetch_all(pool)
        .await?;

    Ok(rows)
}

/// Shared error constructor mirroring the previous `fetch_prev_edit`
/// shape: compaction-aware `InvalidOperation` when snapshots exist,
/// otherwise the same `NotFound` `get_op_by_seq` would have produced.
fn missing_op_error(device_id: &str, seq: i64, has_snapshots: bool) -> AppError {
    if has_snapshots {
        AppError::InvalidOperation(format!(
            "edit chain broken at ({device_id}, {seq}) — likely due to op log compaction; \
             LCA requires intact chains"
        ))
    } else {
        AppError::NotFound(format!("op_log ({device_id}, {seq})"))
    }
}

/// Walk an edit chain backwards from `start` via the recursive CTE.
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
///
/// Semantics (errors, op-type validation, cycle-break, step-cap) match
/// [`walk_edit_chain_oracle`] below byte-for-byte; the oracle parity test
/// in `dag/tests.rs` exercises that contract.
async fn walk_edit_chain<F>(
    pool: &SqlitePool,
    start: &(String, i64),
    has_snapshots: bool,
    mut stop_at: F,
) -> Result<WalkOutcome, AppError>
where
    F: FnMut(&str, i64) -> bool,
{
    let rows = fetch_edit_chain_rows(pool, start).await?;

    // Empty result ⇒ start op itself is missing. Preserve the old
    // `get_op_by_seq → NotFound / compaction-wrapped InvalidOperation`
    // error.
    if rows.is_empty() {
        return Err(missing_op_error(&start.0, start.1, has_snapshots));
    }

    // op_type validation (previously done row-by-row by `extract_prev_edit`).
    // Every row the walker would have fetched must be edit_block or
    // create_block; anything else is corruption and surfaces the same
    // "expected edit_block or create_block, got X" error the Rust walker
    // produced.
    for row in &rows {
        if row.op_type != "edit_block" && row.op_type != "create_block" {
            return Err(AppError::InvalidOperation(format!(
                "expected edit_block or create_block, got {}",
                row.op_type
            )));
        }
    }

    // Borrow `device_id` from `rows` for the visited
    // set so we no longer materialise an owned `String` per visited
    // entry. The hot-path LCA in `find_lca` already uses
    // `HashSet<(&str, i64)>`; this aligns the cold-path walker with the
    // same shape. The owned `(String, i64)` only escapes when we push
    // into `chain` (unavoidable — callers consume the chain) or when
    // `stop_at` matches and we surface the matched key.
    let mut visited: HashSet<(&str, i64)> = HashSet::with_capacity(rows.len());
    visited.insert((start.0.as_str(), start.1));

    let mut chain: Vec<(String, i64)> = Vec::new();
    let mut steps: usize = 0;

    // Iterate rows beyond the anchor (the anchor IS `start`).
    for row in rows.iter().skip(1) {
        let dev: &str = row.device_id.as_str();
        let seq = row.seq;
        if stop_at(dev, seq) {
            return Ok(WalkOutcome::Stopped((row.device_id.clone(), seq)));
        }
        if visited.contains(&(dev, seq)) {
            // Cycle detected — matches the old `break` semantics: stop
            // walking, return the partial chain, let the caller search
            // elsewhere.  Tests:
            // `find_lca_detects_cycle_in_chain`, `find_lca_detects_self_loop`.
            return Ok(WalkOutcome::Completed(chain));
        }
        steps += 1;
        if steps >= MAX_LCA_STEPS {
            return Err(AppError::InvalidOperation(format!(
                "find_lca exceeded max steps ({MAX_LCA_STEPS}) walking chain"
            )));
        }
        visited.insert((dev, seq));
        chain.push((row.device_id.clone(), seq));
    }

    // The CTE walked to a natural end.  If the last row's `prev_*` is
    // NULL, the chain terminated cleanly (create_block or a genesis
    // edit_block with `prev_edit = null`).  If it is non-NULL, the
    // recursive JOIN produced no match — i.e. the next op is MISSING.
    // Preserve the compaction-aware error the Rust walker emitted via
    // `fetch_prev_edit`.
    let last = rows.last().unwrap();
    if let (Some(next_dev), Some(next_seq)) = (last.prev_device_id.as_deref(), last.prev_seq) {
        return Err(missing_op_error(next_dev, next_seq, has_snapshots));
    }

    Ok(WalkOutcome::Completed(chain))
}

// ---------------------------------------------------------------------------
// CTE-oracle pattern (per AGENTS.md §"Performance Conventions")
// ---------------------------------------------------------------------------
//
// The following three helpers preserve the previous N+1 Rust walk used by
// `find_lca` so the oracle parity test in `dag/tests.rs` can confirm the
// CTE-driven path in `walk_edit_chain` agrees with the reference semantics
// on a synthetic op-log fixture. They are `#[cfg(test)]`-gated so they do
// not survive into production builds.
//
// I-Core-2: replaced on the hot path by `walk_edit_chain` above, which
// issues a SINGLE `sqlx::query_as::<ChainRow>(..)` call per chain instead
// of N round-trips through `get_op_by_seq`.

/// Oracle: extract the `prev_edit` pointer from an op record's payload.
///
/// - `edit_block` → returns `payload.prev_edit` (may be `None`)
/// - `create_block` → returns `None` (root of the edit chain)
/// - anything else → `AppError::InvalidOperation`
#[cfg(test)]
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
    match get_op_by_seq(&ReadPool(pool.clone()), device_id, seq).await {
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
/// production CTE path must match. Tests in `dag/tests.rs::cte_oracle_*`
/// run this alongside [`walk_edit_chain`] on the same fixture and assert
/// identical outputs.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a `parent_seqs` JSON string into a **canonically ordered**
/// `Vec<(String, i64)>`.
///
/// The op-log stores `parent_seqs` exactly as it was hashed/received, which
/// the writer ([`append_merge_op`]) sorts lexicographically by
/// `(device_id, seq)` before hashing. [`insert_remote_op`] deliberately
/// preserves the stored bytes verbatim (re-sorting them would change the
/// hash preimage and invalidate legacy rows), so a row written by an older
/// or bugged peer may carry a hash-valid but non-canonically-ordered array.
///
/// This is the single read-side canonicalization point: it parses the JSON
/// and re-sorts the parsed `Vec` into the writer's canonical order. The sort
/// is allocation-local and order-stable for already-canonical input (the
/// common case), so order-sensitive consumers can rely on a deterministic
/// parent ordering without depending on the on-disk byte order.
fn parse_parent_seqs_canonical(parent_seqs_json: &str) -> Result<Vec<(String, i64)>, AppError> {
    let mut parents: Vec<(String, i64)> = serde_json::from_str(parent_seqs_json)?;
    // Canonical order == the writer's order: lexicographic ascending by
    // `(device_id, seq)` (see `append_merge_op`, which `sort()`s the same
    // `Vec<(String, i64)>` shape before hashing).
    parents.sort();
    Ok(parents)
}

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
/// We therefore do **not** re-verify (nor rewrite) the stored `parent_seqs`
/// string to canonical lexicographic order on the read side.  Canonical
/// ordering is enforced by the writer ([`append_merge_op`] sorts before
/// hashing); any non-canonical ordering written by an older or bugged peer
/// would still produce a self-consistent hash that round-trips correctly
/// through `find_lca` and friends.  Re-sorting the *stored string* here
/// (or asserting its order) would change the hash preimage and invalidate
/// otherwise-valid existing op log rows produced under earlier writer code
/// paths — so the bytes on disk are left exactly as received.
///
/// ## Invariant for readers — `parent_seqs` may be non-canonically ordered
///
/// Because the stored string is preserved verbatim, **consumers must not
/// assume the parsed `Vec<(String, i64)>` is in canonical order**. Any
/// order-sensitive consumer (hash-chain re-derivation, dedup keyed on the
/// parent multiset, future merge-parent comparison) MUST canonicalize on
/// read via [`parse_parent_seqs_canonical`], which parses the JSON and
/// re-sorts the parsed `Vec` into the same order the writer used. This is a
/// cheap, allocation-local sort that costs nothing for the already-canonical
/// common case and repairs the rare legacy/peer row, without touching the
/// hash-bearing stored bytes.
pub async fn insert_remote_op(pool: &SqlitePool, record: &OpRecord) -> Result<bool, AppError> {
    // #1600 — Reject any raw NUL byte in a hashed field *before* the op
    // reaches the hash recipe. The `\0` delimiter is the wire-format
    // contract for the hash preimage (see `compute_op_hash`); a NUL in a
    // field would make the preimage ambiguous. `compute_op_hash` only
    // enforces this as a `debug_assert!`, so without this gate a corrupt
    // remote op would PANIC in release at the op-log ingest boundary.
    // Fail fast and gracefully instead — this is the production-facing
    // entry point for untrusted/remote content.
    if record.device_id.contains('\0')
        || record
            .parent_seqs
            .as_deref()
            .is_some_and(|p| p.contains('\0'))
        || record.op_type.contains('\0')
        || record.payload.contains('\0')
    {
        return Err(AppError::InvalidOperation(
            "remote op contains a null byte in a hashed field".into(),
        ));
    }

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

    // Verify every `(device_id, seq)` entry in `parent_seqs` already
    // exists in `op_log` before landing this row.  Without the check, a
    // buggy peer or a corrupted stream can insert a row whose parent
    // pointer dangles, silently breaking later DAG walks (`find_lca`,
    // history reconstruction).  The single-user threat model rules out
    // hardening against malicious peers, but data integrity is the
    // explicit defensive priority — fail fast on insert rather than
    // surface as a `NotFound` deep inside a sync log.
    if let Some(parent_seqs_json) = record.parent_seqs.as_deref() {
        // Canonicalize on read: the stored bytes may be non-canonically
        // ordered (preserved verbatim to keep the hash valid), so any
        // consumer that parses them goes through the single
        // canonicalization point. The existence check below is itself
        // order-insensitive, but routing through the helper enforces the
        // documented read-side contract uniformly.
        let parents: Vec<(String, i64)> = parse_parent_seqs_canonical(parent_seqs_json)?;
        if !parents.is_empty() {
            // SQL-review B-C4 (issue #112 sub-item 3): batch the
            // per-parent existence check into one query. Today this is
            // N=1 (phase 1 of the DAG) so the round-trip win is mostly
            // future-proofing for phase-4 multi-parent merges, but the
            // single statement is also strictly easier to reason about.
            // The IN clause uses row-value comparison (SQLite >= 3.15)
            // against `json_each` of the parent_seqs JSON; we dedupe
            // `parents` in Rust before comparing the count because the
            // IN's set semantics collapse duplicates on the SQL side.
            let unique_parents: HashSet<&(String, i64)> = parents.iter().collect();
            let found: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM op_log \
                 WHERE (device_id, seq) IN ( \
                     SELECT json_extract(value, '$[0]'), \
                            CAST(json_extract(value, '$[1]') AS INTEGER) \
                     FROM json_each(?) \
                 )",
            )
            .bind(parent_seqs_json)
            .fetch_one(pool)
            .await?;
            let expected: i64 =
                i64::try_from(unique_parents.len()).expect("parent count fits in i64");
            if found != expected {
                return Err(AppError::InvalidOperation(
                    "dag.parent_seqs.unresolved".into(),
                ));
            }
        }
    }

    // #1572 — distinguish a benign idempotent re-delivery from a fork /
    // corruption / device-id reuse at the same composite PK.
    //
    // The bare `INSERT OR IGNORE` below collapses BOTH cases into the same
    // `rows_affected() == 0 -> Ok(false)`: a row that already exists with the
    // SAME hash (genuine duplicate delivery, harmless) and a row that already
    // exists with a DIFFERENT hash (the incoming op diverges from what we
    // stored). The latter silently drops conflicting content with no error,
    // log, or integrity signal. Probe the existing row first and reject the
    // mismatch explicitly so divergence is observable.
    //
    // A `Some(h)` where `h == record.hash` is a genuine idempotent
    // re-delivery: fall through to the `INSERT OR IGNORE`, which is a no-op
    // and returns `Ok(false)`, keeping the pre-existing benign behaviour
    // unchanged. Only the different-hash case is rejected.
    let existing_hash = sqlx::query_scalar!(
        "SELECT hash FROM op_log WHERE device_id = ? AND seq = ?",
        record.device_id,
        record.seq,
    )
    .fetch_optional(pool)
    .await?;
    if let Some(existing_hash) = existing_hash
        && existing_hash != record.hash
    {
        tracing::error!(
            device_id = %record.device_id,
            seq = record.seq,
            existing_hash = %existing_hash,
            incoming_hash = %record.hash,
            "op_log divergence: existing row at (device_id, seq) has a \
             different hash than the incoming op (fork / corruption / \
             device-id reuse); rejecting instead of silently dropping",
        );
        return Err(AppError::InvalidOperation(
            "op_log divergence: existing row at (device_id, seq) has a \
             different hash than the incoming op"
                .into(),
        ));
    }

    // INSERT OR IGNORE — duplicate delivery is a no-op.
    // Returns true if a row was inserted, false if it was a duplicate.
    //
    // Populate the indexed block_id column (migration 0030) from
    // the JSON payload so sync'd remote ops participate in fast block-scoped
    // lookups. Local ops use OpPayload::block_id() directly; here we only
    // have the serialized payload string.
    let block_id: Option<String> = extract_block_id_from_payload(&record.payload);

    // SQL-review B-4 / migration 0064: same denormalisation pattern as
    // block_id, applied to attachment_id. Remote attachment ops must
    // populate the column so the reverse-attachment lookup in
    // `reverse::attachment_ops::reverse_delete_attachment` finds them
    // via the indexed `idx_op_log_attachment_id` partial index.
    let attachment_id: Option<String> = extract_attachment_id_from_payload(&record.payload);

    let result = sqlx::query!(
        "INSERT OR IGNORE INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id, attachment_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        record.device_id,
        record.seq,
        record.parent_seqs,
        record.hash,
        record.op_type,
        record.payload,
        record.created_at,
        block_id,
        attachment_id,
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
///
/// **Test/bench-only convenience** (#224) — opens its own transaction.
/// Production merge ingestion appends within an outer transaction.
pub async fn append_merge_op(
    pool: &SqlitePool,
    device_id: &str,
    op_payload: OpPayload,
    parent_entries: Vec<(String, i64)>,
) -> Result<OpRecord, AppError> {
    // Sort lexicographically for deterministic hashing, then dedup.
    // `parent_entries` is caller-supplied and we have seen
    // no contract preventing duplicate `(device_id, seq)` pairs from
    // reaching here. A duplicate parent collapses to a single distinct
    // entry post-dedup, so we re-check `< 2` after the dedup as well —
    // a degenerate input like `[(A, 1), (A, 1)]` must be rejected even
    // though `parent_entries.len() == 2` pre-dedup.
    let mut sorted_parents = parent_entries;
    sorted_parents.sort();
    sorted_parents.dedup();

    if sorted_parents.len() < 2 {
        return Err(AppError::InvalidOperation(
            "merge op requires at least 2 distinct parent entries".into(),
        ));
    }

    let parent_seqs_json = serde_json::to_string(&sorted_parents)?;
    let op_type = op_payload.op_type_str().to_owned();
    let payload_json = serialize_inner_payload(&op_payload)?;
    let created_at = crate::db::now_ms();

    // Test/bench-only convenience wrapper — production merge ingestion appends
    // within an outer transaction; this self-opened tx only ever serves unit
    // tests + benches.
    // allow-raw-tx: test/bench-only helper (#224)
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

    // Populate indexed block_id column from the typed payload.
    let block_id: Option<&str> = op_payload.block_id();

    // SQL-review B-4 / migration 0064: same denormalisation pattern as
    // block_id, applied to attachment_id (Some only for attachment ops).
    let attachment_id: Option<&str> = op_payload.attachment_id();

    sqlx::query!(
        "INSERT INTO op_log \
         (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id, attachment_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        device_id,
        seq,
        parent_seqs_json,
        hash,
        op_type,
        payload_json,
        created_at,
        block_id,
        attachment_id,
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
        // Cache the typed payload's block_id sidecar — same
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
    // EXISTS stops at the first matching row, which is cheaper than COUNT(*).
    let has_snapshots: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM log_snapshots WHERE status = 'complete')")
            .fetch_one(pool)
            .await?;
    let has_snapshots = has_snapshots != 0;

    // Walk chain A to its root (or local cycle) and collect every key.
    // Chain A has no early-exit predicate.
    let chain_a = match walk_edit_chain(pool, op_a, has_snapshots, |_, _| false).await? {
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
    match walk_edit_chain(pool, op_b, has_snapshots, |dev, seq| {
        visited.contains(&(dev, seq))
    })
    .await?
    {
        WalkOutcome::Stopped(key) => Ok(Some(key)),
        WalkOutcome::Completed(_) => Ok(None),
    }
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

/// Extract the text content at a given op.
///
/// - `edit_block` → `to_text`
/// - `create_block` → `content`
/// - anything else → `AppError::InvalidOperation`
pub async fn text_at(pool: &SqlitePool, device_id: &str, seq: i64) -> Result<String, AppError> {
    // I-Core-8: wrap to typed read-pool — caller is in write context
    let record = get_op_by_seq(&ReadPool(pool.clone()), device_id, seq).await?;
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
           AND block_id = ?
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
/// **I-Core-9 — Structural membership test.** `parent_seqs` is serialised
/// by `serde_json::to_string` over a `Vec<(String, i64)>`, so each element
/// is itself a JSON 2-tuple `[device, seq]`. The query decomposes the
/// array with `json_each` and compares each element's `[0]`/`[1]`
/// components (device, seq) to `their_head` via `json_extract`:
///
/// ```sql
/// EXISTS (
///   SELECT 1 FROM json_each(parent_seqs)
///   WHERE json_extract(value, '$[0]') = ?device
///     AND json_extract(value, '$[1]') = ?seq
/// )
/// ```
///
/// This is a true structural membership test: it does not depend on the
/// device-id being a JSON-safe UUID, on `seq` having a single decimal
/// form, or on a closing `]` preventing prefix matches. A future
/// identifier-format change (peer-id rename, alphabetic device names,
/// structured hashes) therefore cannot introduce a false positive that
/// silently suppresses a needed merge op.
pub async fn has_merge_for_heads(
    pool: &SqlitePool,
    block_id: &str,
    their_head: &(String, i64),
) -> Result<bool, AppError> {
    // Each element of `parent_seqs` is a JSON 2-tuple `[device, seq]` (see
    // `append_merge_op`).  Instead of a substring scan over the serialised
    // array — which relied on fragile invariants about identifier shape and
    // the closing `]` preventing prefix matches — decompose the array with
    // `json_each` and compare each element's components structurally.  A
    // future identifier-format change can no longer introduce a false
    // positive that suppresses a needed merge op.
    let (their_device, their_seq) = their_head;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log \
         WHERE op_type = 'edit_block' \
           AND block_id = ? \
           AND parent_seqs IS NOT NULL \
           AND EXISTS ( \
             SELECT 1 FROM json_each(parent_seqs) \
             WHERE json_extract(value, '$[0]') = ? \
               AND json_extract(value, '$[1]') = ? \
           )",
    )
    .bind(block_id)
    .bind(their_device)
    .bind(their_seq)
    .fetch_one(pool)
    .await?;

    Ok(count > 0)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests;

#[cfg(test)]
mod proptest_b2;
