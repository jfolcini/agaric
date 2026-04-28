//! Async recurrence flow: when a task transitions to DONE, read its repeat
//! properties, evaluate end conditions, and create the next sibling occurrence.

use sqlx::SqlitePool;

use super::parser::shift_date;
use crate::block_positions::next_sibling_position_excluding_sentinel;
use crate::commands::{create_block_in_tx, is_valid_iso_date, set_property_in_tx};
use crate::materializer::Materializer;
use crate::op_log;
use crate::pagination::{BlockRow, NULL_POSITION_SENTINEL};

/// Handle recurrence when a task transitions to DONE.
///
/// This checks for a `repeat` property on the block and, if present:
/// 1. Pre-computes shifted dates for end-condition checks
/// 2. Evaluates end conditions (`repeat-until`, `repeat-count`/`repeat-seq`)
/// 3. Creates a new sibling block with TODO state and shifted dates
/// 4. Copies recurrence properties to the new block
///
/// Returns `Ok(true)` if a sibling was created, `Ok(false)` if recurrence
/// was skipped (no repeat rule, end condition met, etc.).
///
/// # Concurrency (H-17)
///
/// All property/counter reads run inside a single `BEGIN IMMEDIATE`
/// transaction so the read-then-increment chain is serialized against
/// concurrent DONE clicks on the same recurring block. Without the
/// IMMEDIATE wrapper, two parallel transitions raced the read of
/// `repeat-seq` / `repeat-count` against the write of the new sibling
/// and could violate the end-condition guard or wedge two siblings into
/// the same position slot.
///
/// # Error handling (M-77)
///
/// Property writes that fail inside the tx propagate via `?` instead of
/// being silently warn-logged. The IMMEDIATE tx then rolls back cleanly,
/// leaving no partial sibling, no stranded op-log entries, and no half-
/// dispatched materializer tasks. Validation failures (e.g. a corrupt
/// `repeat-until` value that can't round-trip through
/// `set_property_in_tx`) surface to the caller instead of being hidden.
#[allow(dead_code)] // H-4: production path now uses handle_recurrence_in_tx.
pub(crate) async fn handle_recurrence(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: &str,
) -> Result<bool, crate::error::AppError> {
    // H-17: open BEGIN IMMEDIATE up front so every property read below
    // and the sibling creation/property writes downstream all run inside
    // the same serialized write transaction. Two concurrent DONE clicks
    // on the same recurring block now queue at the SQLite write lock
    // instead of racing the read-then-increment chain on the bare pool.
    //
    // MAINT-112: CommandTx couples commit + post-commit dispatch. The
    // previous hand-rolled warn included `new_block_id` as an extra
    // context field; with `commit_and_dispatch`'s
    // `dispatch_background_or_warn` the warn now logs `op_type`,
    // `device_id`, `seq`, and `error` — the `(device_id, seq)` pair
    // uniquely identifies the op so the source block can still be
    // recovered via the op log.
    let mut tx = crate::db::CommandTx::begin_immediate(pool, "recurrence_handle").await?;
    let created = handle_recurrence_in_tx(&mut tx, device_id, block_id).await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(created)
}

/// Inner-tx variant of [`handle_recurrence`] for callers that already hold
/// a `CommandTx` and need the recurrence-sibling creation to run inside the
/// same write transaction (H-4: `set_todo_state_inner` wraps the state
/// change + timestamp writes + recurrence sibling creation in one tx so a
/// crash mid-sequence cannot leave a recurring task stuck).
///
/// Returns `Ok(true)` if a sibling was created. The caller is responsible
/// for committing the transaction and dispatching background work — this
/// function only enqueues op records via `tx.enqueue_background(...)`.
pub(crate) async fn handle_recurrence_in_tx(
    tx: &mut crate::db::CommandTx,
    device_id: &str,
    block_id: &str,
) -> Result<bool, crate::error::AppError> {
    // Check for repeat property (inside tx)
    let repeat_rule: Option<String> = sqlx::query_scalar(
        "SELECT value_text FROM block_properties WHERE block_id = ?1 AND key = 'repeat'",
    )
    .bind(block_id)
    .fetch_optional(&mut ***tx)
    .await?;

    let Some(rule) = repeat_rule else {
        // No repeat rule — caller drops/commits the (read-only) tx.
        return Ok(false);
    };

    // Fetch the original block (with updated DONE state) inside the tx.
    // Inlined from `get_block_inner` so the read participates in the
    // same IMMEDIATE transaction as the property reads below.
    let original: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
           FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut ***tx)
    .await?;
    let original =
        original.ok_or_else(|| crate::error::AppError::NotFound(format!("block '{block_id}'")))?;

    // Pre-compute shifted dates for end-condition checks
    let shifted_due = original
        .due_date
        .as_ref()
        .and_then(|d| shift_date(d, &rule));
    let shifted_sched = original
        .scheduled_date
        .as_ref()
        .and_then(|d| shift_date(d, &rule));

    // The "reference" shifted date used for end-condition comparison:
    // prefer due_date, fall back to scheduled_date.
    let reference_date = shifted_due.as_deref().or(shifted_sched.as_deref());

    // --- End condition: repeat-until ---
    let repeat_until: Option<String> = sqlx::query_scalar(
        "SELECT value_date FROM block_properties WHERE block_id = ?1 AND key = 'repeat-until'",
    )
    .bind(block_id)
    .fetch_optional(&mut ***tx)
    .await?;

    if let Some(ref until_str) = repeat_until {
        if let Some(ref_date) = reference_date {
            // L-100: validate ISO-8601 date shape before the lex compare.
            // The lex comparison `ref_date > until_str` is only meaningful
            // when both sides are exactly `YYYY-MM-DD` (10 chars). The query
            // above reads `value_date`, but `set_property` allows type-loose
            // writes — a `repeat-until` planted as `"2025-12-31T23:59:59Z"`
            // would compare wrong (`T` > `-`) and the recurrence would
            // never stop. We re-use `crate::commands::is_valid_iso_date`
            // (already imported) which enforces the same strict shape used
            // when the value was originally written via `set_property_in_tx`.
            // On malformed input we warn loudly and stop the recurrence
            // (`Ok(false)`) rather than silently letting it continue past
            // the deadline.
            if !is_valid_iso_date(until_str) {
                tracing::warn!(
                    block_id,
                    until_str = %until_str,
                    "repeat-until is not a valid YYYY-MM-DD date; stopping recurrence"
                );
                return Ok(false);
            }
            // Simple lexicographic comparison works for YYYY-MM-DD strings
            if ref_date > until_str.as_str() {
                // Shifted date is past the repeat-until deadline — stop recurring
                return Ok(false);
            }
        }
    }

    // --- End condition: repeat-count / repeat-seq ---
    let repeat_count: Option<f64> = sqlx::query_scalar(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-count'",
    )
    .bind(block_id)
    .fetch_optional(&mut ***tx)
    .await?;

    let repeat_seq: Option<f64> = sqlx::query_scalar(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-seq'",
    )
    .bind(block_id)
    .fetch_optional(&mut ***tx)
    .await?;

    if let Some(count) = repeat_count {
        // f64 → i64 has no `TryFrom` in std; the cast is safe because
        // repeat_seq and repeat_count are non-negative whole numbers
        // stored as f64 in SQLite (REAL affinity for `value_num`).
        #[allow(clippy::cast_possible_truncation)]
        let current_seq = repeat_seq.unwrap_or(0.0) as i64;
        #[allow(clippy::cast_possible_truncation)]
        let max_count = count as i64;
        if current_seq >= max_count {
            // Already exhausted the repeat count — stop recurring
            return Ok(false);
        }
    }

    // --- Resolve repeat-origin for the chain ---
    let repeat_origin: Option<String> = sqlx::query_scalar(
        "SELECT value_ref FROM block_properties WHERE block_id = ?1 AND key = 'repeat-origin'",
    )
    .bind(block_id)
    .fetch_optional(&mut ***tx)
    .await?;
    // Use existing origin, or this block is the first in the chain
    let origin_id = repeat_origin.unwrap_or_else(|| block_id.to_string());

    // --- Create the recurrence sibling ---
    // All writes below happen in the same IMMEDIATE tx opened above.
    let mut op_records: Vec<op_log::OpRecord> = Vec::new();

    // M-78: Use MAX(position) + 1 among living siblings to avoid collision.
    // Naive `original.position + 1` collides with whatever sibling already
    // occupies that slot, leaving two siblings sharing one position and the
    // agenda's order non-deterministic. Mirrors the BUG-24 fix in
    // `merge/resolve.rs::create_conflict_copy` — both call sites now share
    // `next_sibling_position_excluding_sentinel`.
    //
    // - If the original carries the NULL_POSITION_SENTINEL, the sibling
    //   keeps the sentinel (incrementing would overflow i64::MAX).
    // - Sentinel-bearing siblings are excluded from the MAX scan to avoid
    //   the same overflow.
    let new_position = match original.position {
        Some(p) if p == NULL_POSITION_SENTINEL => Some(NULL_POSITION_SENTINEL),
        Some(_) => Some(
            next_sibling_position_excluding_sentinel(&mut ***tx, original.parent_id.as_deref())
                .await?,
        ),
        None => Some(NULL_POSITION_SENTINEL),
    };

    // Create next occurrence as a sibling
    let (new_block, op) = create_block_in_tx(
        &mut *tx,
        device_id,
        original.block_type.clone(),
        original.content.unwrap_or_default(),
        original.parent_id.clone(),
        new_position,
    )
    .await?;
    op_records.push(op);

    // Set TODO state on new block
    let (_, op) = set_property_in_tx(
        &mut *tx,
        device_id,
        new_block.id.clone(),
        "todo_state",
        Some("TODO".to_string()),
        None,
        None,
        None,
    )
    .await?;
    op_records.push(op);

    // Copy repeat property to new block
    let (_, op) = set_property_in_tx(
        &mut *tx,
        device_id,
        new_block.id.clone(),
        "repeat",
        Some(rule.clone()),
        None,
        None,
        None,
    )
    .await?;
    op_records.push(op);

    // Shift due_date if present.
    //
    // M-77: failures in `set_property_in_tx` propagate via `?` — the
    // IMMEDIATE tx rolls back so the half-built sibling is not left
    // visible. Previously the call was wrapped in a `match` that
    // tracing::warn!-logged the error and continued, hiding partial
    // failures (e.g. a date validation rejection) behind a log line.
    if let Some(shifted) = shifted_due {
        if !is_valid_iso_date(&shifted) {
            tracing::warn!(
                block_id,
                new_block_id = %new_block.id,
                shifted = %shifted,
                "shifted due_date is not valid YYYY-MM-DD, skipping"
            );
        } else {
            let (_, op) = set_property_in_tx(
                &mut *tx,
                device_id,
                new_block.id.clone(),
                "due_date",
                None,
                None,
                Some(shifted),
                None,
            )
            .await?;
            op_records.push(op);
        }
    }

    // Shift scheduled_date if present (M-77: propagate via `?`).
    if let Some(shifted) = shifted_sched {
        if !is_valid_iso_date(&shifted) {
            tracing::warn!(
                block_id,
                new_block_id = %new_block.id,
                shifted = %shifted,
                "shifted scheduled_date is not valid YYYY-MM-DD, skipping"
            );
        } else {
            let (_, op) = set_property_in_tx(
                &mut *tx,
                device_id,
                new_block.id.clone(),
                "scheduled_date",
                None,
                None,
                Some(shifted),
                None,
            )
            .await?;
            op_records.push(op);
        }
    }

    // Copy repeat-until to new block if present (M-77: propagate via `?`).
    if let Some(ref until_str) = repeat_until {
        let (_, op) = set_property_in_tx(
            &mut *tx,
            device_id,
            new_block.id.clone(),
            "repeat-until",
            None,
            None,
            Some(until_str.clone()),
            None,
        )
        .await?;
        op_records.push(op);
    }

    // Copy repeat-count and increment repeat-seq on new block.
    //
    // L-99: `repeat-seq` only carries forward (and only gets bumped)
    // when `repeat-count` is also set on the origin. This gating is
    // intentional, not a bug:
    //
    //   * `repeat-seq` is a system-managed *output* — the engine
    //     stamps it on each sibling so the UI/MCP can show "3 of 5"
    //     style progress alongside `repeat-count`.
    //   * Without `repeat-count` there is no *bound* against which
    //     `repeat-seq` is meaningful, so the engine deliberately
    //     leaves `repeat-seq` off the sibling.
    //   * A user who manually sets `repeat-seq` on a block without
    //     `repeat-count` will therefore see the counter "freeze" at
    //     whatever value they wrote — the engine treats their seed
    //     as a one-shot annotation, not a counter to advance. This
    //     is the behaviour pinned by
    //     `tests_l99_l100::repeat_seq_not_incremented_without_repeat_count`.
    //
    // Cross-references:
    //   - The property-definition seed migration that registers
    //     `repeat`, `repeat-until`, `repeat-count`, `repeat-seq`,
    //     and `repeat-origin` is `migrations/0016_seed_repeat_properties.sql`.
    //   - ISO-date validation for the *value* written to
    //     `repeat-until` (and other date columns) is enforced by
    //     `crate::commands::is_valid_iso_date` inside
    //     `set_property_in_tx`. The L-100 fix above this block
    //     re-uses the same validator to gate the `repeat-until`
    //     end-condition compare so a malformed value cannot slip
    //     through a lexicographic compare.
    //
    // If a future change wants `repeat-seq` to advance on every
    // recurrence regardless of `repeat-count`, that is a *behavioural*
    // shift (it changes the contract `repeat-seq` carries) and must
    // be discussed with the user first — not introduced silently by
    // dropping this gate.
    if let Some(count) = repeat_count {
        // f64 → i64 has no `TryFrom` in std; the cast is safe because
        // repeat_seq is a non-negative whole number stored as f64.
        #[allow(clippy::cast_possible_truncation)]
        let current_seq = repeat_seq.unwrap_or(0.0) as i64;
        let next_seq = current_seq + 1;

        // Copy repeat-count (M-77: propagate via `?`).
        let (_, op) = set_property_in_tx(
            &mut *tx,
            device_id,
            new_block.id.clone(),
            "repeat-count",
            None,
            Some(count),
            None,
            None,
        )
        .await?;
        op_records.push(op);

        // Set incremented repeat-seq (M-77: propagate via `?`).
        let (_, op) = set_property_in_tx(
            &mut *tx,
            device_id,
            new_block.id.clone(),
            "repeat-seq",
            None,
            Some(next_seq as f64),
            None,
            None,
        )
        .await?;
        op_records.push(op);
    }

    // Set repeat-origin on new block (points to original block in chain)
    // (M-77: propagate via `?`).
    let (_, op) = set_property_in_tx(
        &mut *tx,
        device_id,
        new_block.id.clone(),
        "repeat-origin",
        None,
        None,
        None,
        Some(origin_id),
    )
    .await?;
    op_records.push(op);

    // Enqueue all ops on the tx; the caller drives commit + dispatch.
    for op in op_records {
        tx.enqueue_background(op);
    }

    Ok(true)
}

#[cfg(test)]
mod tests_h17_m77 {
    //! Tests for REVIEW-LATER items H-17 (TOCTOU on counters) and M-77
    //! (silent error swallowing) in [`handle_recurrence`].
    //!
    //! - `handle_recurrence_propagates_set_property_error` exercises M-77:
    //!   we plant a corrupt `repeat-until` value directly into
    //!   `block_properties` (bypassing the validation in
    //!   `set_property_inner`) so that the copy-to-sibling call inside
    //!   `handle_recurrence` triggers `set_property_in_tx`'s ISO-date
    //!   validation. Pre-fix, the failure was warn-logged and the
    //!   sibling/op_log entries committed anyway; post-fix the IMMEDIATE
    //!   tx rolls back and the caller sees the error.
    //! - `handle_recurrence_atomic_under_concurrent_done` exercises H-17:
    //!   two concurrent `handle_recurrence` calls now serialize on the
    //!   IMMEDIATE write lock. The test asserts atomicity (every sibling
    //!   that exists is fully formed) and that no two siblings share a
    //!   position slot.
    use super::*;
    use crate::commands::{
        create_block_inner, get_properties_inner, set_due_date_inner, set_property_inner,
        set_todo_state_inner,
    };
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::pagination::BlockRow;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV: &str = "test-device-h17";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn settle() {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    /// Find TODO siblings (the recurrence-created sibling has todo_state=TODO,
    /// distinct from the original's DONE state).
    async fn find_todo_siblings(pool: &SqlitePool, original_id: &str) -> Vec<BlockRow> {
        sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date, page_id
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            original_id
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handle_recurrence_propagates_set_property_error() {
        // M-77: a corrupt value that bypasses the early end-condition
        // checks but trips `set_property_in_tx`'s validation in the
        // copy step must propagate via `?`. Pre-fix this was
        // warn-logged and swallowed, leaving a half-formed sibling
        // committed. Post-fix the error propagates via `?`, the
        // IMMEDIATE tx rolls back, and the caller sees the Err.
        //
        // Vehicle (post-L-100): a whitespace-only `repeat` value
        // planted directly into `block_properties`, bypassing the L-6
        // empty/whitespace guard in `set_property_inner`. The
        // recurrence flow reads `repeat = " "`, `shift_date(due, " ")`
        // returns `None` (no interval matches), so `reference_date`
        // stays `None` and the L-100 ISO-shape check on `repeat-until`
        // never fires. The copy step then calls
        // `set_property_in_tx(..., "repeat", Some(" "))`, which the L-6
        // empty/whitespace guard in `validate_set_property` rejects.
        //
        // Note: the previous vehicle (a corrupt `repeat-until` value
        // like `"not-a-date"`) no longer reaches the copy step because
        // L-100 stops the recurrence early on a malformed
        // `repeat-until` (covered in `tests_l99_l100`). We pick a
        // different corrupt vehicle here so this test continues to
        // exercise the M-77 propagation path independently.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "task with corrupt repeat".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-15".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        // Plant a whitespace `repeat` directly, bypassing the L-6
        // empty/whitespace guard in `set_property_inner`. The
        // recurrence flow proceeds past the end-condition gates (no
        // `repeat-until`, no `repeat-count`, and `reference_date` is
        // `None` because `shift_date(due, " ")` returns `None`), then
        // the copy step's `set_property_in_tx` call rejects the
        // whitespace value_text.
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(&block.id)
            .bind("repeat")
            .bind(" ")
            .execute(&pool)
            .await
            .unwrap();

        // Snapshot op_log size BEFORE the failing handle_recurrence call so
        // we can assert no partial entries from this call survived rollback.
        let ops_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();

        // Direct call to handle_recurrence — production normally invokes
        // this from set_todo_state_inner after flipping to DONE, but
        // calling directly keeps the assertion focused on this fn's
        // contract.
        let result = handle_recurrence(&pool, DEV, &mat, &block.id).await;

        assert!(
            result.is_err(),
            "handle_recurrence should propagate the set_property_in_tx validation error, got {result:?}"
        );
        let err = result.unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("set_property.value_text.empty") || msg.contains("empty"),
            "error should be the empty/whitespace value_text rejection, got: {msg}"
        );

        // No new TODO sibling: the IMMEDIATE tx rolled back the
        // create_block_in_tx + property-set ops together.
        let siblings = find_todo_siblings(&pool, &block.id).await;
        assert_eq!(
            siblings.len(),
            0,
            "no recurrence sibling should be created when set_property_in_tx fails — got {} sibling(s)",
            siblings.len()
        );

        // No partial op_log entries from this call survived rollback.
        let ops_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            ops_after, ops_before,
            "rolled-back IMMEDIATE tx must leave op_log unchanged (before={ops_before}, after={ops_after})"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handle_recurrence_atomic_under_concurrent_done() {
        // H-17: two `handle_recurrence` calls running concurrently against
        // the same recurring block must serialize on the IMMEDIATE write
        // lock. Each transaction either commits a fully-formed sibling
        // (with all expected properties) or rolls back entirely — no
        // half-formed siblings, no two siblings sharing a position slot.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Parent so siblings share a parent_id and the M-78 position
        // computation has a meaningful scope.
        let parent = create_block_inner(
            &pool,
            DEV,
            &mat,
            "page".into(),
            "parent page".into(),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        let block = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            "concurrent recurring task".into(),
            Some(parent.id.clone()),
            Some(1),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            Some("2025-06-15".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        set_property_inner(
            &pool,
            DEV,
            &mat,
            block.id.clone(),
            "repeat".into(),
            Some("daily".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        // We deliberately skip flipping the original to DONE here:
        // production wires this through `set_todo_state_inner`, which
        // would itself invoke `handle_recurrence` once and pre-create a
        // sibling, polluting the concurrent-only-paths assertion below.
        // Calling `handle_recurrence` directly against the TODO block
        // is sufficient — the function inspects the `repeat` property
        // and the original's date columns; it does not gate on
        // `todo_state` itself.
        //
        // Snapshot any pre-existing siblings (none expected, but guard
        // against environment leakage from earlier setup ops).
        let pre_siblings = find_todo_siblings(&pool, &block.id).await;
        assert_eq!(
            pre_siblings.len(),
            0,
            "no pre-existing TODO siblings should exist before concurrent calls"
        );

        // Spawn two concurrent calls. With BEGIN IMMEDIATE, both queue at
        // the SQLite write lock and run sequentially; without it (the
        // pre-fix bare-pool reads), they would have raced the
        // read-then-increment chain.
        let pool_a = pool.clone();
        let pool_b = pool.clone();
        let mat_a = mat.clone();
        let mat_b = mat.clone();
        let id_a = block.id.clone();
        let id_b = block.id.clone();
        let (r_a, r_b) = tokio::join!(
            async move { handle_recurrence(&pool_a, DEV, &mat_a, &id_a).await },
            async move { handle_recurrence(&pool_b, DEV, &mat_b, &id_b).await },
        );

        // At least one call must have succeeded; if either errored, that
        // tx rolled back cleanly (M-77 invariant).
        assert!(
            r_a.is_ok() || r_b.is_ok(),
            "at least one concurrent handle_recurrence call must succeed; got r_a={r_a:?} r_b={r_b:?}"
        );

        let siblings = find_todo_siblings(&pool, &block.id).await;

        // With IMMEDIATE serialization, each call independently passes the
        // end-condition guard (no repeat-count is set on the original) and
        // creates one sibling, so we expect at most one sibling per
        // successful call. Pre-fix, racing reads against writes could
        // also wedge two siblings into the same position slot — that
        // collision is what we explicitly assert against below.
        let succeeded = r_a.is_ok() as usize + r_b.is_ok() as usize;
        assert!(
            siblings.len() <= succeeded,
            "sibling count ({}) must not exceed number of successful concurrent calls ({succeeded})",
            siblings.len(),
        );

        // Atomicity invariant (H-17 + M-77): every committed sibling has
        // the full set of recurrence properties — IMMEDIATE rollback
        // means we never observe a half-formed sibling.
        for sibling in &siblings {
            let props = get_properties_inner(&pool, sibling.id.clone())
                .await
                .unwrap();
            let has_repeat = props.iter().any(|p| p.key == "repeat");
            let has_origin = props.iter().any(|p| p.key == "repeat-origin");
            let has_todo = sibling.todo_state.as_deref() == Some("TODO");
            assert!(
                has_repeat && has_origin && has_todo,
                "sibling {} is missing recurrence properties (repeat={has_repeat}, origin={has_origin}, todo={has_todo}) — partial commit observed",
                sibling.id,
            );
        }

        // No two siblings (or any living block under the same parent)
        // share a position slot — the IMMEDIATE-tx serialization plus
        // M-78's MAX(position)+1 guarantee distinct slots.
        let positions: Vec<i64> = sqlx::query_scalar(
            "SELECT position FROM blocks \
             WHERE parent_id = ? AND deleted_at IS NULL AND position IS NOT NULL \
             AND position != ?",
        )
        .bind(&parent.id)
        .bind(NULL_POSITION_SENTINEL)
        .fetch_all(&pool)
        .await
        .unwrap();
        let mut deduped = positions.clone();
        deduped.sort_unstable();
        deduped.dedup();
        assert_eq!(
            positions.len(),
            deduped.len(),
            "concurrent recurrence siblings duplicated a position slot: {positions:?}"
        );

        // Distinct sibling identities (`never duplicates the same seq` in
        // the spec): each successful call appended its own create-block
        // op and produced its own sibling block id, even if they share
        // repeat-seq values (the original's repeat-seq is not updated).
        let sibling_ids: std::collections::HashSet<_> =
            siblings.iter().map(|s| s.id.clone()).collect();
        assert_eq!(
            sibling_ids.len(),
            siblings.len(),
            "siblings have duplicate ids — concurrent ops collided"
        );

        mat.shutdown();
    }
}

#[cfg(test)]
mod tests_l99_l100 {
    //! Tests for REVIEW-LATER items L-99 (`repeat-seq` is gated on
    //! `repeat-count`) and L-100 (`repeat-until` lex-compare must
    //! validate ISO date shape) in [`handle_recurrence`].
    //!
    //! - L-99 is documentation-only; no behavioural change. The single
    //!   test here pins the existing gated behaviour so the doc
    //!   comment in `handle_recurrence_in_tx` cannot drift away from
    //!   the code: a `repeat-seq` value set on the origin without a
    //!   `repeat-count` does NOT carry forward to the recurrence
    //!   sibling — the engine intentionally treats the lone seq as a
    //!   one-shot annotation and freezes the counter.
    //! - L-100 fixes a bug where the lex compare on `repeat-until`
    //!   silently let recurrence continue past the deadline when the
    //!   stored value carried a timestamp suffix (e.g.
    //!   `"2025-12-31T23:59:59Z"`). The four L-100 tests exercise the
    //!   four code paths: valid past, valid future, malformed
    //!   timestamp suffix, and empty string.
    use super::*;
    use crate::commands::{
        create_block_inner, get_properties_inner, set_due_date_inner, set_property_inner,
        set_todo_state_inner,
    };
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use crate::pagination::BlockRow;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV: &str = "test-device-l99-l100";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn settle() {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    /// Find TODO siblings (the recurrence-created sibling has todo_state=TODO,
    /// distinct from the original's DONE state). Mirrors the helper in
    /// `tests_h17_m77` so each test module is self-contained.
    async fn find_todo_siblings(pool: &SqlitePool, original_id: &str) -> Vec<BlockRow> {
        sqlx::query_as!(
            BlockRow,
            r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                      is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                      due_date, scheduled_date, page_id
               FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
            original_id
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// Helper: create a TODO block with the given due_date and a
    /// `repeat=daily` rule. Returns the new block's id. Used by every
    /// L-99 / L-100 test to keep the setup boilerplate compact.
    async fn make_recurring_block(pool: &SqlitePool, mat: &Materializer, due: &str) -> String {
        let block = create_block_inner(pool, DEV, mat, "content".into(), "task".into(), None, None)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        set_todo_state_inner(pool, DEV, mat, block.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        set_due_date_inner(pool, DEV, mat, block.id.clone(), Some(due.into()))
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        set_property_inner(
            pool,
            DEV,
            mat,
            block.id.clone(),
            "repeat".into(),
            Some("daily".into()),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        block.id
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeat_seq_not_incremented_without_repeat_count() {
        // L-99: pins the gated behaviour described in the doc comment
        // above the `if let Some(count) = repeat_count` block in
        // `handle_recurrence_in_tx`. A `repeat-seq` set on the origin
        // without `repeat-count` is intentionally NOT propagated to
        // the recurrence sibling — the engine treats the seed as a
        // one-shot annotation and freezes the counter. If a future
        // change "fixes" this by always bumping `repeat-seq`, this
        // test will fail and the author will be forced to revisit the
        // doc comment + REVIEW-LATER L-99.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Origin: due=2025-06-15 + daily → shifted ref 2025-06-16.
        // No `repeat-until` so the L-100 check is a no-op here.
        let id = make_recurring_block(&pool, &mat, "2025-06-15").await;

        // Set `repeat-seq` on the origin WITHOUT setting
        // `repeat-count`. Use the normal API path so we exercise the
        // same code that a user/MCP tool would.
        set_property_inner(
            &pool,
            DEV,
            &mat,
            id.clone(),
            "repeat-seq".into(),
            None,
            Some(3.0),
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
        settle().await;

        let created = handle_recurrence(&pool, DEV, &mat, &id).await.unwrap();
        assert!(
            created,
            "recurrence should create a sibling when no end condition fires (no repeat-count, no repeat-until past deadline)"
        );
        mat.flush_background().await.unwrap();
        settle().await;

        let siblings = find_todo_siblings(&pool, &id).await;
        assert_eq!(siblings.len(), 1, "expected exactly one TODO sibling");
        let sibling = &siblings[0];
        let props = get_properties_inner(&pool, sibling.id.clone())
            .await
            .unwrap();

        let has_seq = props.iter().any(|p| p.key == "repeat-seq");
        let has_count = props.iter().any(|p| p.key == "repeat-count");
        assert!(
            !has_seq,
            "L-99: sibling must NOT carry `repeat-seq` when origin has no `repeat-count`. \
             props = {:?}",
            props.iter().map(|p| p.key.clone()).collect::<Vec<_>>()
        );
        assert!(
            !has_count,
            "sanity: sibling must not carry `repeat-count` either. \
             props = {:?}",
            props.iter().map(|p| p.key.clone()).collect::<Vec<_>>()
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeat_until_valid_iso_date_stops_recurrence_when_past() {
        // L-100: with a valid ISO `repeat-until` strictly less than the
        // shifted reference date, recurrence must stop (Ok(false)) and
        // not create a sibling. This is the unmodified pre-L-100
        // behaviour for valid input — the new validator must not
        // regress it.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Origin: due=2025-12-31 + daily → shifted ref 2026-01-01.
        let id = make_recurring_block(&pool, &mat, "2025-12-31").await;

        // Plant a valid ISO `repeat-until` that's strictly in the
        // past of the shifted ref. We use a direct INSERT to keep the
        // setup symmetric with the malformed-input tests below.
        sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
            .bind(&id)
            .bind("repeat-until")
            .bind("2024-01-01")
            .execute(&pool)
            .await
            .unwrap();

        let created = handle_recurrence(&pool, DEV, &mat, &id).await.unwrap();
        assert!(
            !created,
            "valid past `repeat-until` must stop recurrence (shifted ref 2026-01-01 > 2024-01-01)"
        );

        let siblings = find_todo_siblings(&pool, &id).await;
        assert_eq!(
            siblings.len(),
            0,
            "no sibling expected when `repeat-until` end condition fires"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeat_until_valid_iso_date_continues_recurrence_when_within() {
        // L-100: with a valid ISO `repeat-until` strictly greater than
        // the shifted reference date, recurrence must continue
        // (Ok(true)) and create a sibling. Pinning this protects
        // against an over-eager validator that might reject the lex
        // path entirely.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Origin: due=2023-12-31 + daily → shifted ref 2024-01-01.
        let id = make_recurring_block(&pool, &mat, "2023-12-31").await;

        sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
            .bind(&id)
            .bind("repeat-until")
            .bind("2025-12-31")
            .execute(&pool)
            .await
            .unwrap();

        let created = handle_recurrence(&pool, DEV, &mat, &id).await.unwrap();
        assert!(
            created,
            "valid future `repeat-until` must allow recurrence (shifted ref 2024-01-01 < 2025-12-31)"
        );

        let siblings = find_todo_siblings(&pool, &id).await;
        assert_eq!(
            siblings.len(),
            1,
            "exactly one sibling expected when end condition does not fire"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeat_until_with_timestamp_suffix_stops_recurrence() {
        // L-100: a malformed `repeat-until` like "2025-12-31T23:59:59Z"
        // would slip past the pre-fix lex compare — `T` (0x54) is
        // greater than `-` (0x2D), so any YYYY-MM-DD `ref_date` lex-
        // compares *less than* the timestamp-suffixed value, and
        // recurrence would incorrectly continue past the intended
        // deadline indefinitely.
        //
        // Post-fix, `is_valid_iso_date` rejects the value (length 20
        // != 10) and the recurrence stops loudly with a tracing warn
        // and Ok(false). We do not assert on the warn line itself
        // (no log capture infrastructure here); the Ok(false) +
        // no-sibling pair is sufficient regression protection.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        // Origin: due=2023-12-31 + daily → shifted ref 2024-01-01.
        // Pre-fix: "2024-01-01" < "2025-12-31T23:59:59Z" lex, so
        // recurrence would have proceeded and created a sibling.
        let id = make_recurring_block(&pool, &mat, "2023-12-31").await;

        sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
            .bind(&id)
            .bind("repeat-until")
            .bind("2025-12-31T23:59:59Z")
            .execute(&pool)
            .await
            .unwrap();

        let created = handle_recurrence(&pool, DEV, &mat, &id).await.unwrap();
        assert!(
            !created,
            "malformed `repeat-until` (timestamp suffix) must stop recurrence post-L-100"
        );

        let siblings = find_todo_siblings(&pool, &id).await;
        assert_eq!(
            siblings.len(),
            0,
            "no sibling expected when `repeat-until` is malformed"
        );

        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn repeat_until_empty_string_stops_recurrence() {
        // L-100 (defensive): an empty `repeat-until` is rejected by
        // the ISO-shape validator (length != 10). Recurrence stops
        // loudly rather than treating "" as a non-date that lex-
        // compares wrong against any real shifted date. This is
        // belt-and-suspenders coverage — the L-6 empty-text guard in
        // `set_property_inner` would normally prevent an empty value
        // from being written via the public API, but planting
        // directly into block_properties bypasses that and the
        // recurrence path needs its own defense.
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());

        let id = make_recurring_block(&pool, &mat, "2023-12-31").await;

        sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
            .bind(&id)
            .bind("repeat-until")
            .bind("")
            .execute(&pool)
            .await
            .unwrap();

        let created = handle_recurrence(&pool, DEV, &mat, &id).await.unwrap();
        assert!(
            !created,
            "empty `repeat-until` must stop recurrence (defensive)"
        );

        let siblings = find_todo_siblings(&pool, &id).await;
        assert_eq!(
            siblings.len(),
            0,
            "no sibling expected for empty `repeat-until`"
        );

        mat.shutdown();
    }
}
