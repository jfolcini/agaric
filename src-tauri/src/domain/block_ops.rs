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
//!   (only `AppError` + `chrono`), no DB / op_log / payload coupling.
//! - [`create_block_in_tx`] and [`set_property_in_tx`] (#882) — the
//!   tx-scoped create-block / set-property cores, moved verbatim from
//!   `commands::blocks::crud`. Despite the `…_in_tx` names they are the
//!   *command cores*: they build `OpPayload` / `CreateBlockPayload` /
//!   `SetPropertyPayload`, append to the `op_log`, run the local
//!   `validate_property_value` validator, and depend on
//!   `is_reserved_property_key`, the `ancestors_cte_standard!` macro and
//!   the `recompute_pages_cache_counts_for_pages` materializer path — all
//!   of which already live in neutral layers (`crate::op`, `crate::op_log`,
//!   `crate::materializer`, …), so this is a behavior-preserving move that
//!   removes the residual `recurrence → commands` and `spaces → commands`
//!   upward edges. `crate::commands` re-exports both so its ~20 internal
//!   callers (journal/pages/spaces/properties) are unchanged.

use crate::error::AppError;
use crate::op::{
    CreateBlockPayload, OpPayload, SPACE_PROPERTY_KEY, SetPropertyPayload,
    is_reserved_property_key, validate_set_property,
};
use crate::op_log;
use crate::pagination::BlockRow;
use crate::ulid::BlockId;

/// Maximum block-content size (bytes) enforced at the IPC layer
/// (`create_block_in_tx`, `edit_block_inner`, drafts). `pub(crate)` so
/// the MCP boundary (#699) reuses the same cap for `set_property`'s
/// `value_text` instead of inventing a second number.
pub(crate) const MAX_CONTENT_LENGTH: usize = 256 * 1024;

/// Maximum allowed nesting depth for the block tree.
/// Prevents pathological recursion and keeps recursive CTEs bounded.
pub(crate) const MAX_BLOCK_DEPTH: i64 = 20;

/// Validate that `s` parses as a calendar-valid `YYYY-MM-DD` date.
///
/// I-CommandsCRUD-6: previously did only structural validation (month
/// 01–12, day 01–31) and explicitly accepted impossible combinations
/// (Feb 30, Apr 31), relying on downstream callers to handle them. The
/// agenda path (`list_projected_agenda_inner`) re-parsed via
/// `NaiveDate::parse_from_str` and rejected with a different error
/// shape — inconsistent failure for the same input depending on which
/// command consumed it.
///
/// Now uses `NaiveDate::parse_from_str` directly so impossible dates
/// are rejected at the boundary with a single canonical error message.
/// The agenda re-parse becomes redundant and can be removed in a
/// follow-up; this change keeps the validator's return type stable so
/// existing callers don't need updating.
///
/// MAINT-163: chrono's `%Y-%m-%d` accepts non-zero-padded forms like
/// `2025-1-1` and 2-digit years like `25-1-1`. Pre-validate the strict
/// shape (`\d{4}-\d{2}-\d{2}`) before delegating calendar validity to
/// chrono — otherwise these slip through and downstream callers get
/// surprising "valid" dates that the canonical date format invariant
/// rejects.
pub(crate) fn validate_date_format(s: &str) -> Result<(), AppError> {
    let bytes = s.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !shape_ok {
        return Err(AppError::Validation(format!(
            "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
        )));
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| {
            AppError::Validation(format!(
                "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
            ))
        })
}

/// I-CommandsCRUD-8: previously a separate structural validator that
/// drifted from `validate_date_format`. Now delegates so there is one
/// source of truth for ISO-date validation across the commands surface.
pub(crate) fn is_valid_iso_date(s: &str) -> bool {
    validate_date_format(s).is_ok()
}

/// The `(value_text, value_num, value_date, value_ref, value_bool)` tuple
/// that positionally matches [`set_property_in_tx`]'s trailing args. Named
/// so [`typed_property_args_for_string_value`] stays under the
/// `clippy::type_complexity` threshold (CI runs `clippy -D warnings`).
pub(crate) type TypedPropertyArgs = (
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
pub(crate) fn typed_property_args_for_string_value(key: &str, value: String) -> TypedPropertyArgs {
    match key {
        "due_date" | "scheduled_date" => (None, None, Some(value), None, None),
        _ => (Some(value), None, None, None, None),
    }
}

/// Create a new block inside an existing transaction.
///
/// This is the core implementation shared by [`create_block_inner`](crate::commands::create_block_inner) (which
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
pub(crate) async fn create_block_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    // #400: 0-based sibling slot among `parent_id`'s children; `None` appends
    // after the last sibling. (Was a legacy 1-based `position`.)
    index: Option<i64>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // 1. Validate block_type
    match block_type.as_str() {
        "content" | "tag" | "page" => {}
        _ => {
            return Err(AppError::Validation(format!(
                "unknown block_type '{block_type}': must be 'content', 'tag', or 'page'"
            )));
        }
    }

    // 1b. #400: `index` is a 0-based slot; slot 0 ("first child") is valid. The
    // old positive-1-based-position validation is gone. A stray negative clamps.
    // (#383's NULL_POSITION_SENTINEL rejection is obsolete here: `index` is a
    // sibling slot, not a verbatim position — the engine derives the dense
    // position via reprojection, so a caller can no longer target the sentinel.)
    let index = index.map(|i| i.max(0));

    // 1c. Validate content length
    if content.len() > MAX_CONTENT_LENGTH {
        return Err(AppError::Validation(format!(
            "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
            content.len()
        )));
    }

    // 2. Generate new BlockId
    let block_id = BlockId::new();

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

        // L-37: Enforce `MAX_BLOCK_DEPTH` on the create path. The new block
        // will live at depth = parent_depth + 1, so reject when that exceeds
        // the documented limit (docs/ARCHITECTURE.md §20). Without this guard
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
        let parent_depth = sqlx::query_scalar::<_, i64>(concat!(
            crate::ancestors_cte_standard!(),
            "SELECT MAX(depth) FROM ancestors",
        ))
        .bind(pid)
        .fetch_one(&mut **tx)
        .await?;

        if parent_depth + 1 > MAX_BLOCK_DEPTH {
            return Err(AppError::Validation(format!(
                "maximum nesting depth of {MAX_BLOCK_DEPTH} exceeded"
            )));
        }
    }

    // Provisional 1-based `position` for the optimistic SQL INSERT below. When a
    // slot is given it's `index + 1`; otherwise append after the last sibling.
    // The materializer reprojects the authoritative dense rank from the engine's
    // fractional order shortly after (eventual consistency).
    let effective_position = match index {
        // #400/#383: a 0-based slot maps to a 1-based provisional rank, capped
        // overflow-safe below the reserved keyset tail marker; the materializer
        // reprojects the dense rank regardless. (Supersedes #383's outright
        // sentinel rejection: under #400 the caller supplies a slot, not a
        // verbatim position.)
        Some(i) => crate::pagination::index_to_provisional_position(i),
        None => {
            let row = sqlx::query!(
                "SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM blocks \
                 WHERE parent_id IS ? AND deleted_at IS NULL AND position < 9223372036854775807",
                parent_id
            )
            .fetch_optional(&mut **tx)
            .await?;
            row.map(|r| r.next_pos).unwrap_or(1)
        }
    };

    // 3b. Build OpPayload (#400: carries the 0-based `index`; `None` index ⇒ a
    // bare append, which the engine resolves to the end of the sibling list).
    let parent_block_id = parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: block_id.clone(),
        block_type: block_type.clone(),
        parent_id: parent_block_id,
        position: None,
        index,
        content: content.clone(),
    });

    let op_record =
        op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;

    // Compute page_id: if this block IS a page, page_id = self.
    // Otherwise, inherit from parent's page_id (or parent itself if parent is a page).
    let page_id: Option<String> = if block_type == "page" {
        Some(block_id.as_str().to_string())
    } else if let Some(ref pid) = parent_id {
        // Look up parent's page_id. If parent is a page, use parent's id.

        sqlx::query_scalar!(
            "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END FROM blocks WHERE id = ?",
            pid
        )
        .fetch_optional(&mut **tx)
        .await?
        .flatten()
    } else {
        None
    };

    // 5. Insert into blocks table within same transaction
    let block_id_str = block_id.as_str();
    sqlx::query!(
        // #533: stamp `space_id` synchronously from the owning page so a
        // committed block is never transiently space-less (the background
        // SetBlockPageId task remains belt-and-suspenders). A child inherits
        // its page's space via `page_id`; a brand-new top-level page has no
        // `page_id` row yet → resolves NULL, then set immediately after by
        // the `set_property(space)` op in `create_page_in_space_inner`.
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, ?, ?, ?, ?, ?, (SELECT space_id FROM blocks WHERE id = ?))",
        block_id_str,
        block_type,
        content,
        parent_id,
        effective_position,
        page_id,
        page_id,
    )
    .execute(&mut **tx)
    .await?;

    // PEND-76 F5 — referential cross-space integrity: reject creating a
    // block whose content references a block in a different space. Runs
    // after the INSERT so the new block's `page_id` (hence space) is
    // resolvable; an unparented/orphan block resolves to no space and is
    // skipped by the validator.
    crate::spaces::cross_space_validation::validate_content_cross_space_refs(
        tx, &block_id, &content,
    )
    .await?;

    // P-4: Inherit parent tags for the new block
    crate::tag_inheritance::inherit_parent_tags(tx, block_id.as_str(), parent_id.as_deref())
        .await?;

    // #417/#432: keep the owning page's `pages_cache.child_block_count`
    // correct on the LOCAL command path. Unlike the sync `ApplyOp` path —
    // which runs `maintain_pages_cache_counts_after_op` inside `apply_op_tx`
    // — a content/tag create here only enqueues a per-block background
    // fan-out (FTS, tag refs, page_ids) and NEVER a full `RebuildPagesCache`,
    // so without this in-tx recompute the owning page's child count would
    // stay stale until an unrelated edit (or a manual rebuild, which #432
    // separately fixed). We reuse the materializer's single-source-of-truth
    // `recompute_pages_cache_counts_for_pages` keyed on the block's already-
    // computed `page_id` rather than duplicating the count SQL. A `page`
    // create's own `pages_cache` row is created by the background
    // `RebuildPagesCache` task, so this recompute is a no-op for it (the
    // row doesn't exist yet in-tx) — exactly as on the ApplyOp path, where
    // page creates rely on the rebuild for their row.
    if block_type != "page"
        && let Some(owning_page) = page_id.clone()
    {
        crate::materializer::recompute_pages_cache_counts_for_pages(&mut *tx, &[owning_page])
            .await?;
    }

    // Return block + op record; caller is responsible for commit + dispatch.
    Ok((
        BlockRow {
            id: block_id,
            block_type,
            content: Some(content),
            parent_id: parent_id.map(|s| BlockId::from_trusted(&s)),
            position: Some(effective_position),
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: page_id.map(|s| BlockId::from_trusted(&s)),
        },
        op_record,
    ))
}

/// Snapshot of a `property_definitions` row's validation-relevant fields.
///
/// PEND-28a M2: pre-fetched by the caller of [`set_property_in_tx`] and
/// passed to [`validate_property_value`] so the helper stays sync and
/// trivially unit-testable. The full `PropertyDefinition` struct carries
/// `key` and `created_at` fields that the validation logic does not need;
/// this slimmer view keeps the helper signature minimal.
struct PropertyDeclaration {
    value_type: String,
    options: Option<String>,
}

/// Validate a [`SetPropertyPayload`] against the reserved-key shape rules
/// and (optionally) against a pre-fetched `property_definitions` row.
///
/// PEND-28a M2: structural extraction from [`set_property_in_tx`]. This
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
///   5. BUG-20 select-options-membership: when the definition declares
///      `value_type = "select"` with a non-NULL `options` JSON array, the
///      supplied `value_text` must be one of the listed options.
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
        return Err(AppError::Validation(format!(
            "Invalid date format: '{}'. Expected YYYY-MM-DD.",
            date_str
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
            return Err(AppError::Validation(format!(
                "Property '{}' requires value_date, not value_text/value_num/value_ref/value_bool.",
                payload.key
            )));
        }
        "todo_state" | "priority" if payload.value_text.is_none() => {
            return Err(AppError::Validation(format!(
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
                return Err(AppError::Validation(format!(
                    "Property '{}' expects type '{}', got '{}'.",
                    payload.key, expected_type, actual_type
                )));
            }
        }

        // BUG-20: Options membership validation for select-type
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
                AppError::Validation(format!(
                    "Property '{}' has malformed options JSON: {e}",
                    payload.key
                ))
            })?;
            if !allowed.iter().any(|a| a == actual) {
                return Err(AppError::Validation(format!(
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
/// This is the core implementation shared by [`set_property_inner`](crate::commands::set_property_inner) (which
/// wraps it in its own transaction) and the recurrence path in
/// `set_todo_state_inner` (which batches multiple operations in one tx).
///
/// Returns the updated [`BlockRow`] and the [`op_log::OpRecord`] so the
/// caller can commit the transaction and dispatch background work afterward.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_property_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: String,
    key: &str,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
    value_bool: Option<bool>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // 1. Build and validate the payload before touching the DB.
    //    PEND-28a M2: validation logic lives in `validate_property_value`
    //    above. The `property_definitions` row is pre-fetched here so the
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
    validate_property_value(&prop_payload, declaration.as_ref())?;

    // 2. Validate block exists and is not deleted (TOCTOU-safe inside tx)
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at, todo_state, priority, due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;

    // PEND-76 F5 — referential cross-space integrity (PEND-15 Phase 2):
    // reject a ref-type property whose target lives in a different space
    // than the source block. No-op when `value_ref` is None (clear) and
    // exempts the reserved `space` key (how blocks move between spaces).
    crate::spaces::cross_space_validation::validate_ref_property_cross_space(
        tx,
        &BlockId::from_trusted(&block_id),
        value_ref.as_deref(),
        key,
    )
    .await?;

    // 3. Append SetProperty op to the op_log
    let payload = OpPayload::SetProperty(prop_payload);
    let op_record =
        op_log::append_local_op_in_tx(tx, device_id, payload, crate::db::now_ms()).await?;

    // 4. Materialize: route reserved keys to blocks columns, others to block_properties
    if is_reserved_property_key(key) {
        // Match-arms with explicit `sqlx::query!` per column — preserves
        // compile-time SQL validation instead of bypassing it with
        // runtime `sqlx::query(&format!(...))`. Reserved keys are a
        // closed set (see `is_reserved_property_key`) so the match is
        // exhaustive.
        match key {
            "todo_state" => {
                sqlx::query!(
                    "UPDATE blocks SET todo_state = ? WHERE id = ?",
                    value_text,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            "priority" => {
                sqlx::query!(
                    "UPDATE blocks SET priority = ? WHERE id = ?",
                    value_text,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            "due_date" => {
                sqlx::query!(
                    "UPDATE blocks SET due_date = ? WHERE id = ?",
                    value_date,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            "scheduled_date" => {
                sqlx::query!(
                    "UPDATE blocks SET scheduled_date = ? WHERE id = ?",
                    value_date,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            _ => unreachable!(
                "is_reserved_property_key('{key}') returned true for an unrecognised key"
            ),
        }
    } else if key == SPACE_PROPERTY_KEY {
        // #533 Phase 2: `space` is column-backed ONLY — no block_properties
        // row. Stamp the denormalized `blocks.space_id` for the page's own
        // row AND every block whose owning page is this one
        // (`page_id = block_id`), so a re-assignment (move-to-space) of a
        // populated page moves its descendants too (a space change enqueues
        // no page_id/space_id rebuild). Parity with the sync/replay path
        // (`project_set_property_to_sql`).
        //
        // #612/#708: the generic `set_property` boundary (IPC + MCP RW)
        // reaches this arm unvalidated, so enforce the space contract HERE
        // rather than per caller: the value must be a ref (a text/num/date
        // shape would otherwise NULL `space_id` across the whole page
        // group), and the target must be a live, registered space. The
        // dedicated paths (`move_blocks_to_space_inner`,
        // `create_page_in_space_inner`, journal/pages helpers) pre-validate
        // the same predicate; this is the TOCTOU-safe backstop. The 0089 FK
        // (`blocks.space_id REFERENCES spaces(id)`) would reject a
        // mis-stamp anyway — this turns it into a clean Validation error.
        let Some(target) = value_ref.as_deref() else {
            return Err(AppError::Validation(
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
            return Err(AppError::Validation(format!(
                "space_id '{target}' does not refer to a live, registered space block"
            )));
        }
        sqlx::query!(
            "UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?",
            value_ref,
            block_id,
            block_id
        )
        .execute(&mut **tx)
        .await?;
    } else {
        // PEND-14: persist `value_bool` as INTEGER (0/1) — SQLite has no
        // native boolean type; the column CHECK constraint set in
        // migration 0042 keeps the stored value to (0, 1, NULL).
        let value_bool_int: Option<i64> = value_bool.map(|b| b as i64);
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            block_id,
            key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool_int,
        )
        .execute(&mut **tx)
        .await?;
    }

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

// ===========================================================================
// Tests — `validate_property_value` matrix
// ===========================================================================
//
// PEND-28a M2: pin the pure-validation matrix extracted from
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
            AppError::Validation(msg) => assert!(
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
            AppError::Validation(msg) => assert!(
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
            AppError::Validation(msg) => assert!(
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
            AppError::Validation(msg) => assert!(
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
            AppError::Validation(msg) => assert!(
                msg.contains("expects type 'boolean'") && msg.contains("got 'text'"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    // --- select-typed declarations (BUG-20 options membership) ------------

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
            AppError::Validation(msg) => assert!(
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
            AppError::Validation(msg) => assert!(
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
            AppError::Validation(msg) => assert!(
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
