//! Properties command handlers.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::backlink;
use crate::db::{CommandTx, ReadPool, WriteCtx, WritePool};
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::pagination;
use crate::pagination::ActiveBlockRow;
use crate::ulid::{ActiveBlockId, BlockId};

use super::sanitize_internal_error;
use super::*;

/// Defensive fallback validation for reserved property
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

/// Emit `EVENT_PROPERTY_CHANGED` with a log-on-error
/// fallback so a transient emit failure does not propagate as a
/// command error.  Centralises the previously-duplicated emit block
/// shared by `set_property`, `set_todo_state`, `set_priority`,
/// `set_due_date`, `set_scheduled_date`, and `delete_property`.
fn emit_property_changed_event(
    app: &tauri::AppHandle,
    block_id: String,
    changed_keys: Vec<String>,
) {
    use crate::sync_events::{EVENT_PROPERTY_CHANGED, PropertyChangedEvent};
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

/// List the distinct text values in use for a single property `key`,
/// usage-ranked (#1425).
#[instrument(skip(pool), err)]
pub async fn list_property_values_inner(
    pool: &SqlitePool,
    key: &str,
) -> Result<Vec<String>, AppError> {
    backlink::list_property_values(pool, key).await
}

/// Set (upsert) a property on a block.
///
/// Thin wrapper around [`set_property_in_tx`] that manages the transaction
/// lifecycle and dispatches background work.
///
/// `caller_context`: when `Some(name)`, the exactly-one-value
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
    block_id: ActiveBlockId,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<bool>,
    caller_context: Option<&str>,
) -> Result<ActiveBlockRow, AppError> {
    // When a caller_context is supplied, enforce the
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
    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "set_property").await?;
    let (block, op_record) = set_property_in_tx(
        &mut tx,
        device_id,
        block_id.into_string(),
        &key,
        value_text,
        value_num,
        value_date,
        value_ref,
        value_bool,
    )
    .await?;
    tx.enqueue_background(Arc::new(op_record));
    tx.commit_and_dispatch(materializer).await?;
    Ok(ActiveBlockRow::from_block_row_unchecked(block))
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
    block_id: ActiveBlockId,
    state: Option<String>,
) -> Result<ActiveBlockRow, AppError> {
    if let Some(ref s) = state
        && (s.is_empty() || s.len() > 50)
    {
        return Err(AppError::Validation(
            "Todo state must be 1-50 characters".into(),
        ));
    }

    // H-4: open one IMMEDIATE tx covering every write below — the
    // state change, the `created_at`/`completed_at` timestamp writes,
    // and the recurrence-sibling creation. A pre-fix crash mid-sequence
    // could leave a `done` state with no `completed_at` and no
    // next-occurrence sibling (H-4).
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state").await?;

    // Validate against todo_state property definition options.
    // `set_property_in_tx` already performs this check when the
    // definition exists; this fallback guards the case where the
    // definition has been deleted, ensuring the built-in defaults are
    // Still enforced. the validation logic is shared
    // with `set_priority_inner` via `validate_reserved_property_value`.
    //
    // This fetch was previously issued against `pool` *before*
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

    let block_id_str = block_id.as_str();

    // Fetch only `todo_state` — the full SELECT * is unnecessary here
    // since `set_property_in_tx` (called below) issues its own SELECT.
    // `set_property_in_tx` returns NotFound if the block is missing, so
    // the redundant existence guard is dropped.
    let prev_state: Option<String> = sqlx::query_scalar!(
        "SELECT todo_state FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id_str
    )
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    let new_state = state.clone();

    let block_id_owned = block_id.into_string();
    let (result, todo_op) = set_property_in_tx(
        &mut tx,
        device_id,
        block_id_owned.clone(),
        "todo_state",
        state,
        None,
        None,
        None,
        None,
    )
    .await?;
    tx.enqueue_background(todo_op);

    // Auto-populate timestamps based on state transitions
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    match (prev_state.as_deref(), new_state.as_deref()) {
        // null → TODO/DOING: set created_at
        (None, Some("TODO" | "DOING")) => {
            let (_, op) = set_property_in_tx(
                &mut tx,
                device_id,
                block_id_owned.clone(),
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
                block_id_owned.clone(),
                "created_at",
                None,
                None,
                Some(today),
                None,
                None,
            )
            .await?;
            tx.enqueue_background(op);
            let op =
                delete_property_in_tx(&mut tx, device_id, &block_id_owned, "completed_at").await?;
            tx.enqueue_background(op);
        }
        // TODO/DOING → DONE: set completed_at
        (Some("TODO" | "DOING"), Some("DONE")) => {
            let (_, op) = set_property_in_tx(
                &mut tx,
                device_id,
                block_id_owned.clone(),
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
            let op =
                delete_property_in_tx(&mut tx, device_id, &block_id_owned, "created_at").await?;
            tx.enqueue_background(op);
            let op =
                delete_property_in_tx(&mut tx, device_id, &block_id_owned, "completed_at").await?;
            tx.enqueue_background(op);
        }
        _ => {} // Same state or other transitions — no timestamp changes
    }

    // Recurrence: when transitioning to DONE, delegate to recurrence
    // module — using the in-tx form so the sibling creation rolls back
    // alongside the state change if anything below fails.
    if new_state.as_deref() == Some("DONE") && prev_state.as_deref() != Some("DONE") {
        crate::recurrence::handle_recurrence_in_tx(&mut tx, device_id, &block_id_owned).await?;
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(ActiveBlockRow::from_block_row_unchecked(result))
}

/// Batch variant of [`set_todo_state_inner`].
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
    block_ids: Vec<BlockId>,
    state: Option<String>,
) -> Result<i64, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::Validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    if let Some(ref s) = state
        && (s.is_empty() || s.len() > 50)
    {
        return Err(AppError::Validation(
            "Todo state must be 1-50 characters".into(),
        ));
    }

    // I-CommandsCRUD-2 / AGENTS.md invariant #8 — `BlockId` normalises to
    // canonical uppercase on construction, so the membership probe matches
    // the byte-exact ULID on disk regardless of casing supplied by the
    // caller (MCP, sync replay, hand-crafted scripts). Project to the
    // owned `String` form once for the `json_each` bind below.
    let block_id_strings: Vec<String> =
        block_ids.iter().map(|id| id.as_str().to_string()).collect();

    // One IMMEDIATE tx covers every per-block write (op_log + blocks
    // column). Either every state change commits or none of them.
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state_batch").await?;

    // SQL-review this batch path skips the timestamp + recurrence
    // side-effects that the single-row `set_todo_state_inner` performs.
    // If any block in the batch carries a `repeat` property, emit a
    // `tracing::warn!` so callers expecting per-block recurrence advance
    // notice that this is the batched path. The check is a single
    // SELECT that probes for `key = 'repeat'` across the batch's blocks
    // — cheaper than the per-block-read pre-commit shape.
    //
    // #473 L3: probe inside the IMMEDIATE tx (not on the pool) so the
    // read is in the same serialized window as the writes below —
    // avoiding a TOCTOU race where a repeat property is added/removed
    // between this probe and the tx open.
    let repeat_carriers = sqlx::query_scalar::<_, String>(
        "SELECT block_id FROM block_properties \
         WHERE key = 'repeat' AND block_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(&block_id_strings)?)
    .fetch_all(&mut **tx)
    .await?;
    if !repeat_carriers.is_empty() {
        tracing::warn!(
            target: "agaric::set_todo_state_batch",
            repeat_carrier_count = repeat_carriers.len(),
            example_block_id = %repeat_carriers.first().map_or("", String::as_str),
            "set_todo_state_batch_inner skips per-block recurrence advance + \
             completion-timestamp side-effects that the single-row path runs; \
             {} block(s) in this batch carry `repeat` and will NOT roll forward",
            repeat_carriers.len(),
        );
    }

    // Fallback validation — mirrors
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
        let block_id_str = block_id.as_str();
        let exists = sqlx::query_scalar!(
            r#"SELECT 1 AS "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            block_id_str
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
            block_id.into_string(),
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
/// Priority levels are user-configurable through the
/// `property_definitions.options` JSON for the `priority` key (see
/// Docs/ARCHITECTURE.md §20). Validation against the configured
/// options is performed inside [`set_property_in_tx`], which honours the
/// current definition row. As a defensive fallback — mirroring the
/// `set_todo_state_inner` pattern — when the `priority`
/// definition row has been deleted we re-enforce the seeded built-in
/// `["1","2","3"]` defaults so a missing definition cannot relax the
/// reserved-key contract.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn set_priority_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: ActiveBlockId,
    level: Option<String>,
) -> Result<ActiveBlockRow, AppError> {
    if let Some(ref l) = level
        && (l.is_empty() || l.len() > 50)
    {
        return Err(AppError::Validation(
            "priority must be 1-50 characters".into(),
        ));
    }

    // Open the CommandTx before the property_definitions read so
    // the fallback validation and the write share atomicity. Previously
    // the fetch ran against `pool` and we then delegated to
    // `set_property_inner`, which opens its own tx — the validation
    // window and the write window were separate. Folding everything
    // into one tx removes that gap. Body inlined from
    // `set_property_inner` (with `caller_context = None`) to keep the
    // tx scope wide enough to host the fallback read.
    let mut tx = CommandTx::begin_immediate(pool, "set_priority").await?;

    // Rely on the user-extended `priority` property definition
    // options for validation (handled inside `set_property_in_tx`).
    // If the definition row has been deleted, fall back to the
    // built-in seeded options so reserved-key validation remains
    // enforced. Mirrors `set_todo_state_inner` via the shared
    // `validate_reserved_property_value` helper.
    if let Some(ref l) = level {
        let def_row =
            sqlx::query!("SELECT options FROM property_definitions WHERE key = 'priority'")
                .fetch_optional(&mut **tx)
                .await?;
        validate_reserved_property_value(def_row.is_some(), "priority", l, &["1", "2", "3"])?;
    }

    let (block, op_record) = set_property_in_tx(
        &mut tx,
        device_id,
        block_id.into_string(),
        "priority",
        level,
        None,
        None,
        None,
        None,
    )
    .await?;
    tx.enqueue_background(Arc::new(op_record));
    tx.commit_and_dispatch(materializer).await?;
    Ok(ActiveBlockRow::from_block_row_unchecked(block))
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
    block_id: ActiveBlockId,
    date: Option<String>,
) -> Result<ActiveBlockRow, AppError> {
    if let Some(ref d) = date
        && !is_valid_iso_date(d)
    {
        return Err(AppError::Validation(format!(
            "due_date must be YYYY-MM-DD format, got '{d}'"
        )));
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
    block_id: ActiveBlockId,
    date: Option<String>,
) -> Result<ActiveBlockRow, AppError> {
    if let Some(ref d) = date
        && !is_valid_iso_date(d)
    {
        return Err(AppError::Validation(format!(
            "scheduled_date must be YYYY-MM-DD format, got '{d}'"
        )));
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

/// Delete a property from a block.
///
/// Appends a `DeleteProperty` op and removes the row from `block_properties`.
///
/// # Errors
///
/// - [`AppError::Validation`] — `key` is a system-managed lifecycle property
///   (`created_at` / `completed_at` / `repeat-*`); these are written only by
///   internal state-transition helpers and must not be deleted by FE/MCP
///   callers, or recurrence bookkeeping breaks (#658).
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_property_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: ActiveBlockId,
    key: String,
) -> Result<(), AppError> {
    // #658: `delete_property_core` is the unguarded path used internally by
    // state-transition helpers (e.g. clearing `created_at` / `completed_at`
    // / `repeat-*` during a recurrence transition). The public command must
    // NOT let callers remove those system-managed *lifecycle* keys, or
    // recurrence bookkeeping silently breaks.
    //
    // The reserved *column* keys (`todo_state` / `priority` / `due_date` /
    // `scheduled_date`) are intentionally NOT blocked: clearing them is a
    // legitimate user action (e.g. removing a block's due date), and core
    // routes them to the matching `blocks` column. So the guard is the
    // built-in set MINUS the reserved column keys — i.e. exactly the
    // lifecycle keys.
    if crate::op::is_builtin_property_key(&key) && !crate::op::is_reserved_property_key(&key) {
        return Err(AppError::Validation(format!(
            "cannot delete system-managed property '{key}'"
        )));
    }
    delete_property_core(pool, device_id, materializer, block_id.into_string(), key).await
}

/// Get all properties for a block (read-only).
#[instrument(skip(pool), err)]
pub async fn get_properties_inner(
    pool: &SqlitePool,
    block_id: BlockId,
) -> Result<Vec<PropertyRow>, AppError> {
    let block_id = block_id.as_str();
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

/// Fetch a single property row by `(block_id, key)`
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
    block_id: &BlockId,
    key: &str,
) -> Result<Option<PropertyRow>, AppError> {
    // `BlockId` is already normalised to canonical uppercase on
    // construction (AGENTS.md invariant #8), so the byte-exact column
    // comparison hits the on-disk row without a redundant uppercase pass.
    let block_id = block_id.as_str();
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
                ));
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
/// (AGENTS.md invariant #3).
///
/// `key` is the primary key on `property_definitions` (a string, not a
/// ULID), so the keyset cursor is encoded via [`Cursor::for_id`] with
/// `last.key.clone()` — `for_id` accepts any `String` and stores it in
/// the cursor's `id` slot. `limit` is forwarded through
/// [`pagination::PageRequest::new`] which clamps to the canonical
/// `[1, MAX_PAGE_SIZE]` range; the MCP tool boundary applies its own
/// `LIST_RESULT_CAP` clamp.
///
/// Previously returned a flat `Vec<PropertyDefinition>`. Now
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

/// Fetch a single property definition by primary
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
/// # Orphan rows on narrowing
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

    // #383: open a BEGIN IMMEDIATE tx so the existence/type check, the orphan
    // count, and the UPDATE are TOCTOU-safe — a concurrent
    // `delete_property_def`/`set_property` cannot race in between the read and
    // the write. Mirrors the sibling `delete_property_def_inner`. Dropping the
    // tx without commit (early returns below) rolls it back automatically.
    // allow-raw-tx: updates property_definitions (schema metadata), no op_log (#110)
    let mut tx = crate::db::begin_immediate_logged(pool, "update_property_def_options").await?;

    // Fetch existing to verify it's select-type
    let existing = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;

    if existing.value_type != "select" {
        return Err(AppError::Validation(format!(
            "cannot update options on '{}'-type definition '{key}'",
            existing.value_type
        )));
    }

    // Count orphan rows before applying the narrowing. The new
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
    .fetch_one(&mut *tx)
    .await?;

    if orphan_count > 0 {
        tracing::warn!(
            key = %key,
            orphan_count = orphan_count,
            new_options = %options,
            "narrowing select-type property options leaves rows whose value is no longer in the \
             allowed list; subsequent writes for those values will be rejected but reads \
             continue to surface them",
        );
    }

    let result = sqlx::query("UPDATE property_definitions SET options = ? WHERE key = ?")
        .bind(&options)
        .bind(&key)
        .execute(&mut *tx)
        .await?;

    // #383: guard against a silent no-op write. The existence check above ran
    // inside the same tx, so a 0-row UPDATE here means the row vanished under
    // an impossible concurrency window (or a schema mismatch) — surface it
    // rather than returning a row that was never persisted.
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("property definition '{key}'")));
    }

    // #383: read the post-update row back INSIDE the tx instead of
    // reconstructing the return value from the pre-update snapshot, so the
    // returned shape reflects exactly what is committed.
    let updated = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(updated)
}

/// Delete a property definition by key.
///
/// Returns error if the key doesn't exist, is a built-in, or is still
/// referenced by `block_properties` rows.
///
/// # reject when dependent rows exist
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

    // Open a BEGIN IMMEDIATE tx so the dependent-row check and
    // the DELETE are TOCTOU-safe. Dropping the tx without commit (early
    // returns below) rolls it back automatically.
    // allow-raw-tx: deletes from property_definitions (schema metadata), no op_log (#110)
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
    block_ids: Vec<BlockId>,
) -> Result<HashMap<String, Vec<PropertyRow>>, AppError> {
    if block_ids.is_empty() {
        return Err(AppError::Validation(
            "block_ids list cannot be empty".into(),
        ));
    }

    // `json_each(?)` binds a JSON array of the canonical id strings;
    // `BlockId` already holds the normalised uppercase form.
    let id_strings: Vec<&str> = block_ids.iter().map(BlockId::as_str).collect();
    let ids_json = serde_json::to_string(&id_strings)?;

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
        map.entry(r.block_id.into_string())
            .or_default()
            .push(PropertyRow {
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
#[tauri::command]
#[specta::specta]
pub async fn list_property_keys(read_pool: State<'_, ReadPool>) -> Result<Vec<String>, AppError> {
    list_property_keys_inner(&read_pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list distinct text values for a property key
/// (#1425). Delegates to [`list_property_values_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_property_values(
    read_pool: State<'_, ReadPool>,
    key: String,
) -> Result<Vec<String>, AppError> {
    list_property_values_inner(&read_pool.0, &key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: set (upsert) a property on a block. Delegates to [`set_property_inner`].
///
/// Typed value fields are bundled into [`SetPropertyArgs`] so the
/// IPC signature stays at 7 positional args (under specta's 10-arg cap).
/// Adding `value_bool` as a 5th flat field would have exceeded the limit.
#[tauri::command]
#[specta::specta]
pub async fn set_property(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    key: String,
    value: SetPropertyArgs,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone().into_string();
    let key_clone = key.clone();
    // #1627: mint the type-state newtype without a pre-tx round-trip.
    // The activeness gate (existence + soft-deleted discrimination, with
    // identical NotFound/Validation errors) now runs inside the write
    // transaction's existing re-validation (`set_property_in_tx`).
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let result = set_property_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
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
    Ok(result.into())
}

/// Tauri command: set todo state on a block. Delegates to [`set_todo_state_inner`].
#[tauri::command]
#[specta::specta]
pub async fn set_todo_state(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    state: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone().into_string();
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let result = set_todo_state_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        state,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["todo_state".to_string()]);
    Ok(result.into())
}

/// Tauri command: batch-set todo state on multiple blocks.
///
/// Delegates to [`set_todo_state_batch_inner`]. Single IMMEDIATE tx
/// covers every per-block write — collapses the legacy N-IPC loop the
/// FE used to drive in `useBlockMultiSelect.handleBatchSetTodo` into
/// one round-trip / one op_log seq range / one writer-lock window.
///
/// Emits one `EVENT_PROPERTY_CHANGED` per successfully-updated block
/// so existing per-block listeners (e.g. agenda recompute, property
/// drawer) keep firing without protocol changes. Failed-emit
/// Breadcrumbs follow the established log-on-error pattern.
#[tauri::command]
#[specta::specta]
pub async fn set_todo_state_batch(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
    state: Option<String>,
) -> Result<i64, AppError> {
    let block_ids_for_emit = block_ids.clone();
    let updated = set_todo_state_batch_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_ids,
        state,
    )
    .await
    .map_err(sanitize_internal_error)?;
    // Emit per-block change events so the existing per-block listeners
    // continue to receive the same signal shape they got from the
    // single-row path. The inner already skipped missing rows silently,
    // but emitting for ids that did not actually update is harmless —
    // the listener side already debounces / re-reads.
    for id in block_ids_for_emit {
        emit_property_changed_event(&app, id.into_string(), vec!["todo_state".to_string()]);
    }
    Ok(updated)
}

/// Tauri command: set priority on a block. Delegates to [`set_priority_inner`].
///
/// Emits `EVENT_PROPERTY_CHANGED` after a successful set so the
/// frontend property-change listener fires for priority updates (parity
/// with `set_todo_state` / `set_due_date` / `set_scheduled_date` /
/// `delete_property` / `set_property`). The emit uses the
/// Log-on-error pattern (mirror of) so a transient emit failure
/// does not propagate as a command error.
#[tauri::command]
#[specta::specta]
pub async fn set_priority(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    level: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone().into_string();
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let result = set_priority_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        level,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["priority".to_string()]);
    Ok(result.into())
}

/// Tauri command: set due date on a block. Delegates to [`set_due_date_inner`].
#[tauri::command]
#[specta::specta]
pub async fn set_due_date(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone().into_string();
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let result = set_due_date_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        date,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["due_date".to_string()]);
    Ok(result.into())
}

/// Tauri command: set scheduled date on a block. Delegates to [`set_scheduled_date_inner`].
#[tauri::command]
#[specta::specta]
pub async fn set_scheduled_date(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    date: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone().into_string();
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let result = set_scheduled_date_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        date,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec!["scheduled_date".to_string()]);
    Ok(result.into())
}

/// Tauri command: delete a property from a block. Delegates to [`delete_property_inner`].
#[tauri::command]
#[specta::specta]
pub async fn delete_property(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    key: String,
) -> Result<(), AppError> {
    let block_id_clone = block_id.clone().into_string();
    let key_clone = key.clone();
    // #1627: mint the type-state newtype without a pre-tx round-trip.
    // The activeness gate (existence + soft-deleted discrimination, with
    // identical NotFound/Validation errors) now runs inside the write
    // transaction's existing re-validation (`delete_property_core`).
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    delete_property_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        key,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec![key_clone]);
    Ok(())
}

/// Tauri command: get all properties for a block. Delegates to [`get_properties_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_properties(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
) -> Result<Vec<PropertyRow>, AppError> {
    get_properties_inner(&pool.0, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: fetch a single property row by `(block_id, key)`
/// Primary key. Delegates to [`get_property_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_property(
    pool: State<'_, ReadPool>,
    block_id: BlockId,
    key: String,
) -> Result<Option<PropertyRow>, AppError> {
    get_property_inner(&pool.0, &block_id, &key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-fetch properties. Delegates to [`get_batch_properties_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_batch_properties(
    pool: State<'_, ReadPool>,
    block_ids: Vec<BlockId>,
) -> Result<HashMap<String, Vec<PropertyRow>>, AppError> {
    get_batch_properties_inner(&pool.0, block_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: create a property definition. Delegates to [`create_property_def_inner`].
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

/// Tauri command: list all property definitions, paginated.
/// Delegates to [`list_property_defs_inner`].
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

/// Tauri command: fetch a single property definition by key.
/// Delegates to [`get_property_def_inner`].
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
