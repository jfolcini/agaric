//! Properties command handlers.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::materializer::Materializer;
use agaric_core::error::{AppError, ValidationCode};
use agaric_core::ulid::{ActiveBlockId, BlockId};
use agaric_engine::loro::shared::LoroState;
use agaric_store::backlink;
use agaric_store::op::{PropertyDefState, SetPropertyDefPayload};
use agaric_store::pagination;
use agaric_store::pagination::ActiveBlockRow;
use agaric_store::space::SpaceId;
use agaric_sync::sync_events::{EVENT_PROPERTY_CHANGED, PropertyChangedEvent};

use super::property_unfit::PropertyUnfitCounts;
use super::sanitize_internal_error;
use super::*;

/// The `block:properties-changed` events a property write's wrapper emits once
/// its `_inner` commits: one per block the caller named, whether or not the
/// write changed it, each carrying `changed_keys`. The conformance harness
/// records this same list, which holds the mock to it.
pub fn property_changed_events(
    block_ids: impl IntoIterator<Item = BlockId>,
    changed_keys: &[String],
) -> Vec<PropertyChangedEvent> {
    block_ids
        .into_iter()
        .map(|id| PropertyChangedEvent {
            block_id: id.into_string(),
            changed_keys: changed_keys.to_vec(),
        })
        .collect()
}

/// A failed emit is logged by `main_thread::emit`, never returned: the write
/// has already committed.
fn emit_property_changed_events(app: &tauri::AppHandle, events: Vec<PropertyChangedEvent>) {
    for event in events {
        crate::main_thread::emit(app, EVENT_PROPERTY_CHANGED, event);
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
/// lifecycle and dispatches background work. `todo_state` is written as
/// [`set_todo_state_inner`] writes it instead, so it stamps and recurs as the
/// app's checkbox does; a clear (no value) is a clear there too. A `value_text`
/// under a `ref` definition is the block its id, `[[Title]]` or title names
/// in the block's space (#5160 D11), and is refused when it names none or
/// two.
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
    // CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "set_property").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    // Boxed: inlined, it makes the `set_property` wrapper's future trip
    // `clippy::large_futures`.
    let block = Box::pin(set_property_inner_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        block_id,
        key,
        value_text,
        value_num,
        value_date,
        value_ref,
        value_bool,
        caller_context,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(ActiveBlockRow::from_block_row_unchecked(block))
}

/// [`set_property_inner`] inside the caller's rollback-armed transaction
/// (MCP `batch`, #5399).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_property_inner_in_tx(
    tx: &mut CommandTx,
    loro: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    block_id: ActiveBlockId,
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<bool>,
    caller_context: Option<&str>,
) -> Result<BlockRow, AppError> {
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
    // #5394 — a state set through the generic path (MCP `set_property`, the
    // property drawer) owes the stamps and the next occurrence a click owes.
    // `priority`, `due_date` and `scheduled_date` need no routing: their
    // dedicated setters only validate what `set_property_in_tx` validates.
    if key == "todo_state" {
        if value_num.is_some()
            || value_date.is_some()
            || value_ref.is_some()
            || value_bool.is_some()
        {
            return Err(AppError::validation(
                "Property 'todo_state' requires value_text, not \
                 value_date/value_num/value_ref/value_bool."
                    .into(),
            ));
        }
        let prior = prior_task_state_in_tx(tx, block_id.as_str()).await?;
        return set_todo_state_in_tx(
            tx,
            loro,
            device_id,
            block_id.into_string(),
            &prior,
            value_text,
        )
        .await;
    }
    // #3647 — validate the `repeat` recurrence grammar HERE, at the user's
    // point of entry, so a malformed rule fails where it was typed.
    //
    // `repeat` is free text in a plain `text` column (its built-in
    // definition is `text`), authored through the property drawer's bare
    // `<Input>` or an inline `repeat:: …` line. Until now a bad rule was
    // accepted silently and only misbehaved at completion time, inside a
    // transaction the user cannot observe: `shift_date` returns `Ok(None)`
    // for a shape error, so the recurrence sibling was created with no date
    // and nothing said why (#3281 replaced a hard wedge with exactly this
    // quiet failure).
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

    // #5160 D11 — text under a `ref` definition names its target as a typed
    // `key:: value` line does, so the block editor can commit one.
    let (value_text, value_ref) = match value_text {
        Some(text) if value_ref.is_none() => {
            super::pages::markdown::read_typed_ref(tx, block_id.as_str(), &key, text).await?
        }
        text => (text, value_ref),
    };
    let (block, op_record) = set_property_in_tx(
        tx,
        loro,
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
    Ok(block)
}

/// What a block's row already said about its task lifecycle, read in the
/// caller's transaction before the `todo_state` write lands.
///
/// The two presence flags are correctness, not an optimisation.
/// [`write_todo_timestamp_transitions_in_tx`] clears a stamp on the edges out
/// of a state, and a clear for a key the block never carried records no prior
/// value, so `build_reverse_delete_property` looks in the op log, finds none
/// and answers `NotFound`, which is not a skippable non-reversible, so
/// `compute_reverse_batch` aborts the whole undo group.
/// Multi-selecting TODO blocks and hitting *Clear* is the gesture that hit it
/// — every one of those blocks got a `DeleteProperty(completed_at)` for a key
/// it never had, and the next Ctrl+Z restored nothing (#5074).
#[derive(Clone, Debug, Default)]
pub(crate) struct PriorTaskState {
    todo_state: Option<String>,
    has_created_at: bool,
    has_completed_at: bool,
}

/// One block's [`PriorTaskState`], read on the caller's transaction by
/// primary key. The `blocks` read [`set_todo_state_inner`] already issued,
/// widened (#5074) to carry the two stamp-presence flags so the transition
/// never emits a clear for a key that is not there. A missing or soft-deleted
/// block answers the default, and `set_property_in_tx` then raises the
/// `NotFound` that single-row path owes its caller.
///
/// # Errors
/// Returns [`AppError`] if the query fails.
pub(crate) async fn prior_task_state_in_tx(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<PriorTaskState, AppError> {
    Ok(sqlx::query!(
        r#"SELECT b.todo_state,
                  EXISTS (SELECT 1 FROM block_properties p
                          WHERE p.block_id = b.id AND p.key = 'created_at')
                      AS "has_created_at!: bool",
                  EXISTS (SELECT 1 FROM block_properties p
                          WHERE p.block_id = b.id AND p.key = 'completed_at')
                      AS "has_completed_at!: bool"
           FROM blocks b
           WHERE b.id = ? AND b.deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut *conn)
    .await?
    .map(|r| PriorTaskState {
        todo_state: r.todo_state,
        has_created_at: r.has_created_at,
        has_completed_at: r.has_completed_at,
    })
    .unwrap_or_default())
}

/// Write the `created_at` / `completed_at` rows implied by a
/// `todo_state` transition, on the caller's already-open transaction.
///
/// Extracted from `set_todo_state_inner` (#4639); since #5074 both batch
/// paths run it per block too. `completed_at` is present iff
/// `todo_state = 'DONE'` on every path that writes the state, because
/// `DonePanel` selects on `completed_at` and the agenda excludes DONE in SQL
/// — a batch "mark done" that skipped this dropped the blocks out of both
/// surfaces at once.
///
/// Recurrence is the divergence both batch paths keep — that is what
/// `warn_if_batch_skips_recurrence` tells the user about and what
/// `scripts/bulk-equivalence-baseline.json` records.
///
/// The caller owns the transaction and its commit; this helper only appends
/// writes to it.
pub(crate) async fn write_todo_timestamp_transitions_in_tx(
    tx: &mut CommandTx,
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    block_id: &str,
    prior: &PriorTaskState,
    new_state: Option<&str>,
) -> Result<(), AppError> {
    let prev_state = prior.todo_state.as_deref();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();

    // `created_at`: stamped when a block becomes an open task, cleared when
    // it stops being a task at all.
    match (prev_state, new_state) {
        (None | Some("DONE"), Some("TODO" | "DOING")) => {
            let (_, op) = set_property_in_tx(
                &mut *tx,
                state,
                device_id,
                block_id.to_owned(),
                "created_at",
                None,
                None,
                Some(today.clone()),
                None,
                None,
            )
            .await?;
            tx.enqueue_background(op);
        }
        // Only when the row is actually there: see [`PriorTaskState`].
        (Some(_), None) if prior.has_created_at => {
            let op =
                delete_property_in_tx(&mut *tx, state, device_id, block_id, "created_at").await?;
            tx.enqueue_background(op);
        }
        _ => {}
    }

    // `completed_at` is present iff `todo_state = 'DONE'` (#5074): written on
    // every edge into DONE, cleared on every edge out of it, whatever the
    // other end.
    //
    // Un-tasking a block that WAS a task clears it too, even from a state that
    // is not DONE. That is not redundant with the arm above: a block that went
    // DONE -> CANCELLED before this invariant held still carries a stale
    // stamp. The boot repair (`repair_completed_at`) sweeps that population;
    // this is the same self-heal on the edge the user takes, for a stamp that
    // arrives after boot. Narrowing it to `was_done` would drop it.
    //
    // `prev_state.is_some()` is load-bearing. Without it a bulk "clear todo
    // state" over blocks that were never tasks emits one `DeleteProperty` per
    // block for a key that never existed, and
    // `build_reverse_delete_property` answers that with `NotFound` rather than
    // a skippable non-reversible — which aborts `undo_page_group` over the
    // whole batch.
    //
    // `prior.has_completed_at` closes the rest of that hole: a plain TODO
    // block cleared in bulk IS a task, so the guard above lets it through
    // while it has no `completed_at` to delete. See [`PriorTaskState`].
    let was_done = prev_state == Some("DONE");
    let is_done = new_state == Some("DONE");
    if is_done && !was_done {
        let (_, op) = set_property_in_tx(
            &mut *tx,
            state,
            device_id,
            block_id.to_owned(),
            "completed_at",
            None,
            None,
            Some(today),
            None,
            None,
        )
        .await?;
        tx.enqueue_background(op);
    } else if !is_done
        && prior.has_completed_at
        && (was_done || (prev_state.is_some() && new_state.is_none()))
    {
        let op =
            delete_property_in_tx(&mut *tx, state, device_id, block_id, "completed_at").await?;
        tx.enqueue_background(op);
    }
    Ok(())
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
    // H-4: open one IMMEDIATE tx covering every write below — the
    // state change, the `created_at`/`completed_at` timestamp writes,
    // and the recurrence-sibling creation. A pre-fix crash mid-sequence
    // could leave a `done` state with no `completed_at` and no
    // next-occurrence sibling (H-4).
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // Just the task lifecycle — the full SELECT * is unnecessary here since
    // `set_property_in_tx` (called below) issues its own SELECT and returns
    // NotFound if the block is missing, so the redundant existence guard is
    // dropped.
    let prior = prior_task_state_in_tx(&mut tx, block_id.as_str()).await?;
    let result = set_todo_state_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        block_id.into_string(),
        &prior,
        state,
    )
    .await?;

    tx.commit_and_dispatch(materializer).await?;

    Ok(ActiveBlockRow::from_block_row_unchecked(result))
}

/// [`set_todo_state_inner`]'s writes on the caller's transaction, for a block
/// whose task state before them was `prior`: the state, its #5074 stamps and,
/// on the edge into DONE, the next occurrence. Shared with the page source
/// save (#5140), so a checkbox typed there does what a click does.
///
/// # Errors
///
/// - [`AppError::Validation`] — `state` is not 1-50 characters, or not one
///   of the built-in task states
/// - [`AppError::NotFound`] — the block is missing
pub(crate) async fn set_todo_state_in_tx(
    tx: &mut CommandTx,
    loro: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    block_id: String,
    prior: &PriorTaskState,
    state: Option<String>,
) -> Result<BlockRow, AppError> {
    // `set_property_in_tx` checks the state against the built-in options.
    if let Some(ref s) = state
        && (s.is_empty() || s.len() > 50)
    {
        return Err(AppError::validation(
            "Todo state must be 1-50 characters".into(),
        ));
    }
    let new_state = state.clone();
    let (result, todo_op) = set_property_in_tx(
        &mut *tx,
        loro,
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
    tx.enqueue_background(todo_op);

    write_todo_timestamp_transitions_in_tx(
        tx,
        loro,
        device_id,
        &block_id,
        prior,
        new_state.as_deref(),
    )
    .await?;

    // Recurrence: when transitioning to DONE, delegate to recurrence
    // module — using the in-tx form so the sibling creation rolls back
    // alongside the state change if anything below fails.
    if new_state.as_deref() == Some("DONE") && prior.todo_state.as_deref() != Some("DONE") {
        crate::recurrence::handle_recurrence_in_tx(tx, loro, device_id, &block_id).await?;
    }
    Ok(result)
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
            "{} skips the per-block recurrence advance that the single-row \
             path runs; {} block(s) in this batch carry `repeat` and will NOT \
             roll forward",
            command,
            repeat_carriers.len(),
        );
    }
    Ok(())
}

/// The caller-shape rejections [`set_todo_state_batch_inner`] makes before it
/// opens a transaction: an empty list, an oversize list, a `state` outside
/// 1-50 characters. Split out (#5074) to keep that command under
/// `clippy::too_many_lines`; pure, so it needs no pool.
///
/// # Errors
///
/// - [`AppError::Validation`] — empty `block_ids`, more than
///   `MAX_BATCH_BLOCK_IDS` of them, or a `state` of the wrong length.
fn validate_todo_state_batch_input(
    block_ids: &[BlockId],
    state: Option<&str>,
) -> Result<(), AppError> {
    if block_ids.is_empty() {
        return Err(AppError::validation(
            "block_ids list cannot be empty".into(),
        ));
    }
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    if let Some(s) = state
        && (s.is_empty() || s.len() > 50)
    {
        return Err(AppError::validation(
            "Todo state must be 1-50 characters".into(),
        ));
    }
    Ok(())
}

/// Every live block in `block_ids`, with the [`PriorTaskState`] the
/// `todo_state` batch paths need — ONE query for the whole batch, never a
/// per-block read in the loop (#2038).
///
/// Missing and soft-deleted ids are simply absent from the map, which IS the
/// batch paths' skip-on-miss contract: a row deleted between the FE selection
/// and this call drops out cleanly.
///
/// #473 L3: `conn` is the caller's already-open `BEGIN IMMEDIATE`
/// transaction, so the membership snapshot and the writes that follow sit in
/// the same serialized window.
///
/// # Errors
/// Returns [`AppError`] if the id list cannot be serialized or the query fails.
pub(crate) async fn resolve_prior_task_states_batch(
    conn: &mut sqlx::SqliteConnection,
    block_ids: &[BlockId],
) -> Result<HashMap<String, PriorTaskState>, AppError> {
    let block_ids_json = serde_json::to_string(block_ids)?;
    Ok(sqlx::query!(
        r#"SELECT b.id, b.todo_state,
                  EXISTS (SELECT 1 FROM block_properties p
                          WHERE p.block_id = b.id AND p.key = 'created_at')
                      AS "has_created_at!: bool",
                  EXISTS (SELECT 1 FROM block_properties p
                          WHERE p.block_id = b.id AND p.key = 'completed_at')
                      AS "has_completed_at!: bool"
           FROM blocks b
           WHERE b.id IN (SELECT value FROM json_each(?)) AND b.deleted_at IS NULL"#,
        block_ids_json
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(|r| {
        (
            r.id,
            PriorTaskState {
                todo_state: r.todo_state,
                has_created_at: r.has_created_at,
                has_completed_at: r.has_completed_at,
            },
        )
    })
    .collect())
}

/// Batch variant of [`set_todo_state_inner`].
///
/// Replaces the per-row IMMEDIATE-tx loop the FE used to drive on
/// "mark done" / "mark TODO" multi-select gestures. The whole batch
/// runs in a single `BEGIN IMMEDIATE` transaction so a crash mid-batch
/// either commits every state change or none of them — same all-or-
/// nothing semantics as the single-row path (H-4 / invariant #2).
///
/// `state` validation matches `set_todo_state_inner` (1-50 chars, one of
/// the built-in task states).
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
/// The `created_at`/`completed_at` transitions DO run here, per block,
/// through the same `write_todo_timestamp_transitions_in_tx` the
/// single-row path uses (#5074): `completed_at` is what `DonePanel`
/// selects on and what the agenda's DONE exclusion assumes, so a batch
/// that skipped it dropped the blocks out of both surfaces at once.
///
/// Recurrence is still NOT applied. The batch is a bulk multi-select
/// reflex — the expected gesture is "mark these N blocks DONE" or "clear
/// todo on these N blocks" — and propagating recurrence per item under one
/// IMMEDIATE lock would defeat the latency win. Callers that need the
/// next-occurrence sibling fall through to the single-row path;
/// `warn_if_batch_skips_recurrence` logs when a `repeat` carrier rides
/// in a batch that sets a state.
#[instrument(skip(pool, device_id, materializer, block_ids), err)]
pub async fn set_todo_state_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
    state: Option<String>,
) -> Result<i64, AppError> {
    validate_todo_state_batch_input(&block_ids, state.as_deref())?;

    // One IMMEDIATE tx covers every per-block write (op_log + blocks
    // column). Either every state change commits or none of them.
    let mut tx = CommandTx::begin_immediate(pool, "set_todo_state_batch").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());

    // SQL-review this batch path skips the per-block recurrence advance
    // that the single-row `set_todo_state_inner` performs; since #5074 it no
    // longer skips the timestamp transitions (see the loop below).
    // #3264: the probe + `warn!` live in the shared
    // [`warn_if_batch_skips_recurrence`] so `set_property_batch_inner` — which
    // skips recurrence in exactly the same way — emits the same diagnostic
    // instead of nothing.
    // A clear rolls nothing forward on the single-row path either (#6156:
    // page mode clears tasks through this batch).
    if state.is_some() {
        warn_if_batch_skips_recurrence(&mut tx, "set_todo_state_batch_inner", &block_ids).await?;
    }

    // #2038 / #5074: one membership query for the whole batch, carrying each
    // survivor's prior lifecycle state. See
    // [`resolve_prior_task_states_batch`].
    let alive = resolve_prior_task_states_batch(&mut tx, &block_ids).await?;

    let mut updated: i64 = 0;
    for block_id in block_ids {
        let Some(prior) = alive.get(block_id.as_str()).cloned() else {
            continue;
        };

        // Reuse the canonical per-row helper so reserved-key validation,
        // op_log append, and the `blocks.todo_state` materialised write
        // all share the single source of truth. Returns `(BlockRow,
        // OpRecord)`; we discard the row (the batch wrapper does not
        // surface per-block payloads) and queue the op record for
        // post-commit dispatch.
        let block_id = block_id.into_string();
        let (_row, op_record) = crate::commands::blocks::set_property_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            block_id.clone(),
            "todo_state",
            state.clone(),
            None,
            None,
            None,
            None,
        )
        .await?;
        tx.enqueue_background(op_record);
        // #5074 — same tx, so the state change and its `completed_at` row
        // commit or roll back together, exactly as on the single-row path.
        write_todo_timestamp_transitions_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            &block_id,
            &prior,
            state.as_deref(),
        )
        .await?;
        updated += 1;
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(updated)
}

/// The pre-transaction caller-shape rejections [`set_property_batch_inner`]
/// makes before it opens a transaction: a key outside
/// [`SET_PROPERTY_BATCH_ALLOWED_KEYS`], an empty list, an oversize list, then
/// the 1-50 character bound on the two text keys and the ISO `YYYY-MM-DD`
/// bound on the two date keys. Pure, so it needs no pool.
///
/// The allowlist guard runs FIRST and is the security boundary the command's
/// own doc names: a key that must never reach a typed `blocks` column is
/// refused before the list is even sized.
///
/// Split out of that command (#4639 for the value shape, #5074 for the three
/// guards above it, to keep the command under `clippy::too_many_lines` once
/// the `completed_at` transition moved in). Private to the BATCH root on
/// purpose: the single-row inners (`set_todo_state_inner`,
/// `set_priority_inner`, `set_due_date_inner`, `set_scheduled_date_inner`)
/// each carry their own wording for their own key, and routing them through
/// one shared check would flatten four messages into one and quietly extend
/// the batch allowlist's shape to a path that has none.
///
/// # Errors
///
/// - [`AppError::Validation`] — a non-allowlisted `key`, empty `block_ids`,
///   more than `MAX_BATCH_BLOCK_IDS` of them, or a `value` of the wrong shape
///   for `key`.
fn validate_set_property_batch_input(
    block_ids: &[BlockId],
    key: &str,
    value: Option<&str>,
) -> Result<(), AppError> {
    if !SET_PROPERTY_BATCH_ALLOWED_KEYS.contains(&key) {
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
    match key {
        "todo_state" | "priority" => {
            if let Some(v) = value
                && (v.is_empty() || v.len() > 50)
            {
                return Err(AppError::validation(format!(
                    "{key} must be 1-50 characters"
                )));
            }
        }
        "due_date" | "scheduled_date" => {
            if let Some(d) = value
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
    Ok(())
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
/// - `todo_state` / `priority` → `value_text`, checked against the built-in
///   options by `set_property_in_tx`, as the single-row paths are.
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
/// Like the todo batch, this path deliberately does NOT run recurrence — it
/// is a bulk multi-select reflex. #3264: and, like the todo batch, it says so
/// — when `key` is `todo_state` it runs `warn_if_batch_skips_recurrence`
/// inside the same IMMEDIATE tx, so a Pages-browser multi-select over
/// `repeat`-carrying pages leaves a diagnostic in the daily log instead of
/// nothing.
///
/// The `created_at` / `completed_at` transitions #5074 gave the todo batch DO
/// run here, gated on `key == "todo_state"` exactly as the recurrence warning
/// above is — the other three keys pay nothing. *Set property → Todo state →
/// DONE* in `PageBrowserBatchToolbar` routes to THIS command, not to
/// `set_todo_state_batch`, so skipping the stamp here dropped a bulk-completed
/// page out of the agenda (which excludes DONE in SQL) and out of `DonePanel`
/// (which selects on `completed_at`) at the same time.
#[instrument(skip(pool, device_id, materializer, block_ids), err)]
pub async fn set_property_batch_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_ids: Vec<BlockId>,
    key: String,
    value: Option<String>,
) -> Result<i64, AppError> {
    // Pre-tx caller-shape validation: the allowlist security boundary, the
    // list guards, and the per-key value shape — all BEFORE the tx opens, so
    // a rejected call writes nothing.
    validate_set_property_batch_input(&block_ids, &key, value.as_deref())?;
    let is_text_key = matches!(key.as_str(), "todo_state" | "priority");

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

    // Route the single value to the correct typed column: text keys →
    // `value_text`, date keys → `value_date`. `None` leaves both null,
    // which `set_property_in_tx` treats as a clear.
    let value_text = if is_text_key { value.clone() } else { None };
    let value_date = if is_text_key { None } else { value.clone() };

    // The same one membership query the todo batch runs, for the same two
    // reasons: skip-on-miss without a per-block existence SELECT, and the
    // prior lifecycle state the `todo_state` transition below needs.
    let alive = resolve_prior_task_states_batch(&mut tx, &block_ids).await?;

    let mut updated: i64 = 0;
    for block_id in block_ids {
        let Some(prior) = alive.get(block_id.as_str()).cloned() else {
            continue;
        };

        // Reuse the canonical per-row helper so reserved-key validation,
        // op_log append, and the materialised `blocks` column write all
        // share the single source of truth. Discard the returned row (the
        // batch wrapper surfaces no per-block payload) and queue the op
        // record for post-commit dispatch.
        let block_id = block_id.into_string();
        let (_row, op_record) = crate::commands::blocks::set_property_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            block_id.clone(),
            &key,
            value_text.clone(),
            None,
            value_date.clone(),
            None,
            None,
        )
        .await?;
        tx.enqueue_background(op_record);
        // #5074 — same tx as the state change, so the stamp commits or rolls
        // back with it. Gated on the KEY, like the recurrence probe above:
        // `todo_state` is the only allowlisted key these timestamps track.
        if key == "todo_state" {
            write_todo_timestamp_transitions_in_tx(
                &mut tx,
                materializer.loro_state(),
                device_id,
                &block_id,
                &prior,
                value.as_deref(),
            )
            .await?;
        }
        updated += 1;
    }

    tx.commit_and_dispatch(materializer).await?;

    Ok(updated)
}

/// Set the priority on a block (level value or clear).
///
/// The levels are the built-in `priority` options (#5841); `set_property_in_tx`
/// refuses any other. A block that already holds an out-of-range level from
/// before keeps it until this sets another.
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

/// The keys only state transitions and recurrence write (#658): a task's
/// `created_at` / `completed_at` stamps and each occurrence's `repeat-seq` /
/// `repeat-origin`. The recurrence rule itself (`repeat`, `repeat-until`,
/// `repeat-count`) is the user's to remove, as `/repeat remove` does. Mirrored
/// by the tauri mock's `delete_property`.
const SYSTEM_MANAGED_PROPERTY_KEYS: [&str; 4] =
    ["created_at", "completed_at", "repeat-seq", "repeat-origin"];

/// Delete a property from a block.
///
/// Appends a `DeleteProperty` op and removes the row from `block_properties`;
/// a key the block does not hold appends nothing. Deleting `repeat` also
/// deletes the `repeat-until`, `repeat-count` and `repeat-seq` the block
/// holds, in the same transaction; deleting `todo_state` clears the task's
/// `created_at` / `completed_at` stamps, as the app's clear does. Returns `key`
/// when it was held, and the repeat bounds deleted with it.
///
/// # Errors
///
/// - [`AppError::Validation`] — `key` is one of the
///   `SYSTEM_MANAGED_PROPERTY_KEYS`; direct FE/MCP deletion is rejected to
///   protect that bookkeeping (#658).
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_property_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: ActiveBlockId,
    key: String,
) -> Result<Vec<String>, AppError> {
    // #658: `delete_property_core` is the standalone path that owns its
    // transaction, and this is its sole production caller. Keep the lifecycle
    // guard here before delegating. State-transition helpers that already hold
    // a transaction use `delete_property_in_tx` to clear `created_at` /
    // `completed_at` keys. The reserved *column* keys (`todo_state` /
    // `priority` / `due_date` / `scheduled_date`) are not blocked: clearing
    // them is a user action, and core routes them to their `blocks` column.
    if SYSTEM_MANAGED_PROPERTY_KEYS.contains(&key.as_str()) {
        return Err(AppError::validation(format!(
            "cannot delete system-managed property '{key}'"
        )));
    }
    delete_property_core(pool, device_id, materializer, block_id.into_string(), key).await
}

/// Removing the `repeat` rule removes these with it: its end conditions and
/// the count of its occurrences, which would otherwise bound a rule set later.
const REPEAT_RULE_BOUNDS: [&str; 3] = ["repeat-until", "repeat-count", "repeat-seq"];

/// Delete the [`REPEAT_RULE_BOUNDS`] `block_id` holds in `tx`, as part of
/// deleting its `repeat`. A key it does not hold appends no op, which would
/// have no value to undo to. Returns the keys deleted.
pub(crate) async fn delete_repeat_bounds_in_tx(
    tx: &mut CommandTx,
    state: &agaric_engine::loro::shared::LoroState,
    device_id: &str,
    block_id: &str,
) -> Result<Vec<&'static str>, AppError> {
    let held = get_properties_inner(&mut ***tx, BlockId::from_trusted(block_id)).await?;
    let mut deleted = Vec::new();
    for key in REPEAT_RULE_BOUNDS {
        if held.iter().any(|p| p.key == key) {
            let op = delete_property_in_tx(&mut *tx, state, device_id, block_id, key).await?;
            tx.enqueue_background(op);
            deleted.push(key);
        }
    }
    Ok(deleted)
}

/// Get all properties for a block (read-only).
#[instrument(skip(executor), err)]
pub async fn get_properties_inner<'e>(
    executor: impl sqlx::SqliteExecutor<'e>,
    block_id: BlockId,
) -> Result<Vec<PropertyRow>, AppError> {
    let block_id = block_id.as_str();
    let rows = sqlx::query_as!(
        PropertyRow,
        "SELECT key, value_text, value_num, value_date, value_ref, value_bool \
         FROM block_properties WHERE block_id = ?",
        block_id
    )
    .fetch_all(executor)
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
#[instrument(skip(executor), err)]
pub async fn get_property_inner<'e>(
    executor: impl sqlx::SqliteExecutor<'e>,
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
    .fetch_optional(executor)
    .await?;

    Ok(row)
}

/// Refuse a definition write to a built-in key (#5841): those are code
/// constants, the same in every vault.
pub(crate) fn refuse_builtin_definition_write(key: &str) -> Result<(), AppError> {
    if agaric_store::op::is_builtin_property_key(key) {
        return Err(AppError::validation_coded(
            ValidationCode::BuiltinPropertyLocked,
            format!("property '{key}' is built in and cannot be changed"),
        ));
    }
    Ok(())
}

/// The [`PropertyDefinition`] of a built-in. It is never stored, so it has no
/// creation time of its own; `created_at` is the date migration 0014's seeds
/// carried, the same for every built-in.
fn builtin_definition(def: &agaric_store::op::BuiltinPropertyDef) -> PropertyDefinition {
    PropertyDefinition {
        key: def.key.to_owned(),
        value_type: def.value_type.to_owned(),
        options: def.options_json(),
        created_at: "2026-01-01T00:00:00.000Z".to_owned(),
        builtin: true,
    }
}

/// Shape validation shared by every `property_definitions` writer:
/// [`create_property_def_inner`] (owns its pool round-trip) and
/// [`create_property_def_in_tx`] (writes inside a caller's transaction).
/// Extracted so the two cannot drift — a key/type/options payload either
/// writer accepts must be one the other accepts too.
pub(crate) fn validate_property_def_shape(
    key: &str,
    value_type: &str,
    options: Option<&str>,
) -> Result<(), AppError> {
    refuse_builtin_definition_write(key)?;
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
        "text" | "number" | "date" | "select" | "ref" | "boolean" | "url"
    ) {
        return Err(AppError::validation(format!(
            "invalid value_type '{value_type}': must be text, number, date, select, ref, boolean, or url"
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
        // A url is text with a link rendering, never a block reference.
        "url" => shape == "text",
        _ => true,
    }
}

/// Would declaring `key` as `value_type` in `space_id` orphan values the
/// space's blocks already hold under that key? Returns the rejection message
/// when it would, and `None` when the declaration is safe (#4399).
///
/// # Why a declaration over existing values is a trap
///
/// `property_definitions` is keyed by `(space_id, key)`, so a declaration
/// constrains **every block in the space** (#5841). The dangerous case is a key
/// with existing values and no declaration — the ordinary state, since
/// `validate_property_value` skips its type check entirely when
/// `declaration` is `None`, so an undeclared non-reserved key accepts any
/// of the five typed slots. Declaring a contradicting type over those
/// values costs the user three things at once (#4382):
///
///  1. every later write of the stored shape, on any block of the space, is
///     rejected —
///     `"Property 'year' expects type 'number', got 'text'."`;
///  2. every such value is one the type does not take, kept as text out of
///     the type's column (#6206), so the type's readers never see it;
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
/// Built-in keys never reach the probe: [`validate_property_def_shape`]
/// refuses them first (#5841).
async fn conflicting_existing_values(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    key: &str,
    value_type: &str,
    options: Option<&str>,
) -> Result<Option<String>, AppError> {
    // One aggregate pass over the key's rows in the space. The
    // `exactly_one_value` CHECK (migrations 0062 / 0088) guarantees exactly
    // one non-NULL value column per row, so these five counts partition
    // `total` and a row can never be counted under two shapes.
    let counts = sqlx::query!(
        r#"SELECT
             COUNT(*)                                                               AS "total!: i64",
             COALESCE(SUM(CASE WHEN bp.value_text IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_text!: i64",
             COALESCE(SUM(CASE WHEN bp.value_num  IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_num!: i64",
             COALESCE(SUM(CASE WHEN bp.value_date IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_date!: i64",
             COALESCE(SUM(CASE WHEN bp.value_ref  IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_ref!: i64",
             COALESCE(SUM(CASE WHEN bp.value_bool IS NOT NULL THEN 1 ELSE 0 END), 0) AS "n_bool!: i64"
           FROM block_properties bp
           JOIN blocks b ON b.id = bp.block_id
           WHERE bp.key = ?1 AND b.space_id = ?2"#,
        key,
        space_id,
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
               FROM block_properties bp
               JOIN blocks b ON b.id = bp.block_id
               WHERE bp.key = ?1
                 AND b.space_id = ?3
                 AND bp.value_text IS NOT NULL
                 AND bp.value_text NOT IN (SELECT value FROM json_each(?2))"#,
            key,
            opts,
            space_id,
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
         to every block in its space, and it cannot be removed again while any value under the \
         key exists there. Clear or convert those values first, or declare '{key}' as the type they \
         already use."
    )))
}

/// Create a property definition in `space_id` (#5841), as one `SetPropertyDef`
/// op. Idempotent: if the space already declares the key, nothing is written
/// and the existing row is returned unchanged. A built-in key is refused with
/// [`ValidationCode::BuiltinPropertyLocked`].
///
/// # Refuses to declare a type over values that contradict it (#4399)
///
/// Before writing, this probes the space's `block_properties` for the key
/// and rejects with [`AppError::Validation`] when any value already stored
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
/// The probe, the op and the readback share one `BEGIN IMMEDIATE`.
/// Split across statements this would be a genuine TOCTOU: a concurrent
/// `set_property` can create the very `block_properties` rows the probe
/// looked for and did not find, and the declaration that lands on top of
/// them is exactly the un-exitable state the probe exists to prevent.
/// That window is also why the frontend's own pre-flight
/// (`renameMayDeclareKey`, `src/lib/property-save-utils.ts`) cannot be the
/// guarantee — it reads the read pool while the write goes to the write
/// pool, and it only sees the 1000 most-used keys.
#[instrument(skip(pool, device_id, materializer, options), err)]
pub async fn create_property_def_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
    value_type: String,
    options: Option<String>,
) -> Result<PropertyDefinition, AppError> {
    validate_property_def_shape(&key, &value_type, options.as_deref())?;

    let mut tx = CommandTx::begin_immediate(pool, "create_property_def").await?;
    tx.arm_engine_rollback(materializer.loro_state());

    // Idempotency first, and before the probe. An existing row wins (the
    // INSERT OR IGNORE contract ~20 call sites depend on), and nothing is
    // written — so there is no new constraint to guard, and re-asserting a
    // declaration the user already made must never be refused. This is also
    // what keeps a rename onto an already-declared key a no-op.
    if let Some(row) = user_property_def(&mut tx, space_id, &key).await? {
        return Ok(row);
    }

    if let Some(reason) =
        conflicting_existing_values(&mut tx, space_id, &key, &value_type, options.as_deref())
            .await?
    {
        return Err(AppError::validation(reason));
    }

    let def = PropertyDefState {
        value_type,
        options,
    };
    write_property_def_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        space_id,
        &key,
        Some(def),
    )
    .await?;

    // Fetch back inside the same transaction — the row this call created,
    // never one a racing writer slipped in afterwards.
    let row = user_property_def(&mut tx, space_id, &key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;

    tx.commit_and_dispatch(materializer).await?;
    Ok(row)
}

/// `space_id`'s own row for `key`, never a built-in.
pub(crate) async fn user_property_def(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    key: &str,
) -> Result<Option<PropertyDefinition>, AppError> {
    Ok(sqlx::query_as!(
        PropertyDefinition,
        r#"SELECT key, value_type, options, created_at, 0 AS "builtin!: bool"
           FROM property_definitions WHERE space_id = ? AND key = ?"#,
        space_id,
        key,
    )
    .fetch_optional(conn)
    .await?)
}

/// In-transaction twin of [`create_property_def_inner`] (#4382).
///
/// Same validation and the same idempotency — a key the space already
/// declares is left as it is — but written through a caller-owned
/// transaction instead of the pool, and without the post-write readback
/// (callers that need the winning row already read `property_definitions` in
/// the same transaction).
///
/// This exists so a caller can make "is this key safe to declare?" and the
/// declaration itself **one atomic decision**. Declaring a key constrains
/// every block of the space, so a pre-flight run on a separate connection is
/// a genuine TOCTOU: a
/// concurrent write can create the very `block_properties` rows the
/// pre-flight looked for and did not find. Inside one `BEGIN IMMEDIATE`
/// there is no such window.
///
/// This is the raw writer and deliberately carries **no** in-use probe of
/// its own (#4399); each caller decides what an in-use key means for it,
/// and runs that decision in this same transaction. The two callers do
/// differ: `declare_bib_property_defs` warns and continues, because
/// refusing to import a bibliography over an unrelated key elsewhere in
/// the space is disproportionate, while [`create_property_def_inner`]
/// refuses, because a user asked for this one key by name. Adding a probe
/// here would not change the import's behaviour — its own test is the
/// strictly coarser "any values at all?" — but it would put the decision
/// in the wrong place.
pub async fn create_property_def_in_tx(
    tx: &mut CommandTx,
    state: &LoroState,
    device_id: &str,
    space_id: &str,
    key: &str,
    value_type: &str,
    options: Option<&str>,
) -> Result<(), AppError> {
    validate_property_def_shape(key, value_type, options)?;
    if user_property_def(tx, space_id, key).await?.is_some() {
        return Ok(());
    }
    let def = PropertyDefState {
        value_type: value_type.to_owned(),
        options: options.map(str::to_owned),
    };
    write_property_def_in_tx(tx, state, device_id, space_id, key, Some(def)).await
}

/// The one writer of a space's definitions (#5841): appends the
/// `SetPropertyDef` taking `space_id`'s definition of `key` from what it holds
/// to `def` (`None` deletes it), applies it and enqueues its dispatch. Writing
/// the definition the space already holds appends nothing.
///
/// # Errors
///
/// - [`AppError::Validation`] coded [`ValidationCode::BuiltinPropertyLocked`]
///   for a built-in key.
/// - [`AppError::Validation`] for a malformed definition, or one that changes
///   the type the space declares the key with.
pub(crate) async fn write_property_def_in_tx(
    tx: &mut CommandTx,
    state: &LoroState,
    device_id: &str,
    space_id: &str,
    key: &str,
    def: Option<PropertyDefState>,
) -> Result<(), AppError> {
    refuse_builtin_definition_write(key)?;
    if let Some(def) = &def {
        validate_property_def_shape(key, &def.value_type, def.options.as_deref())?;
    }
    let prior = user_property_def(tx, space_id, key)
        .await?
        .map(|row| PropertyDefState {
            value_type: row.value_type,
            options: row.options,
        });
    if let (Some(def), Some(prior)) = (&def, &prior)
        && def.value_type != prior.value_type
    {
        return Err(AppError::validation(format!(
            "property '{key}' is declared as '{}' and cannot change to '{}'",
            prior.value_type, def.value_type
        )));
    }
    if def == prior {
        return Ok(());
    }
    let payload = OpPayload::SetPropertyDef(SetPropertyDefPayload {
        space_id: BlockId::from_trusted(space_id),
        key: key.to_owned(),
        def,
        prior,
    });
    append_and_apply(tx, state, device_id, payload).await
}

/// Append `payload`, apply it and queue its dispatch, in `tx`.
pub(super) async fn append_and_apply(
    tx: &mut CommandTx,
    state: &LoroState,
    device_id: &str,
    payload: OpPayload,
) -> Result<(), AppError> {
    let record =
        agaric_store::op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms())
            .await?;
    crate::materializer::apply_op_projected(tx, &record, state, false).await?;
    tx.enqueue_background(record);
    Ok(())
}

/// Refuse an undo or redo restoring `p.def` when it moves the key's values to
/// another column and [`create_property_def_inner`] would refuse that
/// declaration over them: re-typed, they would not fit it.
pub(crate) async fn refuse_restoring_def_over_conflicting_values(
    conn: &mut sqlx::SqliteConnection,
    p: &SetPropertyDefPayload,
) -> Result<(), AppError> {
    use agaric_engine::loro::projection::str_column_for;
    let Some(def) = &p.def else {
        return Ok(());
    };
    let space_id = p.space_id.as_str();
    let held = user_property_def(conn, space_id, &p.key).await?;
    if str_column_for(held.as_ref().map(|row| row.value_type.as_str()))
        == str_column_for(Some(&def.value_type))
    {
        return Ok(());
    }
    match conflicting_existing_values(
        conn,
        space_id,
        &p.key,
        &def.value_type,
        def.options.as_deref(),
    )
    .await?
    {
        Some(reason) => Err(AppError::validation(reason)),
        None => Ok(()),
    }
}

/// The editable definitions a new space starts with (#5841): ordinary user
/// definitions, so the user can change or delete them. Mirrored by
/// `DEFAULT_PROPERTY_DEFS` in `src/lib/tauri-mock/seed.ts`.
pub const DEFAULT_PROPERTY_DEFS: [(&str, &str, Option<&str>); 5] = [
    (
        "status",
        "select",
        Some(r#"["active","paused","done","archived"]"#),
    ),
    ("url", "text", None),
    (
        "effort",
        "select",
        Some(r#"["15m","30m","1h","2h","4h","1d"]"#),
    ),
    ("assignee", "text", None),
    ("location", "text", None),
];

/// Give `space_id`, a space just created, the [`DEFAULT_PROPERTY_DEFS`]: one
/// `SetPropertyDef` each, so the space's doc carries them to every device that
/// receives the space.
pub async fn seed_default_property_defs_in_tx(
    tx: &mut CommandTx,
    state: &LoroState,
    device_id: &str,
    space_id: &str,
) -> Result<(), AppError> {
    for (key, value_type, options) in DEFAULT_PROPERTY_DEFS {
        create_property_def_in_tx(tx, state, device_id, space_id, key, value_type, options).await?;
    }
    Ok(())
}

/// List `space_id`'s property definitions, paginated and ordered by
/// `key ASC` (AGENTS.md invariant #3): the built-ins (#5841), marked
/// `builtin`, merged with the space's own rows.
///
/// `key` is unique within a space (a string, not a ULID), so the keyset
/// cursor is encoded via [`pagination::Cursor::for_id`] with
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
    space_id: &str,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<pagination::PageResponse<PropertyDefinition>, AppError> {
    let page = pagination::PageRequest::new(cursor, limit)?;
    let (cursor_flag, cursor_key): (Option<i64>, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.as_str()),
        None => (None, ""),
    };
    let fetch_limit = page.limit + 1;
    let mut rows = sqlx::query_as!(
        PropertyDefinition,
        r#"SELECT key, value_type, options, created_at, 0 AS "builtin!: bool"
         FROM property_definitions
         WHERE space_id = ?1 AND (?2 IS NULL OR key > ?3)
         ORDER BY key ASC
         LIMIT ?4"#,
        space_id,
        cursor_flag,
        cursor_key,
        fetch_limit,
    )
    .fetch_all(pool)
    .await?;
    // The first `fetch_limit` rows after the cursor plus every built-in after
    // it hold the first `fetch_limit` of the union. `str` orders by bytes, as
    // SQLite's BINARY collation does.
    rows.extend(
        agaric_store::op::BUILTIN_PROPERTY_DEFS
            .iter()
            .filter(|def| cursor_flag.is_none() || def.key > cursor_key)
            .map(builtin_definition),
    );
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    rows.truncate(usize::try_from(fetch_limit).unwrap_or(usize::MAX));
    pagination::build_page_response(rows, page.limit, |last| {
        pagination::Cursor::for_id(last.key.clone())
    })
}

/// Fetch a single property definition by key: the built-in (#5841), else
/// `space_id`'s row. Returns `Ok(None)` for a key the space does not declare.
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
    space_id: &str,
    key: &str,
) -> Result<Option<PropertyDefinition>, AppError> {
    if let Some(def) = agaric_store::op::builtin_property_def(key) {
        return Ok(Some(builtin_definition(def)));
    }
    let mut conn = pool.acquire().await?;
    user_property_def(&mut conn, space_id, key).await
}

/// Update the options array of `space_id`'s select-type definition.
/// Returns error if the key is built in, the space doesn't declare it or it
/// isn't select-type.
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
/// link. Inbound sync projects a `select` value
/// (`reproject_block_properties_from_engine`) to `value_text` with no
/// membership check, so the orphan rows are never dropped and stay visible;
/// and the exit is one
/// non-destructive call to this very function with the option added
/// back. Only link 1 fires, and it un-fires on demand. A refusal here
/// would also break the legitimate retire-an-option flow the paragraph
/// above describes, which has no equivalent on the create path — there
/// is no such thing as retiring a declaration you have not made yet.
#[instrument(skip(pool, device_id, materializer, options), err)]
pub async fn update_property_def_options_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
    options: String,
) -> Result<PropertyDefinition, AppError> {
    refuse_builtin_definition_write(&key)?;
    // Validate options is a non-empty JSON array of strings
    let parsed: Vec<String> = serde_json::from_str(&options)
        .map_err(|_| AppError::validation("options must be a JSON array of strings".into()))?;
    if parsed.is_empty() {
        return Err(AppError::validation("options must not be empty".into()));
    }

    // #383: open a BEGIN IMMEDIATE tx so the existence/type check, the orphan
    // count, and the op are TOCTOU-safe — a concurrent
    // `delete_property_def`/`set_property` cannot race in between the read and
    // the write. Mirrors the sibling `delete_property_def_inner`. Dropping the
    // tx without commit (early returns below) rolls it back automatically.
    let mut tx = CommandTx::begin_immediate(pool, "update_property_def_options").await?;
    tx.arm_engine_rollback(materializer.loro_state());

    // Fetch existing to verify it's select-type
    let existing = user_property_def(&mut tx, space_id, &key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;

    if existing.value_type != "select" {
        return Err(AppError::validation(format!(
            "cannot update options on '{}'-type definition '{key}'",
            existing.value_type
        )));
    }

    // Count the space's orphan rows before applying the narrowing. The new
    // options are encoded as a JSON array; bind via `json_each(?)` so
    // SQLite expands the membership test without a placeholder
    // explosion. Live blocks only — `b.deleted_at IS NULL` matches the
    // semantics of `get_properties` so the warn count reflects what
    // the user will actually see.
    let orphan_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties bp \
         JOIN blocks b ON b.id = bp.block_id \
         WHERE bp.key = ?1 \
           AND b.space_id = ?3 \
           AND bp.value_text IS NOT NULL \
           AND b.deleted_at IS NULL \
           AND bp.value_text NOT IN (SELECT value FROM json_each(?2))",
        key,
        options,
        space_id,
    )
    .fetch_one(&mut **tx)
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

    let def = PropertyDefState {
        value_type: existing.value_type,
        options: Some(options),
    };
    write_property_def_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        space_id,
        &key,
        Some(def),
    )
    .await?;

    // #383: read the post-update row back INSIDE the tx instead of
    // reconstructing the return value from the pre-update snapshot, so the
    // returned shape reflects exactly what is committed.
    let updated = user_property_def(&mut tx, space_id, &key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;

    tx.commit_and_dispatch(materializer).await?;

    Ok(updated)
}

/// Delete `space_id`'s definition of `key`, as one `SetPropertyDef` op.
/// Returns the definition it deleted.
///
/// Returns error if the space doesn't declare the key, it is a built-in, or
/// a block of the space still holds a value under it.
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
/// The EXISTS / COUNT check and the op both run inside a single
/// `BEGIN IMMEDIATE` transaction so a concurrent `set_property` cannot
/// race in between the count and the delete and create a fresh
/// `block_properties` row that the caller never saw in the rejection
/// message.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_property_def_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    key: String,
) -> Result<PropertyDefinition, AppError> {
    refuse_builtin_definition_write(&key)?;

    // Open a BEGIN IMMEDIATE tx so the dependent-row check and
    // the delete are TOCTOU-safe. Dropping the tx without commit (early
    // returns below) rolls it back automatically.
    let mut tx = CommandTx::begin_immediate(pool, "delete_property_def").await?;
    tx.arm_engine_rollback(materializer.loro_state());

    let dependent_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_properties bp JOIN blocks b ON b.id = bp.block_id \
         WHERE bp.key = ?1 AND b.space_id = ?2",
        key,
        space_id,
    )
    .fetch_one(&mut **tx)
    .await?;

    if dependent_count > 0 {
        return Err(AppError::validation(format!(
            "Can't delete '{key}': {dependent_count} block(s) still use it. Remove the property \
             from them first."
        )));
    }

    let deleted = user_property_def(&mut tx, space_id, &key)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("property definition '{key}'")))?;

    write_property_def_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        space_id,
        &key,
        None,
    )
    .await?;

    tx.commit_and_dispatch(materializer).await?;
    Ok(deleted)
}

/// Space membership, not a value a user sets: every block of a space holds
/// `space`, and `is_space` sits on the space's own block, which is in no space.
pub(super) const UNCOUNTED_PROPERTY_KEYS: [&str; 2] = ["space", "is_space"];

/// How many live blocks of a space hold a value under one key (#5841), and
/// how many of its values don't fit it (#6206).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct PropertyUsage {
    pub key: String,
    pub count: i64,
    #[serde(flatten)]
    pub unfit: PropertyUnfitCounts,
}

/// Count, for every key `space_id` defines and every built-in, the live
/// blocks of the space holding a value under it, and its values that don't
/// fit it, live and trashed (#6206), ordered by key. Bounded by the space's
/// vocabulary, so it is one flat list (invariant 3's exception).
///
/// `count` leaves trashed blocks out, though [`delete_property_def_inner`]
/// counts them: a key showing 0 uses can still be refused. The column-backed
/// keys are read from their `blocks` columns. `UNCOUNTED_PROPERTY_KEYS` are
/// not listed.
///
/// # Errors
///
/// - [`AppError::NotFound`] — `space_id` is not a registered space
#[instrument(skip(pool), err)]
pub async fn count_property_usage_inner(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<PropertyUsage>, AppError> {
    let mut conn = pool.acquire().await?;
    let registered = sqlx::query_scalar!(
        r#"SELECT 1 AS "ok!: i64" FROM spaces WHERE id = ?"#,
        space_id
    )
    .fetch_optional(&mut *conn)
    .await?;
    if registered.is_none() {
        return Err(AppError::NotFound(format!("space '{space_id}'")));
    }
    let builtin_keys = serde_json::to_string(
        &agaric_store::op::BUILTIN_PROPERTY_DEFS
            .iter()
            .map(|def| def.key)
            .filter(|key| !UNCOUNTED_PROPERTY_KEYS.contains(key))
            .collect::<Vec<_>>(),
    )?;
    let used = sqlx::query!(
        r#"WITH live AS MATERIALIZED (
               SELECT id, todo_state, priority, due_date, scheduled_date
               FROM blocks WHERE space_id = ?1 AND deleted_at IS NULL
           ),
           vocab(key) AS (
               SELECT key FROM property_definitions WHERE space_id = ?1
               UNION
               SELECT CAST(je.value AS TEXT) FROM json_each(?2) AS je
           ),
           columns AS MATERIALIZED (
               SELECT COUNT(todo_state) AS todo_state, COUNT(priority) AS priority,
                      COUNT(due_date) AS due_date, COUNT(scheduled_date) AS scheduled_date
               FROM live
           ),
           used(key, n) AS (
               SELECT bp.key, COUNT(*) FROM live b JOIN block_properties bp ON bp.block_id = b.id
               WHERE bp.key IN (SELECT key FROM vocab)
               GROUP BY bp.key
               UNION ALL SELECT 'todo_state', todo_state FROM columns
               UNION ALL SELECT 'priority', priority FROM columns
               UNION ALL SELECT 'due_date', due_date FROM columns
               UNION ALL SELECT 'scheduled_date', scheduled_date FROM columns
           )
           SELECT v.key AS "key!: String", COALESCE(u.n, 0) AS "count!: i64"
           FROM vocab v LEFT JOIN used u ON u.key = v.key
           ORDER BY v.key"#,
        space_id,
        builtin_keys,
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut unfit = super::property_unfit::unfit_counts(&mut conn, space_id).await?;
    Ok(used
        .into_iter()
        .map(|row| PropertyUsage {
            unfit: unfit.remove(&row.key).unwrap_or_default(),
            key: row.key,
            count: row.count,
        })
        .collect())
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
    // #1627: mint the type-state newtype without a pre-tx round-trip.
    // The activeness gate (existence + soft-deleted discrimination, with
    // identical NotFound/Validation errors) now runs inside the write
    // transaction's existing re-validation (`set_property_in_tx`).
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let events = property_changed_events([block_id], std::slice::from_ref(&key));
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
    emit_property_changed_events(&app, events);
    Ok(result)
}

/// Tauri command: set todo state on a block. Delegates to [`set_todo_state_inner`].
///
/// #6156: the reply carries the refs of every op it appended, the stamps' and
/// the next occurrence's among them, so the frontend undoes it by those refs.
#[tauri::command]
#[specta::specta]
pub async fn set_todo_state(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
    state: Option<String>,
) -> Result<WithOps<BlockRow>, AppError> {
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let events = property_changed_events([block_id], &["todo_state".to_owned()]);
    // Boxed: inlined, the recurrence's future makes the wrapper's trip `clippy::large_futures`.
    let result = capture_op_refs(async {
        Box::pin(set_todo_state_inner(
            ctx.pool(),
            ctx.device_id(),
            ctx.materializer(),
            active_id,
            state,
        ))
        .await
        .map(Into::into)
    })
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_events(&app, events);
    Ok(result)
}

/// Tauri command: batch-set todo state on multiple blocks.
///
/// Delegates to [`set_todo_state_batch_inner`]. Single IMMEDIATE tx
/// covers every per-block write — collapses the legacy N-IPC loop the
/// FE used to drive in `useBlockMultiSelect.handleBatchSetTodo` into
/// one round-trip / one op_log seq range / one writer-lock window.
///
/// Emits one `EVENT_PROPERTY_CHANGED` per block it was handed, skipped
/// or not ([`property_changed_events`]), so the per-block listeners
/// (e.g. agenda recompute, property drawer) get the single-row signal.
///
/// #6156: the reply carries the refs of every op the batch appended, the
/// stamps' among them, so the frontend undoes it by those refs.
#[tauri::command]
#[specta::specta]
pub async fn set_todo_state_batch(
    app: tauri::AppHandle,
    ctx: State<'_, WriteCtx>,
    block_ids: Vec<BlockId>,
    state: Option<String>,
) -> Result<WithOps<TodoStateBatch>, AppError> {
    let events = property_changed_events(block_ids.clone(), &["todo_state".to_owned()]);
    let set = capture_op_refs(async {
        set_todo_state_batch_inner(
            ctx.pool(),
            ctx.device_id(),
            ctx.materializer(),
            block_ids,
            state,
        )
        .await
        .map(|updated| TodoStateBatch { updated })
    })
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_events(&app, events);
    Ok(set)
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
    let events = property_changed_events(block_ids.clone(), std::slice::from_ref(&key));
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
    emit_property_changed_events(&app, events);
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
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let events = property_changed_events([block_id], &["priority".to_owned()]);
    let result = set_priority_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        level,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_events(&app, events);
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
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let events = property_changed_events([block_id], &["due_date".to_owned()]);
    let result = set_due_date_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        date,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_events(&app, events);
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
    // #1627: see `set_property` — activeness gate folded into the tx.
    let active_id = ActiveBlockId::from_trusted_active(block_id.as_str());
    let events = property_changed_events([block_id], &["scheduled_date".to_owned()]);
    let result = set_scheduled_date_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        date,
    )
    .await
    .map_err(sanitize_internal_error)?;
    emit_property_changed_events(&app, events);
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
    let deleted = capture_op_refs(delete_property_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        active_id,
        key,
    ))
    .await
    .map_err(sanitize_internal_error)?;
    // The keys it actually removed, which may be none: `repeat` takes its bounds with it.
    emit_property_changed_events(&app, property_changed_events([block_id], &deleted.inner));
    Ok(WithOps {
        inner: DeletePropertyResponse {
            block_id: block_id_clone,
            key: key_clone,
        },
        op_refs: deleted.op_refs,
    })
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

/// Tauri command: create a property definition in a space. Delegates to
/// [`create_property_def_inner`]; the response carries the op refs it
/// appended, none when the space already declared the key.
#[tauri::command]
#[specta::specta]
pub async fn create_property_def(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
    value_type: String,
    options: Option<String>,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(create_property_def_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
        value_type,
        options,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list a space's property definitions, paginated.
/// Delegates to [`list_property_defs_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_property_defs(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<pagination::PageResponse<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    list_property_defs_inner(&read_pool.0, space_id.as_str(), cursor, limit)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: fetch a single property definition of a space by key.
/// Delegates to [`get_property_def_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_property_def(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    key: String,
) -> Result<Option<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    get_property_def_inner(&read_pool.0, space_id.as_str(), &key)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: update options for a space's select-type definition.
/// Delegates to [`update_property_def_options_inner`]; the response carries
/// the op refs it appended, none when the options are unchanged.
#[tauri::command]
#[specta::specta]
pub async fn update_property_def_options(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
    options: String,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(update_property_def_options_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
        options,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: delete a space's property definition. Delegates to
/// [`delete_property_def_inner`]; the response is the deleted definition and
/// the op ref of its delete.
#[tauri::command]
#[specta::specta]
pub async fn delete_property_def(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    key: String,
) -> Result<WithOps<PropertyDefinition>, AppError> {
    space_id.validate_shape()?;
    capture_op_refs(delete_property_def_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        key,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: how many live blocks of a space use each key of its
/// vocabulary. Delegates to [`count_property_usage_inner`].
#[tauri::command]
#[specta::specta]
pub async fn count_property_usage(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
) -> Result<Vec<PropertyUsage>, AppError> {
    space_id.validate_shape()?;
    count_property_usage_inner(&read_pool.0, space_id.as_str())
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
    /// "url"             => payload.value_text.is_some(),
    /// ```
    ///
    /// Anything not listed for a type must be REFUSED — that half is the
    /// one that keeps #4382 shut, and the half falsification found open.
    const MATRIX: [(&str, &[&str]); 7] = [
        ("text", &["text", "ref"]),
        ("select", &["text", "ref"]),
        ("ref", &["ref"]),
        ("number", &["number"]),
        ("date", &["date"]),
        ("boolean", &["boolean"]),
        ("url", &["text"]),
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
    /// eighth `value_type` added to [`validate_property_def_shape`] and not
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

    /// The other direction of staleness: an eighth declarable `value_type`
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
            "invalid value_type 'septenary': must be text, number, date, select, ref, boolean, or url",
            "the declarable-type set changed. Every type `validate_property_def_shape` accepts \
             needs a row in this module's MATRIX and a named arm in \
             `declared_type_admits_shape` — otherwise it falls through to the `_ => true` \
             catch-all and its declarations are never probed (#4399/#4382)."
        );
    }
}

#[cfg(test)]
mod count_property_usage_tests {
    use super::*;
    use crate::commands::tests::common::{
        DEV, TEST_SPACE_B_ID, TEST_SPACE_ID, assign_to_space, ensure_test_space,
        ensure_test_space_b, test_pool,
    };
    use crate::commands::{create_block_inner, delete_block_inner};

    /// A fresh content block in `space`.
    async fn block_in(pool: &SqlitePool, mat: &Materializer, space: &str) -> String {
        ensure_test_space(pool).await;
        ensure_test_space_b(pool).await;
        let block = create_block_inner(pool, DEV, mat, "content".into(), "card".into(), None, None)
            .await
            .unwrap();
        mat.flush_background().await.unwrap();
        assign_to_space(pool, block.id.as_str(), space).await;
        block.id.as_str().to_owned()
    }

    async fn hold_text(pool: &SqlitePool, mat: &Materializer, block: &str, key: &str) {
        set_property_inner(
            pool,
            DEV,
            mat,
            block.into(),
            key.into(),
            Some("v".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();
    }

    /// `key`'s count in `space`, failing when the key is not listed.
    async fn count_of(pool: &SqlitePool, space: &str, key: &str) -> i64 {
        let rows = count_property_usage_inner(pool, space).await.unwrap();
        rows.iter()
            .find(|row| row.key == key)
            .unwrap_or_else(|| panic!("`{key}` is not listed in {rows:?}"))
            .count
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn counts_only_the_asked_spaces_values() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        for space in [TEST_SPACE_ID, TEST_SPACE_B_ID] {
            create_property_def_inner(&pool, DEV, &mat, space, "stage".into(), "text".into(), None)
                .await
                .unwrap();
        }
        for space in [TEST_SPACE_ID, TEST_SPACE_ID, TEST_SPACE_B_ID] {
            let block = block_in(&pool, &mat, space).await;
            hold_text(&pool, &mat, &block, "stage").await;
        }

        assert_eq!(
            count_of(&pool, TEST_SPACE_ID, "stage").await,
            2,
            "A holds two"
        );
        assert_eq!(
            count_of(&pool, TEST_SPACE_B_ID, "stage").await,
            1,
            "B holds one"
        );
        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_trashed_block_does_not_count() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        create_property_def_inner(
            &pool,
            DEV,
            &mat,
            TEST_SPACE_ID,
            "stage".into(),
            "text".into(),
            None,
        )
        .await
        .unwrap();
        let kept = block_in(&pool, &mat, TEST_SPACE_ID).await;
        let trashed = block_in(&pool, &mat, TEST_SPACE_ID).await;
        hold_text(&pool, &mat, &kept, "stage").await;
        hold_text(&pool, &mat, &trashed, "stage").await;
        delete_block_inner(&pool, DEV, &mat, trashed.as_str().into())
            .await
            .unwrap();
        mat.flush_background().await.unwrap();

        assert_eq!(
            count_of(&pool, TEST_SPACE_ID, "stage").await,
            1,
            "the live one only"
        );
        mat.shutdown();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn column_backed_keys_count_from_their_columns() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let task = block_in(&pool, &mat, TEST_SPACE_ID).await;
        // Holds none of the column keys, but is a live block of the space.
        let _plain = block_in(&pool, &mat, TEST_SPACE_ID).await;
        let elsewhere = block_in(&pool, &mat, TEST_SPACE_B_ID).await;
        set_todo_state_inner(&pool, DEV, &mat, task.as_str().into(), Some("TODO".into()))
            .await
            .unwrap();
        set_priority_inner(&pool, DEV, &mat, task.as_str().into(), Some("1".into()))
            .await
            .unwrap();
        set_due_date_inner(
            &pool,
            DEV,
            &mat,
            task.as_str().into(),
            Some("2026-01-01".into()),
        )
        .await
        .unwrap();
        set_todo_state_inner(
            &pool,
            DEV,
            &mat,
            elsewhere.as_str().into(),
            Some("TODO".into()),
        )
        .await
        .unwrap();
        mat.flush_background().await.unwrap();

        for (key, n) in [
            ("todo_state", 1),
            ("priority", 1),
            ("due_date", 1),
            ("scheduled_date", 0),
        ] {
            assert_eq!(count_of(&pool, TEST_SPACE_ID, key).await, n, "`{key}` in A");
        }
        mat.shutdown();
    }

    /// #5841: the one definition writer refuses a built-in, and a change of
    /// the type the space declares a key with, whatever path reaches it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_definition_writer_refuses_a_builtin_and_a_type_change() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        create_property_def_inner(
            &pool,
            DEV,
            &mat,
            TEST_SPACE_ID,
            "stage".into(),
            "text".into(),
            None,
        )
        .await
        .unwrap();
        let write = |key: &'static str, def: Option<PropertyDefState>| {
            let (pool, mat) = (&pool, &mat);
            async move {
                let mut tx = CommandTx::begin_immediate(pool, "test").await.unwrap();
                tx.arm_engine_rollback(mat.loro_state());
                write_property_def_in_tx(&mut tx, mat.loro_state(), DEV, TEST_SPACE_ID, key, def)
                    .await
            }
        };
        let date = || {
            Some(PropertyDefState {
                value_type: "date".into(),
                options: None,
            })
        };
        let retyped = write("stage", date()).await;
        assert!(
            matches!(&retyped, Err(AppError::Validation { .. }))
                && retyped
                    .as_ref()
                    .unwrap_err()
                    .to_string()
                    .contains("cannot change"),
            "a type change is refused, got {retyped:?}"
        );
        for def in [date(), None] {
            let builtin = write("todo_state", def).await;
            assert_eq!(
                builtin.err().and_then(|e| e.validation_code()),
                Some(ValidationCode::BuiltinPropertyLocked),
                "a built-in is refused"
            );
        }
        let declared: Option<String> = sqlx::query_scalar(
            "SELECT value_type FROM property_definitions WHERE space_id = ? AND key = 'stage'",
        )
        .bind(TEST_SPACE_ID)
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(
            declared.as_deref(),
            Some("text"),
            "the declaration is unchanged"
        );
    }

    /// #5841: a definition written in an armed tx that is dropped uncommitted
    /// leaves no trace: not in the doc, the table or the op log.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_definition_write_leaves_no_trace() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let mut tx = CommandTx::begin_immediate(&pool, "test").await.unwrap();
        tx.arm_engine_rollback(mat.loro_state());
        let def = PropertyDefState {
            value_type: "text".into(),
            options: None,
        };
        write_property_def_in_tx(
            &mut tx,
            mat.loro_state(),
            DEV,
            TEST_SPACE_ID,
            "stage",
            Some(def),
        )
        .await
        .unwrap();
        drop(tx);

        let in_doc = mat
            .loro_state()
            .registry
            .for_space(&SpaceId::from_trusted(TEST_SPACE_ID), DEV)
            .unwrap()
            .engine_mut()
            .read_property_def("stage")
            .unwrap();
        assert_eq!(in_doc, None, "the doc rewound");
        let rows: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM property_definitions WHERE key = 'stage') \
                  + (SELECT COUNT(*) FROM op_log WHERE op_type = 'set_property_def')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 0, "no row and no op");
        mat.shutdown();
    }

    #[tokio::test]
    async fn a_defined_key_with_no_values_counts_zero() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        let mat = Materializer::new(pool.clone());
        create_property_def_inner(
            &pool,
            DEV,
            &mat,
            TEST_SPACE_ID,
            "unused".into(),
            "text".into(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(count_of(&pool, TEST_SPACE_ID, "unused").await, 0);
    }

    #[tokio::test]
    async fn space_membership_keys_are_not_listed() {
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;

        let rows = count_property_usage_inner(&pool, TEST_SPACE_ID)
            .await
            .unwrap();

        let listed: Vec<&str> = rows.iter().map(|row| row.key.as_str()).collect();
        assert!(
            !listed.contains(&"space") && !listed.contains(&"is_space"),
            "membership keys listed: {listed:?}"
        );
    }

    #[tokio::test]
    async fn an_unknown_space_is_not_found() {
        let (pool, _dir) = test_pool().await;

        let result = count_property_usage_inner(&pool, TEST_SPACE_ID).await;

        assert!(
            matches!(result, Err(AppError::NotFound(_))),
            "a space that is not registered is refused, got {result:?}"
        );
    }
}
