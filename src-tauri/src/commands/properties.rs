//! Properties command handlers.

use std::collections::HashMap;

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::backlink;
use crate::db::{CommandTx, ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;

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
        ]
        .iter()
        .filter(|b| **b)
        .count();
        if provided != 1 {
            return Err(AppError::Validation(format!(
                "tool '{name}': exactly one of value_text / value_num / value_date / \
                 value_ref must be provided (got {provided})"
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
    )
    .await?;
    // Clone `op_record` for the dispatch queue so the post-commit
    // `notify_gcal_for_op` call below still has the original.
    tx.enqueue_background(op_record.clone());
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

        // BUG-20: Validate against todo_state property definition options.
        // `set_property_in_tx` already performs this check when the
        // definition exists; this fallback guards the case where the
        // definition has been deleted, ensuring the built-in defaults are
        // still enforced. MAINT-147 (e): the validation logic is shared
        // with `set_priority_inner` via `validate_reserved_property_value`.
        let def_row =
            sqlx::query!("SELECT options FROM property_definitions WHERE key = 'todo_state'")
                .fetch_optional(pool)
                .await?;
        validate_reserved_property_value(
            def_row.is_some(),
            "todo_state",
            s,
            &["TODO", "DOING", "DONE"],
        )?;
    }

    // H-4: open one IMMEDIATE tx covering every write below — the
    // state change, the `created_at`/`completed_at` timestamp writes,
    // and the recurrence-sibling creation. A pre-fix crash mid-sequence
    // could leave a `done` state with no `completed_at` and no
    // next-occurrence sibling — see REVIEW-LATER H-4 for the rationale.
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state").await?;

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
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
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

        // M-20: rely on the user-extended `priority` property definition
        // options for validation (handled inside `set_property_in_tx`).
        // If the definition row has been deleted, fall back to the
        // built-in seeded options so reserved-key validation remains
        // enforced. Mirrors `set_todo_state_inner` via the shared
        // `validate_reserved_property_value` helper (MAINT-147 (e)).
        let def_row =
            sqlx::query!("SELECT options FROM property_definitions WHERE key = 'priority'")
                .fetch_optional(pool)
                .await?;
        validate_reserved_property_value(def_row.is_some(), "priority", l, &["1", "2", "3"])?;
    }
    set_property_inner(
        pool,
        device_id,
        materializer,
        block_id,
        "priority".to_string(),
        level,
        None,
        None,
        None,
        None,
    )
    .await
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
    )
    .await
}

/// Simple validation for ISO date format `YYYY-MM-DD`.
pub(crate) fn is_valid_iso_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let all_digits = bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !all_digits {
        return false;
    }
    let month: u32 = s[5..7].parse().unwrap_or(0);
    let day: u32 = s[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
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
        "SELECT key, value_text, value_num, value_date, value_ref \
         FROM block_properties WHERE block_id = ?",
        block_id
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
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
        "text" | "number" | "date" | "select" | "ref"
    ) {
        return Err(AppError::Validation(format!(
            "invalid value_type '{value_type}': must be text, number, date, select, or ref"
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

/// List all property definitions, ordered by key.
#[instrument(skip(pool), err)]
pub async fn list_property_defs_inner(
    pool: &SqlitePool,
) -> Result<Vec<PropertyDefinition>, AppError> {
    let rows = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions ORDER BY key"
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Update the options array for a select-type definition.
/// Returns error if the key doesn't exist or isn't select-type.
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
/// Returns error if the key doesn't exist.
#[instrument(skip(pool), err)]
pub async fn delete_property_def_inner(pool: &SqlitePool, key: String) -> Result<(), AppError> {
    if crate::op::is_builtin_property_key(&key) {
        return Err(AppError::Validation(
            "cannot delete builtin property definition".into(),
        ));
    }

    let result = sqlx::query("DELETE FROM property_definitions WHERE key = ?")
        .bind(&key)
        .execute(pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("property definition '{key}'")));
    }

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
        r#"SELECT block_id, key, value_text, value_num, value_date, value_ref
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
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn set_property(
    app: tauri::AppHandle,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
) -> Result<BlockRow, AppError> {
    let block_id_clone = block_id.clone();
    let key_clone = key.clone();
    let result = set_property_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        key,
        value_text,
        value_num,
        value_date,
        value_ref,
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

/// Tauri command: list all property definitions. Delegates to [`list_property_defs_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_property_defs(
    read_pool: State<'_, ReadPool>,
) -> Result<Vec<PropertyDefinition>, AppError> {
    list_property_defs_inner(&read_pool.0)
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
