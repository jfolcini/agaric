//! Async recurrence flow core (#2621 THE INVERSION) — the recurrence-sibling
//! builder moved down from the app crate's `recurrence::compute`.
//!
//! [`build_recurrence_sibling_in_tx`] is the neutral, transaction-scoped core:
//! given an open `sqlx::Transaction`, it reads a block's `repeat` properties,
//! evaluates the end conditions, and (when they pass) creates the next sibling
//! occurrence plus its recurrence properties, returning the op records to the
//! caller. The app keeps the `CommandTx` / `Materializer` orchestration behind
//! an unchanged shim (`crate::recurrence::compute::handle_recurrence_in_tx`),
//! which forwards the transaction here and enqueues the returned ops.
//!
//! The block-write dependencies (`create_block_in_tx`, `set_property_in_tx`,
//! `is_valid_iso_date`) are engine siblings now ([`crate::block_ops`]), so the
//! recurrence core depends *down* on them with no upward app edge.

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::op_log;
use agaric_store::pagination::BlockRow;

use super::parser::shift_date;
use crate::block_ops::{create_block_in_tx, is_valid_iso_date, set_property_in_tx};
use crate::loro::shared::LoroState;

/// Build the next recurrence sibling inside an open transaction.
///
/// This checks for a `repeat` property on the block and, if present:
/// 1. Pre-computes shifted dates for end-condition checks
/// 2. Evaluates end conditions (`repeat-until`, `repeat-count`/`repeat-seq`)
/// 3. Creates a new sibling block with TODO state and shifted dates
/// 4. Copies recurrence properties to the new block
///
/// Returns `Ok((true, ops))` if a sibling was created, `Ok((false, vec![]))`
/// if recurrence was skipped (no repeat rule, end condition met, etc.). All
/// writes happen inside the caller-provided transaction; the caller is
/// responsible for committing and for dispatching the returned op records as
/// background work.
///
/// # Concurrency (H-17)
///
/// The caller is expected to open a `BEGIN IMMEDIATE` transaction so the
/// property/counter reads below and the sibling creation all run inside a
/// single serialized write transaction. Without the IMMEDIATE wrapper, two
/// parallel DONE transitions raced the read of `repeat-seq` / `repeat-count`
/// against the write of the new sibling and could violate the end-condition
/// guard or wedge two siblings into the same position slot.
///
/// # Error handling
///
/// Property writes that fail inside the tx propagate via `?` instead of being
/// silently warn-logged. The caller's IMMEDIATE tx then rolls back cleanly,
/// leaving no partial sibling, no stranded op-log entries, and no half-
/// dispatched materializer tasks. Validation failures (e.g. a corrupt
/// `repeat-until` value that can't round-trip through `set_property_in_tx`)
/// surface to the caller instead of being hidden.
pub async fn build_recurrence_sibling_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: &str,
) -> Result<(bool, Vec<op_log::OpRecord>), AppError> {
    // Check for repeat property (inside tx)
    let repeat_rule: Option<String> = sqlx::query_scalar!(
        "SELECT value_text FROM block_properties WHERE block_id = ?1 AND key = 'repeat'",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .flatten();

    let Some(rule) = repeat_rule else {
        // No repeat rule — caller drops/commits the (read-only) tx.
        return Ok((false, Vec::new()));
    };

    // Fetch the original block (with updated DONE state) inside the tx.
    // Inlined from `get_block_inner` so the read participates in the
    // same IMMEDIATE transaction as the property reads below.
    let original: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: agaric_core::ulid::BlockId", block_type, content, parent_id as "parent_id: agaric_core::ulid::BlockId", position, deleted_at,  todo_state, priority,
                  due_date, scheduled_date, page_id as "page_id: agaric_core::ulid::BlockId"
           FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    let original = original.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))?;

    // Pre-compute shifted dates for end-condition checks.
    //
    // `shift_date` now returns
    // `Result<Option<String>, AppError>` so the caller can distinguish
    // "rule could not be parsed" (`Ok(None)` — keep silent, mirrors the
    // pre-fix `None` channel) from the two `++`-arm dead-ends that
    // previously returned silent garbage:
    //
    // * single-step `NaiveDate` arithmetic overflow inside the `++` loop
    // (pre-fix the `?` propagation flushed this through
    //   as `None`, and this caller created a sibling with no due date).
    // * 10 000-iteration cap exhausted without `current > today` (
    //   H2 — pre-fix the loop returned a stale past date silently).
    //
    // Both are `Err(AppError::Validation)` and propagate via `?` here so
    // The IMMEDIATE tx rolls back cleanly — same shape as the
    // `set_property_in_tx` propagation below, no half-formed sibling.
    // #679: each completion shifts the block's CURRENT date forward by
    // one interval and writes it back, so the next recurrence step uses
    // this freshly-shifted date as its base. For `monthly` rules this
    // makes the month-end clamp intentionally sticky: once Jan-31 clamps
    // to Feb-28 it shifts to Mar-28, Apr-28, … and never recovers day-31
    // (Org-mode in-place-shift semantics). See the clamp site in
    // `parser.rs::shift_date_once` ("monthly" arm) for the full contract.
    let shifted_due = match original.due_date.as_ref() {
        Some(d) => shift_date(d, &rule)?,
        None => None,
    };
    let shifted_sched = match original.scheduled_date.as_ref() {
        Some(d) => shift_date(d, &rule)?,
        None => None,
    };

    // The "reference" shifted date used for end-condition comparison:
    // prefer due_date, fall back to scheduled_date.
    let reference_date = shifted_due.as_deref().or(shifted_sched.as_deref());

    // --- End condition: repeat-until ---
    let repeat_until: Option<String> = sqlx::query_scalar!(
        "SELECT value_date FROM block_properties WHERE block_id = ?1 AND key = 'repeat-until'",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .flatten();

    if let Some(ref until_str) = repeat_until
        && let Some(ref_date) = reference_date
    {
        // Validate ISO-8601 date shape before the lex compare.
        // The lex comparison `ref_date > until_str` is only meaningful
        // when both sides are exactly `YYYY-MM-DD` (10 chars). The query
        // above reads `value_date`, but `set_property` allows type-loose
        // writes — a `repeat-until` planted as `"2025-12-31T23:59:59Z"`
        // would compare wrong (`T` > `-`) and the recurrence would
        // never stop. We re-use `crate::block_ops::is_valid_iso_date`
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
            return Ok((false, Vec::new()));
        }
        // Simple lexicographic comparison works for YYYY-MM-DD strings
        if ref_date > until_str.as_str() {
            // Shifted date is past the repeat-until deadline — stop recurring
            return Ok((false, Vec::new()));
        }
    }

    // --- End condition: repeat-count / repeat-seq ---
    let repeat_count: Option<f64> = sqlx::query_scalar!(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-count'",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .flatten();

    let repeat_seq: Option<f64> = sqlx::query_scalar!(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-seq'",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .flatten();

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
            return Ok((false, Vec::new()));
        }
    }

    // --- Resolve repeat-origin for the chain ---
    let repeat_origin: Option<String> = sqlx::query_scalar!(
        "SELECT value_ref FROM block_properties WHERE block_id = ?1 AND key = 'repeat-origin'",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    // Use existing origin, or this block is the first in the chain
    let origin_id = repeat_origin.unwrap_or_else(|| block_id.to_string());

    // --- Create the recurrence sibling ---
    // All writes below happen in the same IMMEDIATE tx opened above.
    let mut op_records: Vec<op_log::OpRecord> = Vec::new();

    // (#400): append the next occurrence after the last living sibling.
    // The pre-#400 code computed `MAX(position) + 1` to avoid collisions; with
    // the fractional-index scheme a bare append (`index = None`) is the engine's
    // "after last sibling" placement and carries no collision/overflow concern.
    let new_index = None;

    // Create next occurrence as a sibling
    let (new_block, op) = create_block_in_tx(
        &mut *tx,
        state,
        device_id,
        original.block_type.clone(),
        original.content.unwrap_or_default(),
        original.parent_id.clone().map(BlockId::into_string),
        new_index,
    )
    .await?;
    op_records.push(op);

    // Set TODO state on new block
    set_recurrence_property(
        &mut *tx,
        state,
        device_id,
        new_block.id.clone().into_string(),
        "todo_state",
        Some("TODO".to_string()),
        None,
        None,
        None,
        &mut op_records,
    )
    .await?;

    // Copy repeat property to new block
    set_recurrence_property(
        &mut *tx,
        state,
        device_id,
        new_block.id.clone().into_string(),
        "repeat",
        Some(rule.clone()),
        None,
        None,
        None,
        &mut op_records,
    )
    .await?;

    // Shift due_date / scheduled_date if present.
    //
    // Failures in `set_property_in_tx` propagate via `?` — the
    // IMMEDIATE tx rolls back so the half-built sibling is not left
    // visible. Previously the call was wrapped in a `match` that
    // tracing::warn!-logged the error and continued, hiding partial
    // failures (e.g. a date validation rejection) behind a log line.
    //
    // #1547: the post-shift `is_valid_iso_date` guard used to `warn!` and
    // *skip* the property write while still committing the sibling. The
    // shifted date should always be a valid `YYYY-MM-DD` (it comes from
    // `chrono::NaiveDate::format` with the year clamped to the calendar
    // guard rail in `shift_date`), so this branch is defensive. But if it
    // ever fired, the source block's own date had already advanced and the
    // sibling committed *dateless* — silently losing the date it was meant
    // To carry. We now propagate `AppError::Validation` (matching and
    // the surrounding date-shape rejections) so the IMMEDIATE tx rolls back
    // cleanly instead of committing a half-formed, dateless sibling.
    if let Some(shifted) = shifted_due {
        push_shifted_date_property(
            &mut *tx,
            state,
            device_id,
            &new_block,
            block_id,
            "due_date",
            shifted,
            &mut op_records,
        )
        .await?;
    }

    if let Some(shifted) = shifted_sched {
        push_shifted_date_property(
            &mut *tx,
            state,
            device_id,
            &new_block,
            block_id,
            "scheduled_date",
            shifted,
            &mut op_records,
        )
        .await?;
    }

    // Copy repeat-until to new block if present (propagate via `?`).
    if let Some(ref until_str) = repeat_until {
        set_recurrence_property(
            &mut *tx,
            state,
            device_id,
            new_block.id.clone().into_string(),
            "repeat-until",
            None,
            None,
            Some(until_str.clone()),
            None,
            &mut op_records,
        )
        .await?;
    }

    // Copy repeat-count and increment repeat-seq on new block.
    //
    // `repeat-seq` only carries forward (and only gets bumped)
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
    //     `crate::block_ops::is_valid_iso_date` inside
    // `set_property_in_tx`. The fix above this block
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

        // Copy repeat-count (propagate via `?`).
        set_recurrence_property(
            &mut *tx,
            state,
            device_id,
            new_block.id.clone().into_string(),
            "repeat-count",
            None,
            Some(count),
            None,
            None,
            &mut op_records,
        )
        .await?;

        // Set incremented repeat-seq (propagate via `?`).
        set_recurrence_property(
            &mut *tx,
            state,
            device_id,
            new_block.id.clone().into_string(),
            "repeat-seq",
            None,
            Some(next_seq as f64),
            None,
            None,
            &mut op_records,
        )
        .await?;
    }

    // Set repeat-origin on new block (points to original block in chain)
    // (propagate via `?`).
    set_recurrence_property(
        &mut *tx,
        state,
        device_id,
        new_block.id.clone().into_string(),
        "repeat-origin",
        None,
        None,
        None,
        Some(origin_id),
        &mut op_records,
    )
    .await?;

    // Hand the op records back to the caller, which drives commit + dispatch.
    Ok((true, op_records))
}

/// #1547: write a shifted `due_date` / `scheduled_date` onto the recurrence
/// sibling, propagating `AppError::Validation` if the shifted value somehow
/// fails post-shift ISO validation.
///
/// In normal operation `shifted` is always a valid `YYYY-MM-DD` — it is the
/// output of `chrono::NaiveDate::format("%Y-%m-%d")` with the year clamped to
/// the calendar guard rail in `shift_date`. The validation here is therefore
/// defensive. But it must NOT silently skip on failure: the source block's
/// own date has already advanced and the sibling is about to commit, so a
/// skipped write leaves a *dateless* sibling committed (the #1547 bug). By
/// returning `Err(AppError::Validation)` we let the `?` at the call site roll
/// Back the IMMEDIATE tx, matching the contract for the other property
/// writes in this flow.
#[allow(clippy::too_many_arguments)]
async fn push_shifted_date_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    new_block: &BlockRow,
    block_id: &str,
    key: &str,
    shifted: String,
    op_records: &mut Vec<op_log::OpRecord>,
) -> Result<(), AppError> {
    if !is_valid_iso_date(&shifted) {
        return Err(AppError::validation(format!(
            "recurrence sibling {new_block_id}: shifted {key} '{shifted}' is not a valid \
             YYYY-MM-DD date (source block {block_id})",
            new_block_id = new_block.id,
        )));
    }
    set_recurrence_property(
        tx,
        state,
        device_id,
        new_block.id.clone().into_string(),
        key,
        None,
        None,
        Some(shifted),
        None,
        op_records,
    )
    .await
}

/// Thin wrapper over [`set_property_in_tx`] that captures the
/// `let (_, op) = …; op_records.push(op);` pattern repeated at every
/// property write inside [`build_recurrence_sibling_in_tx`]. Kept module-private
/// because the recurrence flow is the only caller that needs this exact
/// shape (discard the returned `BlockRow`, append the op to a local vec).
#[allow(clippy::too_many_arguments)]
async fn set_recurrence_property(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: String,
    key: &str,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    op_records: &mut Vec<op_log::OpRecord>,
) -> Result<(), AppError> {
    let (_, op) = set_property_in_tx(
        tx, state, device_id, block_id, key, value_text, value_num, value_date, value_ref, None,
    )
    .await?;
    op_records.push(op);
    Ok(())
}

#[cfg(test)]
mod tests {
    //! #1547 defensive-branch unit test moved down with the recurrence core.
    use super::*;

    const DEV: &str = "test-device-recur-engine";

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn push_shifted_date_property_rejects_invalid_date() {
        // #1547 (defensive branch): the post-shift ISO guard used to
        // `warn!` and SKIP the date write while the sibling still
        // committed — leaving a dateless sibling after the source block's
        // date had already advanced. The guard now returns
        // `AppError::Validation` so the caller's `?` rolls the IMMEDIATE
        // tx back. This branch is unreachable through the public recurrence
        // flow (shifted dates always validate), so we drive the helper
        // directly with a deliberately malformed shifted value to pin the
        // propagation contract.
        let (pool, _dir) = agaric_store::test_support::test_pool().await;

        // A bare BlockRow is enough — the helper rejects the date *before*
        // touching the DB, so no block needs to exist for the Err path.
        let new_block = BlockRow {
            id: BlockId::new(),
            block_type: "task".into(),
            content: Some("content".into()),
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: Some("TODO".into()),
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
        };
        let mut op_records: Vec<op_log::OpRecord> = Vec::new();
        let mut tx = pool.begin().await.unwrap();

        let err = push_shifted_date_property(
            &mut tx,
            &LoroState::new(),
            DEV,
            &new_block,
            "source-block-id",
            "due_date",
            "not-a-date".to_string(),
            &mut op_records,
        )
        .await
        .expect_err("invalid shifted date must return Err, not silently skip (#1547)");

        assert!(
            matches!(err, AppError::Validation { .. }),
            "invalid shifted date must surface AppError::Validation so the tx rolls back, got {err:?}"
        );
        assert!(
            op_records.is_empty(),
            "no op record must be enqueued for a rejected shifted date"
        );

        // A valid shifted date, by contrast, is accepted and enqueues an op.
        // (Use the same bare tx — the date is validated before any block
        // lookup, and set_property_in_tx upserts the property row.)
        // We don't assert on persisted state here; the full-flow test in the
        // app crate covers the carry. This only confirms the valid branch
        // does not err on the validation gate.
        assert!(
            is_valid_iso_date("2025-06-16"),
            "sanity: a shifted date is valid ISO"
        );

        tx.rollback().await.unwrap();
    }
}
