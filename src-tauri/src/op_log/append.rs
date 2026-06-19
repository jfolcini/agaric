use sqlx::SqlitePool;

use crate::error::AppError;
use crate::hash::compute_op_hash;
use crate::op::OpPayload;

use super::payload::serialize_inner_payload;
use super::record::OpRecord;

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/// Append a local operation to the op log inside a transaction.
///
/// Delegates to [`append_local_op_at`] with the current UTC timestamp.
///
/// # TEST/BENCH ONLY — never call on a runtime path (#224, #1657)
///
/// This self-opening-transaction form opens **and commits** its own
/// `BEGIN IMMEDIATE` transaction, which decouples the op-log append from the
/// caller's post-commit materializer dispatch. Production **must** append via
/// [`append_local_op_in_tx`] on an outer `CommandTx` so dispatch stays coupled
/// to the commit; a runtime caller of this wrapper would silently break that
/// coupling.
///
/// Why this is only doc-guarded (not `#[cfg(test)]`): the benches in
/// `src-tauri/benches/` consume this through the public library API
/// (`agaric_lib::op_log::append_local_op`), which is compiled **without**
/// `cfg(test)`, so a compiler gate would break the bench build (`cargo check
/// --benches` / `cargo bench --no-run`). No production call site exists today
/// (verified #1657: every `src/` caller is inside a `#[cfg(test)]` module; the
/// only non-test consumer is the bench). If you are wiring this into runtime
/// code, you are doing something wrong — use [`append_local_op_in_tx`].
pub async fn append_local_op(
    pool: &SqlitePool,
    device_id: &str,
    op_payload: OpPayload,
) -> Result<OpRecord, AppError> {
    append_local_op_at(pool, device_id, op_payload, crate::db::now_ms()).await
}

/// Append a local operation within an existing transaction.
///
/// The caller is responsible for committing the transaction.
/// This is used by command handlers to wrap both the op_log append
/// and the blocks-table write in a single atomic transaction.
///
/// # Transaction mode requirement (L-5)
///
/// **The caller MUST open the transaction with `BEGIN IMMEDIATE`** (e.g.
/// via [`sqlx::SqlitePool::begin_with`]`("BEGIN IMMEDIATE")` or
/// [`crate::db::begin_immediate_logged`]), not the sqlx default
/// `pool.begin()` (which uses `BEGIN DEFERRED`).
///
/// The reason: the function reads `MAX(seq)` from `op_log` and then
/// `INSERT`s a row keyed on `seq + 1`. Under a deferred transaction, a
/// concurrent writer can commit a higher `seq` for the same `device_id`
/// between the read and the write, producing `SQLITE_BUSY_SNAPSHOT`.
/// `BEGIN IMMEDIATE` eagerly acquires the write lock at the start of
/// the transaction so the read+write pair sees a consistent
/// `MAX(seq)`. The sibling [`append_local_op_at`] follows this rule
/// (see its `pool.begin_with("BEGIN IMMEDIATE")` line below); every
/// other production caller does too.
///
/// # How the contract is enforced (#653)
///
/// This was previously a doc-only contract. It is now lint-enforced by the
/// `check-raw-tx` prek hook (`scripts/check-raw-tx.py`, the #110 CommandTx
/// guard): in any file that references `append_local_op_in_tx` /
/// `append_local_undo_op_in_tx`, a bare `pool.begin()` (the sqlx default,
/// which opens `BEGIN DEFERRED`) is flagged as a violation. The proximity
/// rule — only files that call the append helpers — keeps it
/// false-positive-free against the many legitimate read-only / rollback-only
/// `pool.begin()` sites elsewhere in the tree, and the usual
/// `// allow-raw-tx: <reason>` per-site escape hatch and `#[cfg(test)]`
/// skipping still apply. A future caller wiring a deferred `pool.begin()`
/// into this append now fails the hook at commit/push time, instead of only
/// surfacing as a hard-to-reproduce `SQLITE_BUSY_SNAPSHOT` under contention.
///
/// Why a lint and not a stronger guard:
/// - **Type-level** (require a `CommandTx`-derived marker) was rejected as
///   too invasive: ~25 production call sites plus intermediate helpers in
///   `domain/`, `spaces/`, and `tags.rs` thread a bare
///   `&mut sqlx::Transaction` (not a `CommandTx`), and the test/bench-only
///   [`append_local_op_at`] opens a raw transaction — a marker would have to
///   be threaded through all of them.
/// - **Runtime `debug_assert`** (probe the live tx for an IMMEDIATE write
///   lock via `sqlite3_txn_state`) was rejected because it needs FFI: a
///   direct `libsqlite3-sys` dependency and an entry in the audited
///   unsafe-allowlist to opt the file out of the workspace `unsafe_code`
///   deny lint — far too heavy for this guard, and there is no
///   false-positive-free pure-SQL way to distinguish IMMEDIATE from DEFERRED
///   without a destructive write.
///
/// If you find yourself adding a new caller, follow the pattern in
/// [`append_local_op_at`] verbatim (open via `BEGIN IMMEDIATE`).
pub async fn append_local_op_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    op_payload: OpPayload,
    created_at: i64,
) -> Result<OpRecord, AppError> {
    append_local_op_in_tx_with_provenance(tx, device_id, op_payload, created_at, false).await
}

/// #659: append a local op flagged as an UNDO op (`op_log.is_undo = 1`,
/// migration 0090).
///
/// Only `undo_page_op_inner` calls this — the reverse op it appends is the
/// one thing `redo_page_op` may later reverse, and redo verifies the flag
/// before reversing. Redo's own output ops are forward-equivalent and go
/// through the plain [`append_local_op_in_tx`] (flag 0), as does everything
/// else. Same `BEGIN IMMEDIATE` contract as the plain variant.
pub async fn append_local_undo_op_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    op_payload: OpPayload,
    created_at: i64,
) -> Result<OpRecord, AppError> {
    append_local_op_in_tx_with_provenance(tx, device_id, op_payload, created_at, true).await
}

async fn append_local_op_in_tx_with_provenance(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    mut op_payload: OpPayload,
    created_at: i64,
    is_undo: bool,
) -> Result<OpRecord, AppError> {
    // L-98: `op_log.created_at` is INTEGER epoch-ms (migration 0079);
    // reverse-op "find prior op" queries compare it numerically. No
    // shape assertion is needed — integer ordering is intrinsically
    // monotonic. See the doc-comment on `OpRecord`.

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

    // SQL-review B-4 / migration 0064: extract attachment_id for the
    // indexed column. Returns Some only for the two attachment-bearing
    // variants (`add_attachment` / `delete_attachment`); every other
    // variant yields None and the column is NULL (excluded by the
    // partial index `idx_op_log_attachment_id`).
    let attachment_id: Option<&str> = op_payload.attachment_id();

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
        //
        // I-Core-11: previously hand-built as `format!(r#"[["{}",{}]]"#, ...)`
        // to avoid the Vec + sort overhead. Switching to `serde_json::to_string`
        // keeps the JSON shape byte-identical for UUID device_ids (verified by a
        // regression test) AND removes the silent dependency on "device_id is
        // JSON-safe", which a future migration to non-UUID identifiers would
        // break. The Vec + heap String are negligible against the surrounding
        // SQL transaction cost. The element type is `(String, i64)` to match
        // what `dag::append_merge_op` produces.
        Some(serde_json::to_string(&[(device_id.to_string(), prev_seq)])?)
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

    // #659: `is_undo` (migration 0090) records undo provenance so
    // `redo_page_op` can verify its target really is an undo op. Like
    // `origin`, it is local metadata and NOT part of the hash preimage.
    let is_undo_flag: i64 = i64::from(is_undo);

    sqlx::query!(
        "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id, origin, attachment_id, is_undo) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        device_id,
        seq,
        parent_seqs,
        hash,
        op_type,
        payload_json,
        created_at,
        block_id,
        origin,
        attachment_id,
        is_undo_flag,
    )
    .execute(&mut **tx)
    .await?;

    // FEAT-4h slice 3: populate the task-local `LAST_APPEND` cell so the
    // MCP dispatch layer can attach an `OpRef` to the emitted
    // `mcp:activity` entry for per-entry Undo. Silent no-op outside a
    // `task_locals::LAST_APPEND` scope — i.e. every frontend-invoked
    // command.
    //
    // MAINT-150 (j): the task-local lives in `crate::task_locals` (a
    // neutral home) rather than `crate::mcp`, so this core module no
    // longer depends on the `mcp` integration.
    crate::task_locals::record_append(crate::op::OpRef {
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
        // L-13: cache the typed payload's block_id sidecar so the
        // materializer hot path (`dispatch::enqueue_background_tasks`)
        // does not re-parse `payload` to recover the same value.
        block_id: block_id.map(str::to_owned),
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
///
/// # TEST/BENCH ONLY — never call on a runtime path (#224, #1657)
///
/// This opens **and commits** its own `BEGIN IMMEDIATE` transaction,
/// decoupling the op-log append from the caller's post-commit materializer
/// dispatch. Production **must** append via [`append_local_op_in_tx`] on an
/// outer `CommandTx` so dispatch stays coupled to the commit. See
/// [`append_local_op`] for why this contract is enforced by doc-comment rather
/// than `#[cfg(test)]` (the benches consume the public API without `cfg(test)`)
/// and for the #1657 audit confirming there are no runtime callers.
pub async fn append_local_op_at(
    pool: &SqlitePool,
    device_id: &str,
    op_payload: OpPayload,
    created_at: i64,
) -> Result<OpRecord, AppError> {
    // L-98: `op_log.created_at` is INTEGER epoch-ms (migration 0079) —
    // numeric ordering, no shape assertion needed. See `OpRecord`.

    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT when a concurrent background cache rebuild
    // commits between our first read and first write inside the tx.
    // Test/bench-only convenience wrapper — production couples dispatch via
    // append_local_op_in_tx on an outer CommandTx; this self-opened tx only
    // ever serves unit tests + benches, never a runtime path.
    // allow-raw-tx: test/bench-only helper (#224)
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let record = append_local_op_in_tx(&mut tx, device_id, op_payload, created_at).await?;
    tx.commit().await?;
    Ok(record)
}
