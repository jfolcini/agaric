//! #3226 — durable quarantine for permanently-stuck Loro-sync inbox slots.
//!
//! # Why this exists
//!
//! [`super::loro_sync::import_and_project`] KEEPS a write-ahead
//! `loro_sync_inbox` slot whose blob's declared end frontier the post-import
//! `oplog_vv()` did not reach (#3194 for the batch replay path, #3213 for the
//! live `apply_remote` and per-row `replay_inbox_row` paths). That is the
//! #535-correct direction: the payload parked in loro's `pending_changes`, so it
//! reached neither the op-log nor SQL, and the slot row is its ONLY durable copy.
//!
//! The cost is that a *permanently* unsatisfiable slot — a truncated or corrupt
//! blob, or a sender that declared a base it will never supply — is re-imported
//! once per boot, logged as an error, indefinitely, with no path to resolution.
//! Both #3194 and #3213 considered a retry CAP and rejected it, correctly: the
//! only bound available *without new storage* is deleting the row, which is
//! precisely the violation the check exists to prevent. A cap would trade a
//! bounded, visible annoyance for unbounded, silent data loss.
//!
//! This module is the new storage that makes a bound honest. A slot that stays
//! unresolved across [`QUARANTINE_AFTER_BOOTS`] boot replays is **moved** —
//! inside one transaction, never copied and never dropped — into
//! `loro_sync_quarantine`. The bytes stay durable (#535 is satisfied exactly as
//! it was by keeping the slot), the retry loop terminates, and the stuck blob
//! becomes queryable via [`list_quarantined_slots`] instead of log-only.
//!
//! # What counts as "a boot"
//!
//! Only the boot walk (`recovery::sync_inbox::replay_sync_inbox` →
//! [`super::loro_sync::replay_inbox_batch`]) calls [`note_unresolved_slot`].
//! The live `apply_remote` path INSERTs a fresh row per delivery, so a live keep
//! is always attempt #0 of a brand-new slot and must not count toward any
//! budget; counting it would let three redeliveries of one unsatisfiable blob
//! quarantine themselves before a single retry had run.
//!
//! Within a boot, a slot is noted at most once: `replay_sync_inbox` advances its
//! `id > last_seen` cursor past every row BEFORE attempting it, and inside
//! `replay_inbox_batch` a slot is accounted for in EITHER the batch-success arm
//! or the per-row fallback arm, never both (the fallback runs only when the
//! batch returned `Err`, which happens before any slot is cleared).
//!
//! # The counter is cumulative, and that is the same as consecutive
//!
//! `loro_sync_inbox.unresolved_boots` only ever increases, but there is no state
//! in which a slot "recovers" and keeps its row: the sole exits from the inbox
//! are (a) its projection committing, which DELETEs it in the same transaction,
//! (b) a #792 / #1054 gate dropping it, and (c) this quarantine move. So a slot
//! that reaches N has genuinely failed N boots in a row.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use agaric_core::error::AppError;
use loro::{Counter, PeerID};

/// #3226 — how many boot replays may observe a slot unresolved before it is
/// moved to durable quarantine.
///
/// ## Why 5, and not 1, 2 or 50
///
/// The floor is set by the case this must NOT catch. The overwhelmingly common
/// reason a slot is kept is transient: a blob whose dependency arrives in a
/// LATER live message. That heals at the very next boot, when the replay
/// re-imports the kept blob against an engine that now holds the dep and the
/// slot clears — pinned end-to-end, across a real persist + rehydrate boundary,
/// by `kept_slot_self_heals_at_the_next_boot_once_the_dependency_lands_3213`.
/// So N = 1 would quarantine exactly the population that self-heals, and N = 2
/// leaves no margin at all above it.
///
/// The margin above that floor is for the slower variant of the same transient
/// case: the dependency exists, but on a peer that is not currently reachable,
/// so it cannot arrive until that peer syncs again. That is bounded by SYNC
/// cadence, not boot cadence, and the two are unrelated — a user who launches
/// the app several times in an afternoon while the other device stays off gets
/// several "boots" out of one sync opportunity. Four further boots is the slack
/// bought for that, chosen to be comfortably more than one and small enough that
/// a genuinely dead blob stops erroring within days rather than never.
///
/// The ceiling is soft: quarantining is not destructive (the bytes move intact,
/// and [`readmit_quarantined_slot`] puts them back), so erring low costs a
/// diagnostic entry, while erring high costs the exact "an error every boot
/// forever" this issue exists to end. 5 sits deliberately near the low end of
/// that asymmetry.
///
/// Not measured from production telemetry — none exists for this path. This is a
/// reasoned choice from the mechanism, and it is stated as such rather than
/// dressed up as an empirical threshold.
pub const QUARANTINE_AFTER_BOOTS: i64 = 5;

/// What [`note_unresolved_slot`] did with the slot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlotDisposition {
    /// Still in `loro_sync_inbox`; a later boot will retry it.
    Kept {
        /// The slot's `unresolved_boots` AFTER this observation.
        unresolved_boots: i64,
    },
    /// Moved to `loro_sync_quarantine`. No boot will retry it again.
    Quarantined {
        /// The slot's `unresolved_boots` at the moment it was moved
        /// (>= [`QUARANTINE_AFTER_BOOTS`]).
        unresolved_boots: i64,
    },
    /// The inbox row was already gone when we looked (a concurrent replay
    /// cleared it). Nothing to account for.
    Gone,
}

/// One row of `loro_sync_quarantine`, as surfaced to diagnostics.
///
/// Deliberately carries `byte_len` rather than `bytes`: the point of the listing
/// is "what is stuck, since when, and why", and a diagnostics call must not
/// materialize multi-MB payloads. The bytes are still there — see
/// [`read_quarantined_bytes`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuarantinedSlot {
    /// `loro_sync_quarantine.id`.
    pub id: i64,
    /// The `loro_sync_inbox.id` this was moved from (provenance / log
    /// correlation only — that row no longer exists).
    pub inbox_id: i64,
    pub space_id: String,
    /// Size of the preserved blob in bytes. Non-zero for every row: the move is
    /// a straight `INSERT … SELECT` of the inbox row's `bytes`.
    pub byte_len: i64,
    /// JSON array of `[peer_id, counter]` pairs — the frontier the blob
    /// declared. `[]` for a blob that declared nothing or would not decode.
    pub declared_end_vv: String,
    /// The last observed reason the slot did not clear.
    pub last_reason: String,
    /// How many boot replays observed it unresolved before the move.
    pub unresolved_boots: i64,
    /// When the blob was first durably admitted (the inbox row's `created_at`).
    pub first_seen_at_ms: i64,
    pub quarantined_at_ms: i64,
}

/// Encode a declared end frontier for the `declared_end_vv` column.
///
/// `PeerID` is a `u64`, which JSON numbers (f64) cannot represent exactly, so
/// peers are stringified. Round-trips through `serde_json` for reading.
fn encode_declared_end_vv(end_vv: &[(PeerID, Counter)]) -> String {
    let pairs: Vec<(String, i64)> = end_vv
        .iter()
        .map(|(peer, counter)| (peer.to_string(), i64::from(*counter)))
        .collect();
    // A `Vec<(String, i64)>` cannot fail to serialize; fall back to `[]` rather
    // than propagating an impossible error onto the crash-recovery path.
    serde_json::to_string(&pairs).unwrap_or_else(|_| "[]".to_string())
}

/// Record that a boot replay observed `inbox_id` still unresolved, and move it
/// to durable quarantine once the budget is spent.
///
/// `reason` is the observation itself: `LoroEngine::oplog_shortfall`'s
/// diagnostic when the slot was KEPT by the #3194/#3213 frontier rule, or the
/// replay error when the blob could not be imported at all. Both are terminal in
/// the same way if they persist, and the issue names both populations
/// ("truncated blob, corrupt payload, or a sender that declared a base it will
/// never supply"), so both count.
///
/// # The move preserves the #535 invariant
///
/// The `INSERT … SELECT` and the `DELETE` share ONE transaction, so the blob is
/// in exactly one of the two tables at every observable instant — it can never
/// be absent from both. That is the same atomicity argument
/// `import_and_project`'s Phase-2 tx makes for "a slot is deleted IFF its
/// projection committed"; here it is "a slot leaves the inbox IFF the quarantine
/// row exists". Nothing is deleted before its content is durable somewhere else,
/// which is the whole of #535.
pub async fn note_unresolved_slot(
    pool: &SqlitePool,
    inbox_id: i64,
    declared_end_vv: &[(PeerID, Counter)],
    reason: &str,
) -> Result<SlotDisposition, AppError> {
    // System-level crash-recovery storage, not a user-edit path: this tx writes
    // no `op_log` row and no derived cache, and exists ONLY to make the
    // inbox→quarantine MOVE atomic (see the #535 argument above), so there is
    // no post-commit materializer dispatch for `CommandTx` to couple to.
    // allow-raw-tx: #110 — system-level write-ahead storage, no op_log write.
    let mut tx = agaric_store::db::begin_immediate_logged(pool, "sync_inbox_quarantine").await?;

    // Only the counter is read here; `created_at` is carried into the
    // quarantine row by the `INSERT … SELECT` below without a round trip.
    let Some(row) = sqlx::query!(
        "SELECT unresolved_boots FROM loro_sync_inbox WHERE id = ?",
        inbox_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    else {
        // A concurrent replay already cleared it — nothing to account for, and
        // certainly nothing to quarantine.
        tx.commit().await?;
        return Ok(SlotDisposition::Gone);
    };

    let unresolved_boots = row.unresolved_boots.saturating_add(1);

    if unresolved_boots < QUARANTINE_AFTER_BOOTS {
        sqlx::query!(
            "UPDATE loro_sync_inbox SET unresolved_boots = ? WHERE id = ?",
            unresolved_boots,
            inbox_id,
        )
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(SlotDisposition::Kept { unresolved_boots });
    }

    let declared_json = encode_declared_end_vv(declared_end_vv);
    let now = agaric_store::db::now_ms();
    // `INSERT … SELECT` so the blob never round-trips through memory: SQLite
    // copies it inside the transaction. `first_seen_at_ms` is the inbox row's
    // own `created_at` (INTEGER epoch-ms, migration 0084 — same encoding).
    sqlx::query!(
        "INSERT INTO loro_sync_quarantine \
           (inbox_id, space_id, bytes, purged_ids, declared_end_vv, last_reason, \
            unresolved_boots, first_seen_at_ms, quarantined_at_ms) \
         SELECT id, space_id, bytes, purged_ids, ?, ?, ?, created_at, ? \
           FROM loro_sync_inbox WHERE id = ?",
        declared_json,
        reason,
        unresolved_boots,
        now,
        inbox_id,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!("DELETE FROM loro_sync_inbox WHERE id = ?", inbox_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(SlotDisposition::Quarantined { unresolved_boots })
}

/// Every quarantined blob, newest first. The diagnostics read surface.
///
/// This is what makes a stuck blob discoverable without reading logs: it names
/// the space, when the payload was first admitted, how many boots it survived,
/// and the last reason it would not settle.
pub async fn list_quarantined_slots(pool: &SqlitePool) -> Result<Vec<QuarantinedSlot>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id as "id!: i64", inbox_id, space_id,
                  LENGTH(bytes) as "byte_len!: i64",
                  declared_end_vv, last_reason, unresolved_boots,
                  first_seen_at_ms, quarantined_at_ms
           FROM loro_sync_quarantine
           ORDER BY quarantined_at_ms DESC, id DESC"#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| QuarantinedSlot {
            id: r.id,
            inbox_id: r.inbox_id,
            space_id: r.space_id,
            byte_len: r.byte_len,
            declared_end_vv: r.declared_end_vv,
            last_reason: r.last_reason,
            unresolved_boots: r.unresolved_boots,
            first_seen_at_ms: r.first_seen_at_ms,
            quarantined_at_ms: r.quarantined_at_ms,
        })
        .collect())
}

/// How many blobs are currently quarantined. Surfaced in the boot
/// `RecoveryReport` so a non-zero value is visible without a separate query.
pub async fn count_quarantined_slots(pool: &SqlitePool) -> Result<u64, AppError> {
    let n = sqlx::query_scalar!(r#"SELECT COUNT(*) as "n!: i64" FROM loro_sync_quarantine"#)
        .fetch_one(pool)
        .await?;
    Ok(u64::try_from(n).unwrap_or(0))
}

/// The preserved bytes of one quarantined slot, or `None` if the id is unknown.
///
/// The #535 proof obligation in one call: what went into quarantine can be read
/// back out, byte-identical. Used by the invariant test and by any future
/// export-to-bug-report tooling.
pub async fn read_quarantined_bytes(
    pool: &SqlitePool,
    quarantine_id: i64,
) -> Result<Option<Vec<u8>>, AppError> {
    let row = sqlx::query!(
        "SELECT bytes FROM loro_sync_quarantine WHERE id = ?",
        quarantine_id,
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.bytes))
}

/// Move a quarantined blob back into `loro_sync_inbox` so the next boot replays
/// it. Returns the new `loro_sync_inbox.id`, or `None` if the id is unknown.
///
/// # Re-admission is MANUAL ONLY — the decision, and why (#3226)
///
/// A quarantined blob is **never** re-admitted automatically. Nothing in the
/// boot path, the live apply path, or any background task reads
/// `loro_sync_quarantine` back into the inbox. The only route back is an
/// explicit call to this function.
///
/// The alternative the issue raises — re-admit when the missing dependency
/// finally arrives — was rejected for three reasons:
///
/// * **The cheap trigger is the loop we are ending.** The only trigger available
///   without new machinery is "try again at boot", which is exactly the
///   once-per-boot retry that quarantine exists to terminate. Automatic
///   re-admission on a schedule reintroduces the problem under a new name; it
///   just makes the error message rarer.
/// * **The precise trigger is not cheap.** Detecting "the dep finally arrived"
///   means testing every quarantined blob's declared frontier against
///   `oplog_vv()` after every import — per-import work proportional to the size
///   of the quarantine, on the hot inbound path, on behalf of blobs that have by
///   construction already failed [`QUARANTINE_AFTER_BOOTS`] consecutive boots.
///   The population that would benefit is the one we have the most evidence
///   against.
/// * **Sync already has a repair path, and it is better than this one.** A blob
///   sits in quarantine because its content reached neither our op-log nor our
///   SQL. In the recoverable case the peer that sent it still holds those ops,
///   and the protocol's own machinery fetches them: `from_vv` reachability
///   failure routes into snapshot catch-up (#1054, #3213), which reconciles the
///   whole space rather than one stale blob. Replaying our copy is the strictly
///   worse of the two recoveries and is not on the critical path for any of
///   them.
///
/// So quarantine's job is the #535 half — never destroy the local durable
/// record while the lineage it belongs to is still live; a snapshot catch-up
/// retires the two together — and NOT to be a second delivery mechanism. This
/// function exists so that "manual" means something concrete: the bytes are
/// byte-identical to what was admitted, so re-admission remains possible at any
/// time, by a human or a diagnostic tool, without a schema migration or a
/// rebuild.
///
/// # A snapshot catch-up empties this table (#3243)
///
/// `snapshot::restore::apply_snapshot`'s RESET path deletes
/// `loro_sync_quarantine` alongside `loro_sync_inbox`, so there is never a row
/// left to re-admit pre-reset bytes from under the retired #792 peer epoch.
///
/// The move is transactional in the same direction as
/// [`note_unresolved_slot`]'s: the inbox row is inserted and the quarantine row
/// deleted in ONE transaction, so the blob is never absent from both tables.
/// `unresolved_boots` resets to 0 — a deliberate re-admission grants a fresh
/// budget; without the reset the slot would re-quarantine on its very next
/// unresolved boot and the manual action would look like it did nothing.
pub async fn readmit_quarantined_slot(
    pool: &SqlitePool,
    quarantine_id: i64,
) -> Result<Option<i64>, AppError> {
    // The exact mirror of `note_unresolved_slot`'s move, in the other
    // direction. System-level write-ahead storage only: no `op_log` append, no
    // derived cache, nothing to dispatch after commit.
    // allow-raw-tx: #110 — system-level write-ahead storage, no op_log write.
    let mut tx = agaric_store::db::begin_immediate_logged(pool, "sync_quarantine_readmit").await?;

    let Some(row) = sqlx::query!(
        "SELECT space_id, bytes, purged_ids FROM loro_sync_quarantine WHERE id = ?",
        quarantine_id,
    )
    .fetch_optional(&mut *tx)
    .await?
    else {
        tx.commit().await?;
        return Ok(None);
    };

    let created_at = agaric_store::db::now_ms();
    let inbox_id: i64 = sqlx::query_scalar!(
        r#"INSERT INTO loro_sync_inbox
             (space_id, bytes, purged_ids, created_at, unresolved_boots)
           VALUES (?, ?, ?, ?, 0)
           RETURNING id as "id!: i64""#,
        row.space_id,
        row.bytes,
        row.purged_ids,
        created_at,
    )
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query!(
        "DELETE FROM loro_sync_quarantine WHERE id = ?",
        quarantine_id,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    tracing::info!(
        quarantine_id,
        inbox_id,
        space_id = %row.space_id,
        "#3226: manually re-admitted a quarantined sync blob into the write-ahead \
         inbox; the next boot replay will retry it with a fresh boot budget"
    );
    Ok(Some(inbox_id))
}
