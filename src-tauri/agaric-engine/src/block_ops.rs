//! Neutral block-write core (#2621 THE INVERSION — moved from the app crate's
//! `domain::block_ops`). The pure validators / typed-arg builders / content
//! caps plus the three in-transaction writers `create_block_in_tx`,
//! `set_property_in_tx`, and `set_property_in_tx_with_declaration`. They drive
//! the moved apply kernel (`crate::apply::kernel::apply_op_projected`) and the
//! store's `cross_space_validation`; the app re-exports the module
//! (`pub use agaric_engine::block_ops::*;`) at `crate::domain::block_ops` so the
//! recurrence / bootstrap / command call sites resolve unchanged.
//!
//! Neutral tx-scoped / domain helpers (#642, #882).
//!
//! Holds the cleanly-movable block-domain helpers that lower layers need
//! without reaching up into `crate::commands`: the pure ISO-date validators
//! consumed by `crate::recurrence` (and the command surface), plus the
//! create-block / set-property transaction cores.
//!
//! ## What lives here
//!
//! - [`validate_date_format`] and [`is_valid_iso_date`] (#642) — both pure
//!   (only `AppError` + `chrono`), no DB / op_log / payload coupling; moved
//!   DOWN into `agaric_core::date_validation` (#2633) and re-exported here.
//! - [`create_block_in_tx`] and [`set_property_in_tx`] (#882) — the
//!   tx-scoped create-block / set-property cores, moved verbatim from
//!   `commands::blocks::crud`. Despite the `…_in_tx` names they are the
//!   *command cores*: they build `OpPayload` / `CreateBlockPayload` /
//!   `SetPropertyPayload`, append to the `op_log`, run the local
//!   `validate_property_value` validator, and depend on
//!   `is_reserved_property_key`, the `ancestors_cte_standard!` macro and
//!   the `recompute_pages_cache_counts_for_pages` materializer path — all
//!   of which already live in neutral layers (`crate::op`, `agaric_store::op_log`,
//!   `crate::materializer`, …), so this is a behavior-preserving move that
//!   removes the residual `recurrence → commands` and `spaces → commands`
//!   upward edges. `crate::commands` re-exports both so its ~20 internal
//!   callers (journal/pages/spaces/properties) are unchanged.

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::op::{
    CreateBlockPayload, OpPayload, SPACE_PROPERTY_KEY, SetPropertyPayload,
    is_reserved_property_key, validate_set_property,
};
use agaric_store::op_log;
use agaric_store::pagination::BlockRow;

/// Maximum block-content size (bytes) enforced at the IPC layer
/// (`create_block_in_tx`, `edit_block_inner`, drafts). `pub(crate)` so
/// the MCP boundary (#699) reuses the same cap for `set_property`'s
/// `value_text` instead of inventing a second number.
pub const MAX_CONTENT_LENGTH: usize = 256 * 1024;

/// Maximum allowed nesting depth for the block tree.
/// Prevents pathological recursion and keeps recursive CTEs bounded.
///
/// #2621 (wave E4-import) — the value now lives in
/// [`agaric_store::block_descendants::MAX_BLOCK_DEPTH`], beside the looser
/// `DESCENDANT_DEPTH_CAP` runaway net, so the query-free import parser (which
/// moved into `agaric-engine`) can reach it without depending on the app
/// crate. Re-exported here so every existing
/// `crate::domain::block_ops::MAX_BLOCK_DEPTH` call site resolves unchanged.
pub use agaric_store::block_descendants::MAX_BLOCK_DEPTH;

/// The pure ISO-date (`YYYY-MM-DD`) validators moved DOWN into `agaric-core`
/// (#2633): [`validate_date_format`] and its `.is_ok()` delegate
/// [`is_valid_iso_date`] depend only on `AppError` + `chrono`, so they belong
/// at the bottom of the DAG rather than in this engine module. Re-exported so
/// the block write-path (`validate_property_value`), the recurrence projector
/// (`crate::recurrence::compute`), and the app command surface (via the
/// `crate::domain::block_ops` glob) all resolve `block_ops::validate_date_format`
/// / `block_ops::is_valid_iso_date` unchanged.
pub use agaric_core::date_validation::{is_valid_iso_date, validate_date_format};

/// The `(value_text, value_num, value_date, value_ref, value_bool)` tuple
/// that positionally matches [`set_property_in_tx`]'s trailing args. Named
/// so [`typed_property_args_for_string_value`] stays under the
/// `clippy::type_complexity` threshold (CI runs `clippy -D warnings`).
pub type TypedPropertyArgs = (
    Option<String>,
    Option<f64>,
    Option<String>,
    Option<String>,
    Option<bool>,
);

/// Typed field-shape for [`set_property_in_tx`] from a flat string-valued
/// property entry (import / batch-create). (#623)
///
/// Callers that build properties from a parsed `key:: value` map (Logseq
/// import, `create_blocks_batch`) only have a `String` value, but
/// [`set_property_in_tx`]'s validator (`validate_property_value` step 3)
/// requires the *right* typed field per reserved key. The date reserved
/// keys (`due_date` / `scheduled_date`) must arrive as `value_date`, not
/// `value_text`, or the whole all-or-nothing transaction aborts with a
/// "requires value_date" Validation error.
///
/// Returns the `(value_text, value_num, value_date, value_ref, value_bool)`
/// tuple positionally matching [`set_property_in_tx`]'s trailing args.
/// Only the two date reserved keys are re-shaped to `value_date`; every
/// other key (custom keys, `todo_state`, `priority`) keeps the `value_text`
/// shape that already validates. Non-reserved date-typed *definitions* are
/// out of scope here — import/batch don't carry a declared-type hint, and
/// the column-routing only applies to reserved keys.
pub fn typed_property_args_for_string_value(key: &str, value: String) -> TypedPropertyArgs {
    match key {
        "due_date" | "scheduled_date" => (None, None, Some(value), None, None),
        _ => (Some(value), None, None, None, None),
    }
}

/// Registry-aware typed field-shape for [`set_property_in_tx`] (#1432).
///
/// Like [`typed_property_args_for_string_value`], but consults the declared
/// `value_type` from `property_definitions` (passed by the caller, which has
/// already queried it in-tx) so that a flat string value coerces into the
/// *correct* `block_properties` column — `value_num` for `number`,
/// `value_bool` for `boolean`, `value_date` for `date`, and `value_text` for
/// `text` / `select` / unknown. This is what makes the frontmatter export →
/// import round-trip preserve typed page properties (a `count: 5` number
/// re-lands in `value_num`, not `value_text`).
///
/// `ref`-typed keys are deliberately NOT handled here: the exporter renders a
/// ref as the target page's *title*, so recovering the original ULID needs a
/// title→id reverse lookup against the DB, which the caller does (this is a
/// pure function with no DB access). A `ref` type therefore falls through to
/// the `value_text` default; the caller overrides that case.
///
/// `value_type == None` (no registered definition for the key) falls back to
/// the reserved-key routing of [`typed_property_args_for_string_value`], so
/// unknown frontmatter keys are stored as `value_text` exactly like an
/// unknown inline `key:: value` property.
///
/// Coercion failures (e.g. a `number`-typed key whose value isn't a valid
/// `f64`) degrade gracefully to `value_text` so a single malformed line can
/// never abort the whole import.
pub fn typed_property_args_for_registry_value(
    key: &str,
    value: String,
    value_type: Option<&str>,
) -> TypedPropertyArgs {
    match value_type {
        Some("number") => match value.trim().parse::<f64>() {
            Ok(n) => (None, Some(n), None, None, None),
            Err(_) => (Some(value), None, None, None, None),
        },
        Some("boolean") => match value.trim().to_ascii_lowercase().as_str() {
            "true" => (None, None, None, None, Some(true)),
            "false" => (None, None, None, None, Some(false)),
            _ => (Some(value), None, None, None, None),
        },
        Some("date") => (None, None, Some(value), None, None),
        // text / select / ref / unknown declared type, or no definition at
        // all: fall back to the reserved-key-aware string routing (`ref` is
        // overridden by the caller with a title→ULID reverse lookup).
        _ => typed_property_args_for_string_value(key, value),
    }
}

/// Pure per-block create validation: block_type membership + content-length
/// cap. Extracted from [`create_block_in_tx`]'s former inline steps 1 / 1c so
/// `create_blocks_batch_inner` can PRE-validate every spec BEFORE the first
/// `apply_op_projected` call commits a block into the shared per-space Loro
/// engine — a mid-batch shape rejection must not leave earlier specs applied
/// in the (non-transactional) engine while SQL + op_log roll back.
pub fn validate_create_block_shape(block_type: &str, content: &str) -> Result<(), AppError> {
    match block_type {
        "content" | "tag" | "page" => {}
        _ => {
            return Err(AppError::validation(format!(
                "unknown block_type '{block_type}': must be 'content', 'tag', or 'page'"
            )));
        }
    }
    if content.len() > MAX_CONTENT_LENGTH {
        return Err(AppError::validation(format!(
            "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
            content.len()
        )));
    }
    Ok(())
}

/// Create a new block inside an existing transaction.
///
/// This is the core implementation shared by `create_block_inner` (the app-crate `#[tauri::command]`) (which
/// wraps it in its own transaction) and the recurrence path in
/// `set_todo_state_inner` (which batches multiple operations in one tx).
///
/// Returns the new [`BlockRow`] and the [`op_log::OpRecord`] so the caller
/// can commit the transaction and dispatch background work afterward.
///
/// # Position contract (#383)
///
/// `position` is **NOT unique** among siblings. The canonical sibling
/// ordering is `(position ASC, id ASC)` — `id` (a monotonically increasing
/// ULID) breaks ties when two siblings share a `position`. When `position`
/// is `None`, the next position is computed as `MAX(position) + 1` over the
/// live siblings (excluding rows carrying `NULL_POSITION_SENTINEL`). When an
/// explicit `position` is supplied this function writes it verbatim and
/// performs **no in-transaction shift / renumber** of the existing
/// siblings; a caller that needs collision-free positions must renumber the
/// siblings itself.
// #2849 PR2 added the trailing `client_id` slot (8 args, one over the clippy
// threshold of 7). Bundling the create-block core's positional args into a
// struct would touch ~12 call sites for zero behavioural gain; the tx-scoped
// writer signature is intentionally flat.
#[allow(clippy::too_many_arguments)]
pub async fn create_block_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    // #400: 0-based sibling slot among `parent_id`'s children; `None` appends
    // after the last sibling. (Was a legacy 1-based `position`.)
    index: Option<i64>,
    // #2849 PR2: an OPTIONAL client-supplied block id. `Some(id)` is used
    // verbatim iff it is a well-formed ULID that does not collide with an
    // existing block (else a hard error — never a silent fallback, which would
    // defeat the stable-id optimistic-create UX). `None` (every non-optimistic
    // caller) generates a fresh server id, preserving all existing behaviour.
    client_id: Option<BlockId>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // 1 + 1c. Validate block_type and content length (pure checks, shared
    // with `create_blocks_batch_inner`'s pre-validation pass).
    validate_create_block_shape(&block_type, &content)?;

    // 1b. #400: `index` is a 0-based slot; slot 0 ("first child") is valid. The
    // old positive-1-based-position validation is gone. A stray negative clamps.
    // (#383's NULL_POSITION_SENTINEL rejection is obsolete here: `index` is a
    // sibling slot, not a verbatim position — the engine derives the dense
    // position via reprojection, so a caller can no longer target the sentinel.)
    let index = index.map(|i| i.max(0));

    // 2. Resolve the new BlockId. #2849 PR2: an optimistic-create caller supplies
    //    a client-generated ULID so the frontend can splice the row in BEFORE this
    //    IPC resolves and never has to relocate focus/selection to a server id.
    //    Accept it verbatim ONLY when it is a well-formed ULID that does not
    //    collide with any existing row; otherwise error (a silent swap would hide
    //    bugs and break the stable-id contract). `None` keeps the legacy
    //    server-generated id (every non-optimistic caller).
    let block_id = match client_id {
        Some(id) => {
            // The IPC `BlockId` Deserialize is lenient (it uppercases a non-ULID
            // string instead of erroring — it must, so synthetic test ids survive),
            // so re-validate here through the strict `from_string` parse: a
            // malformed client id becomes `AppError::Ulid` rather than a phantom
            // insert. This also canonicalises to uppercase Crockford base32.
            let id = BlockId::from_string(id.into_string())?;
            // Collision check against ALL rows (live OR tombstoned): `blocks.id`
            // is the primary key, so a soft-deleted row carrying this id would
            // still fail the INSERT below. Reject up-front with a clear Conflict.
            let id_str = id.as_str();
            let existing = sqlx::query!(r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ?"#, id_str)
                .fetch_optional(&mut **tx)
                .await?;
            if existing.is_some() {
                return Err(AppError::Conflict(format!(
                    "block id '{id_str}' already exists"
                )));
            }
            id
        }
        None => BlockId::new(),
    };

    // F01: Validate parent_id inside the transaction to prevent TOCTOU race.
    // A concurrent purge_block could physically delete the parent between
    // our check and the INSERT, violating the FK constraint.
    if let Some(ref pid) = parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }

        // Enforce `MAX_BLOCK_DEPTH` on the create path. The new block
        // will live at depth = parent_depth + 1, so reject when that exceeds
        // the documented limit (docs/architecture/data-and-events.md § Everything is a block). Without this guard
        // a user could repeatedly create blocks under the deepest leaf and
        // drift past the bound — `move_block_inner` already enforces the
        // same limit; the asymmetry was the loophole.
        //
        // The shared `ancestors_cte_standard!()` macro pins invariant #9
        // (`a.depth < 100` recursion bound). Same shape as the cycle-
        // detection CTE in `move_block_inner` (move_ops.rs).
        // The seed (`pid`, depth 0) plus N ancestors yields MAX(depth) = N,
        // i.e. the parent's depth from the root — identical semantics to
        // the previous inline `path` CTE.
        // dynamic-sql: concat! of the ancestors CTE macro expansion — query! needs a string literal.
        let parent_depth = sqlx::query_scalar::<_, i64>(concat!(
            agaric_store::ancestors_cte_standard!(),
            "SELECT MAX(depth) FROM ancestors",
        ))
        .bind(pid)
        .fetch_one(&mut **tx)
        .await?;

        if parent_depth + 1 > MAX_BLOCK_DEPTH {
            return Err(AppError::validation(format!(
                "maximum nesting depth of {MAX_BLOCK_DEPTH} exceeded"
            )));
        }
    }

    // 2b. Referential cross-space integrity — validated BEFORE the engine
    // apply below. `apply_op_projected` COMMITS the block into the shared
    // per-space LoroDoc, and the engine has no rollback: running this
    // fallible check after it (the old post-INSERT ordering) left a phantom
    // committed node in the CRDT on rejection — op_log + SQL rolled back
    // while the block kept exporting over sync. A non-page block's space is
    // fully determined by its parent (the SAME resolution anchor
    // `apply_create_block_via_loro` uses), so resolve the parent's space and
    // scan the content against it pre-insert. A parentless create — or a
    // page, which resolves its space via itself (`page_id = id`), not its
    // parent — has no resolvable space at this point and is skipped, exactly
    // matching the post-INSERT `resolve_block_space(new_block)` outcome this
    // ordering replaces (orphans are tolerated by the validator's contract).
    if block_type != "page"
        && let Some(ref pid) = parent_id
        && let Some(source_space) =
            agaric_store::space::resolve_block_space(&mut **tx, &BlockId::from_trusted(pid)).await?
    {
        agaric_store::cross_space_validation::validate_content_refs_in_space(
            tx,
            &block_id,
            &source_space,
            &content,
        )
        .await?;
    }

    // 3b. Build CreateBlockPayload (#400: carries the 0-based `index`; `None`
    // index ⇒ a bare append, which the engine resolves to the end of the
    // sibling list). The engine derives the authoritative DENSE 1-based
    // `position` from the fractional sibling order, so this payload no longer
    // carries a provisional SQL position.
    let parent_block_id = parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    let create_payload = CreateBlockPayload {
        block_id: block_id.clone(),
        block_type: block_type.clone(),
        parent_id: parent_block_id,
        position: None,
        index,
        content: content.clone(),
    };

    let op_record = op_log::append_local_op_in_tx(
        tx,
        device_id,
        OpPayload::CreateBlock(create_payload.clone()),
        agaric_store::db::now_ms(),
    )
    .await?;

    // #2344/#2325 route the just-appended `op_record` through the SINGLE
    // collapsed apply-projection entry point (`apply_op_projected`), IN this
    // transaction, INSTEAD of the direct `apply_create_block_via_loro` call —
    // the CreateBlock arm of the #2325 apply-path collapse. This is the SAME
    // engine-apply + SQL projection the boot-replay / sync `ApplyOp` path uses
    // (via `apply_op_tx`), so the LOCAL and REMOTE create paths now share one
    // entry point. `apply_op_projected` re-derives the `CreateBlockPayload` from
    // `op_record.payload` and runs the SAME `apply_create_block_via_loro`
    // (resolve space → per-space Loro engine apply → `project_create_block_to_sql`
    // INSERT of the engine's dense rank → `reproject_dense_positions` +
    // `inherit_parent_tags`), PLUS the in-tx maintenance the Create arm of
    // `apply_op_tx` runs via `maintain_pages_cache_counts_after_op`: the #2349
    // non-page `page_id`/`space_id` stamp AND the owning-page `pages_cache`
    // count recompute + `reindex_block_links`. Those two used to be duplicated
    // inline on this LOCAL path (the old (a) re-stamp UPDATE and (d) count
    // recompute) and are now REMOVED as redundant — #2349 proved LOCAL and
    // REMOTE create commit identical state (the `..._identical_rows_2250` pin
    // now compares page_id/space_id too). We pass `advance_cursor = false`: the
    // apply cursor (`materialized_through_seq`) stays put on the LOCAL path so
    // boot replay re-applies idempotently (#1248 / #1257). If the block's space
    // can't be resolved (#2250: `SpaceUnresolved` — e.g. a brand-new top-level
    // page before its `SetProperty(space)`), the helper internally FALLS BACK
    // to the SQL-only projection, so the row is never skipped and we never
    // crash. `apply_op_tx` does NOT run the LOCAL-only bare-append sentinel
    // fixup or the cross-space ref validation, so both stay below.
    // `apply_op_projected` borrows `&op_record` here (it is returned to the
    // caller unmoved, for commit + dispatch). Create runs no post-commit cohort
    // fan-out, so the returned `ApplyEffects` is empty and discarded.
    // #2200: the LOCAL create path is a "chunk of one" — `apply_op_projected`
    // passes `None` so the dense-position reprojection + count recompute run
    // inline here, exactly as before (deferral is a batch-import-only
    // optimisation).
    crate::apply::kernel::apply_op_projected(&mut *tx, &op_record, state, false).await?;

    // #2344: the `page_id`/`space_id` in-tx re-stamp that used to live here (old
    // step (a)) is now performed by the routed `apply_op_projected` maintenance
    // step — the #2349 `PreOpState::Create` arm of
    // `maintain_pages_cache_counts_after_op` runs the IDENTICAL
    // `UPDATE blocks SET page_id = ?, space_id = (SELECT space_id ...)` for
    // non-page blocks, shared with the REMOTE `ApplyOp` path. The redundant
    // LOCAL copy is gone; `block_id_str` is retained for the fixups below.
    let block_id_str = block_id.as_str();

    // #1257 ENGINE-ABSENT bare-append position parity. When the engine
    // path engages, `reproject_dense_positions` gives every sibling a concrete
    // dense 1-based rank (never the sentinel). But when the create falls back to
    // the SQL-only path (space unresolved, #2250) AND it's a
    // bare append (`index: None`, `position: None` — the payload this command
    // path always builds), `apply_create_block_sql_only` writes the append
    // sentinel `i64::MAX` (its documented both-`None` corner). The pre-PR-2
    // command path instead computed a concrete `MAX(position)+1` rank inline for
    // that case, and existing tests pin `1, 2, 3` for successive bare appends.
    // Restore that concrete rank here, scoped to exactly the fallback-append
    // case (position == sentinel), so the engine-absent fallback is observably
    // identical to before. A no-op when the engine ran (dense rank ≠ sentinel)
    // or when an explicit `index` was given (the fallback used the provisional
    // `index+1`, never the sentinel). We do NOT touch the op-log payload
    // (`position: None`) — only the projected SQL column — so sync/replay
    // semantics are unchanged.
    if index.is_none() {
        let next_pos = sqlx::query_scalar!(
            "SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM blocks \
             WHERE parent_id IS ? AND deleted_at IS NULL \
               AND position < 9223372036854775807 AND id <> ?",
            parent_id,
            block_id_str,
        )
        .fetch_one(&mut **tx)
        .await?;
        sqlx::query!(
            "UPDATE blocks SET position = ? \
             WHERE id = ? AND position = 9223372036854775807",
            next_pos,
            block_id_str,
        )
        .execute(&mut **tx)
        .await?;
    }

    // Referential cross-space integrity moved to step 2b ABOVE: it must run
    // BEFORE `apply_op_projected` commits the block into the LoroDoc, so a
    // rejected create leaves no phantom engine node behind. The space is
    // resolved from the parent pre-insert (identical outcome to the old
    // post-INSERT self-resolution).

    // #2344: the owning-page `pages_cache` count recompute that used to run here
    // (old step (d)) is now performed by the routed `apply_op_projected`
    // maintenance step — the `recompute_pages_cache_counts_for_pages` at the
    // tail of `maintain_pages_cache_counts_after_op` (chunk = None → inline),
    // shared with the REMOTE `ApplyOp` path. The redundant LOCAL copy is gone.

    // #1257/#2344 the engine projected the authoritative DENSE position and the
    // routed maintenance step stamped the owning `page_id`; read BOTH back so
    // the returned `BlockRow` reflects the persisted, committed values rather
    // than a locally-recomputed guess. (The engine-absent fallback wrote the
    // provisional rank here instead — either way this is the committed row.)
    let projected = sqlx::query!(
        r#"SELECT position as "position: i64", page_id as "page_id: agaric_core::ulid::BlockId" FROM blocks WHERE id = ?"#,
        block_id_str,
    )
    .fetch_one(&mut **tx)
    .await?;
    let position = projected.position;
    let page_id = projected.page_id;

    // Return block + op record; caller is responsible for commit + dispatch.
    Ok((
        BlockRow {
            id: block_id,
            block_type,
            content: Some(content),
            parent_id: parent_id.map(|s| BlockId::from_trusted(&s)),
            position,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id,
        },
        op_record,
    ))
}

/// Snapshot of a `property_definitions` row's validation-relevant fields.
///
/// Pre-fetched by the caller of [`set_property_in_tx`] and
/// passed to [`validate_property_value`] so the helper stays sync and
/// trivially unit-testable. The full `PropertyDefinition` struct carries
/// `key` and `created_at` fields that the validation logic does not need;
/// this slimmer view keeps the helper signature minimal.
///
/// `Clone` (#2201): the move-to-space batch fetches the `space` declaration
/// ONCE and feeds a clone to each per-block
/// [`set_property_in_tx_with_declaration`] call, hoisting the per-iteration
/// `property_definitions` SELECT out of the loop.
#[derive(Clone)]
pub struct PropertyDeclaration {
    pub value_type: String,
    pub options: Option<String>,
}

/// Validate a [`SetPropertyPayload`] against the reserved-key shape rules
/// and (optionally) against a pre-fetched `property_definitions` row.
///
/// Structural extraction from [`set_property_in_tx`]. This
/// function has no side effects — it never touches the DB and only reads
/// from its inputs — so unit tests can exercise the full validation matrix
/// without spinning up a pool.
///
/// Performs (in order):
///   1. [`validate_set_property`] — key format (alphanumeric + `-_`,
///      1–64 chars), exactly-one non-null value field (or all-null for
///      reserved keys), finite numbers, non-empty string fields.
///   2. ISO-8601 (`YYYY-MM-DD`) format check on `value_date` if present.
///   3. Reserved-key field-shape check: `due_date`/`scheduled_date`
///      require `value_date`; `todo_state`/`priority` require `value_text`.
///      All-null payloads are treated as "clear" and skip the rest of the
///      checks.
///   4. Declared-type vs. payload-shape check (only for non-reserved
///      keys — reserved-key shape is fixed by step 3 and the columns on
///      `blocks` already constrain the type).
/// 5. select-options-membership: when the definition declares
///    `value_type = "select"` with a non-NULL `options` JSON array, the
///    supplied `value_text` must be one of the listed options.
///
/// `declaration` is `None` when no `property_definitions` row exists for
/// the key — type/options checks are skipped (custom keys without a
/// declaration are permissive).
fn validate_property_value(
    payload: &SetPropertyPayload,
    declaration: Option<&PropertyDeclaration>,
) -> Result<(), AppError> {
    // 1. Key format + exactly-one-value invariants.
    validate_set_property(payload)?;

    // 2. ISO-date format check on `value_date`.
    if let Some(ref date_str) = payload.value_date
        && !is_valid_iso_date(date_str)
    {
        return Err(AppError::validation(format!(
            "Invalid date format: '{date_str}'. Expected YYYY-MM-DD."
        )));
    }

    // "Clear" calls (all-null) are only valid for reserved keys —
    // `validate_set_property` already enforced that — and they skip the
    // shape/type/options checks below: the column-clear is performed by
    // the caller's dual-write step.
    let is_clear = payload.value_text.is_none()
        && payload.value_num.is_none()
        && payload.value_date.is_none()
        && payload.value_ref.is_none()
        && payload.value_bool.is_none();
    if is_clear {
        return Ok(());
    }

    // 3. Reserved-key field-shape: route the right typed field to the
    //    right native column on `blocks`.
    match payload.key.as_str() {
        "due_date" | "scheduled_date" if payload.value_date.is_none() => {
            return Err(AppError::validation(format!(
                "Property '{}' requires value_date, not value_text/value_num/value_ref/value_bool.",
                payload.key
            )));
        }
        "todo_state" | "priority" if payload.value_text.is_none() => {
            return Err(AppError::validation(format!(
                "Property '{}' requires value_text, not value_date/value_num/value_ref/value_bool.",
                payload.key
            )));
        }
        _ => {}
    }

    // 4 + 5. Declared-type and select-options checks against
    //        `property_definitions` (caller pre-fetched).
    if let Some(decl) = declaration {
        let expected_type = decl.value_type.as_str();
        let options_json = decl.options.as_ref();

        // Type validation — only for non-reserved keys. Reserved-key
        // field-shape is enforced by step 3 above.
        if !is_reserved_property_key(&payload.key) {
            let type_matches = match expected_type {
                "text" | "select" => payload.value_text.is_some() || payload.value_ref.is_some(),
                "ref" => payload.value_ref.is_some(),
                "number" => payload.value_num.is_some(),
                "date" => payload.value_date.is_some(),
                "boolean" => payload.value_bool.is_some(),
                _ => true,
            };
            if !type_matches {
                let actual_type = if payload.value_text.is_some() {
                    "text"
                } else if payload.value_num.is_some() {
                    "number"
                } else if payload.value_date.is_some() {
                    "date"
                } else if payload.value_ref.is_some() {
                    "ref"
                } else if payload.value_bool.is_some() {
                    "boolean"
                } else {
                    "unknown"
                };
                return Err(AppError::validation(format!(
                    "Property '{}' expects type '{}', got '{}'.",
                    payload.key, expected_type, actual_type
                )));
            }
        }

        // Options membership validation for select-type
        // properties. When the definition declares a non-NULL options
        // array, the supplied value_text must be one of the listed
        // options. A NULL options column means "no restriction" — a
        // select-type definition without options is treated permissively
        // so custom keys stay flexible.
        if expected_type == "select"
            && let Some(opts_json) = options_json
            && let Some(ref actual) = payload.value_text
        {
            let allowed: Vec<String> = serde_json::from_str(opts_json).map_err(|e| {
                AppError::validation(format!(
                    "Property '{}' has malformed options JSON: {e}",
                    payload.key
                ))
            })?;
            if !allowed.iter().any(|a| a == actual) {
                return Err(AppError::validation(format!(
                    "Property '{}' value '{actual}' is not in allowed options: {}",
                    payload.key,
                    allowed.join(", ")
                )));
            }
        }
    }

    Ok(())
}

/// Set (upsert) a property on a block inside an existing transaction.
///
/// This is the core implementation shared by `set_property_inner` (the app-crate `#[tauri::command]`) (which
/// wraps it in its own transaction) and the recurrence path in
/// `set_todo_state_inner` (which batches multiple operations in one tx).
///
/// Returns the updated [`BlockRow`] and the [`op_log::OpRecord`] so the
/// caller can commit the transaction and dispatch background work afterward.
#[allow(clippy::too_many_arguments)]
pub async fn set_property_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    block_id: String,
    key: &str,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<bool>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // Thin wrapper (#1921): fetch the key's `property_definitions` row (the
    // current behaviour) and delegate. A "clear" (all-null) write needs no
    // declaration, so the lookup is skipped exactly as before. Callers that
    // ALREADY hold the declaration (e.g. the batched import frontmatter path)
    // call [`set_property_in_tx_with_declaration`] directly to avoid the
    // per-key round-trip.
    let is_clear = value_text.is_none()
        && value_num.is_none()
        && value_date.is_none()
        && value_ref.is_none()
        && value_bool.is_none();
    let declaration = if is_clear {
        None
    } else {
        sqlx::query!(
            "SELECT value_type, options FROM property_definitions WHERE key = ?",
            key,
        )
        .fetch_optional(&mut **tx)
        .await?
        .map(|row| PropertyDeclaration {
            value_type: row.value_type,
            options: row.options,
        })
    };
    set_property_in_tx_with_declaration(
        tx,
        state,
        device_id,
        block_id,
        key,
        value_text,
        value_num,
        value_date,
        value_ref,
        value_bool,
        declaration,
    )
    .await
}

/// Core of [`set_property_in_tx`] with the `property_definitions` declaration
/// supplied by the caller (#1921).
///
/// Extracted so a caller that has ALREADY fetched the declaration — e.g. the
/// import frontmatter loop, which batches every key's `(value_type, options)`
/// in one `json_each` query — can skip the per-key `SELECT … WHERE key = ?`
/// round-trip [`set_property_in_tx`] otherwise issues. Behaviour is identical:
/// the wrapper fetches the row and delegates here, so all existing callers are
/// unaffected. `declaration` MUST be `None` for an all-null ("clear") write
/// (matching the wrapper's `is_clear` skip) and otherwise the row for `key`
/// (or `None` when `key` is undeclared — a permissive custom key).
#[allow(clippy::too_many_arguments)]
pub async fn set_property_in_tx_with_declaration(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    block_id: String,
    key: &str,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<bool>,
    declaration: Option<PropertyDeclaration>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // 1. Build and validate the payload before touching the DB.
    // Validation logic lives in `validate_property_value`
    //    above. The `property_definitions` row is supplied by the caller so the
    //    helper stays sync and unit-testable.
    let prop_payload = SetPropertyPayload {
        block_id: BlockId::from_trusted(&block_id),
        key: key.to_owned(),
        value_text: value_text.clone(),
        value_num,
        value_date: value_date.clone(),
        value_ref: value_ref.clone().map(BlockId::from),
        value_bool,
    };
    validate_property_value(&prop_payload, declaration.as_ref())?;

    // 2. Validate block exists and is not deleted (TOCTOU-safe inside tx).
    //    #1627: this single in-tx read is also the authoritative
    //    activeness gate now that the redundant pre-tx `verify_active`
    //    round-trip on the pool has been dropped from the command
    //    wrappers. The `deleted_at IS NULL` filter is removed from the
    //    WHERE clause so the fetched `deleted_at` lets us reproduce
    //    `verify_active`'s EXACT discrimination (distinct NotFound vs
    //    soft-deleted errors) from this one query.
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: agaric_core::ulid::BlockId", block_type, content, parent_id as "parent_id: agaric_core::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: agaric_core::ulid::BlockId" FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let existing =
        existing.ok_or_else(|| AppError::NotFound(format!("block '{block_id}' does not exist")))?;
    if existing.deleted_at.is_some() {
        return Err(AppError::validation(format!(
            "block '{block_id}' has been soft-deleted"
        )));
    }

    // Referential cross-space integrity (Phase 2):
    // reject a ref-type property whose target lives in a different space
    // than the source block. No-op when `value_ref` is None (clear) and
    // exempts the reserved `space` key (how blocks move between spaces).
    agaric_store::cross_space_validation::validate_ref_property_cross_space(
        tx,
        &BlockId::from_trusted(&block_id),
        value_ref.as_deref(),
        key,
    )
    .await?;

    // 3. Append SetProperty op to the op_log
    let payload = OpPayload::SetProperty(prop_payload.clone());
    let op_record =
        op_log::append_local_op_in_tx(tx, device_id, payload, agaric_store::db::now_ms()).await?;

    // 3b. #533/#612/#708: `space` key registration backstop. The
    // `project_set_property_to_sql` projection only LOGS+SKIPS an unregistered
    // space target (the sync/replay degrade contract), but the LOCAL command
    // boundary must reject it loudly (the generic `set_property` IPC/MCP path
    // reaches this unvalidated). Keep this TOCTOU-safe Validation check on the
    // LOCAL path BEFORE the engine helper runs, preserving the pre-#1257
    // behaviour. (The helper's projection then performs the identical
    // `UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?` fan-out.)
    if key == SPACE_PROPERTY_KEY {
        // R17: only the authoritative `space_id` holders may carry the
        // reserved `space` key — page blocks and top-level tag blocks (the
        // documented membership model; see `move_blocks_to_space_inner`'s
        // doc comment and `cache::page_id::rebuild_space_ids`). Stamping a
        // CONTENT block into a foreign space mis-scopes every space-filtered
        // read and mis-routes all later per-space engine applies for the
        // block (reachable via the generic `set_property` IPC/MCP path), so
        // reject loudly at the LOCAL command boundary. The tag
        // adoption/migration paths append their `SetProperty(space)` ops
        // directly (`add_tag` orphan adoption, `migrate_orphan_tags_to_space`)
        // and are unaffected.
        let is_space_holder = existing.block_type == "page"
            || (existing.block_type == "tag" && existing.parent_id.is_none());
        if !is_space_holder {
            return Err(AppError::validation(format!(
                "property 'space' can only be set on a page or top-level tag block; \
                 block '{block_id}' is a '{}' block",
                existing.block_type
            )));
        }
        let Some(target) = value_ref.as_deref() else {
            return Err(AppError::validation(
                "property 'space' requires a value_ref pointing at a space block".into(),
            ));
        };
        let space_ok = sqlx::query_scalar!(
            r#"SELECT 1 AS "ok: i32" FROM spaces s
               JOIN blocks b ON b.id = s.id
               WHERE s.id = ? AND b.deleted_at IS NULL"#,
            target,
        )
        .fetch_optional(&mut **tx)
        .await?;
        if space_ok.is_none() {
            return Err(AppError::validation(format!(
                "space_id '{target}' does not refer to a live, registered space block"
            )));
        }
    }

    // 4. #1257 route the property write through the SAME engine-apply +
    // projection the boot-replay / sync `ApplyOp` path uses, IN this CommandTx,
    // INSTEAD of the inline reserved-column / `space` fan-out / `block_properties`
    // INSERT branches. `apply_set_property_via_loro` resolves the block's space,
    // applies the typed value to the per-space Loro engine (sync guard, dropped
    // before any `.await`), then `project_set_property_to_sql` runs the IDENTICAL
    // per-key SQL (reserved → `blocks` column UPDATE; `space` → the
    // `space_id` page-group fan-out; non-reserved → `INSERT OR REPLACE INTO
    // block_properties`). We do NOT call `apply_op_tx` / `advance_apply_cursor`:
    // the apply cursor stays put on the LOCAL path so boot replay re-applies
    // idempotently (the safety net while local engine-apply hardens — #1257). If
    // the block's space can't be resolved (#2250: `SpaceUnresolved`,
    // the only remaining sql_only trigger), the helper internally FALLS BACK
    // to `apply_set_property_sql_only`, which runs the SAME projection — so the
    // row is never skipped and we never crash. The up-front `space`-registration
    // Validation above is preserved regardless.
    // #2325/#2250: route through the collapsed single-entry-point projection
    // (`advance_cursor = false`, #1257). It re-derives the `SetPropertyPayload`
    // from `op_record.payload` and runs the SAME `apply_set_property_via_loro`
    // (SetProperty is `PreOpState::None`, so `apply_op_tx`'s count maintenance
    // is a no-op and the returned `ApplyEffects` is empty).
    crate::apply::kernel::apply_op_projected(&mut *tx, &op_record, state, false).await?;

    // Return block + op record; caller is responsible for commit + dispatch.
    Ok((
        BlockRow {
            id: existing.id,
            block_type: existing.block_type,
            content: existing.content,
            parent_id: existing.parent_id,
            position: existing.position,
            deleted_at: existing.deleted_at,
            todo_state: if key == "todo_state" {
                value_text.clone()
            } else {
                existing.todo_state
            },
            priority: if key == "priority" {
                value_text.clone()
            } else {
                existing.priority
            },
            due_date: if key == "due_date" {
                value_date.clone()
            } else {
                existing.due_date
            },
            scheduled_date: if key == "scheduled_date" {
                value_date.clone()
            } else {
                existing.scheduled_date
            },
            page_id: existing.page_id,
        },
        op_record,
    ))
}

/// Physically delete every `blocks` row in a purge subtree (#2895 slice 1).
///
/// The final `DELETE FROM blocks` of the app's subtree-purge chain, moved
/// behind the `blocks`-owning crate. `member_subquery` is the SQL that yields
/// the set of block ids being purged, and `cte_prefix` is the optional
/// `WITH RECURSIVE …` prefix that defines the relation it selects from. `bind`
/// is the single value bound to the `?` / `?1` placeholder in `cte_prefix` (a
/// seed block id, or a JSON id array for the multi-root variant); pass `None`
/// for the "all soft-deleted" variant, whose member set carries no
/// placeholder. Returns the number of `blocks` rows deleted.
///
/// Operates on a borrowed `&mut SqliteConnection` (never a pool): it opens no
/// transaction of its own and runs inside the caller's IMMEDIATE tx, preserving
/// the #110 raw-write-tx convention. Deferred FK checks (PRAGMA set by the
/// caller) let this single DELETE sweep the whole subtree.
pub async fn delete_blocks_in_subtree(
    conn: &mut sqlx::SqliteConnection,
    cte_prefix: &str,
    member_subquery: &str,
    bind: Option<&str>,
) -> Result<u64, AppError> {
    // dynamic-sql: #664/#2895 — the purge chain is emitted against three
    // runtime membership shapes (single-root recursive CTE / multi-root
    // json_each CTE / flat deleted-set); the macro form cannot take a runtime
    // query string.
    // dynamic-sql: runtime membership shapes (see above).
    let mut q = sqlx::query(sqlx::AssertSqlSafe(format!(
        "{cte_prefix}DELETE FROM blocks \
         WHERE id IN ({member_subquery})"
    )));
    if let Some(b) = bind {
        q = q.bind(b.to_string());
    }
    Ok(q.execute(conn).await?.rows_affected())
}

/// Wholesale-wipe the `blocks` table (RESET path, #2895 slice 4).
///
/// Runs a single `DELETE FROM blocks` on the caller's connection/transaction.
/// Extracted from `agaric-sync`'s snapshot RESET so the raw write to `blocks`
/// (owned by `agaric-engine`, the authoritative Loro→SQLite projection writer)
/// lives in the owner crate rather than open-coded cross-crate.
///
/// `blocks` is the parent of nearly every FK in the schema, so the RESET wipes
/// it LAST; FK ordering is moot there because the caller sets
/// `PRAGMA defer_foreign_keys = ON` for the whole tx. Opens NO transaction —
/// the caller controls the transaction boundary.
///
/// # Errors
/// Returns [`AppError`] if the DELETE fails.
pub async fn truncate_all_blocks(conn: &mut sqlx::SqliteConnection) -> Result<(), AppError> {
    sqlx::query!("DELETE FROM blocks")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// NULL out `blocks.space_id` values that point at a block absent from the
/// `spaces` registry (RESET-path FK repair, #2895 slice 4).
///
/// Reproduces the snapshot-RESET repair (#708) verbatim: a snapshot from an
/// older build — or one carrying a historically mis-stamped membership (the
/// #612 class) — can hold `blocks.space_id` values pointing at a block with no
/// `is_space` flag; under the 0089 FK (`space_id REFERENCES spaces(id)`,
/// checked at COMMIT under `defer_foreign_keys = ON`) those rows would abort
/// the whole restore. NULLing them lets the every-boot `pages_without_space`
/// backfill reassign the affected pages to Personal.
///
/// Runs the byte-identical predicate on the caller's connection/transaction and
/// returns the number of rows affected so the caller can log/warn. Opens NO
/// transaction.
///
/// # Errors
/// Returns [`AppError`] if the UPDATE fails.
pub async fn null_orphan_space_ids(conn: &mut sqlx::SqliteConnection) -> Result<u64, AppError> {
    let res = sqlx::query!(
        "UPDATE blocks SET space_id = NULL \
         WHERE space_id IS NOT NULL \
           AND space_id NOT IN (SELECT id FROM spaces)"
    )
    .execute(&mut *conn)
    .await?;
    Ok(res.rows_affected())
}

// ===========================================================================
// #2895 slice 2 — narrow `blocks` write primitives migrated from the app
// crate's non-recovery command paths (blocks CRUD, history/undo, soft-delete,
// draft recovery). Each reproduces its former app-crate statement
// BYTE-FOR-BYTE (same SQL text, same predicates, same bind order) so moving a
// call site behind the `blocks`-owning crate cannot alter the effective SQL.
// All operate on a borrowed `&mut SqliteConnection` (never a pool): they open
// no transaction and run inside the caller's IMMEDIATE tx, preserving the #110
// raw-write-tx convention.
// ===========================================================================

/// Which `deleted_at` transition to apply across a JSON id-array cohort.
///
/// The three variants preserve the three distinct predicates the former
/// app-crate cohort UPDATEs used, all sharing one `json_each(?1)` membership
/// shape.
pub enum CohortDeletedAt {
    /// Soft-delete: stamp `deleted_at = <ts>` on LIVE (`deleted_at IS NULL`)
    /// cohort members. Idempotent under re-run.
    Stamp(i64),
    /// Restore a specific delete cohort: clear `deleted_at` on members whose
    /// `deleted_at` still equals the originating delete's `<ref>` timestamp.
    ClearWhereRef(i64),
    /// Bulk restore: clear `deleted_at` on ANY tombstoned
    /// (`deleted_at IS NOT NULL`) cohort member.
    ClearAll,
}

/// Apply a `deleted_at` transition across the cohort whose ids are the values
/// of the bound JSON array `ids_json` (`SELECT value FROM json_each(?1)`).
/// Returns the number of `blocks` rows updated.
///
/// Migrated call sites: bulk delete / restore cohort UPDATEs in
/// `commands::blocks::crud` and the undo/revert cascade UPDATEs in
/// `commands::history`.
pub async fn write_cohort_deleted_at_json(
    conn: &mut sqlx::SqliteConnection,
    ids_json: &str,
    op: CohortDeletedAt,
) -> Result<u64, AppError> {
    // dynamic-sql: one static per-variant literal selected by match (no user
    // input interpolated); each is byte-identical to the former app-crate
    // cohort UPDATE. Runtime form because the three predicates share one
    // json_each membership shape.
    let sql: &str = match op {
        CohortDeletedAt::Stamp(_) => {
            "UPDATE blocks SET deleted_at = ?2 \
             WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL"
        }
        CohortDeletedAt::ClearWhereRef(_) => {
            "UPDATE blocks SET deleted_at = NULL \
             WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at = ?2"
        }
        CohortDeletedAt::ClearAll => {
            "UPDATE blocks SET deleted_at = NULL \
             WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NOT NULL"
        }
    };
    // dynamic-sql: per-variant static literal selected at runtime (see match above).
    let mut q = sqlx::query(sql).bind(ids_json);
    match op {
        CohortDeletedAt::Stamp(ts) | CohortDeletedAt::ClearWhereRef(ts) => q = q.bind(ts),
        CohortDeletedAt::ClearAll => {}
    }
    Ok(q.execute(conn).await?.rows_affected())
}

/// Clear `deleted_at` on EVERY tombstoned row (bulk "restore all"). Returns
/// the number of rows restored. (`crud::restore_all_deleted`.)
pub async fn clear_all_deleted_at(conn: &mut sqlx::SqliteConnection) -> Result<u64, AppError> {
    // dynamic-sql: byte-identical to the former app-crate literal.
    Ok(
        // dynamic-sql: byte-identical moved app-crate literal (see fn doc).
        sqlx::query("UPDATE blocks SET deleted_at = NULL WHERE deleted_at IS NOT NULL")
            .execute(conn)
            .await?
            .rows_affected(),
    )
}

/// Rebuild `page_id` for the whole table after a bulk restore: pages
/// self-reference, then a single recursive walk propagates each page's id
/// down to its non-page descendants. Byte-identical to the former two
/// app-crate statements (`crud::restore_all_deleted`, #346/P7). No
/// `deleted_at` filter is needed — nothing is deleted at this point.
pub async fn rebuild_all_page_ids(conn: &mut sqlx::SqliteConnection) -> Result<(), AppError> {
    // dynamic-sql: two byte-identical static literals.
    sqlx::query("UPDATE blocks SET page_id = id WHERE block_type = 'page'")
        .execute(&mut *conn)
        .await?;
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    // dynamic-sql: byte-identical moved app-crate literal (see fn doc).
    sqlx::query(
        "WITH RECURSIVE page_of(id, page_id, depth) AS ( \
             SELECT id, id, 0 FROM blocks WHERE block_type = 'page' \
             UNION ALL \
             SELECT b.id, p.page_id, p.depth + 1 \
             FROM blocks b \
             JOIN page_of p ON b.parent_id = p.id \
             WHERE b.block_type != 'page' AND p.depth < 100 \
         ) \
         UPDATE blocks SET page_id = ( \
             SELECT page_id FROM page_of WHERE page_of.id = blocks.id \
         ) \
         WHERE block_type != 'page' \
           AND EXISTS (SELECT 1 FROM page_of WHERE page_of.id = blocks.id)",
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Reparent a LIVE block to `new_parent_id` at `position` (undo of a move):
/// `UPDATE blocks SET parent_id = ?, position = ? WHERE id = ? AND
/// deleted_at IS NULL`. Returns rows affected (0 ⇒ not found / soft-deleted,
/// which the caller maps to `NotFound`). (`commands::history` move revert.)
pub async fn reparent_active_block(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    new_parent_id: Option<&str>,
    position: i64,
) -> Result<u64, AppError> {
    // dynamic-sql: byte-identical to the former app-crate literal.
    Ok(sqlx::query(
        "UPDATE blocks SET parent_id = ?, position = ? \
         WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(new_parent_id)
    .bind(position)
    .bind(block_id)
    .execute(conn)
    .await?
    .rows_affected())
}

/// Overwrite a LIVE block's content (undo of an edit):
/// `UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL`.
/// Returns rows affected (0 ⇒ not found / soft-deleted, mapped to `NotFound`
/// by the caller). (`commands::history` edit revert.)
pub async fn set_active_block_content(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    content: &str,
) -> Result<u64, AppError> {
    // dynamic-sql: byte-identical to the former app-crate literal.
    Ok(
        // dynamic-sql: byte-identical moved app-crate literal (see fn doc).
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
            .bind(content)
            .bind(block_id)
            .execute(conn)
            .await?
            .rows_affected(),
    )
}

/// Overwrite a block's content unconditionally (draft recovery re-applies the
/// unflushed draft text): `UPDATE blocks SET content = ? WHERE id = ?` — NO
/// `deleted_at` guard, matching the former app-crate statement exactly.
/// (`recovery::draft_recovery`.)
pub async fn set_block_content(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    content: &str,
) -> Result<u64, AppError> {
    // dynamic-sql: byte-identical to the former app-crate literal.
    Ok(sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
        .bind(content)
        .bind(block_id)
        .execute(conn)
        .await?
        .rows_affected())
}

/// Restore a single seed's connected same-cohort subtree (downward only): the
/// shared `descendants_cte_cohort!` walk + `UPDATE ... deleted_at = NULL WHERE
/// id IN (SELECT id FROM descendants) AND deleted_at = ?`. Byte-identical to
/// `soft_delete::restore`'s former statement (#1119). Binds: seed id, then the
/// cohort timestamp twice (recursive-arm filter + outer filter). Returns rows
/// affected.
pub async fn restore_cohort_subtree(
    conn: &mut sqlx::SqliteConnection,
    seed_block_id: &str,
    deleted_at_ref: i64,
) -> Result<u64, AppError> {
    // dynamic-sql: recursive cohort CTE built via concat! of the
    // descendants_cte_cohort! macro expansion (not a string literal, so the
    // query! macro is unusable); byte-identical to the former app-crate site.
    // dynamic-sql: concat! of descendants_cte_cohort! macro expansion — query! unusable.
    Ok(sqlx::query(concat!(
        agaric_store::descendants_cte_cohort!(),
        "UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
    ))
    .bind(seed_block_id)
    .bind(deleted_at_ref)
    .bind(deleted_at_ref)
    .execute(conn)
    .await?
    .rows_affected())
}

/// Cascade soft-delete a seed's LIVE descendant subtree, stamping
/// `deleted_at = <ts>` (`soft_delete::trash`). Byte-identical to the former
/// app-crate inline recursive-CTE UPDATE (kept as an explicit literal rather
/// than the `descendants_cte_active!` macro to preserve the original
/// whitespace exactly). Binds: seed id, then the delete timestamp. Returns
/// rows affected.
pub async fn cascade_soft_delete_subtree(
    conn: &mut sqlx::SqliteConnection,
    seed_block_id: &str,
    deleted_at: i64,
) -> Result<u64, AppError> {
    // byte-identical to the former app-crate literal.
    // dynamic-sql: inline recursive descendants CTE + UPDATE.
    Ok(sqlx::query(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ) \
         UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at IS NULL",
    )
    .bind(seed_block_id)
    .bind(deleted_at)
    .execute(conn)
    .await?
    .rows_affected())
}

// ===========================================================================
// Tests — `validate_property_value` matrix
// ===========================================================================
//
// Pin the pure-validation matrix extracted from
// `set_property_in_tx`. Each test exercises one (declared type ×
// payload shape) cell. The helper is sync and DB-free, so these tests
// don't need a pool.
#[cfg(test)]
mod validate_property_value_tests {
    use super::*;

    /// Synthetic ULID for the payload's `block_id` — content is irrelevant
    /// to validation, only the key + value fields are checked.
    const TEST_BID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    /// Build a payload with all-None value fields and the given key.
    /// Caller mutates the one field they want set.
    fn empty_payload(key: &str) -> SetPropertyPayload {
        SetPropertyPayload {
            block_id: BlockId::test_id(TEST_BID),
            key: key.to_string(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }
    }

    fn decl(value_type: &str, options: Option<&str>) -> PropertyDeclaration {
        PropertyDeclaration {
            value_type: value_type.to_string(),
            options: options.map(str::to_string),
        }
    }

    // --- text-typed declarations ------------------------------------------

    #[test]
    fn validate_property_value_text_with_text_payload_succeeds() {
        let mut p = empty_payload("note");
        p.value_text = Some("hello".into());
        let d = decl("text", None);
        validate_property_value(&p, Some(&d)).expect("text/text should pass");
    }

    #[test]
    fn validate_property_value_text_with_number_payload_rejects() {
        let mut p = empty_payload("note");
        p.value_num = Some(42.0);
        let d = decl("text", None);
        let err = validate_property_value(&p, Some(&d))
            .expect_err("text decl + number payload must reject");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("expects type 'text'") && msg.contains("got 'number'"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // --- number-typed declarations ----------------------------------------

    #[test]
    fn validate_property_value_number_with_number_payload_succeeds() {
        let mut p = empty_payload("effort");
        p.value_num = Some(3.5);
        let d = decl("number", None);
        validate_property_value(&p, Some(&d)).expect("number/number should pass");
    }

    #[test]
    fn validate_property_value_number_with_text_payload_rejects() {
        let mut p = empty_payload("effort");
        p.value_text = Some("three".into());
        let d = decl("number", None);
        let err = validate_property_value(&p, Some(&d))
            .expect_err("number decl + text payload must reject");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("expects type 'number'") && msg.contains("got 'text'"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // --- date-typed declarations ------------------------------------------

    #[test]
    fn validate_property_value_date_with_iso_date_succeeds() {
        let mut p = empty_payload("deadline");
        p.value_date = Some("2025-01-15".into());
        let d = decl("date", None);
        validate_property_value(&p, Some(&d)).expect("date/iso-date should pass");
    }

    #[test]
    fn validate_property_value_date_with_malformed_string_rejects() {
        let mut p = empty_payload("deadline");
        p.value_date = Some("not-a-date".into());
        let d = decl("date", None);
        let err =
            validate_property_value(&p, Some(&d)).expect_err("malformed value_date must reject");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("Invalid date format"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // --- ref-typed declarations -------------------------------------------

    #[test]
    fn validate_property_value_ref_with_ref_payload_succeeds() {
        let mut p = empty_payload("assignee");
        p.value_ref = Some("01HJK0000000000000000000AA".into());
        let d = decl("ref", None);
        validate_property_value(&p, Some(&d)).expect("ref/ref should pass");
    }

    #[test]
    fn validate_property_value_ref_with_text_payload_rejects() {
        let mut p = empty_payload("assignee");
        p.value_text = Some("alice".into());
        let d = decl("ref", None);
        let err =
            validate_property_value(&p, Some(&d)).expect_err("ref decl + text payload must reject");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("expects type 'ref'") && msg.contains("got 'text'"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // --- boolean-typed declarations ---------------------------------------

    #[test]
    fn validate_property_value_boolean_with_true_succeeds() {
        let mut p = empty_payload("starred");
        p.value_bool = Some(true);
        let d = decl("boolean", None);
        validate_property_value(&p, Some(&d)).expect("boolean/true should pass");
    }

    #[test]
    fn validate_property_value_boolean_with_text_payload_rejects() {
        let mut p = empty_payload("starred");
        p.value_text = Some("yes".into());
        let d = decl("boolean", None);
        let err = validate_property_value(&p, Some(&d))
            .expect_err("boolean decl + text payload must reject");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("expects type 'boolean'") && msg.contains("got 'text'"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // --- select-typed declarations (options membership) ------------

    #[test]
    fn validate_property_value_select_with_value_in_options_succeeds() {
        let mut p = empty_payload("status");
        p.value_text = Some("done".into());
        let d = decl("select", Some(r#"["todo","doing","done"]"#));
        validate_property_value(&p, Some(&d)).expect("select with allowed value should pass");
    }

    #[test]
    fn validate_property_value_select_with_value_not_in_options_rejects() {
        let mut p = empty_payload("status");
        p.value_text = Some("blocked".into());
        let d = decl("select", Some(r#"["todo","doing","done"]"#));
        let err = validate_property_value(&p, Some(&d))
            .expect_err("select rejects values not in options");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("not in allowed options"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // --- reserved-key field-shape checks (step 3) -------------------------
    //
    // Reserved keys (`todo_state`/`priority` ⇒ value_text;
    // `due_date`/`scheduled_date` ⇒ value_date) are validated independently
    // of any `property_definitions` row — pass `None` for the declaration.

    #[test]
    fn validate_property_value_reserved_due_date_with_text_payload_rejects() {
        let mut p = empty_payload("due_date");
        p.value_text = Some("2025-01-15".into());
        let err = validate_property_value(&p, None)
            .expect_err("due_date requires value_date, not value_text");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("requires value_date"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    #[test]
    fn validate_property_value_reserved_todo_state_with_date_payload_rejects() {
        let mut p = empty_payload("todo_state");
        p.value_date = Some("2025-01-15".into());
        let err = validate_property_value(&p, None)
            .expect_err("todo_state requires value_text, not value_date");
        match err {
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains("requires value_text"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    /// All-null payload on a reserved key is a "clear" — must succeed
    /// without a declaration. Pins the early-return at step 3 of
    /// [`validate_property_value`].
    #[test]
    fn validate_property_value_reserved_clear_succeeds() {
        let p = empty_payload("todo_state");
        validate_property_value(&p, None).expect("all-null reserved-key clear should pass");
    }
}
