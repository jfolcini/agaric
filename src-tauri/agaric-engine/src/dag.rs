//! Op-log ingest for a peer's replicated records, plus two read helpers.
//!
//! Inbound sync lands remote state through the Loro engine import and its
//! SQL projection. A peer's op records reach `op_log` only as
//! `is_replicated = 1` audit rows (#2481), through
//! [`ingest_replicated_record`](crate::dag::ingest_replicated_record):
//! hash-verified, stored for cross-device History and attribution, never
//! applied to state.
use std::collections::HashSet;

use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_core::hash::verify_op_hash;
use agaric_store::op::*;
use agaric_store::op_log::OpRecord;

/// Parse a `parent_seqs` JSON string into a **canonically ordered**
/// `Vec<(String, i64)>`.
///
/// Ingest stores `parent_seqs` exactly as received, since re-sorting would
/// change the hash preimage, so a row written by an older or bugged peer may
/// carry a hash-valid but non-canonically-ordered array. This is the single
/// read-side canonicalization point: order-sensitive consumers rely on it
/// rather than on the on-disk byte order.
pub fn parse_parent_seqs_canonical(parent_seqs_json: &str) -> Result<Vec<(String, i64)>, AppError> {
    let mut parents: Vec<(String, i64)> = serde_json::from_str(parent_seqs_json)?;
    parents.sort();
    Ok(parents)
}

/// #2481 phase 1 — ingest an already-decoded replicated op record as
/// append-only, hash-verified **audit metadata**.
///
/// The app-level `insert_replicated_op` shim decodes the wire `OpTransfer`
/// (extracting the transfer-carried `origin`, which `OpRecord` does not
/// surface) and calls into here. The row is stamped `is_replicated = 1`, the
/// caller-supplied `origin` is kept verbatim, and an unresolved `parent_seqs`
/// pointer (the peer compacted its own early history) lands with a `warn!`
/// breadcrumb instead of being rejected.
///
/// The stored record is **never applied to state**: the `is_replicated = 1`
/// stamp keeps it out of boot replay (`recovery::replay`), the materializer
/// apply pipeline, and the apply-cursor bookkeeping (migration 0099).
pub async fn ingest_replicated_record(
    pool: &SqlitePool,
    record: &OpRecord,
    origin: &str,
) -> Result<bool, AppError> {
    ingest_remote_record(pool, record, origin).await
}

/// Verification + insert core behind [`ingest_replicated_record`].
async fn ingest_remote_record(
    pool: &SqlitePool,
    record: &OpRecord,
    origin: &str,
) -> Result<bool, AppError> {
    verify_remote_record_integrity(record)?;

    // #2275 — run the parent-existence check, the #1572 divergence probe, and
    // the INSERT inside ONE `BEGIN IMMEDIATE` transaction. Previously each ran
    // as an independent autocommitted statement against `pool`, so a concurrent
    // inserter could land a row between the divergence probe (which classifies
    // "benign duplicate vs fork") and the `INSERT OR IGNORE`: the read that
    // makes the decision and the write that acts on it were not atomic, so a
    // divergent op could slip through the window and be silently ignored.
    // `BEGIN IMMEDIATE` takes the write lock up front, serializing concurrent
    // inserters so the probe → insert decision cannot be raced. A pure-CPU
    // validation failure above returns before the lock is taken; any `Err`
    // below drops `tx`, rolling the transaction back.
    // TOCTOU fix (#2275 item 5): parent-check, divergence probe, and the op
    // INSERT must be one atomic unit; sync-ingestion-only (no materializer
    // dispatch), so a raw immediate tx is the correct scope.
    // allow-raw-tx: atomic parent-check + insert for sync ingestion (#2275)
    let mut tx = agaric_store::db::begin_immediate_logged(pool, "ingest_remote_record").await?;

    verify_parent_seqs_exist(&mut tx, record).await?;
    reject_hash_divergence(&mut tx, record).await?;

    // INSERT OR IGNORE — duplicate delivery is a no-op. The store-owned
    // primitive (#2895 slice 5) returns true when a row was inserted, false
    // when it was a duplicate; it also populates the indexed block_id
    // (migration 0030) / attachment_id (migration 0064) columns from the JSON
    // payload for fast block-scoped and reverse-attachment lookups.
    //
    // #2481: `origin` carries cross-device attribution and `is_replicated` is
    // the isolation boundary — audit records (migration 0099) are skipped by
    // boot replay / materializer / apply-cursor bookkeeping.
    let inserted =
        agaric_store::op_log::ingest_remote_op_in_tx(&mut tx, record, origin, true).await?;
    // #5371: a peer's edit moves its page up "Last edited" here, the one
    // place its op reaches this device's op log; it is never applied. The
    // block comes from the payload, as the indexed column's does: a record
    // decoded off the wire carries no `block_id` sidecar (#6048).
    if inserted
        && let (Some(block_id), _) =
            agaric_store::op_log::extract_indexed_ids_from_payload(&record.payload)
    {
        agaric_store::cache::raise_pages_last_edited_ms(&mut tx, &[(&block_id, record.created_at)])
            .await?;
    }

    tx.commit().await?;
    Ok(inserted)
}

/// Pure-CPU integrity gate for a remote op record: NUL bytes in hashed
/// fields, the blake3 hash recipe, and the `SetProperty` payload domain.
///
/// Runs before the ingest transaction is opened, so a rejected record never
/// takes the write lock.
fn verify_remote_record_integrity(record: &OpRecord) -> Result<(), AppError> {
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

    // #2026 — Enforce the SetProperty domain invariants on the remote
    // ingest path. The local append path
    // (`append_local_op_in_tx_with_provenance`) runs every SetProperty
    // payload through `agaric_store::op::validate_set_property` (key format,
    // exactly-one-value, finite num, non-empty string fields) before it
    // can land. Remote ingest previously validated only null
    // bytes / hash / parents, so a peer or a buggy/older client could
    // land a hash-valid SetProperty with an empty/oversized/special-char
    // key, an empty value, or multiple value fields — all rejected
    // locally — which then flow into `engine_apply` and downstream (e.g.
    // agenda ISO-date parsing). We re-decode the inner payload (the
    // stored `payload` column is the *inner* struct JSON, without the
    // `op_type` tag — see `serialize_inner_payload`) and reuse the same
    // validator verbatim so the two append paths cannot drift. Only
    // SetProperty ops are decoded; every other op type is untouched.
    if record.op_type == OpType::SetProperty.as_str() {
        let payload: SetPropertyPayload = serde_json::from_str(&record.payload)?;
        validate_set_property(&payload)?;
    }

    Ok(())
}

/// Check every `(device_id, seq)` entry in `parent_seqs` against `op_log`.
///
/// An unresolved pointer means the *peer* compacted its own early history
/// before replicating this op. The replicated log is audit-only and never
/// load-bearing for state, and per-device ordered delivery (sort by seq) makes
/// the gap attributable to compaction only, so the row lands with a `warn!`
/// breadcrumb instead of being rejected (`op-log-format.md` §Validity rules).
/// Runs on the caller's ingest transaction (#2275).
async fn verify_parent_seqs_exist(
    conn: &mut sqlx::SqliteConnection,
    record: &OpRecord,
) -> Result<(), AppError> {
    let Some(parent_seqs_json) = record.parent_seqs.as_deref() else {
        return Ok(());
    };
    let parents: Vec<(String, i64)> = parse_parent_seqs_canonical(parent_seqs_json)?;
    if parents.is_empty() {
        return Ok(());
    }
    // One query for every parent (#112). The IN's set semantics collapse
    // duplicates, so `parents` is deduped before comparing the count.
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
    .fetch_one(&mut *conn)
    .await?;
    let expected: i64 = i64::try_from(unique_parents.len()).expect("parent count fits in i64");
    if found != expected {
        tracing::warn!(
            device_id = %record.device_id,
            seq = record.seq,
            parents_found = found,
            parents_expected = expected,
            "op_log audit ingest: unresolved parent_seqs \
             (peer-side compaction of early history); landing \
             the replicated record with a breadcrumb rather \
             than rejecting (#2481)"
        );
    }
    Ok(())
}

/// #1572 — distinguish a benign idempotent re-delivery from a fork /
/// corruption / device-id reuse at the same composite PK.
///
/// The caller's bare `INSERT OR IGNORE` collapses BOTH cases into the same
/// `rows_affected() == 0 -> Ok(false)`: a row that already exists with the
/// SAME hash (genuine duplicate delivery, harmless) and a row that already
/// exists with a DIFFERENT hash (the incoming op diverges from what we
/// stored). The latter silently drops conflicting content with no error,
/// log, or integrity signal. Probe the existing row first and reject the
/// mismatch explicitly so divergence is observable.
///
/// A `Some(h)` where `h == record.hash` is a genuine idempotent
/// re-delivery: fall through to the `INSERT OR IGNORE`, which is a no-op
/// and returns `Ok(false)`, keeping the pre-existing benign behaviour
/// unchanged. Only the different-hash case is rejected.
async fn reject_hash_divergence(
    conn: &mut sqlx::SqliteConnection,
    record: &OpRecord,
) -> Result<(), AppError> {
    let existing_hash = sqlx::query_scalar!(
        "SELECT hash FROM op_log WHERE device_id = ? AND seq = ?",
        record.device_id,
        record.seq,
    )
    .fetch_optional(&mut *conn)
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

    Ok(())
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
