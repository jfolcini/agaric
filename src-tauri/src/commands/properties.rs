//! Properties command handlers.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx, WritePool};
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::{ActiveBlockId, BlockId};
use agaric_store::backlink;
use agaric_store::pagination;
use agaric_store::pagination::ActiveBlockRow;

use super::sanitize_internal_error;
use super::*;

/// Built-in fallback vocabulary for the `todo_state` reserved key —
/// must mirror the live `property_definitions.options` seeded by
/// migrations 0014/0029/0031 (`["TODO","DOING","DONE","CANCELLED"]`).
/// Declared once here (rather than re-typed as a literal at each
/// `validate_reserved_property_value` call site) so a future seed
/// change only needs one edit; `todo_state_and_priority_fallback_defaults_match_seeded_options`
/// (in `src-tauri/tests/commands/property_cmd_tests.rs`) asserts this constant
/// stays in sync with the actual seeded options as a drift guard
/// (#3124 — the fallback previously omitted CANCELLED).
pub const TODO_STATE_FALLBACK_DEFAULTS: &[&str] = &["TODO", "DOING", "DONE", "CANCELLED"];

/// Built-in fallback vocabulary for the `priority` reserved key —
/// must mirror the live `property_definitions.options` seeded by
/// migration 0014 (`["1","2","3"]`, never changed since). See
/// [`TODO_STATE_FALLBACK_DEFAULTS`] for why this is a named constant.
pub const PRIORITY_FALLBACK_DEFAULTS: &[&str] = &["1", "2", "3"];

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
/// `defaults` is the ordered list of allowed values (pass
/// [`TODO_STATE_FALLBACK_DEFAULTS`] / [`PRIORITY_FALLBACK_DEFAULTS`]);
/// the error message echoes them verbatim so the frontend toast lines
/// up with the user's mental model of "TODO/DOING/DONE/CANCELLED" or
/// "1/2/3".
fn validate_reserved_property_value(
    def_row_present: bool,
    key: &str,
    value: &str,
    defaults: &[&str],
) -> Result<(), AppError> {
    if !def_row_present && !defaults.contains(&value) {
        return Err(AppError::validation(format!(
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
    use agaric_sync::sync_events::{EVENT_PROPERTY_CHANGED, PropertyChangedEvent};
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
            return Err(AppError::validation(format!(
                "tool '{name}': exactly one of value_text / value_num / value_date / \
                 value_ref / value_bool must be provided (got {provided})"
            )));
        }
    }
    // #3647 — validate the `repeat` recurrence grammar HERE, at the user's
    // point of entry, so a malformed rule fails where it was typed.
    //
    // `repeat` is free text in a plain `text` column (migration 0016),
    // authored through the property drawer's bare `<Input>` or an inline
    // `repeat:: …` line. Until now a bad rule was accepted silently and only
    // misbehaved at completion time, inside a transaction the user cannot
    // observe: `shift_date` returns `Ok(None)` for a shape error, so the
    // recurrence sibling was created with no date and nothing said why
    // (#3281 replaced a hard wedge with exactly this quiet failure).
    //
    // Deliberately at the COMMAND boundary, not inside `set_property_in_tx`:
    // the recurrence flow copies the parent's rule onto the new sibling
    // through that same helper (`compute::set_recurrence_property`), so
    // validating there would make a task carrying an already-stored bad rule
    // un-completable — re-creating the #3281 wedge for existing rows. It is
    // also NOT in `op::validate_set_property`, which runs on the remote-op
    // ingest path (`dag::insert_remote_op`): a peer's legacy rule must still
    // land, or the two devices stop converging. See the back-compat note in
    // `repeat_rule_validation_is_entry_point_only_3647`.
    //
    // Non-text values need no gate here: `repeat` is a declared `text`
    // property, so `validate_property_value` already rejects a `value_num` /
    // `value_date` / `value_ref` / `value_bool` write to it.
    if key == "repeat"
        && let Some(ref rule) = value_text
    {
        agaric_engine::recurrence::validate_repeat_rule(rule)?;
    }

    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "set_property").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let (block, op_record) = set_property_in_tx(
        &mut tx,
        materializer.loro_state(),
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
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
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
        return Err(AppError::validation(
            "Todo state must be 1-50 characters".into(),
        ));
    }

    // H-4: open one IMMEDIATE tx covering every write below — the
    // state change, the `created_at`/`completed_at` timestamp writes,
    // and the recurrence-sibling creation. A pre-fix crash mid-sequence
    // could leave a `done` state with no `completed_at` and no
    // next-occurrence sibling (H-4).
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

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
            TODO_STATE_FALLBACK_DEFAULTS,
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
        materializer.loro_state(),
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
                materializer.loro_state(),
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
                materializer.loro_state(),
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
            let op = delete_property_in_tx(
                &mut tx,
                materializer.loro_state(),
                device_id,
                &block_id_owned,
                "completed_at",
            )
            .await?;
            tx.enqueue_background(op);
        }
        // TODO/DOING → DONE: set completed_at
        (Some("TODO" | "DOING"), Some("DONE")) => {
            let (_, op) = set_property_in_tx(
                &mut tx,
                materializer.loro_state(),
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
            let op = delete_property_in_tx(
                &mut tx,
                materializer.loro_state(),
                device_id,
                &block_id_owned,
                "created_at",
            )
            .await?;
            tx.enqueue_background(op);
            let op = delete_property_in_tx(
                &mut tx,
                materializer.loro_state(),
                device_id,
                &block_id_owned,
                "completed_at",
            )
            .await?;
            tx.enqueue_background(op);
        }
        _ => {} // Same state or other transitions — no timestamp changes
    }

    // Recurrence: when transitioning to DONE, delegate to recurrence
    // module — using the in-tx form so the sibling creation rolls back
    // alongside the state change if anything below fails.
    if new_state.as_deref() == Some("DONE") && prev_state.as_deref() != Some("DONE") {
        crate::recurrence::handle_recurrence_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            &block_id_owned,
        )
        .await?;
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(ActiveBlockRow::from_block_row_unchecked(result))
}

/// Probe a batch's target blocks for a `repeat` property and `warn!` if any
/// carry one, because none of the batch paths run the per-block recurrence
/// advance the single-row `set_todo_state_inner` performs.
///
/// #3264: this used to be open-coded inside [`set_todo_state_batch_inner`]
/// only. [`set_property_batch_inner`] — its generalisation across the four
/// reserved column-backed keys — skips recurrence identically but emitted
/// nothing, so the two live batch surfaces behaved the same and logged
/// differently. The concrete cost: a user multi-selects pages in the Pages
/// browser and sets `todo_state = DONE` through
/// `PageBrowserBatchToolbar`, any `repeat`-carrying page never rolls forward,
/// and the daily log is silent — triage has to first work out WHICH of the two
/// batch commands the click routed to before it can even look for the
/// diagnostic. One helper, one target, both callers.
///
/// The `command` field (not the target) distinguishes the callers, so a log
/// filter on `agaric::batch_recurrence_skip` catches every batch path,
/// including ones added later.
///
/// #473 L3: `conn` MUST be the caller's already-open `BEGIN IMMEDIATE`
/// transaction, not the pool, so the read sits in the same serialized window
/// as the writes it is warning about — otherwise a `repeat` property
/// added/removed between the probe and the tx open makes the warning lie.
/// A single SELECT probing `key = 'repeat'` across the whole batch, not a
/// per-block read.
///
/// The gate at the call sites is the KEY (`todo_state`), never the value:
/// [`set_todo_state_batch_inner`] warns for every state it is handed —
/// including a clear — so gating the sibling on `Some("DONE")` would put the
/// two paths back out of step, which is the whole defect.
///
/// # Errors
/// Returns [`AppError`] if the probe query fails. Deliberately propagated
/// rather than swallowed: the probe runs on the command transaction, so a
/// failure here is a failure of that transaction, and silently degrading to
/// "no warning" would recreate the blind spot this helper exists to close.
async fn warn_if_batch_skips_recurrence(
    conn: &mut sqlx::SqliteConnection,
    command: &'static str,
    block_ids: &[BlockId],
) -> Result<(), AppError> {
    // I-CommandsCRUD-2 / AGENTS.md invariant #8 — `BlockId` normalises to
    // canonical uppercase on construction, so the serialized ids match the
    // byte-exact ULIDs on disk regardless of the casing the caller supplied
    // (MCP, sync replay, hand-crafted scripts).
    let block_ids_json = serde_json::to_string(block_ids)?;
    let repeat_carriers = sqlx::query_scalar::<_, String>(
        "SELECT block_id FROM block_properties \
         WHERE key = 'repeat' AND block_id IN (SELECT value FROM json_each(?))",
    )
    .bind(block_ids_json)
    .fetch_all(&mut *conn)
    .await?;
    if !repeat_carriers.is_empty() {
        tracing::warn!(
            target: "agaric::batch_recurrence_skip",
            command = command,
            repeat_carrier_count = repeat_carriers.len(),
            example_block_id = %repeat_carriers.first().map_or("", String::as_str),
            "{} skips the per-block recurrence advance + completion-timestamp \
             side-effects that the single-row path runs; {} block(s) in this \
             batch carry `repeat` and will NOT roll forward",
            command,
            repeat_carriers.len(),
        );
    }
    Ok(())
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
/// fallback to seeded `["TODO","DOING","DONE","CANCELLED"]` defaults
/// when the `property_definitions` row is missing).
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
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    if let Some(ref s) = state
        && (s.is_empty() || s.len() > 50)
    {
        return Err(AppError::validation(
            "Todo state must be 1-50 characters".into(),
        ));
    }

    // One IMMEDIATE tx covers every per-block write (op_log + blocks
    // column). Either every state change commits or none of them.
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state_batch").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // SQL-review this batch path skips the timestamp + recurrence
    // side-effects that the single-row `set_todo_state_inner` performs.
    // #3264: the probe + `warn!` now live in the shared
    // [`warn_if_batch_skips_recurrence`] so `set_property_batch_inner` — which
    // skips recurrence in exactly the same way — emits the same diagnostic
    // instead of nothing.
    warn_if_batch_skips_recurrence(&mut tx, "set_todo_state_batch_inner", &block_ids).await?;

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
            TODO_STATE_FALLBACK_DEFAULTS,
        )?;
    }

    // #2038: resolve which target blocks are live in ONE membership query
    // instead of a per-block existence SELECT inside the loop (N+1). Skip-on-
    // miss semantics are preserved: a row deleted between the FE selection and
    // this call is absent from `alive` and cleanly skipped.
    let block_ids_json = serde_json::to_string(&block_ids)?;
    let alive: std::collections::HashSet<String> = sqlx::query_scalar!(
        r#"SELECT id FROM blocks
           WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL"#,
        block_ids_json
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();

    let mut updated: i64 = 0;
    for block_id in block_ids {
        if !alive.contains(block_id.as_str()) {
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
            materializer.loro_state(),
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

/// The set of property keys `set_property_batch` is allowed to write.
///
/// This is a **security boundary**: the batch command routes an untrusted
/// `(key, value)` pair into a typed `blocks` column, so only the four
/// reserved column-backed keys may be set in bulk. Arbitrary keys are
/// rejected up-front — a batch write must never become a channel for
/// injecting undeclared custom properties across N blocks under one lock.
const SET_PROPERTY_BATCH_ALLOWED_KEYS: &[&str] =
    &["todo_state", "priority", "due_date", "scheduled_date"];

/// Batch-set one allowlisted property `(key, value)` on N blocks in a
/// single IMMEDIATE tx — the generalisation of
/// [`set_todo_state_batch_inner`] across the four reserved column-backed
/// keys (`todo_state`, `priority`, `due_date`, `scheduled_date`).
///
/// `value = None` CLEARS the property (all `value_*` columns null), same
/// clear semantics as the single-row inners. `value = Some(_)` routes to
/// the correct typed column by key:
/// - `todo_state` / `priority` → `value_text`, with the same
///   `property_definitions` option-list fallback validation the single-row
///   (`set_todo_state_inner` / `set_priority_inner`) and
///   `set_todo_state_batch_inner` paths run.
/// - `due_date` / `scheduled_date` → `value_date`, with the same ISO
///   `YYYY-MM-DD` format check the single-row date inners run (also
///   re-enforced by `validate_property_value` inside `set_property_in_tx`).
///
/// Tolerance / atomicity match `set_todo_state_batch_inner`: missing or
/// soft-deleted ids in the input list are silently skipped (best-effort
/// across the surviving subset), while caller errors (non-allowlisted key,
/// empty list, oversize list, invalid value) abort the whole tx before any
/// write lands. Returns the number of blocks actually updated.
///
/// Like the todo batch, this path deliberately does NOT run recurrence /
/// completion-timestamp transitions — it is a bulk multi-select reflex.
/// #3264: and, like the todo batch, it now says so — when `key` is
/// `todo_state` it runs `warn_if_batch_skips_recurrence` inside the same
/// IMMEDIATE tx, so a Pages-browser multi-select over `repeat`-carrying pages
/// leaves a diagnostic in the daily log instead of nothing.
#[instrument(skip(pool, device_id, materializer, block_ids), err)]
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub async fn set_property_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
    key: String,
    value: Option<String>,
) -> Result<i64, AppError> {
    // Security boundary: reject any key outside the reserved column-backed
    // allowlist BEFORE opening the tx, so a bad key writes nothing.
    if !SET_PROPERTY_BATCH_ALLOWED_KEYS.contains(&key.as_str()) {
        return Err(AppError::validation(format!(
            "set_property_batch: key '{key}' is not settable in batch; \
             allowed keys: {}",
            SET_PROPERTY_BATCH_ALLOWED_KEYS.join(", ")
        )));
    }

    if block_ids.is_empty() {
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

    // Pre-tx value-shape validation, mirroring the single-row inners
    // (`set_todo_state_inner` / `set_priority_inner` length check;
    // `set_due_date_inner` / `set_scheduled_date_inner` ISO-date check).
    let is_text_key = matches!(key.as_str(), "todo_state" | "priority");
    match key.as_str() {
        "todo_state" | "priority" => {
            if let Some(ref v) = value
                && (v.is_empty() || v.len() > 50)
            {
                return Err(AppError::validation(format!(
                    "{key} must be 1-50 characters"
                )));
            }
        }
        "due_date" | "scheduled_date" => {
            if let Some(ref d) = value
                && !is_valid_iso_date(d)
            {
                return Err(AppError::validation(format!(
                    "{key} must be YYYY-MM-DD format, got '{d}'"
                )));
            }
        }
        // Unreachable: the allowlist guard above already rejected any other
        // key. Kept as a defensive no-op rather than `unreachable!` so a
        // future allowlist edit that forgets the routing branch degrades to
        // a clean write attempt (still bounded by `set_property_in_tx`
        // validation) instead of a panic under the writer lock.
        _ => {}
    }

    // One IMMEDIATE tx covers every per-block write (op_log + blocks
    // column). Either every property change commits or none of them.
    let mut tx = CommandTx::begin_immediate(pool, "set_property_batch").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // #3264: `todo_state` is the only allowlisted key with recurrence
    // semantics, and this path skips them exactly as
    // `set_todo_state_batch_inner` does — so it now emits the same warning
    // through the same shared probe. Gated on the KEY, not on
    // `value == Some("DONE")`: the sibling warns for every state including a
    // clear, and re-introducing a value gate here would put the two paths back
    // out of step. Skipped entirely for the three non-recurring keys so the
    // other 3/4 of this command pays no extra SELECT.
    if key == "todo_state" {
        warn_if_batch_skips_recurrence(&mut tx, "set_property_batch_inner", &block_ids).await?;
    }

    // Reserved-key option-list fallback validation for the two text keys,
    // mirroring `set_todo_state_batch_inner` / `set_priority_inner`. Read
    // once for the whole batch (single SELECT, regardless of N). Branch into
    // two compile-checked `query!` macros with literal keys (both already in
    // the `.sqlx/` cache) rather than one runtime query on the dynamic `key`,
    // so this stays schema-validated at build time with no new cache entry.
    if is_text_key && let Some(ref v) = value {
        let (def_exists, defaults): (bool, &[&str]) = if key == "todo_state" {
            let row =
                sqlx::query!("SELECT options FROM property_definitions WHERE key = 'todo_state'")
                    .fetch_optional(&mut **tx)
                    .await?;
            (row.is_some(), TODO_STATE_FALLBACK_DEFAULTS)
        } else {
            let row =
                sqlx::query!("SELECT options FROM property_definitions WHERE key = 'priority'")
                    .fetch_optional(&mut **tx)
                    .await?;
            (row.is_some(), PRIORITY_FALLBACK_DEFAULTS)
        };
        validate_reserved_property_value(def_exists, &key, v, defaults)?;
    }

    // Route the single value to the correct typed column: text keys →
    // `value_text`, date keys → `value_date`. `None` leaves both null,
    // which `set_property_in_tx` treats as a clear.
    let value_text = if is_text_key { value.clone() } else { None };
    let value_date = if is_text_key { None } else { value.clone() };

    // Resolve which target blocks are live in ONE membership query (no
    // per-block existence SELECT in the loop). Skip-on-miss semantics: a row
    // deleted between the FE selection and this call is absent from `alive`
    // and cleanly skipped.
    let block_ids_json = serde_json::to_string(&block_ids)?;
    let alive: std::collections::HashSet<String> = sqlx::query_scalar!(
        r#"SELECT id FROM blocks
           WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL"#,
        block_ids_json
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();

    let mut updated: i64 = 0;
    for block_id in block_ids {
        if !alive.contains(block_id.as_str()) {
            continue;
        }

        // Reuse the canonical per-row helper so reserved-key validation,
        // op_log append, and the materialised `blocks` column write all
        // share the single source of truth. Discard the returned row (the
        // batch wrapper surfaces no per-block payload) and queue the op
        // record for post-commit dispatch.
        let (_row, op_record) = crate::commands::blocks::set_property_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            block_id.into_string(),
            &key,
            value_text.clone(),
            None,
            value_date.clone(),
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
/// docs/architecture/data-and-events.md § Property values). Validation against the configured
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
        return Err(AppError::validation(
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
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

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
        validate_reserved_property_value(
            def_row.is_some(),
            "priority",
            l,
            PRIORITY_FALLBACK_DEFAULTS,
        )?;
    }

    let (block, op_record) = set_property_in_tx(
        &mut tx,
        materializer.loro_state(),
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
        return Err(AppError::validation(format!(
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
        return Err(AppError::validation(format!(
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
/// - [`AppError::Validation`] — `key` is a protected lifecycle/recurrence
///   property (`created_at` / `completed_at` / `repeat-*`). Created/completed dates are
///   managed by state transitions, while repeat keys participate in recurrence
///   configuration; direct FE/MCP deletion is rejected to protect that
///   bookkeeping (#658).
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_property_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: ActiveBlockId,
    key: String,
) -> Result<(), AppError> {
    // #658: `delete_property_core` is the standalone path that owns its
    // transaction, and this is its sole production caller. Keep the lifecycle
    // guard here before delegating. State-transition helpers that already hold
    // a transaction use `delete_property_in_tx` to clear `created_at` /
    // `completed_at` keys.
    //
    // The reserved *column* keys (`todo_state` / `priority` / `due_date` /
    // `scheduled_date`) are intentionally NOT blocked: clearing them is a
    // legitimate user action (e.g. removing a block's due date), and core
    // routes them to the matching `blocks` column. So the guard is the
    // built-in set MINUS the reserved column keys — i.e. exactly the
    // lifecycle keys.
    if agaric_store::op::is_builtin_property_key(&key)
        && !agaric_store::op::is_reserved_property_key(&key)
    {
        return Err(AppError::validation(format!(
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

/// Shape validation shared by every `property_definitions` writer:
/// [`create_property_def_inner`] (owns its pool round-trip) and
/// [`create_property_def_in_tx`] (writes inside a caller's transaction).
/// Extracted so the two cannot drift — a key/type/options payload either
/// writer accepts must be one the other accepts too.
fn validate_property_def_shape(
    key: &str,
    value_type: &str,
    options: Option<&str>,
) -> Result<(), AppError> {
    // Validate key: non-empty, max 64 chars, alphanumeric + underscore + hyphen
    if key.is_empty() || key.len() > 64 {
        return Err(AppError::validation(
            "property definition key must be 1-64 characters".into(),
        ));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AppError::validation(
            "property definition key must contain only alphanumeric, underscore, or hyphen characters".into(),
        ));
    }
    // Validate value_type
    if !matches!(
        value_type,
        "text" | "number" | "date" | "select" | "ref" | "boolean"
    ) {
        return Err(AppError::validation(format!(
            "invalid value_type '{value_type}': must be text, number, date, select, ref, or boolean"
        )));
    }
    // Validate options: required for select, forbidden for others
    if value_type == "select" {
        match options {
            None => {
                return Err(AppError::validation(
                    "select-type definitions require an options array".into(),
                ));
            }
            Some(opts) => {
                let parsed: Vec<String> = serde_json::from_str(opts).map_err(|_| {
                    AppError::validation("options must be a JSON array of strings".into())
                })?;
                if parsed.is_empty() {
                    return Err(AppError::validation(
                        "select-type options must not be empty".into(),
                    ));
                }
            }
        }
    } else if options.is_some() {
        return Err(AppError::validation(format!(
            "options are only allowed for select-type definitions, not '{value_type}'"
        )));
    }

    Ok(())
}

/// Whether a declaration of `value_type` would still accept a
/// `block_properties` row stored in the `shape` column (#4399).
///
/// This is `validate_property_value`'s step-4 `type_matches`
/// (`agaric-engine/src/block_ops.rs`) read backwards: there it asks "does
/// this payload fit the declaration?", here we ask "does every value
/// already stored fit the declaration we are about to create?". The two
/// must agree exactly — a shape this says is admitted but the engine
/// rejects is a row the user can never rewrite. In particular `text` and
/// `select` admit `value_ref` as well as `value_text`, and the catch-all
/// mirrors step 4's `_ => true` (an unrecognised declared type constrains
/// nothing, so nothing conflicts with it).
fn declared_type_admits_shape(value_type: &str, shape: &str) -> bool {
    match value_type {
        "text" | "select" => shape == "text" || shape == "ref",
        "ref" => shape == "ref",
        "number" => shape == "number",
        "date" => shape == "date",
        "boolean" => shape == "boolean",
        _ => true,
    }
}

/// Would declaring `key` as `value_type` orphan values the vault already
/// holds under that key? Returns the rejection message when it would, and
/// `None` when the declaration is safe (#4399).
///
/// # Why a declaration over existing values is a trap
///
/// `property_definitions` is keyed by `key` alone, so a declaration
/// constrains **every block in the vault**. The dangerous case is a key
/// with existing values and no declaration — the ordinary state, since
/// `validate_property_value` skips its type check entirely when
/// `declaration` is `None`, so an undeclared non-reserved key accepts any
/// of the five typed slots. Declaring a contradicting type over those
/// values costs the user three things at once (#4382):
///
///  1. every later write of the stored shape, on any block, is rejected —
///     `"Property 'year' expects type 'number', got 'text'."`;
///  2. on inbound sync a `Str` value is routed by `value_type`,
///     `parse::<f64>()` fails, and there is a deliberate
///     no-fallback-to-`value_text` rule, so the row is dropped row-absent
///     and the user cannot even see which blocks are affected;
///  3. the declaration cannot be withdrawn —
///     [`delete_property_def_inner`] refuses while any `block_properties`
///     row references the key, and the remedy its error names
///     (`set_property(value = None)`) is itself rejected for a
///     non-reserved key. The only exit discards the data.
///
/// # Why the probe is shape-aware rather than "any rows at all"
///
/// [`declare_bib_property_defs`](crate::commands::pages::bibliography)
/// uses the coarse "does this key have any values?" test, and that is
/// right for an import: it is not the user's typing decision, so the
/// cheap conservative answer costs nothing. It is the wrong test for a
/// command a user invokes deliberately. Declaring a type is most useful
/// for a key that is already in use — that is the whole reason to open
/// Settings → Properties — and the coarse test would make exactly that
/// case permanently impossible, with no way back short of deleting every
/// value. Declaring `number` over rows that already live in `value_num`
/// traps nothing: none of the three links above can fire, because every
/// stored value still satisfies the declaration.
///
/// So the predicate is the precise one: refuse only when a stored value
/// would be rejected by the requested type. That is
/// [`declared_type_admits_shape`] per shape, plus step 5's options
/// membership for a `select` declaration that carries an options array —
/// a stored `value_text` outside the list is just as un-writable as a
/// wrong-shaped one.
///
/// # Deliberately no `blocks.deleted_at` filter
///
/// The COUNT(*) that blocks [`delete_property_def_inner`] does not filter
/// soft-deleted blocks either, so a declaration created over a trashed
/// block's values is just as permanently stuck. Narrowing the condition
/// here would let link 3 back in through the trash.
///
/// Reserved / column-backed keys need no carve-out: migration 0088's
/// `key_not_reserved` CHECK forbids `block_properties` rows for them
/// outright, so the probe finds nothing and the declaration proceeds.
async fn conflicting_existing_values(
    conn: &mut sqlx::SqliteConnection,
    key: &str,
    value_type: &str,
    options: Option<&str>,
) -> Result<Option<String>, AppError> {
    // One aggregate pass over the key's rows. The `exactly_one_value` CHECK
    // (migrations 0062 / 0088) guarantees exactly one non-NULL value column
    // per row, so these five counts partition `total` and a row can never be
    // counted under two shapes.
    let counts = sqlx::query!(
        r#"SELECT
             COUNT(*)                                                            AS "total!: i64",
             COALESCE(SUM(CASE WHEN value_text IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_text!: i64",
             COALESCE(SUM(CASE WHEN value_num  IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_num!: i64",
             COALESCE(SUM(CASE WHEN value_date IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_date!: i64",
             COALESCE(SUM(CASE WHEN value_ref  IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_ref!: i64",
             COALESCE(SUM(CASE WHEN value_bool IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_bool!: i64"
           FROM block_properties
           WHERE key = ?1"#,
        key,
    )
    .fetch_one(&mut *conn)
    .await?;

    if counts.total == 0 {
        return Ok(None);
    }

    let mut offending: i64 = 0;
    let mut parts: Vec<String> = Vec::new();
    for (n, shape) in [
        (counts.n_text, "text"),
        (counts.n_num, "number"),
        (counts.n_date, "date"),
        (counts.n_ref, "ref"),
        (counts.n_bool, "boolean"),
    ] {
        if n > 0 && !declared_type_admits_shape(value_type, shape) {
            offending += n;
            parts.push(format!("{n} stored as {shape}"));
        }
    }

    // Step 5 (`validate_property_value`): a `select` declaration with a
    // non-NULL options array also constrains `value_text` to the listed
    // options. Disjoint from the shape counts above — these rows ARE
    // `value_text`, which `select` admits by shape, and fail on membership.
    if value_type == "select"
        && let Some(opts) = options
    {
        let out_of_options: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64"
               FROM block_properties
               WHERE key = ?1
                 AND value_text IS NOT NULL
                 AND value_text NOT IN (SELECT value FROM json_each(?2))"#,
            key,
            opts,
        )
        .fetch_one(&mut *conn)
        .await?;
        if out_of_options > 0 {
            offending += out_of_options;
            parts.push(format!("{out_of_options} not in the declared options"));
        }
    }

    if offending == 0 {
        return Ok(None);
    }

    let detail = parts.join(", ");
    Ok(Some(format!(
        "cannot declare property '{key}' as '{value_type}': {offending} value(s) already stored \
         under this key would be rejected by that type ({detail}). A property definition applies \
         to every block in the vault, and it cannot be removed again while any value under the \
         key exists. Clear or convert those values first, or declare '{key}' as the type they \
         already use."
    )))
}

/// Create a property definition. Uses INSERT OR IGNORE for idempotency —
/// if the key already exists, this is a no-op and the existing row is
/// returned unchanged.
///
/// # Refuses to declare a type over values that contradict it (#4399)
///
/// Before inserting, this probes `block_properties` for the key and
/// rejects with [`AppError::Validation`] when any value already stored
/// under it would be rejected by the requested `value_type` — see
/// `conflicting_existing_values` for the trap that guards against, and
/// for why the probe is shape-aware instead of the coarser "any values at
/// all?" test the bibliography import uses.
///
/// The refusal is deliberate, and deliberately different from the
/// import's warn-and-continue: this command is a single-key action a user
/// took on purpose with a dialog open, so silently declining to declare
/// what they asked for would leave them staring at a key that reports no
/// type and no reason. All three UI call sites already render a rejection.
///
/// # Atomicity
///
/// The probe, the INSERT and the readback share one `BEGIN IMMEDIATE`.
/// Split across statements this would be a genuine TOCTOU: a concurrent
/// `set_property` can create the very `block_properties` rows the probe
/// looked for and did not find, and the declaration that lands on top of
/// them is exactly the un-exitable state the probe exists to prevent.
/// That window is also why the frontend's own pre-flight
/// (`renameMayDeclareKey`, `src/lib/property-save-utils.ts`) cannot be the
/// guarantee — it reads the read pool while the write goes to the write
/// pool, and it only sees the 1000 most-used keys.
#[instrument(skip(pool, options), err)]
pub async fn create_property_def_inner(
    pool: &SqlitePool,
    key: String,
    value_type: String,
    options: Option<String>,
) -> Result<PropertyDefinition, AppError> {
    validate_property_def_shape(&key, &value_type, options.as_deref())?;

    // allow-raw-tx: writes property_definitions (schema metadata), no op_log (#110)
    let mut tx = crate::db::begin_immediate_logged(pool, "create_property_def").await?;

    // Idempotency first, and before the probe. An existing row wins (the
    // INSERT OR IGNORE contract ~20 call sites depend on), and nothing is
    // written — so there is no new constraint to guard, and re-asserting a
    // declaration the user already made must never be refused. This is also
    // what keeps a rename onto an already-declared key a no-op.
    let existing = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = existing {
        return Ok(row);
    }

    if let Some(reason) =
        conflicting_existing_values(&mut tx, &key, &value_type, options.as_deref()).await?
    {
        return Err(AppError::validation(reason));
    }

    create_property_def_in_tx(&mut tx, &key, &value_type, options.as_deref()).await?;

    // Fetch back inside the same transaction — the row this call created,
    // never one a racing writer slipped in afterwards.
    let row = sqlx::query_as!(
        PropertyDefinition,
        "SELECT key, value_type, options, created_at FROM property_definitions WHERE key = ?",
        key
    )
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(row)
}

/// In-transaction twin of [`create_property_def_inner`] (#4382).
///
/// Same validation and the same idempotent `INSERT OR IGNORE`, but written
/// through a caller-owned connection instead of the pool, and without the
/// post-insert readback (callers that need the winning row already read
/// `property_definitions` in the same transaction).
///
/// This exists so a caller can make "is this key safe to declare?" and the
/// declaration itself **one atomic decision**. Declaring a key is globally
/// visible — `property_definitions` is keyed by `key` alone — so a
/// pre-flight run on a separate connection is a genuine TOCTOU: a
/// concurrent write can create the very `block_properties` rows the
/// pre-flight looked for and did not find. Inside one `BEGIN IMMEDIATE`
/// there is no such window.
///
/// This is the raw writer and deliberately carries **no** in-use probe of
/// its own (#4399); each caller decides what an in-use key means for it,
/// and runs that decision in this same transaction. The two callers do
/// differ: `declare_bib_property_defs` warns and continues, because
/// refusing to import a bibliography over an unrelated key elsewhere in
/// the vault is disproportionate, while [`create_property_def_inner`]
/// refuses, because a user asked for this one key by name. Adding a probe
/// here would not change the import's behaviour — its own test is the
/// strictly coarser "any values at all?" — but it would put the decision
/// in the wrong place.
pub async fn create_property_def_in_tx(
    conn: &mut sqlx::SqliteConnection,
    key: &str,
    value_type: &str,
    options: Option<&str>,
) -> Result<(), AppError> {
    validate_property_def_shape(key, value_type, options)?;

    let now = agaric_core::time::now_rfc3339();
    sqlx::query!(
        "INSERT OR IGNORE INTO property_definitions (key, value_type, options, created_at) VALUES (?1, ?2, ?3, ?4)",
        key,
        value_type,
        options,
        now,
    )
    .execute(conn)
    .await?;

    Ok(())
}

/// List all property definitions, paginated and ordered by `key ASC`
/// (AGENTS.md invariant #3).
///
/// `key` is the primary key on `property_definitions` (a string, not a
/// ULID), so the keyset cursor is encoded via [`pagination::Cursor::for_id`] with
/// `last.key.clone()` — `for_id` accepts any `String` and stores it in
/// the cursor's `id` slot. [`pagination::PageRequest::new`] rejects a
/// supplied `limit` outside the canonical `[1, MAX_PAGE_SIZE]` range;
/// the MCP tool boundary applies its stricter `LIST_RESULT_CAP`
/// validation first.
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
///
/// ## Why this warns where `create_property_def` refuses (#4399)
///
/// [`create_property_def_inner`] now **rejects** a declaration whose
/// stored values would fail step 5's options membership — the same
/// predicate this function only warns about. The asymmetry is
/// deliberate, so read this before "fixing" either side to match the
/// other. What made the create case worth a refusal was #4382's third
/// link: the declaration cannot be withdrawn, because
/// [`delete_property_def_inner`] refuses while any `block_properties`
/// row references the key, and the remedy its error names
/// (`set_property(value = None)`) is itself rejected for a non-reserved
/// key. The only exit discards the data.
///
/// Narrowing an options array arms neither the second nor the third
/// link. Inbound sync routes a `select` value through
/// `reproject_block_properties_from_engine`'s `"select" | "text" | …`
/// arm straight to `value_text` with no membership check, so the orphan
/// rows are never dropped and stay visible; and the exit is one
/// non-destructive call to this very function with the option added
/// back. Only link 1 fires, and it un-fires on demand. A refusal here
/// would also break the legitimate retire-an-option flow the paragraph
/// above describes, which has no equivalent on the create path — there
/// is no such thing as retiring a declaration you have not made yet.
#[instrument(skip(pool, options), err)]
pub async fn update_property_def_options_inner(
    pool: &SqlitePool,
    key: String,
    options: String,
) -> Result<PropertyDefinition, AppError> {
    // Validate options is a non-empty JSON array of strings
    let parsed: Vec<String> = serde_json::from_str(&options)
        .map_err(|_| AppError::validation("options must be a JSON array of strings".into()))?;
    if parsed.is_empty() {
        return Err(AppError::validation("options must not be empty".into()));
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
        return Err(AppError::validation(format!(
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
    if agaric_store::op::is_builtin_property_key(&key) {
        return Err(AppError::validation(
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
        return Err(AppError::validation(format!(
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
/// Returns a map of block_id → `Vec<PropertyRow>`. Block IDs with no properties
/// are omitted from the result (not an error).
///
/// Uses `json_each()` so the full ID list is passed as a single JSON-encoded
/// bind parameter — no dynamic SQL construction.
///
/// Empty `block_ids` returns an empty map (not an error), matching the
/// bulk-read convention across the `*_by_ids` family (bulk reads return
/// empty; only bulk writes reject empty).
///
/// # Errors
/// - [`AppError::Validation`] — `block_ids.len()` >
///   [`agaric_store::pagination::MAX_BATCH_BLOCK_IDS`]
#[instrument(skip(pool, block_ids), err)]
pub async fn get_batch_properties_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
) -> Result<HashMap<String, Vec<PropertyRow>>, AppError> {
    if block_ids.is_empty() {
        return Ok(HashMap::new());
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;

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
/// #2468: the response carries the produced op ref(s) (`WithOps` — a
/// flattened, strict superset of the previous `BlockRow` shape) so the
/// frontend undo stack can address the action by exact ref (`undo_op`).
#[tauri::command]
#[specta::specta]
pub async fn set_property(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    key: String,
    value: SetPropertyArgs,
) -> Result<WithOps<BlockRow>, AppError> {
    let block_id_clone = block_id.clone().into_string();
    let key_clone = key.clone();
    // #1627: mint the type-state newtype without a pre-tx round-trip.
    // The activeness gate (existence + soft-deleted discrimination, with
    // identical NotFound/Validation errors) now runs inside the write
    // transaction's existing re-validation (`set_property_in_tx`).
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let result = capture_op_refs(async {
        set_property_inner(
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
        .map(Into::into)
    })
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec![key_clone]);
    Ok(result)
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

/// Tauri command: batch-set one allowlisted property on multiple blocks.
///
/// Delegates to [`set_property_batch_inner`] — the generalisation of
/// [`set_todo_state_batch`] across the four reserved column-backed keys
/// (`todo_state`, `priority`, `due_date`, `scheduled_date`). A single
/// IMMEDIATE tx covers every per-block write; `value = None` clears the
/// property.
///
/// Emits one `EVENT_PROPERTY_CHANGED` per input block (carrying the changed
/// `key`) so existing per-block listeners keep firing without protocol
/// changes — mirroring the `set_todo_state_batch` emit loop.
#[tauri::command]
#[specta::specta]
pub async fn set_property_batch(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
    key: String,
    value: Option<String>,
) -> Result<i64, AppError> {
    let block_ids_for_emit = block_ids.clone();
    let key_for_emit = key.clone();
    let updated = set_property_batch_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        block_ids,
        key,
        value,
    )
    .await
    .map_err(sanitize_internal_error)?;
    // Emit per-block change events so the existing per-block listeners
    // receive the same signal shape they got from the single-row path. The
    // inner already skipped missing rows silently; emitting for ids that did
    // not actually update is harmless (listeners debounce / re-read).
    for id in block_ids_for_emit {
        emit_property_changed_event(&app, id.into_string(), vec![key_for_emit.clone()]);
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
///
/// #2468: previously returned unit; now echoes `(block_id, key)` plus the
/// produced op ref(s) (`WithOps<DeletePropertyResponse>`) so the frontend
/// undo stack can address the action by exact ref (`undo_op`). The wire
/// change is `null` → an object — additive for every existing caller (all
/// current call sites discard the result).
#[tauri::command]
#[specta::specta]
pub async fn delete_property(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    key: String,
) -> Result<WithOps<DeletePropertyResponse>, AppError> {
    let block_id_clone = block_id.clone().into_string();
    let key_clone = key.clone();
    // #1627: mint the type-state newtype without a pre-tx round-trip.
    // The activeness gate (existence + soft-deleted discrimination, with
    // identical NotFound/Validation errors) now runs inside the write
    // transaction's existing re-validation (`delete_property_core`).
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let result = capture_op_refs(async {
        delete_property_inner(
            ctx.pool(),
            ctx.device_id(),
            ctx.materializer(),
            active_id,
            key,
        )
        .await
        .map(|()| DeletePropertyResponse {
            block_id: block_id_clone.clone(),
            key: key_clone.clone(),
        })
    })
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_event(&app, block_id_clone, vec![key_clone]);
    Ok(result)
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

/// #4399 — the pin on [`declared_type_admits_shape`], which is a
/// hand-written mirror of `validate_property_value`'s step-4 `type_matches`
/// (`agaric-engine/src/block_ops.rs`) and is therefore only as good as
/// whatever reddens when it drifts.
///
/// Adversarial falsification found three arms nothing was holding up: `ref`,
/// `boolean`, and the `|| shape == "ref"` half of `text | select`. Rewriting
/// `ref` and `boolean` to admit a stored `text` — the fail-OPEN direction,
/// which reinstates #4382's trap for those two types — left all 518 property
/// tests green. The matrix below is the missing pin; the arms are also
/// exercised end-to-end through the command path in
/// `src-tauri/tests/commands/property_cmd_tests.rs`
/// (`create_property_def_admits_stored_refs_under_text_4399`,
/// `create_property_def_refuses_ref_and_boolean_over_stored_text_4399`),
/// which is what proves the mirror agrees with the real engine rather than
/// with a transcription of it.
#[cfg(test)]
mod declared_type_admits_shape_tests {
    use super::{AppError, declared_type_admits_shape, validate_property_def_shape};

    /// The shapes a `block_properties` row can have — one per value column,
    /// and exactly one per row (`exactly_one_value`, migration 0062). The
    /// probe's own `for` loop iterates this same list.
    const SHAPES: [&str; 5] = ["text", "number", "date", "ref", "boolean"];

    /// Every declarable `value_type` paired with the shapes it admits,
    /// transcribed arm-for-arm from step 4's `type_matches`:
    ///
    /// ```text
    /// "text" | "select" => payload.value_text.is_some() || payload.value_ref.is_some(),
    /// "ref"             => payload.value_ref.is_some(),
    /// "number"          => payload.value_num.is_some(),
    /// "date"            => payload.value_date.is_some(),
    /// "boolean"         => payload.value_bool.is_some(),
    /// ```
    ///
    /// Anything not listed for a type must be REFUSED — that half is the
    /// one that keeps #4382 shut, and the half falsification found open.
    const MATRIX: [(&str, &[&str]); 6] = [
        ("text", &["text", "ref"]),
        ("select", &["text", "ref"]),
        ("ref", &["ref"]),
        ("number", &["number"]),
        ("date", &["date"]),
        ("boolean", &["boolean"]),
    ];

    #[test]
    fn matches_step_4_type_matches_arm_for_arm_4399() {
        for (value_type, admitted) in MATRIX {
            for shape in SHAPES {
                let expected = admitted.contains(&shape);
                assert_eq!(
                    declared_type_admits_shape(value_type, shape),
                    expected,
                    "declaring '{value_type}' over a stored '{shape}' value must be {}: \
                     `declared_type_admits_shape` mirrors `validate_property_value`'s step-4 \
                     `type_matches` (agaric-engine/src/block_ops.rs) arm for arm. Admitting a \
                     shape the engine rejects reopens #4382 for that type; refusing one it \
                     admits makes the key permanently undeclarable.",
                    if expected { "admitted" } else { "refused" },
                );
            }
        }
    }

    /// The `_ => true` catch-all is correct — it mirrors step 4's own
    /// `_ => true`, so a declared type the engine does not constrain
    /// conflicts with nothing — but it is fail-OPEN for any type the engine
    /// DOES constrain. The only way a *declarable* type reaches it is a
    /// seventh `value_type` added to [`validate_property_def_shape`] and not
    /// to [`declared_type_admits_shape`].
    ///
    /// A named arm always refuses at least one shape; the catch-all refuses
    /// none. So "refuses something" is exactly "has a named arm".
    #[test]
    fn every_declarable_type_has_a_named_arm_4399() {
        for (value_type, _) in MATRIX {
            let options = if value_type == "select" {
                Some(r#"["a"]"#)
            } else {
                None
            };
            validate_property_def_shape("k", value_type, options).unwrap_or_else(|e| {
                panic!("'{value_type}' must be declarable for this matrix to mean anything: {e:?}")
            });
            assert!(
                SHAPES
                    .iter()
                    .any(|s| !declared_type_admits_shape(value_type, s)),
                "'{value_type}' is declarable but admits EVERY stored shape, so it fell through \
                 to the `_ => true` catch-all. That is fail-open: a declaration of it can be \
                 created over values the engine will then refuse to rewrite (#4382). Give it a \
                 named arm mirroring `validate_property_value`'s step 4."
            );
        }
    }

    /// The other direction of staleness: a seventh declarable `value_type`
    /// that never reaches [`MATRIX`], and so is never asked the question
    /// above.
    ///
    /// [`validate_property_def_shape`] cannot be enumerated from outside, but
    /// its rejection message spells the accepted set out for the user, right
    /// beside the `matches!` that defines it. Pinning the message pins the
    /// set: adding a type without touching this file reddens here, and the
    /// failure names the two places that then need an arm.
    #[test]
    fn matrix_covers_every_type_validate_property_def_shape_accepts_4399() {
        let err = validate_property_def_shape("k", "septenary", None)
            .expect_err("an unknown value_type must be rejected");
        let AppError::Validation { message, .. } = err else {
            panic!("expected a Validation rejection");
        };
        assert_eq!(
            message,
            "invalid value_type 'septenary': must be text, number, date, select, ref, or boolean",
            "the declarable-type set changed. Every type `validate_property_def_shape` accepts \
             needs a row in this module's MATRIX and a named arm in \
             `declared_type_admits_shape` — otherwise it falls through to the `_ => true` \
             catch-all and its declarations are never probed (#4399/#4382)."
        );
    }
}
