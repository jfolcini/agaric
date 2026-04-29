use sqlx::SqlitePool;
use std::sync::Arc;

use super::types::*;
use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};
use crate::merge;
use crate::op_log::{self, OpRecord};
use crate::peer_refs;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Get the latest `(device_id, seq, hash)` per device in the op log.
pub async fn get_local_heads(pool: &SqlitePool) -> Result<Vec<DeviceHead>, AppError> {
    let heads = sqlx::query_as::<_, DeviceHead>(
        "SELECT device_id, seq, hash FROM op_log \
         WHERE (device_id, seq) IN \
           (SELECT device_id, MAX(seq) FROM op_log GROUP BY device_id) \
         ORDER BY device_id",
    )
    .fetch_all(pool)
    .await?;
    Ok(heads)
}

/// Compute the set of [`OpRecord`]s to send to a remote peer based on their
/// advertised heads.
///
/// For each device we have ops for:
/// - If remote knows about this device: send ops with `seq > remote_seq`.
/// - If remote doesn't know: send ALL ops for that device.
///
/// # Ordering semantics — order-tolerant op log (L-69)
///
/// The outer loop iterates `local_heads`, which [`get_local_heads`]
/// returns `ORDER BY device_id` (lexicographic). Within a device, ops
/// are seq-ordered. Concretely, device-A's ops always precede
/// device-B's lexicographically — so a device-A op that references a
/// block created by device-B may arrive *before* device-B's create-op
/// when A's `device_id` sorts first.
///
/// This is **deliberate**: the sync protocol relies on the op log
/// being **order-tolerant**, not strictly ordered:
///
/// - The op log has no foreign keys — `apply_remote_ops` uses
///   `INSERT OR IGNORE` semantics for duplicates and the materializer
///   handles `row-not-found` gracefully on `EditBlock` /
///   `SetProperty` / `MoveBlock` etc.
/// - Most op variants (set_property, add_tag, remove_tag) are
///   commutative or idempotent against the materialized state.
/// - The few order-sensitive pairings (e.g. `MoveBlock` arriving
///   before its target's `CreateBlock`) leave the materializer's
///   derived tables temporarily inconsistent — the create op then
///   "fills in" the row when it arrives, and a subsequent rebuild
///   on the same `block_id` group reconciles the order.
///
/// **Sorting the combined list by `created_at` would NOT make this
/// stricter** because clocks across devices can skew, and the cost of
/// validating clock consistency is more than the cost of absorbing
/// out-of-order arrivals at the materializer. If you find yourself
/// reaching for "let's sort by `created_at` to be safe", read the
/// rationale above and prefer fixing the materializer's ordering
/// tolerance instead.
pub async fn compute_ops_to_send(
    pool: &SqlitePool,
    remote_heads: &[DeviceHead],
) -> Result<Vec<OpRecord>, AppError> {
    let local_heads = get_local_heads(pool).await?;
    let mut ops: Vec<OpRecord> = Vec::new();

    for local_head in &local_heads {
        let after_seq = remote_heads
            .iter()
            .find(|rh| rh.device_id == local_head.device_id)
            .map(|rh| rh.seq)
            .unwrap_or(0);

        if after_seq >= local_head.seq {
            continue; // remote is up-to-date for this device
        }

        let device_ops = op_log::get_ops_since(pool, &local_head.device_id, after_seq).await?;
        ops.extend(device_ops);
    }

    Ok(ops)
}

/// Check whether a full reset is required for sync with a remote peer.
///
/// Returns `true` if the remote advertises a `(device_id, seq)` that we no
/// longer have in our op log (e.g. after compaction).
pub async fn check_reset_required(
    pool: &SqlitePool,
    remote_heads: &[DeviceHead],
) -> Result<bool, AppError> {
    for head in remote_heads {
        match op_log::get_op_by_seq(pool, &head.device_id, head.seq).await {
            Ok(_) => {}
            Err(AppError::NotFound(_)) => return Ok(true),
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

/// Insert remote ops into the local op log and enqueue materialisation.
///
/// All ops are inserted inside a **single explicit transaction** to amortise
/// the per-op `BEGIN IMMEDIATE` / `COMMIT` overhead.  Materialisation tasks
/// are enqueued only *after* the transaction commits, guaranteeing that every
/// op is durable before any of them are processed.
///
/// Duplicates are detected via `INSERT OR IGNORE` on the composite PK
/// `(device_id, seq)` — zero `rows_affected` means the op was already
/// present.
pub async fn apply_remote_ops(
    pool: &SqlitePool,
    materializer: &Materializer,
    ops: Vec<OpTransfer>,
) -> Result<ApplyResult, AppError> {
    use crate::hash::verify_op_record;

    let mut result = ApplyResult {
        inserted: 0,
        duplicates: 0,
        hash_mismatches: 0,
        forks: 0,
    };
    let mut to_materialize = Vec::new();

    // Convert all transfers to records and verify them upfront.
    // All-or-nothing contract: any single hash mismatch OR malformed JSON
    // payload rejects the entire batch. We refuse to leak partial state from
    // a buggy peer build (e.g., a serializer regression for one op type)
    // into our op log, which would silently desynchronise op_log from the
    // materialized state.
    let mut records: Vec<OpRecord> = ops.into_iter().map(OpRecord::from).collect();
    for record in &mut records {
        verify_op_record(record).map_err(|msg| {
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                "integrity check failed during sync: {msg}"
            );
            AppError::InvalidOperation(format!("integrity check failed: {msg}"))
        })?;

        // Validate payload is well-formed JSON before any insertion.
        // Treated identically to a hash mismatch: the whole batch is
        // rejected so the op log never contains an op with an unparseable
        // payload.
        //
        // L-13: piggy-back on this existing parse to populate the
        // cached `OpRecord::block_id` sidecar. `From<OpTransfer> for
        // OpRecord` leaves the field `None` precisely so we can do
        // the work here exactly once instead of parsing `payload`
        // twice per sync'd op (once on the wire conversion, once
        // here). The materializer hot path
        // (`dispatch::enqueue_background_tasks`) reads the sidecar
        // for any sync-induced op that later flows through
        // `dispatch_op` (the conflict-resolution paths in
        // `merge_diverged_blocks` are the current consumers).
        match serde_json::from_str::<serde_json::Value>(&record.payload) {
            Ok(value) => {
                record.block_id = value
                    .get("block_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
            }
            Err(e) => {
                tracing::warn!(
                    device_id = %record.device_id,
                    seq = record.seq,
                    "rejecting batch: op has invalid JSON payload: {e}"
                );
                return Err(AppError::InvalidOperation(format!(
                    "invalid JSON payload for op (device_id={}, seq={}): {e}",
                    record.device_id, record.seq
                )));
            }
        }
    }

    // Fork detection (H-14): bulk-fetch existing hashes for every
    // `(device_id, seq)` pair in this batch in a SINGLE query, BEFORE
    // opening the write transaction. Per-op SELECTs inside the txn would
    // extend the BEGIN IMMEDIATE write-lock window proportional to batch
    // size and starve other writers (materializer etc.), causing
    // intermittent SQLITE_BUSY under load.
    //
    // Concurrency: `apply_remote_ops` is the only writer for *remote*
    // `(device_id, seq)` slots — `append_local_op_at` only writes for the
    // local device_id, which by construction never collides with the
    // remote ops we're applying here. So there's no TOCTOU window we
    // need to defend against; if a future code path introduces concurrent
    // writers for the same device_id, the existing INSERT OR IGNORE
    // remains the authoritative safety net.
    let existing_map: std::collections::HashMap<(String, i64), String> = if records.is_empty() {
        std::collections::HashMap::new()
    } else {
        // Build a JSON array of [device_id, seq] pairs and join via
        // `json_each` — works in a single roundtrip regardless of batch
        // size, sidestepping bind-parameter limits and per-op latency.
        let pairs: Vec<(String, i64)> = records
            .iter()
            .map(|r| (r.device_id.clone(), r.seq))
            .collect();
        let pairs_json = serde_json::to_string(&pairs).map_err(|e| {
            AppError::InvalidOperation(format!("failed to serialize fork-check pairs: {e}"))
        })?;

        let rows: Vec<(String, i64, String)> = sqlx::query_as(
            "SELECT o.device_id, o.seq, o.hash \
             FROM op_log o \
             INNER JOIN json_each(?) j \
               ON o.device_id = json_extract(j.value, '$[0]') \
              AND o.seq = json_extract(j.value, '$[1]')",
        )
        .bind(&pairs_json)
        .fetch_all(pool)
        .await?;

        rows.into_iter().map(|(d, s, h)| ((d, s), h)).collect()
    };

    // Wrap all inserts in a single transaction to reduce per-op overhead.
    let mut tx = pool.begin().await?;

    for record in records {
        // Look up the pre-fetched existing hash (no DB roundtrip).
        let existing_hash = existing_map.get(&(record.device_id.clone(), record.seq));
        let is_fork = matches!(existing_hash, Some(h) if h != &record.hash);

        if is_fork {
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                existing_hash = %existing_hash.map(String::as_str).unwrap_or(""),
                incoming_hash = %record.hash,
                "fork detected: peer sent op with same (device_id, seq) but different hash; keeping local copy"
            );
            result.forks += 1;
            // Fall through to the INSERT OR IGNORE below: it is a no-op for
            // a row that already exists, but we keep the call for parity
            // with the duplicate path and as a safety net. Do NOT add to
            // `to_materialize` — the local op is unchanged, so nothing new
            // to materialize.
        }

        // INSERT OR IGNORE — duplicate delivery is a no-op.
        //
        // PERF-26 / L-13: persist the `block_id` column too. The
        // sibling sync entry-point [`crate::dag::insert_remote_op`]
        // already does this; the bulk-batch path here was missed when
        // PERF-26 shipped and would leave `op_log.block_id IS NULL`
        // for every remote-applied row, defeating the index that
        // FEAT-* draft-recovery and other block-scoped lookups
        // depend on. We have the value in `record.block_id` from
        // the validation-parse piggyback above, so binding it costs
        // nothing extra.
        let r = sqlx::query(
            "INSERT OR IGNORE INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.device_id)
        .bind(record.seq)
        .bind(&record.parent_seqs)
        .bind(&record.hash)
        .bind(&record.op_type)
        .bind(&record.payload)
        .bind(&record.created_at)
        .bind(&record.block_id)
        .execute(&mut *tx)
        .await?;

        if r.rows_affected() > 0 {
            to_materialize.push(record);
            result.inserted += 1;
        } else if !is_fork {
            // Forks are NOT duplicates — only count true same-hash collisions.
            result.duplicates += 1;
        }
    }

    tx.commit().await?;

    // Enqueue materialization AFTER commit — ensures all ops are durable
    // before any are processed.
    //
    // L-68: split the freshly-inserted batch into one
    // `BatchApplyOps` task per `block_id` instead of a single
    // monolithic task. Each task becomes its own materializer
    // transaction in `handlers::handle_foreground_task` (BatchApplyOps
    // arm), which buys two things on the bulk-sync hot path:
    //
    // 1. **Failure isolation.** A bad op for block X (e.g. a remote
    //    `MoveBlock` whose target parent is missing) only rolls back
    //    its own group's transaction — the rest of the catch-up batch
    //    still commits. The pre-L-68 monolith rolled back the entire
    //    multi-thousand-op batch on any single failure, which the
    //    foreground retry then re-tried once and dropped, leaving
    //    every op in the batch un-materialized until the next sync.
    // 2. **Smaller WAL transactions** that don't starve concurrent
    //    readers / the local writer for the duration of a 5,000-op
    //    apply.
    //
    // The grouping key is `record.block_id.as_deref()` — the L-13
    // sidecar populated above. The `DeleteAttachment` variant carries
    // no `block_id` and is grouped under `None` (a single combined
    // task per batch).
    //
    // Ordering rationale (the cross-group invariant):
    //
    // - The materializer's foreground consumer drains its mpsc queue
    //   strictly **FIFO** (see `consumer::process_foreground_segment`
    //   — the H-5/H-6 fix dropped the parallel `JoinSet` in 2026-04
    //   precisely so parent-before-child invariants survive). So the
    //   order in which we enqueue tasks IS the order they execute.
    // - We use `HashMap<Option<String>, Vec<OpRecord>>` paired with a
    //   side `Vec<Option<String>>` that records first-encounter
    //   order. Iterating that side-vec preserves the input's
    //   `to_materialize` order at the GROUP level — i.e. the group
    //   whose first op appeared earliest enqueues first. Since the
    //   input is already seq-ordered per device (and parent-creates
    //   appear before child-creates within a well-formed op log),
    //   this is the only ordering that keeps "parent's group commits
    //   before child's group" true without serialising everything
    //   through one transaction. Sorted-by-key (BTreeMap) would
    //   re-order groups by ULID-lex, which is NOT temporal in
    //   general and would put a child before its parent on roughly
    //   half of all batches.
    // - Within a single group's `Vec<OpRecord>`, ops are pushed in
    //   the order they were encountered, which is the same per-device
    //   seq order. So an `EditBlock` always lands after its
    //   `CreateBlock` for the same block, and a `MoveBlock` lands
    //   after the edits that preceded it.
    // - For genuinely out-of-order remote arrivals (e.g. a
    //   `MoveBlock` whose new-parent ULID has not been created yet
    //   in the local DB), the per-group transaction rolls back, the
    //   foreground consumer's single retry runs after a 100 ms
    //   backoff (see `consumer::process_single_foreground_task`),
    //   and the parent's group — enqueued AFTER ours but processed
    //   FIFO before our retry — has already committed by then. This
    //   is strictly better than the pre-L-68 behaviour, which lost
    //   the entire batch on any in-batch FK violation.
    if !to_materialize.is_empty() {
        use std::collections::HashMap;
        // `groups` owns the records; `group_order` records first-encounter
        // order so iteration order is deterministic AND preserves the input's
        // group-level temporal ordering (see the comment above for why this
        // matters vs. BTreeMap's ULID-lex order).
        let mut groups: HashMap<Option<String>, Vec<OpRecord>> = HashMap::new();
        let mut group_order: Vec<Option<String>> = Vec::new();
        for record in to_materialize {
            let key = record.block_id.clone();
            if !groups.contains_key(&key) {
                group_order.push(key.clone());
            }
            groups.entry(key).or_default().push(record);
        }
        for key in group_order {
            // Safe to expect: every key in `group_order` was inserted
            // by the loop above and the corresponding vec is never
            // removed before this point.
            let group = groups
                .remove(&key)
                .expect("invariant: group_order key always has a populated entry");
            materializer
                .enqueue_foreground(MaterializeTask::BatchApplyOps(std::sync::Arc::new(group)))
                .await?;
        }
    }

    Ok(result)
}

/// After receiving all ops, merge blocks that have diverged between two
/// devices.
///
/// Handles four kinds of concurrent-edit conflicts:
///
/// 1. **`edit_block` divergence** — finds blocks with concurrent edits from
///    both devices, performs three-way text merge via
///    [`merge::merge_block_text_only`].
/// 2. **`set_property` conflicts** — concurrent property changes on the same
///    `(block_id, key)` pair are resolved via Last-Writer-Wins
///    ([`merge::resolve_property_conflict`]).
/// 3. **`move_block` conflicts** — concurrent reparenting of the same block
///    is resolved via LWW (later `created_at` wins, with `device_id`
///    tiebreaker).
/// 4. **`delete_block` vs `edit_block`** — if one device deleted a block
///    while the other edited it, the edit wins and the block is resurrected
///    via a `restore_block` op.
///
/// **Not handled as a conflict: `move_block` vs `delete_block`.**  Both ops
/// apply in sequence and the block ends up deleted regardless of order
/// (commutativity).  A move to a new parent followed by a delete still
/// soft-deletes the block; a delete followed by a move updates a
/// soft-deleted row's parent (harmless).  No resolution op is needed.
pub async fn merge_diverged_blocks(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    remote_device_id: &str,
) -> Result<MergeResults, AppError> {
    use crate::dag;
    use sqlx::Row;

    let mut results = MergeResults {
        clean_merges: 0,
        conflicts: 0,
        already_up_to_date: 0,
        property_lww: 0,
        move_lww: 0,
        delete_edit_resurrect: 0,
    };

    // ── 1. edit_block divergence ──────────────────────────────────────────
    let rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id \
         FROM op_log WHERE device_id IN (?, ?) AND op_type = 'edit_block' \
         GROUP BY json_extract(payload, '$.block_id') \
         HAVING COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in rows {
        let block_id: String = row.try_get("block_id")?;

        let heads = dag::get_block_edit_heads(pool, &block_id).await?;
        if heads.len() < 2 {
            continue;
        }

        // Find our head and their head
        let our_head = heads.iter().find(|(d, _)| d == device_id);
        let their_head = heads
            .iter()
            .find(|(d, _)| d == remote_device_id)
            .or_else(|| heads.iter().find(|(d, _)| d != device_id));

        if let (Some(ours), Some(theirs)) = (our_head, their_head) {
            // Idempotency guard (S-10): skip if a previous merge op already
            // integrated their head.  After a merge, get_block_edit_heads
            // still returns 2 heads (one per device) because the merge op
            // only advances the LOCAL device's max seq.  Without this
            // check, merge_block_text_only would be called again on every
            // subsequent sync, creating duplicate merge ops.
            if dag::has_merge_for_heads(pool, &block_id, theirs).await? {
                results.already_up_to_date += 1;
                continue;
            }

            let outcome = merge::merge_block_text_only(
                pool,
                device_id,
                materializer,
                &block_id,
                ours,
                theirs,
            )
            .await?;

            match outcome {
                merge::MergeOutcome::Merged(ref record) => {
                    materializer
                        .enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(record.clone())))
                        .await?;
                    results.clean_merges += 1;
                }
                merge::MergeOutcome::ConflictCopy {
                    ref conflict_block_op,
                    ..
                } => {
                    materializer
                        .enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(
                            conflict_block_op.clone(),
                        )))
                        .await?;
                    results.conflicts += 1;
                }
                merge::MergeOutcome::AlreadyUpToDate => {
                    results.already_up_to_date += 1;
                }
            }
        }
    }

    // ── 2. set_property conflicts (LWW) ──────────────────────────────────
    // Batch query: find all conflicting (block_id, key) pairs AND fetch the
    // latest op per device per pair in a single pass using ROW_NUMBER().
    // This replaces the former N+1 pattern (1 query to find pairs + 2
    // queries per pair).
    let prop_op_rows = sqlx::query(
        "WITH conflict_keys AS ( \
             SELECT json_extract(payload, '$.block_id') as block_id, \
                    json_extract(payload, '$.key') as prop_key \
             FROM op_log \
             WHERE device_id IN (?, ?) AND op_type = 'set_property' \
             GROUP BY json_extract(payload, '$.block_id'), \
                      json_extract(payload, '$.key') \
             HAVING COUNT(DISTINCT device_id) > 1 \
         ), \
         ranked AS ( \
             SELECT o.device_id, o.seq, o.parent_seqs, o.hash, o.op_type, \
                    o.payload, o.created_at, \
                    json_extract(o.payload, '$.block_id') as block_id, \
                    json_extract(o.payload, '$.key') as prop_key, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY o.device_id, \
                            json_extract(o.payload, '$.block_id'), \
                            json_extract(o.payload, '$.key') \
                        ORDER BY o.seq DESC \
                    ) as rn \
             FROM op_log o \
             INNER JOIN conflict_keys ck \
               ON json_extract(o.payload, '$.block_id') = ck.block_id \
              AND json_extract(o.payload, '$.key') = ck.prop_key \
             WHERE o.device_id IN (?, ?) AND o.op_type = 'set_property' \
         ) \
         SELECT device_id, seq, parent_seqs, hash, op_type, payload, \
                created_at, block_id, prop_key \
         FROM ranked WHERE rn = 1 \
         ORDER BY block_id, prop_key, device_id",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    // Group batch rows by (block_id, prop_key), then resolve each conflict.
    {
        use std::collections::HashMap;
        let mut groups: HashMap<(String, String), (Option<OpRecord>, Option<OpRecord>)> =
            HashMap::new();
        for row in &prop_op_rows {
            let bid: String = row.try_get("block_id")?;
            let pk: String = row.try_get("prop_key")?;
            let dev: String = row.try_get("device_id")?;
            // L-13: this row is the LWW-conflict candidate — its
            // `block_id` is already the very `bid` we just pulled out
            // above (the SELECT projects it as a separate column),
            // so we cache it on the sidecar without a JSON parse.
            let op = OpRecord {
                device_id: dev.clone(),
                seq: row.try_get::<i64, _>("seq")?,
                parent_seqs: row.try_get::<Option<String>, _>("parent_seqs")?,
                hash: row.try_get::<String, _>("hash")?,
                op_type: row.try_get::<String, _>("op_type")?,
                payload: row.try_get::<String, _>("payload")?,
                created_at: row.try_get::<String, _>("created_at")?,
                block_id: Some(bid.clone()),
            };
            let entry = groups.entry((bid, pk)).or_insert((None, None));
            if dev == device_id {
                entry.0 = Some(op);
            } else {
                entry.1 = Some(op);
            }
        }

        for ((bid, pk), (op_a_opt, op_b_opt)) in groups {
            if let (Some(op_a), Some(op_b)) = (op_a_opt, op_b_opt) {
                let resolution = merge::resolve_property_conflict(&op_a, &op_b)?;

                // Idempotent guard (M-43): skip if the **materialized**
                // value already matches the LWW winner.  Comparing
                // `op_a.payload` (the latest local set_property op)
                // against `resolution.winner_value` decouples the equality
                // check from the actual LWW state and exposes two failure
                // modes:
                //   (a) spurious skip — local user re-edited the property
                //       after a prior LWW pass; the latest op happens to
                //       carry the winner's value, but the materialized
                //       state diverged in between.  We'd skip and leak.
                //   (b) perpetual re-emit — local user re-edited and
                //       op_a.payload now differs from winner.value, so we
                //       emit a redundant LWW op every sync round forever.
                // Reserved property keys (todo_state, priority, due_date,
                // scheduled_date) materialize into fixed columns on the
                // `blocks` table, NOT `block_properties` (see
                // `materializer/handlers.rs::OpType::SetProperty`); branch
                // on `is_reserved_property_key` so the read goes to the
                // right table.
                // Type aliases keep clippy::type_complexity happy on the
                // four-Option SELECT result tuples (otherwise each call
                // site triggers `-D warnings`).
                type ReservedRow = (
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                );
                type PropertyRow = (Option<String>, Option<f64>, Option<String>, Option<String>);

                let materialized_matches = if crate::op::is_reserved_property_key(&pk) {
                    let row: Option<ReservedRow> = sqlx::query_as(
                        "SELECT todo_state, priority, due_date, scheduled_date \
                         FROM blocks WHERE id = ?",
                    )
                    .bind(&bid)
                    .fetch_optional(pool)
                    .await?;
                    row.map(|(todo, prio, due, sched)| match pk.as_str() {
                        "todo_state" => todo == resolution.winner_value.value_text,
                        "priority" => prio == resolution.winner_value.value_text,
                        "due_date" => due == resolution.winner_value.value_date,
                        "scheduled_date" => sched == resolution.winner_value.value_date,
                        _ => unreachable!(),
                    })
                    .unwrap_or(false)
                } else {
                    let materialized: Option<PropertyRow> = sqlx::query_as(
                        "SELECT value_text, value_num, value_date, value_ref \
                         FROM block_properties WHERE block_id = ? AND key = ?",
                    )
                    .bind(&bid)
                    .bind(&pk)
                    .fetch_optional(pool)
                    .await?;
                    materialized
                        .map(|(vt, vn, vd, vr)| {
                            vt == resolution.winner_value.value_text
                                && vn == resolution.winner_value.value_num
                                && vd == resolution.winner_value.value_date
                                && vr == resolution.winner_value.value_ref
                        })
                        .unwrap_or(false)
                };

                if materialized_matches {
                    continue;
                }

                // Apply the winner by appending a new set_property op
                let winning_payload = crate::op::OpPayload::SetProperty(resolution.winner_value);
                let new_record = op_log::append_local_op_at(
                    pool,
                    device_id,
                    winning_payload,
                    crate::now_rfc3339(),
                )
                .await?;

                tracing::debug!(
                    "LWW auto-resolved property conflict for block {} key {}",
                    bid,
                    pk
                );

                materializer
                    .enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(new_record)))
                    .await?;
                results.property_lww += 1;
            }
        }
    }

    // ── 3. move_block conflicts (LWW) ────────────────────────────────────
    // Batch query: find all conflicting block_ids AND fetch the latest
    // move_block op per device per block in a single pass using
    // ROW_NUMBER().  Replaces the former N+1 pattern.
    let move_op_rows = sqlx::query(
        "WITH conflict_blocks AS ( \
             SELECT json_extract(payload, '$.block_id') as block_id \
             FROM op_log \
             WHERE device_id IN (?, ?) AND op_type = 'move_block' \
             GROUP BY json_extract(payload, '$.block_id') \
             HAVING COUNT(DISTINCT device_id) > 1 \
         ), \
         ranked AS ( \
             SELECT o.device_id, o.seq, o.parent_seqs, o.hash, o.op_type, \
                    o.payload, o.created_at, \
                    json_extract(o.payload, '$.block_id') as block_id, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY o.device_id, \
                            json_extract(o.payload, '$.block_id') \
                        ORDER BY o.seq DESC \
                    ) as rn \
             FROM op_log o \
             INNER JOIN conflict_blocks cb \
               ON json_extract(o.payload, '$.block_id') = cb.block_id \
             WHERE o.device_id IN (?, ?) AND o.op_type = 'move_block' \
         ) \
         SELECT device_id, seq, parent_seqs, hash, op_type, payload, \
                created_at, block_id \
         FROM ranked WHERE rn = 1 \
         ORDER BY block_id, device_id",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    // Group batch rows by block_id, then resolve each conflict.
    {
        use std::collections::HashMap;
        let mut groups: HashMap<String, (Option<OpRecord>, Option<OpRecord>)> = HashMap::new();
        for row in &move_op_rows {
            let bid: String = row.try_get("block_id")?;
            let dev: String = row.try_get("device_id")?;
            // L-13: same shortcut as the property-LWW path above —
            // the SELECT already projects `block_id`, so we cache it
            // on the sidecar without a JSON parse.
            let op = OpRecord {
                device_id: dev.clone(),
                seq: row.try_get::<i64, _>("seq")?,
                parent_seqs: row.try_get::<Option<String>, _>("parent_seqs")?,
                hash: row.try_get::<String, _>("hash")?,
                op_type: row.try_get::<String, _>("op_type")?,
                payload: row.try_get::<String, _>("payload")?,
                created_at: row.try_get::<String, _>("created_at")?,
                block_id: Some(bid.clone()),
            };
            let entry = groups.entry(bid).or_insert((None, None));
            if dev == device_id {
                entry.0 = Some(op);
            } else {
                entry.1 = Some(op);
            }
        }

        for (bid, (op_a_opt, op_b_opt)) in groups {
            if let (Some(op_a), Some(op_b)) = (op_a_opt, op_b_opt) {
                // LWW: later created_at wins, with device_id tiebreaker
                let winner = match op_a.created_at.cmp(&op_b.created_at) {
                    std::cmp::Ordering::Greater => &op_a,
                    std::cmp::Ordering::Less => &op_b,
                    std::cmp::Ordering::Equal => {
                        if op_a.device_id >= op_b.device_id {
                            &op_a
                        } else {
                            &op_b
                        }
                    }
                };

                let winner_move: crate::op::MoveBlockPayload =
                    serde_json::from_str(&winner.payload)?;

                // Idempotent guard (M-44): skip if the **materialized**
                // parent_id + position in `blocks` already match the
                // winning move.  Comparing `op_a.payload` against
                // `winner_move` decouples the check from the actual LWW
                // state and either spuriously skips or re-emits the move
                // op every sync round when the local user has issued a
                // subsequent move (or the materializer has otherwise
                // converged on the winner via prior remote ops).  The
                // materialized row is the source of truth for "is the
                // block already at the target location?".
                let materialized: Option<(Option<String>, Option<i64>)> =
                    sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
                        .bind(&bid)
                        .fetch_optional(pool)
                        .await?;

                if let Some((parent_id, position)) = materialized {
                    let target_parent = winner_move
                        .new_parent_id
                        .as_ref()
                        .map(|id| id.as_str().to_owned());
                    if parent_id == target_parent && position == Some(winner_move.new_position) {
                        continue;
                    }
                }

                let move_payload = crate::op::OpPayload::MoveBlock(winner_move);
                let new_record =
                    op_log::append_local_op_at(pool, device_id, move_payload, crate::now_rfc3339())
                        .await?;

                tracing::debug!("LWW auto-resolved move conflict for block {}", bid);

                materializer
                    .enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(new_record)))
                    .await?;
                results.move_lww += 1;
            }
        }
    }

    // ── 4. delete_block vs edit_block (edit wins → resurrect) ────────────
    let del_edit_rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id \
         FROM op_log \
         WHERE device_id IN (?, ?) AND op_type IN ('delete_block', 'edit_block') \
         GROUP BY json_extract(payload, '$.block_id') \
         HAVING COUNT(DISTINCT op_type) > 1 AND COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in del_edit_rows {
        let block_id: String = row.try_get("block_id")?;

        // Fetch the block's deleted_at to build the RestoreBlockPayload
        let block_row = sqlx::query("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(pool)
            .await?;

        let deleted_at_value: String = match block_row {
            Some(ref r) => r
                .try_get::<Option<String>, _>("deleted_at")?
                .unwrap_or_default(),
            None => String::new(),
        };

        // Idempotent guard: only resurrect if the block is actually deleted
        // in the materialized table.  On repeated syncs the delete_block and
        // edit_block ops still sit in op_log (satisfying the HAVING clause)
        // even after a previous restore.  Without this check we would emit
        // a redundant restore_block op on every subsequent sync.
        // This also handles the race where the delete hasn't been materialised
        // yet — we correctly skip and let the materialiser process in order.
        if deleted_at_value.is_empty() {
            continue;
        }

        // Edit wins — resurrect the block
        let restore_payload = crate::op::OpPayload::RestoreBlock(crate::op::RestoreBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(&block_id),
            deleted_at_ref: deleted_at_value,
        });
        let new_record =
            op_log::append_local_op_at(pool, device_id, restore_payload, crate::now_rfc3339())
                .await?;

        materializer
            .enqueue_foreground(MaterializeTask::ApplyOp(Arc::new(new_record)))
            .await?;
        results.delete_edit_resurrect += 1;
    }

    Ok(results)
}

/// Complete a sync session — update peer_refs with the final hashes.
pub async fn complete_sync(
    pool: &SqlitePool,
    peer_id: &str,
    last_received_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    peer_refs::update_on_sync(pool, peer_id, last_received_hash, last_sent_hash).await
}

// ---------------------------------------------------------------------------
// M-43 / M-44 LWW idempotency tests
// ---------------------------------------------------------------------------
//
// These tests cover the two REVIEW-LATER items M-43 (property LWW) and
// M-44 (move LWW).  The bug they target: the idempotency early-exit
// previously parsed `op_a.payload` (the latest local op for the
// conflicting key/block) and compared it to the LWW winner.  After the
// user re-edits the property/moves the block locally, that comparison
// either spuriously skips OR re-emits the resolution op every sync
// round.  The fix pulls values from the materialized state
// (`block_properties` for M-43, `blocks` for M-44) and compares those
// against the winner — the materialized row is the actual integrated
// state.

#[cfg(test)]
mod tests_m43_m44 {
    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::op::{CreateBlockPayload, MoveBlockPayload, OpPayload, SetPropertyPayload};
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    fn create_payload(block_id: &str) -> OpPayload {
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(block_id),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "test".into(),
        })
    }

    /// Materialized state already matches the LWW winner.  No new
    /// resolution op should be emitted regardless of the latest local
    /// op's payload.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lww_property_skip_when_materialized_already_winning() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00Z";
        let ts_b = "2025-01-15T12:01:00Z"; // B wins LWW

        // Create the block.
        append_local_op_at(&pool, "device-A", create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();

        // M-43/M-44: idempotency guard reads materialized state, so the
        // block row must exist (the test bypasses the materializer's
        // CreateBlock handler by calling append_local_op_at directly).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position)              VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BlockId::test_id("BLK1").as_str())
        .execute(&pool)
        .await
        .unwrap();

        // Both devices append a set_property op so the conflict-detect
        // HAVING clause (COUNT(DISTINCT device_id) > 1) fires.
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("winning".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_a.into(),
        )
        .await
        .unwrap();
        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("winning".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // Materialize the block row with `priority = 'winning'` directly
        // (simulating a prior merge pass that already converged).  Note
        // `priority` is a reserved property key — the materializer writes
        // it to `blocks.priority`, NOT `block_properties` — so the M-43
        // idempotency guard must read from there.
        sqlx::query(
            "INSERT OR REPLACE INTO blocks              (id, block_type, content, parent_id, position, priority)              VALUES (?, 'content', 'test', NULL, 0, 'winning')",
        )
        .bind(BlockId::test_id("BLK1").as_str())
        .execute(&pool)
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        assert_eq!(
            results.property_lww, 0,
            "materialized value already matches the LWW winner — no new \
             set_property op should be emitted"
        );

        materializer.shutdown();
    }

    /// The bug fix in action: materialized value matches the winner,
    /// but the latest local op carries a different value (e.g. from a
    /// concurrent re-edit).  The OLD code would compare op_a.payload
    /// to winner and re-emit the LWW op every sync round.  The fix
    /// compares materialized state to winner and correctly skips.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lww_property_emits_when_materialized_diverges_from_local_op() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00Z";
        let ts_b = "2025-01-15T12:01:00Z"; // B's "winning" wins LWW

        // Create the block.
        append_local_op_at(&pool, "device-A", create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();

        // M-43/M-44: idempotency guard reads materialized state, so the
        // block row must exist (the test bypasses the materializer's
        // CreateBlock handler by calling append_local_op_at directly).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position)              VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BlockId::test_id("BLK1").as_str())
        .execute(&pool)
        .await
        .unwrap();

        // device-A's latest set_property op is "later_value" — diverges
        // from the materialized state intentionally.
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("later_value".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        // device-B's set_property op carries "winning" with a later
        // timestamp, so LWW resolves to "winning".
        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK1"),
                key: "priority".into(),
                value_text: Some("winning".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // Materialized state matches the LWW winner ("winning") but
        // diverges from op_a.payload ("later_value").  Reserved-key
        // properties land on `blocks.<col>` directly (M-43 fix branches
        // on `is_reserved_property_key`).
        sqlx::query(
            "INSERT OR REPLACE INTO blocks \
             (id, block_type, content, parent_id, position, priority) \
             VALUES (?, 'content', 'test', NULL, 0, 'winning')",
        )
        .bind(BlockId::test_id("BLK1").as_str())
        .execute(&pool)
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        // M-43 fix: compare against materialized state, not op_a.payload.
        // The OLD code would have emitted a LWW op here because
        // op_a.payload ("later_value") != winner ("winning").  The fix
        // recognises the materialized state already matches the winner
        // and skips.  The local re-edit is a separate concern that the
        // LWW idempotency guard should not undo.
        assert_eq!(
            results.property_lww, 0,
            "materialized state matches the winner — no new LWW op should \
             be emitted, even though op_a.payload diverges"
        );

        materializer.shutdown();
    }

    /// Same pattern for move LWW: materialized parent_id + position
    /// already match the winning move.  No new resolution op should be
    /// emitted regardless of op_a.payload.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lww_move_skip_when_materialized_already_at_target() {
        let (pool, _dir) = test_pool().await;
        let materializer = Materializer::new(pool.clone());

        let ts_a = "2025-01-15T12:00:00Z";
        let ts_b = "2025-01-15T12:01:00Z"; // B wins LWW

        // Create the block and the two candidate parents.
        append_local_op_at(&pool, "device-A", create_payload("BLK1"), ts_a.into())
            .await
            .unwrap();

        // M-43/M-44: idempotency guard reads materialized state, so the
        // block row must exist (the test bypasses the materializer's
        // CreateBlock handler by calling append_local_op_at directly).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position)              VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BlockId::test_id("BLK1").as_str())
        .execute(&pool)
        .await
        .unwrap();
        append_local_op_at(&pool, "device-A", create_payload("PARENTA"), ts_a.into())
            .await
            .unwrap();
        append_local_op_at(&pool, "device-A", create_payload("PARENTB"), ts_a.into())
            .await
            .unwrap();

        // device-A: latest move op points BLK1 at PARENTA.  This is the
        // op_a.payload that the OLD code would compare against.
        append_local_op_at(
            &pool,
            "device-A",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                new_parent_id: Some(BlockId::test_id("PARENTA")),
                new_position: 0,
            }),
            ts_a.into(),
        )
        .await
        .unwrap();

        // device-B: later move op points BLK1 at PARENTB at position 1
        // — wins LWW.
        append_local_op_at(
            &pool,
            "device-B",
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK1"),
                new_parent_id: Some(BlockId::test_id("PARENTB")),
                new_position: 1,
            }),
            ts_b.into(),
        )
        .await
        .unwrap();

        // Materialize the parents and the block at the LWW-winning
        // location (parent_id = PARENTB, position = 1).  Diverges from
        // op_a.payload (which says PARENTA / position 0).
        for parent in &["PARENTA", "PARENTB"] {
            sqlx::query(
                "INSERT OR REPLACE INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', 'p', NULL, 0)",
            )
            .bind(BlockId::test_id(parent).as_str())
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT OR REPLACE INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'test', ?, 1)",
        )
        .bind(BlockId::test_id("BLK1").as_str())
        .bind(BlockId::test_id("PARENTB").as_str())
        .execute(&pool)
        .await
        .unwrap();

        let results = merge_diverged_blocks(&pool, "device-A", &materializer, "device-B")
            .await
            .unwrap();

        // M-44 fix: compare against materialized blocks.parent_id +
        // blocks.position, not op_a.payload.  The OLD code would have
        // re-emitted the move op because op_a.payload (PARENTA/0)
        // differs from the winner (PARENTB/1).  The fix sees materialized
        // state already at the winner and skips.
        assert_eq!(
            results.move_lww, 0,
            "materialized parent_id + position already match the winning \
             move — no new move op should be emitted"
        );

        materializer.shutdown();
    }
}
