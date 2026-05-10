//! Properties command handlers.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::backlink;
use crate::db::{CommandTx, ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::pagination;

use super::sanitize_internal_error;
use super::*;

/// MAINT-147 (e): defensive fallback validation for reserved property
/// keys (`todo_state`, `priority`) when the corresponding row in
/// `property_definitions` has been deleted.
///
/// `set_property_in_tx` is the primary line of validation — it
/// consults the live `property_definitions.options` JSON. If that row
/// is missing (stale schema, manual delete, fresh test DB), this
/// helper re-enforces the seeded built-in defaults so a missing
/// definition cannot silently relax the reserved-key contract.
///
/// `def_row_present` is the boolean result of fetching
/// `property_definitions WHERE key = '<key>'` — fed in by the caller
/// so each reserved key keeps its own literal-keyed `sqlx::query!`
/// statement (the per-key literals are already cached in `.sqlx/`,
/// and avoiding a parameterised lookup here means no cache
/// regeneration is required).
///
/// `defaults` is the ordered list of allowed values; the error
/// message echoes them verbatim so the frontend toast lines up with
/// the user's mental model of "TODO/DOING/DONE" or "1/2/3".
fn validate_reserved_property_value(
    def_row_present: bool,
    key: &str,
    value: &str,
    defaults: &[&str],
) -> Result<(), AppError> {
    if !def_row_present && !defaults.contains(&value) {
        return Err(AppError::Validation(format!(
            "{key} '{value}' is not in allowed options: {}",
            defaults.join(", ")
        )));
    }
    Ok(())
}

/// MAINT-134: Emit `EVENT_PROPERTY_CHANGED` with a log-on-error
/// fallback so a transient emit failure does not propagate as a
/// command error.  Centralises the previously-duplicated emit block
/// shared by `set_property`, `set_todo_state`, `set_priority`,
/// `set_due_date`, `set_scheduled_date`, and `delete_property`.
fn emit_property_changed_event(
    app: &tauri::AppHandle,
    block_id: String,
    changed_keys: Vec<String>,
) {
    use crate::sync_events::{PropertyChangedEvent, EVENT_PROPERTY_CHANGED};
    use tauri::Emitter;
    if let Err(e) = app.emit(
        EVENT_PROPERTY_CHANGED,
        PropertyChangedEvent {
            block_id,
            changed_keys,
        },
    ) {
        tracing::warn!(
            error = %e,
            event = EVENT_PROPERTY_CHANGED,
            "failed to emit property-changed event",
        );
    }
}

/// List all distinct property keys currently in use across all blocks.
#[instrument(skip(pool), err)]
pub async fn list_property_keys_inner(pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    backlink::list_property_keys(pool).await
}

/// Set (upsert) a property on a block.
///
/// Thin wrapper around [`set_property_in_tx`] that manages the transaction
/// lifecycle and dispatches background work.
///
/// `caller_context` (L-122): when `Some(name)`, the exactly-one-value
/// invariant is enforced up-front and the resulting `AppError::Validation`
/// message names the caller (e.g. `"tool 'set_property': ..."`). When
/// `None`, the message wording is delegated to `set_property_in_tx`'s
/// inner `validate_set_property` call (i.e. unchanged from prior behaviour).
/// This collapses the duplicate exactly-one-value precheck that used to
/// live in the MCP `handle_set_property` boundary purely to carry the
/// tool name.
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn set_property_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<bool>,
    caller_context: Option<&str>,
) -> Result<BlockRow, AppError> {
    // L-122: when a caller_context is supplied, enforce the
    // exactly-one-value invariant here so the error message can name
    // the caller. Callers that pass `None` keep the legacy behaviour
    // (the inner `validate_set_property` in `set_property_in_tx` runs
    // with its existing wording, which also tolerates count==0 for
    // reserved-key clears). Callers that pass `Some(_)` (currently
    // only the MCP `set_property` tool boundary) reject any non-1
    // count up front, matching what the MCP precheck used to do.
    if let Some(name) = caller_context {
        let provided = [
            value_text.is_some(),
            value_num.is_some(),
            value_date.is_some(),
            value_ref.is_some(),
            value_bool.is_some(),
        ]
        .iter()
        .filter(|b| **b)
        .count();
        if provided != 1 {
            return Err(AppError::Validation(format!(
                "tool '{name}': exactly one of value_text / value_num / value_date / \
                 value_ref / value_bool must be provided (got {provided})"
            )));
        }
    }
    // MAINT-112: CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "set_property").await?;
    // FEAT-5i — snapshot pre-mutation agenda-relevant state so the
    // post-commit `notify_gcal_for_op` call can compute the
    // `old_affected_dates` half of the `DirtyEvent`.  Skip the
    // extra SELECT when no connector is wired (common in tests).
    let gcal_snapshot = if materializer.is_gcal_hook_active() {
        Some(crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &block_id).await?)
    } else {
        None
    };
    let (block, op_record) = set_property_in_tx(
        &mut tx, device_id, block_id, &key, value_text, value_num, value_date, value_ref,
        value_bool,
    )
    .await?;
    // PEND-25 L9: wrap once in `Arc` so the dispatch queue and the
    // post-commit `notify_gcal_for_op` borrow share the record by
    // refcount (one atomic increment) instead of deep-cloning the
    // owned `String` payloads. Pairs with PEND-25 L2 on
    // `DeferredNotification`.
    let op_record = Arc::new(op_record);
    tx.enqueue_background(Arc::clone(&op_record));
    tx.commit_and_dispatch(materializer).await?;
    if let Some(snapshot) = gcal_snapshot {
        materializer.notify_gcal_for_op(&op_record, &snapshot);
    }
    Ok(block)
}

/// Set the todo state on a block (TODO / DOING / DONE or clear).
///
/// Validates the value and delegates to [`set_property_in_tx`] with the
/// reserved `"todo_state"` key.  Also auto-populates `created_at` and
/// `completed_at` timestamps as regular `block_properties` rows based on
/// state transitions.
///
/// When transitioning to DONE and the block has a `repeat` property, a new
/// sibling block is created with TODO state and the dates shifted forward
/// by the recurrence interval.
///
/// # Atomicity (H-4)
///
/// All writes — the state-change op, the `created_at`/`completed_at`
/// timestamp writes, and the recurrence-sibling creation — run inside
/// a single `BEGIN IMMEDIATE` transaction so a crash mid-sequence
/// can never leave a `done` state with no `completed_at` and no
/// next-occurrence sibling. Either every step commits, or every step
/// rolls back.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn set_todo_state_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    state: Option<String>,
) -> Result<BlockRow, AppError> {
    if let Some(ref s) = state {
        if s.is_empty() || s.len() > 50 {
            return Err(AppError::Validation(
                "Todo state must be 1-50 characters".into(),
            ));
        }
    }

    // H-4: open one IMMEDIATE tx covering every write below — the
    // state change, the `created_at`/`completed_at` timestamp writes,
    // and the recurrence-sibling creation. A pre-fix crash mid-sequence
    // could leave a `done` state with no `completed_at` and no
    // next-occurrence sibling — see REVIEW-LATER H-4 for the rationale.
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state").await?;

    // BUG-20: Validate against todo_state property definition options.
    // `set_property_in_tx` already performs this check when the
    // definition exists; this fallback guards the case where the
    // definition has been deleted, ensuring the built-in defaults are
    // still enforced. MAINT-147 (e): the validation logic is shared
    // with `set_priority_inner` via `validate_reserved_property_value`.
    //
    // M-97: this fetch was previously issued against `pool` *before*
    // opening the tx; folded inside so the validation read and the
    // write share atomicity (single source of truth = the live tx).
    if let Some(ref s) = state {
        let def_row =
            sqlx::query!("SELECT options FROM property_definitions WHERE key = 'todo_state'")
                .fetch_optional(&mut **tx)
                .await?;
        validate_reserved_property_value(
            def_row.is_some(),
            "todo_state",
            s,
            &["TODO", "DOING", "DONE"],
        )?;
    }

    // FEAT-5i — snapshot pre-mutation agenda-relevant state once for
    // the post-commit `notify_gcal_for_op` call below. Skip the extra
    // SELECT when no connector is wired (common in tests).
    let gcal_snapshot = if materializer.is_gcal_hook_active() {
        Some(crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &block_id).await?)
    } else {
        None
    };

    // Fetch current block (inside tx so prev_state is read in the same
    // serialized window as the writes below) to drive transition logic.
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let _ = existing
        .as_ref()
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;

    let prev_state = existing.as_ref().and_then(|b| b.todo_state.clone());
    let new_state = state.clone();

    let (result, todo_op) = set_property_in_tx(
        &mut tx,
        device_id,
        block_id.clone(),
        "todo_state",
        state,
        None,
        None,
        None,
        None,
    )
    .await?;
    // Keep `todo_op` clone for the post-commit GCal notify (the queued
    // background dispatch consumes the original).
    let todo_op_for_gcal = todo_op.clone();
    tx.enqueue_background(todo_op);

    // Auto-populate timestamps based on state transitions
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    match (prev_state.as_deref(), new_state.as_deref()) {
        // null → TODO/DOING: set created_at
        (None, Some("TODO" | "DOING")) => {
            let (_, op) = set_property_in_tx(
                &mut tx,
                device_id,
                block_id.clone(),
                "created_at",
                None,
                None,
                Some(today),
                None,
                None,
            )
            .await?;
            tx.enqueue_background(op);
        }
        // DONE → TODO/DOING: set created_at, clear completed_at
        (Some("DONE"), Some("TODO" | "DOING")) => {
            let (_, op) = set_property_in_tx(
                &mut tx,
                device_id,
                block_id.clone(),
                "created_at",
                None,
                None,
                Some(today),
                None,
                None,
            )
            .await?;
            tx.enqueue_background(op);
            let op = delete_property_in_tx(&mut tx, device_id, &block_id, "completed_at").await?;
            tx.enqueue_background(op);
        }
        // TODO/DOING → DONE: set completed_at
        (Some("TODO" | "DOING"), Some("DONE")) => {
            let (_, op) = set_property_in_tx(
                &mut tx,
                device_id,
                block_id.clone(),
                "completed_at",
                None,
                None,
                Some(today),
                None,
                None,
            )
            .await?;
            tx.enqueue_background(op);
        }
        // Any → null (un-tasking): clear both
        (Some(_), None) => {
            let op = delete_property_in_tx(&mut tx, device_id, &block_id, "created_at").await?;
            tx.enqueue_background(op);
            let op = delete_property_in_tx(&mut tx, device_id, &block_id, "completed_at").await?;
            tx.enqueue_background(op);
        }
        _ => {} // Same state or other transitions — no timestamp changes
    }

    // Recurrence: when transitioning to DONE, delegate to recurrence
    // module — using the in-tx form so the sibling creation rolls back
    // alongside the state change if anything below fails.
    if new_state.as_deref() == Some("DONE") && prev_state.as_deref() != Some("DONE") {
        crate::recurrence::handle_recurrence_in_tx(&mut tx, device_id, &block_id).await?;
    }

    tx.commit_and_dispatch(materializer).await?;

    // FEAT-5i — notify GCal connector post-commit. Only the
    // `todo_state` op is agenda-relevant for GCal (created_at /
    // completed_at are not in `is_agenda_relevant_key`'s set; the
    // recurrence sibling's CreateBlock + SetProperty ops do not have a
    // pre-mutation snapshot since the block is brand new and are
    // therefore picked up by the periodic reconcile sweep).
    if let Some(snapshot) = gcal_snapshot {
        materializer.notify_gcal_for_op(&todo_op_for_gcal, &snapshot);
    }

    Ok(result)
}

/// PEND-35 Tier 2.1 — maximum number of block ids accepted by a single
/// `*_batch` / `*_by_ids` command in one transaction.
///
/// The cap exists to bound the blast radius of one IMMEDIATE transaction:
/// a runaway caller (or a malicious MCP tool) could otherwise hold the
/// writer lock for an unbounded interval while writing thousands of
/// op_log rows. 1000 covers every realistic UI multi-select gesture
/// (TrashView caps its own table to a few hundred rows; the page editor's
/// multi-select fans the same way). Callers exceeding the cap should
/// chunk client-side — the FE wrappers in `src/lib/tauri.ts` deliberately
/// pass the input through unchanged so the backend's cap is the single
/// authority. The same constant is reused in `set_todo_state_batch_inner`
/// and `delete_blocks_by_ids_inner` (and any future `*_by_ids` siblings)
/// so the limit is not silently inconsistent across the family.
pub(crate) const MAX_BATCH_BLOCK_IDS: usize = 1000;

/// PEND-35 Tier 2.1 — batch variant of [`set_todo_state_inner`].
///
/// Replaces the per-row IMMEDIATE-tx loop the FE used to drive on
/// "mark done" / "mark TODO" multi-select gestures. The whole batch
/// runs in a single `BEGIN IMMEDIATE` transaction so a crash mid-batch
/// either commits every state change or none of them — same all-or-
/// nothing semantics as the single-row path (H-4 / invariant #2).
///
/// `state` validation matches `set_todo_state_inner` (1-50 chars,
/// fallback to seeded `["TODO","DOING","DONE"]` defaults when the
/// `property_definitions` row is missing).
///
/// **Tolerance for missing rows**: in contrast with the single-row
/// `set_todo_state_inner` (which returns `NotFound` for a missing or
/// soft-deleted block), the batch path silently skips ids that no
/// longer resolve to a live block. Multi-select gestures inevitably
/// race against concurrent deletes / sync replay; the batch is
/// "best-effort across the surviving subset". The return value is the
/// number of blocks actually updated so the FE can decide how to
/// summarise the result. Validation failures (empty list, oversize
/// list, invalid `state`) still abort the whole tx — those are caller
/// errors, not data drift.
///
/// Recurrence + `created_at`/`completed_at` timestamp transitions
/// (which the single-row path performs in the same tx) are NOT
/// applied here. The batch is a bulk multi-select reflex — the
/// expected gesture is "mark these N blocks DONE" or "clear todo on
/// these N blocks" — and propagating recurrence per item under one
/// IMMEDIATE lock would defeat the latency win. Callers that need
/// recurrence + timestamp transitions should fall through to the
/// single-row path.
#[instrument(skip(pool, device_id, materializer, block_ids), err)]
pub async fn set_todo_state_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<String>,
    state: Option<String>,
) -> Result<i64, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::Validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    if block_ids.len() > MAX_BATCH_BLOCK_IDS {
        return Err(AppError::Validation(format!(
            "block_ids length {} exceeds maximum {MAX_BATCH_BLOCK_IDS}",
            block_ids.len()
        )));
    }
    if let Some(ref s) = state {
        if s.is_empty() || s.len() > 50 {
            return Err(AppError::Validation(
                "Todo state must be 1-50 characters".into(),
            ));
        }
    }

    // I-CommandsCRUD-2 / AGENTS.md invariant #8 — normalise every input id
    // to canonical uppercase before any SQL touch so the membership
    // probe matches the byte-exact ULID on disk regardless of casing
    // supplied by the caller (MCP, sync replay, hand-crafted scripts).
    let block_ids: Vec<String> = block_ids
        .into_iter()
        .map(|id| id.to_ascii_uppercase())
        .collect();

    // One IMMEDIATE tx covers every per-block write (op_log + blocks
    // column). Either every state change commits or none of them.
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state_batch").await?;

    // BUG-20 / MAINT-147 (e) fallback validation — mirrors
    // `set_todo_state_inner`. Read once for the whole batch (single
    // SELECT, regardless of N).
    if let Some(ref s) = state {
        let def_row =
            sqlx::query!("SELECT options FROM property_definitions WHERE key = 'todo_state'")
                .fetch_optional(&mut **tx)
                .await?;
        validate_reserved_property_value(
            def_row.is_some(),
            "todo_state",
            s,
            &["TODO", "DOING", "DONE"],
        )?;
    }

    let mut updated: i64 = 0;
    for block_id in block_ids {
        // Probe existence inside the tx so a concurrent delete that
        // landed between the FE selection and this call cleanly skips
        // rather than aborting the whole batch.
        let exists = sqlx::query_scalar!(
            r#"SELECT 1 AS "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            block_id
        )
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            continue;
        }

        // Reuse the canonical per-row helper so reserved-key validation,
        // op_log append, and the `blocks.todo_state` materialised write
        // all share the single source of truth. Returns `(BlockRow,
        // OpRecord)`; we discard the row (the batch wrapper does not
        // surface per-block payloads) and queue the op record for
        // post-commit dispatch.
        let (_row, op_record) = crate::commands::blocks::set_property_in_tx(
            &mut tx,
            device_id,
            block_id,
            "todo_state",
            state.clone(),
            None,
            None,
            None,
            None,
        )
        .await?;
        tx.enqueue_background(op_record);
        updated += 1;
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(updated)
}

/// Set the priority on a block (level value or clear).
///
/// M-20: priority levels are user-configurable through the
/// `property_definitions.options` JSON for the `priority` key (see
/// ARCHITECTURE.md §20 / UX-201b). Validation against the configured
/// options is performed inside [`set_property_in_tx`], which honours the
/// current definition row. As a defensive fallback — mirroring the
/// `set_todo_state_inner` pattern (BUG-20) — when the `priority`
/// definition row has been deleted we re-enforce the seeded built-in
/// `["1","2","3"]` defaults so a missing definition cannot relax the
/// reserved-key contract.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn set_priority_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    level: Option<String>,
) -> Result<BlockRow, AppError> {
    if let Some(ref l) = level {
        if l.is_empty() || l.len() > 50 {
            return Err(AppError::Validation(
                "priority must be 1-50 characters".into(),
            ));
        }
    }

    // M-97: open the CommandTx before the property_definitions read so
    // the fallback validation and the write share atomicity. Previously
    // the fetch ran against `pool` and we then delegated to
    // `set_property_inner`, which opens its own tx — the validation
    // window and the write window were separate. Folding everything
    // into one tx removes that gap. Body inlined from
    // `set_property_inner` (with `caller_context = None`) to keep the
    // tx scope wide enough to host the fallback read.
    let mut tx = CommandTx::begin_immediate(pool, "set_priority").await?;

    // M-20: rely on the user-extended `priority` property definition
    // options for validation (handled inside `set_property_in_tx`).
    // If the definition row has been deleted, fall back to the
    // built-in seeded options so reserved-key validation remains
    // enforced. Mirrors `set_todo_state_inner` via the shared
    // `validate_reserved_property_value` helper (MAINT-147 (e)).
    if let Some(ref l) = level {
        let def_row =
            sqlx::query!("SELECT options FROM property_definitions WHERE key = 'priority'")
                .fetch_optional(&mut **tx)
                .await?;
        validate_reserved_property_value(def_row.is_some(), "priority", l, &["1", "2", "3"])?;
    }

    // FEAT-5i — snapshot pre-mutation agenda-relevant state so the
    // post-commit `notify_gcal_for_op` call can compute the
    // `old_affected_dates` half of the `DirtyEvent`. Skip the extra
    // SELECT when no connector is wired (common in tests).
    let gcal_snapshot = if materializer.is_gcal_hook_active() {
        Some(crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &block_id).await?)
    } else {
        None
    };

    let (block, op_record) = set_property_in_tx(
        &mut tx, device_id, block_id, "priority", level, None, None, None, None,
    )
    .await?;
    // PEND-25 L9: same Arc-share pattern as `set_property_inner`. The
    // dispatch queue and the post-commit GCal notify borrow the same
    // record via refcount.
    let op_record = Arc::new(op_record);
    tx.enqueue_background(Arc::clone(&op_record));
    tx.commit_and_dispatch(materializer).await?;
    if let Some(snapshot) = gcal_snapshot {
        materializer.notify_gcal_for_op(&op_record, &snapshot);
    }
    Ok(block)
}

/// Set the due date on a block (ISO date YYYY-MM-DD or clear).
///
/// Validates the date format and delegates to [`set_property_inner`] with the
/// reserved `"due_date"` key.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn set_due_date_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    if let Some(ref d) = date {
        if !is_valid_iso_date(d) {
            return Err(AppError::Validation(format!(
                "due_date must be YYYY-MM-DD format, got '{d}'"
            )));
        }
    }
    set_property_inner(
        pool,
        device_id,
        materializer,
        block_id,
        "due_date".to_string(),
        None,
        None,
        date,
        None,
        None,
        None,
    )
    .await
}

/// Set the scheduled date on a block (ISO date YYYY-MM-DD or clear).
///
/// Validates the date format and delegates to [`set_property_inner`] with the
/// reserved `"scheduled_date"` key.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn set_scheduled_date_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    if let Some(ref d) = date {
        if !is_valid_iso_date(d) {
            return Err(AppError::Validation(format!(
                "scheduled_date must be YYYY-MM-DD format, got '{d}'"
            )));
        }
    }
    set_property_inner(
        pool,
        device_id,
        materializer,
        block_id,
        "scheduled_date".to_string(),
        None,
        None,
        date,
        None,
        None,
        None,
    )
    .await
}

/// I-CommandsCRUD-8: previously a separate structural validator that
/// drifted from `validate_date_format`. Now delegates so there is one
/// source of truth for ISO-date validation across the commands surface.
pub(crate) fn is_valid_iso_date(s: &str) -> bool {
    crate::commands::validate_date_format(s).is_ok()
}

/// Delete a property from a block.
///
/// Appends a `DeleteProperty` op and removes the row from `block_properties`.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_property_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    key: String,
) -> Result<(), AppError> {
    delete_property_core(pool, device_id, materializer, block_id, key).await
}

/// Get all properties for a block (read-only).
#[instrument(skip(pool), err)]
pub async fn get_properties_inner(
    pool: &SqlitePool,
    block_id: String,
) -> Result<Vec<PropertyRow>, AppError> {
    let rows = sqlx::query_as!(
        PropertyRow,
        "SELECT key, value_text, value_num, value_date, value_ref, value_bool \
         FROM block_properties WHERE block_id = ?",
        block_id
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// PEND-35 Tier 2.4c — fetch a single property row by `(block_id, key)`
/// primary key. Returns `Ok(None)` when no row exists.
///
/// Sibling of [`get_properties_inner`] for the common "list everything
/// then `find(p => p.key === '<one-key>')`" pattern: five FE callsites
/// (`loadJournalTemplateForSpace`, `StaticBlock` image-width read, the
/// three `blocked_by` dependency probes in `useBlockProperties` /
/// `useBlockSlashCommands` / `useCheckboxSyntax`) used to ship the full
/// vocabulary across the IPC boundary just to read one well-known key.
/// This dedicated PK lookup collapses that O(N) wire payload to one row.
///
/// Block id is normalised to canonical uppercase per AGENTS.md
/// invariant #8 — callers occasionally pass lowercase ids (sync replay,
/// hand-crafted scripts) and the on-disk row stores the canonical
/// uppercase form.
///
/// The column projection mirrors `get_properties_inner` so the FE
/// `PropertyRow` shape is byte-identical between the bulk and single-key
/// paths.
#[instrument(skip(pool), err)]
pub async fn get_property_inner(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
) -> Result<Option<PropertyRow>, AppError> {
    let block_id = block_id.to_ascii_uppercase();
    let row = sqlx::query_as!(
        PropertyRow,
        "SELECT key, value_text, value_num, value_date, value_ref, value_bool \
         FROM block_properties WHERE block_id = ?1 AND key = ?2",
        block_id,
        key,
    )
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

/// Create a property definition. Uses INSERT OR IGNORE for idempotency —
/// if the key already exists, this is a no-op.
#[instrument(skip(pool, options), err)]
pub async fn create_property_def_inner(
    pool: &SqlitePool,
    key: String,
    value_type: String,
    options: Option<String>,
) -> Result<PropertyDefinition, AppError> {
    // Validate key: non-empty, max 64 chars, alphanumeric + underscore + hyphen
    if key.is_empty() || key.len() > 64 {
        return Err(AppError::Validation(
            "property definition key must be 1-64 characters".into(),
        ));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AppError::Validation(
            "property definition key must contain only alphanumeric, underscore, or hyphen characters".into(),
        ));
    }
    // Validate value_type
    if !matches!(
        value_type.as_str(),
        "text" | "number" | "date" | "select" | "ref" | "boolean"
    ) {
        return Err(AppError::Validation(format!(
            "invalid value_type '{value_type}': must be text, number, date, select, ref, or boolean"
        )));
    }
    // Validate options: required for select, forbidden for others
    if value_type == "select" {
        match &options {
            None => {
                return Err(AppError::Validation(
                    "select-type definitions require an options array".into(),
                ))
            }
            Some(opts) => {
                let parsed: Vec<String> = serde_json::from_str(opts).map_err(|_| {
                    AppError::Validation("options must be a JSON array of strings".into())
                })?;
                if parsed.is_empty() {
                    return Err(AppError::Validation(
                        "select-type options must not be empty".into(),
                    ));
                }
            }
        }
    } else if options.is_some() {
        return Err(AppError::Validation(format!(
            "options are only allowed for select-type definitions, not '{value_type}'"
        )));
    }

    let now = crate::now_rfc3339();
    sqlx::query(
        "INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&key)
    .bind(&value_type)
    .bind(&options)
    .bind(&now)
    .execute(pool)
    .await?;

    // Fetch back (may differ from input if key already existed)
    let row = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_one(pool)
    .await?;

    Ok(row)
}

/// List all property definitions, paginated and ordered by `key ASC`
/// (M-85, AGENTS.md invariant #3).
///
/// `key` is the primary key on `property_definitions` (a string, not a
/// ULID), so the keyset cursor is encoded via [`Cursor::for_id`] with
/// `last.key.clone()` — `for_id` accepts any `String` and stores it in
/// the cursor's `id` slot. `limit` is forwarded through
/// [`pagination::PageRequest::new`] which clamps to the canonical
/// `[1, MAX_PAGE_SIZE]` range; the MCP tool boundary applies its own
/// `LIST_RESULT_CAP` clamp.
///
/// M-85: previously returned a flat `Vec<PropertyDefinition>`. Now
/// returns a [`PageResponse<PropertyDefinition>`] so the tool surface
/// is consistent with the rest of the paginated read commands. The
/// frontend `listPropertyDefs()` wrapper destructures `.items`; MCP
/// agents thread `cursor` / `next_cursor` / `has_more`.
#[instrument(skip(pool), err)]
pub async fn list_property_defs_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<pagination::PageResponse<PropertyDefinition>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    let (cursor_flag, cursor_key): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.as_str()),
        None => (None, ""),
    };
    let fetch_limit = page.limit + 1;
    let rows = sqlx::query_as!(
        PropertyDefinition,
        r#"SELECT key, value_type, options, created_at
         FROM property_definitions
         WHERE (?1 IS NULL OR key > ?2)
         ORDER BY key ASC
         LIMIT ?3"#,
        cursor_flag,
        cursor_key,
        fetch_limit,
    )
    .fetch_all(pool)
    .await?;
    pagination::build_page_response(rows, page.limit, |last| {
        pagination::Cursor::for_id(last.key.clone())
    })
}

/// PEND-35 Tier 2.6 — fetch a single property definition by primary
/// key. Returns `Ok(None)` when no row exists for `key` (callers like
/// `useAppBootRecovery` treat the missing-priority-def case as "use
/// the default level set" rather than an error).
///
/// The SQL shape mirrors the existing single-key `SELECT` already used
/// inside [`create_property_def_inner`] (post-INSERT readback) and
/// [`update_property_def_options_inner`] (existing-row probe) — both
/// fetch the same four columns from `property_definitions WHERE key =
/// ?`. Two FE call sites previously called `list_property_defs` (the
/// full vocabulary) just to read one well-known key; the dedicated PK
/// SELECT collapses that O(N) wire payload to one row.
#[instrument(skip(pool), err)]
pub async fn get_property_def_inner(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<PropertyDefinition>, AppError> {
    let row = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Update the options array for a select-type definition.
/// Returns error if the key doesn't exist or isn't select-type.
///
/// # Orphan rows on narrowing (L-32)
///
/// Narrowing the option set (e.g. removing `"in_review"` from
/// `["todo", "in_review", "done"]`) leaves any existing
/// `block_properties.value_text` rows whose value is no longer in the
/// allowed list as **orphans**. Subsequent `set_property_in_tx` writes
/// will reject those values, but reads through `get_properties`
/// continue to surface them — a UX inconsistency where the user can
/// read a value they can no longer write.
///
/// We do not reject the narrowing call here (that would be a
/// behaviour change for callers that knowingly want to retire an
/// option without first migrating dependent rows). Instead, we count
/// the orphans up front and emit a `tracing::warn!` breadcrumb naming
/// the key, the count, and the dropped values, so the log surfaces
/// the inconsistency rather than the user discovering it later via a
/// failed write. Sync replay behaves identically on both ends, so
/// this is not a corruption vector.
#[instrument(skip(pool, options), err)]
pub async fn update_property_def_options_inner(
    pool: &SqlitePool,
    key: String,
    options: String,
) -> Result<PropertyDefinition, AppError> {
    // Validate options is a non-empty JSON array of strings
    let parsed: Vec<String> = serde_json::from_str(&options)
        .map_err(|_| AppError::Validation("options must be a JSON array of strings".into()))?;
    if parsed.is_empty() {
        return Err(AppError::Validation("options must not be empty".into()));
    }

    // Fetch existing to verify it's select-type
    let existing = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;

    if existing.value_type != "select" {
        return Err(AppError::Validation(format!(
            "cannot update options on '{}'-type definition '{key}'",
            existing.value_type
        )));
    }

    // L-32: count orphan rows before applying the narrowing. The new
    // options are encoded as a JSON array; bind via `json_each(?)` so
    // SQLite expands the membership test without a placeholder
    // explosion. Live blocks only — `b.deleted_at IS NULL` matches the
    // semantics of `get_properties` so the warn count reflects what
    // the user will actually see.
    let orphan_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties bp \
         JOIN blocks b ON b.id = bp.block_id \
         WHERE bp.key = ?1 \
           AND bp.value_text IS NOT NULL \
           AND b.deleted_at IS NULL \
           AND bp.value_text NOT IN (SELECT value FROM json_each(?2))",
        key,
        options,
    )
    .fetch_one(pool)
    .await?;

    if orphan_count > 0 {
        tracing::warn!(
            key = %key,
            orphan_count = orphan_count,
            new_options = %options,
            "narrowing select-type property options leaves rows whose value is no longer in the \
             allowed list (L-32); subsequent writes for those values will be rejected but reads \
             continue to surface them",
        );
    }

    sqlx::query("UPDATE property_definitions SET options = ? WHERE key = ?")
        .bind(&options)
        .bind(&key)
        .execute(pool)
        .await?;

    Ok(PropertyDefinition {
        key: existing.key,
        value_type: existing.value_type,
        options: Some(options),
        created_at: existing.created_at,
    })
}

/// Delete a property definition by key.
///
/// Returns error if the key doesn't exist, is a built-in, or is still
/// referenced by `block_properties` rows.
///
/// # M-26 — reject when dependent rows exist
///
/// The previous behaviour deleted the `property_definitions` row
/// unconditionally, which orphaned any `block_properties` rows that
/// referenced the same key: `def_meta` then became `None` in
/// `set_property_in_tx`, the type/options validation block was skipped
/// silently, and re-creating the same key with a different `value_type`
/// later mismatched the existing data.
///
/// Cascading the delete is not an option — `block_properties` rows are
/// produced by SetProperty ops and the op log is strictly append-only,
/// so removing them outside the op-log path would violate that
/// invariant. Instead we reject the delete with [`AppError::Validation`]
/// and surface the count plus a suggested clean-up path so the user
/// knows exactly which key to clear before retrying.
///
/// The EXISTS / COUNT check and the DELETE both run inside a single
/// `BEGIN IMMEDIATE` transaction so a concurrent `set_property` cannot
/// race in between the count and the DELETE and create a fresh
/// `block_properties` row that the caller never saw in the rejection
/// message.
#[instrument(skip(pool), err)]
pub async fn delete_property_def_inner(pool: &SqlitePool, key: String) -> Result<(), AppError> {
    if crate::op::is_builtin_property_key(&key) {
        return Err(AppError::Validation(
            "cannot delete builtin property definition".into(),
        ));
    }

    // M-26: open a BEGIN IMMEDIATE tx so the dependent-row check and
    // the DELETE are TOCTOU-safe. Dropping the tx without commit (early
    // returns below) rolls it back automatically.
    let mut tx = crate::db::begin_immediate_logged(pool, "delete_property_def").await?;

    let dependent_count: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM block_properties WHERE key = ?", key,)
            .fetch_one(&mut *tx)
            .await?;

    if dependent_count > 0 {
        return Err(AppError::Validation(format!(
            "cannot delete property definition '{key}': {dependent_count} block_properties \
             row(s) reference this key. Clear them first via set_property(value=None) on each \
             affected block."
        )));
    }

    let result = sqlx::query("DELETE FROM property_definitions WHERE key = ?")
        .bind(&key)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("property definition '{key}'")));
    }

    tx.commit().await?;
    Ok(())
}

/// Batch-fetch properties for multiple blocks in a single query.
///
/// Returns a map of block_id → Vec<PropertyRow>. Block IDs with no properties
/// are omitted from the result (not an error).
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction.
///
/// # Errors
/// - [`AppError::Validation`] — `block_ids` is empty
#[instrument(skip(pool, block_ids), err)]
pub async fn get_batch_properties_inner(
    pool: &SqlitePool,
    block_ids: Vec<String>,
) -> Result<HashMap<String, Vec<PropertyRow>>, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::Validation(
            "block_ids list cannot be empty".into(),
        ));
    }

    let ids_json = serde_json::to_string(&block_ids)?;

    let rows = sqlx::query_as!(
        BatchPropertyRow,
        r#"SELECT block_id, key, value_text, value_num, value_date, value_ref, value_bool
           FROM block_properties
           WHERE block_id IN (SELECT value FROM json_each(?1))"#,
        ids_json,
    )
    .fetch_all(pool)
    .await?;

    let mut map: HashMap<String, Vec<PropertyRow>> = HashMap::new();
    for r in rows {
        map.entry(r.block_id).or_default().push(PropertyRow {
            key: r.key,
            value_text: r.value_text,
            value_num: r.value_num,
            value_date: r.value_date,
            value_ref: r.value_ref,
            value_bool: r.value_bool,
        });
    }

    Ok(map)
}

/// Tauri command: list distinct property keys. Delegates to [`list_property_keys_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_property_keys(read_pool: State<'_, ReadPool>) -> Result<Vec<String>, AppError> {
    list_property_keys_inner(&read_pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: set (upsert) a property on a block. Delegates to [`set_property_inner`].
///
/// PEND-14: typed value fields are bundled into [`SetPropertyArgs`] so the
/// IPC signature stays at 7 positional args (under specta's 10-arg cap).
/// Adding `value_bool` as a 5th flat field would have exceeded the limit.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_property(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    key: String,
    value: SetPropertyArgs,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone();
    let key_clone = key.clone();
    let result = set_property_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        key,
        value.value_text,
        value.value_num,
        value.value_date,
        value.value_ref,
        value.value_bool,
        None,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec![key_clone]);
    Ok(result)
}

/// Tauri command: set todo state on a block. Delegates to [`set_todo_state_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_todo_state(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    state: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone();
    let result = set_todo_state_inner(&pool.0, device_id.as_str(), &materializer, block_id, state)
        .await
        .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["todo_state".to_string()]);
    Ok(result)
}

/// Tauri command: batch-set todo state on multiple blocks (PEND-35 Tier 2.1).
///
/// Delegates to [`set_todo_state_batch_inner`]. Single IMMEDIATE tx
/// covers every per-block write — collapses the legacy N-IPC loop the
/// FE used to drive in `useBlockMultiSelect.handleBatchSetTodo` into
/// one round-trip / one op_log seq range / one writer-lock window.
///
/// Emits one `EVENT_PROPERTY_CHANGED` per successfully-updated block
/// so existing per-block listeners (e.g. agenda recompute, property
/// drawer) keep firing without protocol changes. Failed-emit
/// breadcrumbs follow the established log-on-error pattern (L-33).
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_todo_state_batch(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_ids: Vec<String>,
    state: Option<String>,
) -> Result<i64, AppError> {
    let block_ids_for_emit = block_ids.clone();
    let updated =
        set_todo_state_batch_inner(&pool.0, device_id.as_str(), &materializer, block_ids, state)
            .await
            .map_err(sanitize_internal_error)?;
    // Emit per-block change events so the existing per-block listeners
    // continue to receive the same signal shape they got from the
    // single-row path. The inner already skipped missing rows silently,
    // but emitting for ids that did not actually update is harmless —
    // the listener side already debounces / re-reads.
    for id in block_ids_for_emit {
        emit_property_changed_event(
            &app,
            id.to_ascii_uppercase(),
            vec!["todo_state".to_string()],
        );
    }
    Ok(updated)
}

/// Tauri command: set priority on a block. Delegates to [`set_priority_inner`].
///
/// L-38: emits `EVENT_PROPERTY_CHANGED` after a successful set so the
/// frontend property-change listener fires for priority updates (parity
/// with `set_todo_state` / `set_due_date` / `set_scheduled_date` /
/// `delete_property` / `set_property`). The emit uses the
/// log-on-error pattern (mirror of L-33) so a transient emit failure
/// does not propagate as a command error.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_priority(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    level: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone();
    let result = set_priority_inner(&pool.0, device_id.as_str(), &materializer, block_id, level)
        .await
        .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["priority".to_string()]);
    Ok(result)
}

/// Tauri command: set due date on a block. Delegates to [`set_due_date_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_due_date(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone();
    let result = set_due_date_inner(&pool.0, device_id.as_str(), &materializer, block_id, date)
        .await
        .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["due_date".to_string()]);
    Ok(result)
}

/// Tauri command: set scheduled date on a block. Delegates to [`set_scheduled_date_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_scheduled_date(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone();
    let result =
        set_scheduled_date_inner(&pool.0, device_id.as_str(), &materializer, block_id, date)
            .await
            .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["scheduled_date".to_string()]);
    Ok(result)
}

/// Tauri command: delete a property from a block. Delegates to [`delete_property_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_property(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    key: String,
) -> Result<(), AppError> {
    let block_id_clone = block_id.clone();
    let key_clone = key.clone();
    delete_property_inner(&pool.0, device_id.as_str(), &materializer, block_id, key)
        .await
        .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec![key_clone]);
    Ok(())
}

/// Tauri command: get all properties for a block. Delegates to [`get_properties_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_properties(
    pool: State<'_, ReadPool>,
    block_id: String,
) -> Result<Vec<PropertyRow>, AppError> {
    get_properties_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: fetch a single property row by `(block_id, key)`
/// primary key (PEND-35 Tier 2.4c). Delegates to [`get_property_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_property(
    pool: State<'_, ReadPool>,
    block_id: String,
    key: String,
) -> Result<Option<PropertyRow>, AppError> {
    get_property_inner(&pool.0, &block_id, &key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-fetch properties. Delegates to [`get_batch_properties_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_batch_properties(
    pool: State<'_, ReadPool>,
    block_ids: Vec<String>,
) -> Result<HashMap<String, Vec<PropertyRow>>, AppError> {
    get_batch_properties_inner(&pool.0, block_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: create a property definition. Delegates to [`create_property_def_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn create_property_def(
    write_pool: State<'_, WritePool>,
    key: String,
    value_type: String,
    options: Option<String>,
) -> Result<PropertyDefinition, AppError> {
    create_property_def_inner(&write_pool.0, key, value_type, options)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list all property definitions, paginated (M-85).
/// Delegates to [`list_property_defs_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_property_defs(
    read_pool: State<'_, ReadPool>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<pagination::PageResponse<PropertyDefinition>, AppError> {
    list_property_defs_inner(&read_pool.0, cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: fetch a single property definition by key (PEND-35 Tier 2.6).
/// Delegates to [`get_property_def_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_property_def(
    read_pool: State<'_, ReadPool>,
    key: String,
) -> Result<Option<PropertyDefinition>, AppError> {
    get_property_def_inner(&read_pool.0, &key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: update options for a select-type definition. Delegates to [`update_property_def_options_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn update_property_def_options(
    write_pool: State<'_, WritePool>,
    key: String,
    options: String,
) -> Result<PropertyDefinition, AppError> {
    update_property_def_options_inner(&write_pool.0, key, options)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: delete a property definition. Delegates to [`delete_property_def_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_property_def(
    write_pool: State<'_, WritePool>,
    key: String,
) -> Result<(), AppError> {
    delete_property_def_inner(&write_pool.0, key)
        .await
        .map_err(sanitize_internal_error)
}
