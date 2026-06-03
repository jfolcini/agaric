//! Loro-to-SQL projection helpers.
//!
//! The materializer applies each op to the per-space
//! [`crate::loro::engine::LoroEngine`] FIRST, reads the post-apply
//! state, and PROJECTS that state into SQL — so the SQL `blocks` /
//! `block_properties` / `block_tags` rows are derived from the CRDT.
//!
//! Each function in this module is a per-op-type projection helper:
//! given a typed payload (or a read-back snapshot from the engine)
//! and a borrowed `&mut SqliteConnection` from the caller's
//! transaction, it writes the SQL rows that mirror the engine's
//! post-apply state.
//!
//! ## Atomic semantics
//!
//! Each helper uses the SAME `&mut SqliteConnection` the caller is
//! using. If the projection fails, the caller's transaction rolls
//! back (no partial SQL state escapes); but the engine state is NOT
//! rolled back (Loro 1.x does not expose a transaction primitive we
//! can wrap). This trade-off is acceptable because the op_log is the
//! source of truth: a snapshot+replay rebuilds engine state from the
//! same op_log the materializer reads.
//!
//! ## Coverage
//!
//! All twelve op types have projection helpers; the two attachment
//! ops bypass the projection (file blobs live outside CRDT state).
//!
//! ## What this module does NOT do
//!
//! - Run the engine apply. The caller is responsible for invoking
//!   `engine.apply_*` and reading back the post-apply state before
//!   calling these projection helpers. This split keeps the engine
//!   guard's lifetime bounded (the projection runs after the guard is
//!   dropped) and makes the helpers unit-testable from synthetic
//!   payloads.
//! - Project attachment ops. `AddAttachment` / `DeleteAttachment`
//!   carry file blobs that live outside the CRDT state.
//! - Rebuild derived caches (`block_links`, `block_tag_inherited`).
//!   The caller continues to invoke `cache::reindex_*` /
//!   `tag_inheritance::*` AFTER projection.

use sqlx::SqliteConnection;

use crate::error::AppError;
use crate::loro::engine::BlockSnapshot;
use crate::op::{is_reserved_property_key, SetPropertyPayload};

/// Project a `CreateBlock` engine state into SQL.
///
/// `snapshot` is the engine's read-back state for the freshly-created
/// block (after `engine.apply_create_block(...)` ran). `payload.position`
/// is `Option<i64>` on the payload but the engine flattens to `i64`,
/// so the snapshot's `position` is the source of truth here.
///
/// **Note on `tag_inheritance::inherit_parent_tags`.** The projection
/// helper does NOT call it — the caller (the per-op branch in
/// `apply_op_tx`) is responsible for invoking it after the
/// projection. Keeps the helper pure (just the row INSERT) so it's
/// directly unit-testable.
pub async fn project_create_block_to_sql(
    conn: &mut SqliteConnection,
    snapshot: &BlockSnapshot,
) -> Result<(), AppError> {
    let parent_id = snapshot.parent_id.as_deref();
    sqlx::query!(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
        snapshot.block_id,
        snapshot.block_type,
        snapshot.content,
        parent_id,
        snapshot.position,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Project an `EditBlock` engine state into SQL via
/// `UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS
/// NULL`. The `content` value comes from the engine's post-apply
/// read-back, not the payload's `to_text` field directly. In a
/// single-author scenario the two are identical; in a concurrent-edit
/// scenario the engine's character-level merge produces different
/// content from either peer's `to_text` (the CRDT convergence win).
pub async fn project_edit_block_to_sql(
    conn: &mut SqliteConnection,
    snapshot: &BlockSnapshot,
) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL",
        snapshot.content,
        snapshot.block_id,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Project a `SetProperty` engine state into SQL.
///
/// - **Reserved keys** (`todo_state`, `priority`, `due_date`,
///   `scheduled_date`) update the dedicated `blocks` column, NOT
///   `block_properties`.
/// - **Non-reserved keys** INSERT-OR-REPLACE a row in
///   `block_properties` with the typed value columns set per the
///   payload.
///
/// The engine compresses property values to a single string; SQL
/// preserves the typed shape (`value_num`, `value_date`, `value_ref`,
/// `value_bool`) for read-side filters (`WHERE value_num > ?` etc.).
/// The projection therefore reads the typed value fields off the
/// payload directly — the engine's post-apply state for a property
/// equals the payload's value field by construction.
pub async fn project_set_property_to_sql(
    conn: &mut SqliteConnection,
    payload: &SetPropertyPayload,
) -> Result<(), AppError> {
    if is_reserved_property_key(&payload.key) {
        let block_id = payload.block_id.as_str();
        match payload.key.as_str() {
            "todo_state" => {
                sqlx::query!(
                    "UPDATE blocks SET todo_state = ? WHERE id = ?",
                    payload.value_text,
                    block_id
                )
                .execute(&mut *conn)
                .await?;
            }
            "priority" => {
                sqlx::query!(
                    "UPDATE blocks SET priority = ? WHERE id = ?",
                    payload.value_text,
                    block_id
                )
                .execute(&mut *conn)
                .await?;
            }
            "due_date" => {
                sqlx::query!(
                    "UPDATE blocks SET due_date = ? WHERE id = ?",
                    payload.value_date,
                    block_id
                )
                .execute(&mut *conn)
                .await?;
            }
            "scheduled_date" => {
                sqlx::query!(
                    "UPDATE blocks SET scheduled_date = ? WHERE id = ?",
                    payload.value_date,
                    block_id
                )
                .execute(&mut *conn)
                .await?;
            }
            other => {
                return Err(AppError::Validation(format!(
                    "project_set_property_to_sql: unrecognised reserved key '{other}'",
                )));
            }
        }
    } else {
        let value_bool_int: Option<i64> = payload.value_bool.map(|b| b as i64);
        let block_id = payload.block_id.as_str();
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            block_id,
            payload.key,
            payload.value_text,
            payload.value_num,
            payload.value_date,
            payload.value_ref,
            value_bool_int,
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Project a `PurgeBlock` engine state into SQL. Hard-delete: the
/// row in `blocks` plus the row in `block_properties` plus rows in
/// `block_tags` keyed on this `block_id`.
///
/// The full SQL-side cascade against the descendant CTE — sweeping
/// `block_tag_inherited`, `block_links`, `agenda_cache`, `tags_cache`,
/// `pages_cache`, `attachments`, `block_drafts`, `fts_blocks`,
/// `page_aliases`, `projected_agenda_cache`, and `blocks` — lives in
/// `apply_purge_block_tx`. This projection handles only the per-
/// block-id rows in the three tables the engine knows about
/// (`blocks`, `block_properties`, `block_tags`); the cascade caller
/// invokes the engine's `apply_purge_block` for the seed plus every
/// descendant and the SQL-side helper for the rest.
pub async fn project_purge_block_to_sql(
    conn: &mut SqliteConnection,
    block_id: &str,
) -> Result<(), AppError> {
    sqlx::query!("DELETE FROM block_tags WHERE block_id = ?", block_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query!("DELETE FROM block_properties WHERE block_id = ?", block_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query!("DELETE FROM blocks WHERE id = ?", block_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Day-11 stubs — wired in day-12+
// ---------------------------------------------------------------------------

/// Project a `DeleteBlock` engine state into SQL. The engine's
/// `apply_delete_block` writes a fixed-marker `deleted_at` value (the
/// CRDT only needs to know "deleted vs not"); the SQL side stamps the
/// real timestamp from `record.created_at` so `block_lifecycle`
/// reports / restore-cohort lookups remain accurate. The caller passes
/// the timestamp string explicitly rather than reading it back from
/// the engine — see `apply_delete_block_via_loro` for the wiring.
///
/// **Cascade scope.** This projection walks the descendant CTE and
/// soft-deletes every active descendant in one UPDATE. The engine's
/// `apply_delete_block` is per-block-id only, so the engine-side
/// fan-out for descendants is handled by the post-commit dispatch
/// (`dispatch_restore_descendants` is the symmetric helper for
/// restore); SQL state for the cohort is correct as soon as this
/// projection runs.
///
/// **Idempotence.** The `WHERE deleted_at IS NULL` filter on the CTE
/// makes a re-apply a no-op for rows already soft-deleted at any
/// earlier timestamp.
pub async fn project_delete_block_to_sql(
    conn: &mut SqliteConnection,
    block_id: &str,
    deleted_at: i64,
) -> Result<(), AppError> {
    sqlx::query(concat!(
        crate::descendants_cte_active!(),
        "UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
    ))
    .bind(block_id)
    .bind(deleted_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Project a `MoveBlock` engine state into SQL.  Mirrors the per-block
/// `UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?` shape
/// of `apply_move_block_tx`.  The snapshot's `parent_id` / `position`
/// fields are the source of truth — the engine's per-key LWW resolves
/// concurrent reparents on the engine side, and we project that
/// post-LWW state here.
///
/// **Sibling-shift.** A `MoveBlock` op's `new_position` is taken at
/// face value; ordering collisions accept the LWW outcome. Loro's
/// per-key LWW means two devices moving distinct blocks to the same
/// position resolve to the same final state on both sides (same
/// `(parent_id, position)` per block), and a single SQL row per block
/// keeps the projection 1:1 with the engine state. Position
/// uniqueness is not enforced in the schema; concurrent moves to the
/// same position are an application-layer concern.
pub async fn project_move_block_to_sql(
    conn: &mut SqliteConnection,
    snapshot: &BlockSnapshot,
) -> Result<(), AppError> {
    let parent_id = snapshot.parent_id.as_deref();
    sqlx::query!(
        "UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?",
        parent_id,
        snapshot.position,
        snapshot.block_id,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Project a `RestoreBlock` engine state into SQL. Mirrors the cohort
/// UPDATE in `apply_restore_block_tx` — clears `deleted_at` for every
/// block in the descendant CTE that was soft-deleted at the same
/// `deleted_at_ref` timestamp.
///
/// **Engine fan-out trade-off.** The engine's `apply_restore_block` is
/// per-block-id only, so only the SEED block is applied to the engine
/// here. The descendant cohort's engine state is reconciled by the
/// post-commit `dispatch_restore_descendants` fanout (SQL state for
/// the full cohort is correct as soon as this projection runs; engine
/// state for descendants follows).
///
/// **Idempotence.** The `WHERE deleted_at = ?` filter on the CTE makes
/// a re-apply a no-op for rows that have already been restored
/// (their `deleted_at` is now NULL and won't match `= ?`).
pub async fn project_restore_block_to_sql(
    conn: &mut SqliteConnection,
    block_id: &str,
    deleted_at_ref: i64,
) -> Result<(), AppError> {
    sqlx::query(concat!(
        crate::descendants_cte_standard!(),
        "UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
    ))
    .bind(block_id)
    .bind(deleted_at_ref)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Project a `DeleteProperty` engine state into SQL.  Mirrors the
/// per-key match in `apply_delete_property_tx`:
///
/// - **Reserved keys** (`todo_state`, `priority`, `due_date`,
///   `scheduled_date`) clear the dedicated `blocks` column.
/// - **Non-reserved keys** delete the `block_properties` row keyed on
///   `(block_id, key)`.
///
/// Idempotent on either branch — the UPDATE on a column already NULL
/// is a no-op, and the DELETE matching zero rows is a no-op.
pub async fn project_delete_property_to_sql(
    conn: &mut SqliteConnection,
    block_id: &str,
    key: &str,
) -> Result<(), AppError> {
    if is_reserved_property_key(key) {
        match key {
            "todo_state" => {
                sqlx::query!("UPDATE blocks SET todo_state = NULL WHERE id = ?", block_id)
                    .execute(&mut *conn)
                    .await?;
            }
            "priority" => {
                sqlx::query!("UPDATE blocks SET priority = NULL WHERE id = ?", block_id)
                    .execute(&mut *conn)
                    .await?;
            }
            "due_date" => {
                sqlx::query!("UPDATE blocks SET due_date = NULL WHERE id = ?", block_id)
                    .execute(&mut *conn)
                    .await?;
            }
            "scheduled_date" => {
                sqlx::query!(
                    "UPDATE blocks SET scheduled_date = NULL WHERE id = ?",
                    block_id
                )
                .execute(&mut *conn)
                .await?;
            }
            other => {
                return Err(AppError::Validation(format!(
                    "project_delete_property_to_sql: unrecognised reserved key '{other}'",
                )));
            }
        }
    } else {
        sqlx::query!(
            "DELETE FROM block_properties WHERE block_id = ? AND key = ?",
            block_id,
            key,
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Project an `AddTag` engine state into SQL via
/// `INSERT OR IGNORE INTO block_tags`.
///
/// **Note on `tag_inheritance::propagate_tag_to_descendants`.** The
/// caller (the per-op branch in `apply_op_tx`) is responsible for
/// invoking it AFTER the projection. Keeps the helper pure.
pub async fn project_add_tag_to_sql(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        block_id,
        tag_id,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Project a `RemoveTag` engine state into SQL.  Mirrors the
/// `DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?` shape of
/// `apply_remove_tag_tx`.
///
/// **Note on `tag_inheritance::remove_inherited_tag`.**  The caller
/// invokes it AFTER the projection — same shape as `AddTag` above.
pub async fn project_remove_tag_to_sql(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?",
        block_id,
        tag_id,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Project an engine-side block snapshot to SQL after a sync-pull
/// import. Drives the `apply_remote` side of
/// [`crate::sync_protocol::loro_sync`].
///
/// Behaviour:
///
/// * `Some(snapshot)` → **UPSERT** (`INSERT … ON CONFLICT(id) DO
///   UPDATE`) the `blocks` row, writing only the engine-authoritative
///   core columns `(block_type, content, parent_id, position)`.
///
///   This must NOT be `INSERT OR REPLACE`: REPLACE deletes the
///   conflicting row first, and with `PRAGMA foreign_keys=ON` the
///   `ON DELETE CASCADE` FKs then cascade-delete every derived row
///   (`block_tags`, `block_properties`, `block_links`, `page_aliases`,
///   `*_cache`, …) and reset the un-listed columns (`deleted_at`,
///   `todo_state`, `priority`, `due_date`, `scheduled_date`, `page_id`)
///   to their defaults. Because [`import_with_changed_blocks`] returns
///   *every* block in the space on each import, a single inbound sync
///   would wipe the whole space's derived/soft-delete state. The
///   conflict-update touches only the core columns and leaves the
///   derived and soft-delete columns intact.
///
///   Note `deleted_at` is deliberately preserved, not re-derived from
///   the engine: the engine's `read_deleted` only marks the delete
///   *seed* (descendant soft-deletes are an SQL-side CTE fan-out, never
///   mirrored into the engine), so projecting it per-block here would
///   resurrect soft-deleted descendants. Remote delete/restore and
///   tag/property *changes* therefore still require a per-op projection
///   pass — out of scope for this core-shape upsert (see PEND-76 F1).
///
///   [`import_with_changed_blocks`]: crate::loro::engine::LoroEngine::import_with_changed_blocks
/// * `None` → engine has no record of `block_id`.  The plan
///   (`docs/session-log/2026-sessions-401-800.md` Session 699 Phase 3 §3 day 4) defers the
///   purge-from-SQL semantics: an absent engine record could mean
///   (a) the block was hard-purged on the remote (legitimate
///   delete-from-SQL), or (b) a transient engine miss the caller
///   shouldn't act on.  Day-4 logs a warn + skips.  The next
///   sync-pull that carries an explicit purge op re-triggers this
///   path with proper semantics via the per-op projection helpers.
pub async fn project_block_full_to_sql(
    conn: &mut SqliteConnection,
    space_id: &crate::space::SpaceId,
    block_id: &crate::ulid::BlockId,
    snapshot: Option<&crate::loro::engine::BlockSnapshot>,
) -> Result<(), AppError> {
    match snapshot {
        Some(snap) => {
            let parent_id = snap.parent_id.as_deref();
            sqlx::query!(
                "INSERT INTO blocks \
                     (id, block_type, content, parent_id, position) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                     block_type = excluded.block_type, \
                     content = excluded.content, \
                     parent_id = excluded.parent_id, \
                     position = excluded.position",
                snap.block_id,
                snap.block_type,
                snap.content,
                parent_id,
                snap.position,
            )
            .execute(&mut *conn)
            .await?;
            Ok(())
        }
        None => {
            tracing::warn!(
                space_id = %space_id.as_str(),
                block_id = %block_id.as_str(),
                "project_block_full_to_sql: engine has no record; skipping (defer to explicit purge op)"
            );
            Ok(())
        }
    }
}

/// Re-project a block's full property set from the engine into the SQL
/// `block_properties` table (non-reserved keys) and the dedicated
/// `blocks` hot-path columns (reserved keys) after a sync-pull import.
///
/// This closes the PEND-76 F1 property-propagation residual:
/// [`project_block_full_to_sql`] deliberately touches only the core
/// `blocks` columns, so remote `SetProperty` / `DeleteProperty` changes
/// would otherwise never reach SQL.  `apply_remote` calls this helper
/// per changed block with the engine's post-import **typed** property
/// snapshot (`props`, from
/// [`crate::loro::engine::LoroEngine::read_all_properties_typed`]).
///
/// ## Authoritative-replace semantics
///
/// The engine is the source of truth after an import, so the helper
/// first `DELETE`s all existing `block_properties` rows for the block,
/// then re-INSERTs one row per non-reserved engine property.  This makes
/// remote *deletes* propagate correctly: a property removed on the
/// remote is absent from `props`, so the stale SQL row is swept by the
/// up-front DELETE and never re-inserted.
///
/// ## Typed-column routing (PEND-80 Phase 4)
///
/// The engine stores each value as a native [`PropertyValue`]
/// (`Num`/`Bool`/`Str`/`Null`), so numbers and booleans route **directly**
/// to `value_num` / `value_bool` with no string round-trip — the engine is
/// type-lossless end-to-end. A `Str` covers text/date/ref/select (all
/// `LoroValue::String` in Loro per the §8 Q5 encoding); only that case
/// consults `property_definitions.value_type` (defaulting to `"text"`) to
/// pick the column, and it still tolerates a legacy pre-§2.1 `Str`-encoded
/// number/boolean. An explicit `Null` (cleared), or a `number`-typed `Str`
/// whose text fails to parse, routes to no column — and since
/// `block_properties` has an `exactly_one_value` CHECK (migration 0062)
/// that forbids an all-NULL row, such a value is represented as row-absent
/// (no INSERT; the up-front DELETE already cleared any prior row), matching
/// "cleared property" semantics.
///
/// ## Reserved keys → hot-path `blocks` columns (PEND-81 §2A)
///
/// Reserved property keys (`todo_state`, `priority`, `due_date`,
/// `scheduled_date`) live on dedicated `blocks` columns, not in
/// `block_properties`, so they are skipped by the `block_properties`
/// pass above.  A second pass re-projects them to their columns,
/// mirroring the local [`project_set_property_to_sql`] routing
/// (`todo_state`/`priority` → text columns; `due_date`/`scheduled_date`
/// → date columns; the engine stores all four as a single string that
/// maps directly).  Authoritative-replace holds here too: a single
/// `UPDATE` sets each column from the engine value and NULLs any
/// reserved key *absent* from `props`, so a remote delete/clear of a
/// hot-path key propagates.
///
/// This pass touches only the four hot-path columns — never `deleted_at`
/// — so it cannot resurrect a soft-deleted cohort (re-projecting a
/// hot-path value onto an already-soft-deleted block is harmless: every
/// read path filters by `deleted_at`).  The agenda/projected-agenda
/// caches that read `due_date`/`scheduled_date`/`todo_state` are rebuilt
/// by the inbound-sync cache fan-out
/// ([`crate::materializer::Materializer::enqueue_inbound_sync_rebuilds`]).
pub async fn reproject_block_properties_from_engine(
    conn: &mut SqliteConnection,
    block_id: &crate::ulid::BlockId,
    props: &[(String, crate::loro::engine::PropertyValue)],
) -> Result<(), AppError> {
    use crate::loro::engine::PropertyValue;
    // Authoritative replace: clear all existing rows first so remote
    // deletes (absent from `props`) are swept and never re-inserted.
    //
    // Safe by construction: a non-reserved `block_properties` row can only
    // exist for a block whose property writes went through the engine. The
    // SQL-only fallbacks (`apply_set_property_sql_only`, orphan-tag adoption,
    // undo) either fire only when the block has no resolvable space — in
    // which case it is in no per-space engine and never reaches this sync
    // path — or also append the op to the op_log, which drives the engine via
    // the materializer. So the engine is never *behind* SQL for a synced
    // block, and this DELETE never sweeps a property the engine doesn't know.
    // (A future change that lets spaceless blocks into an engine must revisit
    // this.)
    let block_id_str = block_id.as_str();
    sqlx::query!(
        "DELETE FROM block_properties WHERE block_id = ?",
        block_id_str
    )
    .execute(&mut *conn)
    .await?;

    // P3 (#346): preload all `property_definitions` (key → value_type) ONCE
    // instead of a per-String-typed-property SELECT inside the loop, which
    // was an N+1 on every inbound sync. Behaviour is identical: a key absent
    // from the map (no definition row) still defaults to "text" with a warn.
    let value_types: std::collections::HashMap<String, String> =
        sqlx::query!("SELECT key, value_type FROM property_definitions")
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .map(|r| (r.key, r.value_type))
            .collect();

    for (key, value) in props {
        if is_reserved_property_key(key) {
            // Reserved keys map to dedicated `blocks` columns, never
            // `block_properties`.  Handled by the reserved-key pass below.
            continue;
        }

        let mut value_text: Option<&str> = None;
        let mut value_num: Option<f64> = None;
        let mut value_date: Option<&str> = None;
        let mut value_ref: Option<&str> = None;
        let mut value_bool: Option<i64> = None;
        match value {
            // Native typed values route straight to their column — no string
            // round-trip and no `property_definitions` lookup needed.
            PropertyValue::Num(n) => value_num = Some(*n),
            PropertyValue::Bool(b) => value_bool = Some(i64::from(*b)),
            PropertyValue::Null => { /* cleared → row-absent (handled below) */ }
            // A String value is text/date/ref/select (or a legacy pre-§2.1
            // Str-encoded number/bool); recover the SQL column from the
            // property definition, defaulting to "text" for an undefined key
            // (warn so a missing definition is observable).
            PropertyValue::Str(s) => {
                let value_type: &str = value_types.get(key).map_or_else(
                    || {
                        tracing::warn!(
                            key = %key,
                            block_id = %block_id.as_str(),
                            "reproject_block_properties_from_engine: no property_definitions row; \
                             defaulting to 'text'"
                        );
                        "text"
                    },
                    String::as_str,
                );
                match value_type {
                    "number" => value_num = s.parse::<f64>().ok(),
                    "boolean" => value_bool = Some(i64::from(s == "true")),
                    "date" => value_date = Some(s.as_str()),
                    "ref" => value_ref = Some(s.as_str()),
                    // "select" | "text" | anything unrecognised → text column.
                    _ => value_text = Some(s.as_str()),
                }
            }
        }

        // The `block_properties.exactly_one_value` CHECK (migration 0062)
        // forbids an all-NULL row. An explicit-null engine value (a cleared
        // property), or a `number` whose string fails to parse, routes to no
        // column. The correct SQL representation of a cleared property is
        // row-absent — the up-front DELETE already removed any prior row — so
        // skip the INSERT rather than violate the CHECK and abort the whole
        // inbound-sync transaction.
        if value_text.is_none()
            && value_num.is_none()
            && value_date.is_none()
            && value_ref.is_none()
            && value_bool.is_none()
        {
            continue;
        }

        sqlx::query!(
            "INSERT INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            block_id_str,
            key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
        )
        .execute(&mut *conn)
        .await?;
    }

    // Reserved hot-path keys → dedicated `blocks` columns (PEND-81 §2A).
    // Authoritative-replace: collect each reserved key's engine value (None
    // when absent / cleared on the remote), then a single UPDATE sets all
    // four columns at once — present keys to their value, absent keys to
    // NULL. All four are stored as `Str` in the engine (todo_state/priority
    // are text; due_date/scheduled_date are date strings); render each to
    // its string form (`Null` → column NULL), mirroring the local
    // `project_set_property_to_sql` routing.
    let mut todo_state: Option<String> = None;
    let mut priority: Option<String> = None;
    let mut due_date: Option<String> = None;
    let mut scheduled_date: Option<String> = None;
    for (key, value) in props {
        match key.as_str() {
            "todo_state" => todo_state = value.as_legacy_string(),
            "priority" => priority = value.as_legacy_string(),
            "due_date" => due_date = value.as_legacy_string(),
            "scheduled_date" => scheduled_date = value.as_legacy_string(),
            _ => {}
        }
    }
    sqlx::query!(
        "UPDATE blocks SET \
             todo_state = ?, priority = ?, due_date = ?, scheduled_date = ? \
         WHERE id = ?",
        todo_state,
        priority,
        due_date,
        scheduled_date,
        block_id_str,
    )
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Re-project a block's full tag set from the engine into the SQL
/// `block_tags` table after a sync-pull import.
///
/// This closes the PEND-81 §2A tag-propagation residual:
/// [`project_block_full_to_sql`] touches only the core `blocks` columns,
/// so remote `AddTag` / `RemoveTag` changes would otherwise never reach
/// SQL.  `apply_remote` calls this helper per changed block with the
/// engine's post-import tag-id list (`tag_ids`, from
/// [`crate::loro::engine::LoroEngine::read_tags`] — the values are tag
/// block ULIDs, matching `block_tags.tag_id`).
///
/// ## Authoritative-replace semantics
///
/// The engine is the source of truth after an import, so the helper
/// first `DELETE`s all existing `block_tags` rows for the block, then
/// re-inserts one row per engine tag.  This makes remote *removals*
/// propagate correctly: a tag removed on the remote is absent from
/// `tag_ids`, so the stale SQL edge is swept by the up-front DELETE and
/// never re-inserted.
///
/// ## FK safety (dangling / cross-space tag ids)
///
/// `block_tags.tag_id` has an FK to `blocks(id)` (the tag block).
/// `apply_remote` upserts every changed block — including tag blocks —
/// in the core pass before this one, so the common case is covered. But
/// `read_tags` can still return a tag id with **no** `blocks` row: the
/// engine's `apply_purge_block` removes a purged tag block's own entries
/// without scrubbing the dangling element it left in *other* blocks' tag
/// lists, and a cross-space tag block isn't in this space's doc at all.
/// `INSERT OR IGNORE` suppresses only UNIQUE conflicts, **not** FK
/// violations — an unguarded insert of such an id would abort the whole
/// inbound-sync tx (and keep failing on retry). So the INSERT is gated on
/// the tag block existing: a dangling/foreign edge is silently dropped,
/// matching the engine's intent (the tag block is gone) without breaking
/// the sync.
pub async fn reproject_block_tags_from_engine(
    conn: &mut SqliteConnection,
    block_id: &crate::ulid::BlockId,
    tag_ids: &[String],
) -> Result<(), AppError> {
    // Authoritative replace: clear all existing edges first so remote
    // removals (absent from `tag_ids`) are swept and never re-inserted.
    let block_id_str = block_id.as_str();
    sqlx::query!("DELETE FROM block_tags WHERE block_id = ?", block_id_str)
        .execute(&mut *conn)
        .await?;

    for tag_id in tag_ids {
        // FK-safe + idempotent: only insert when the tag block exists (see
        // the "FK safety" doc above); `INSERT OR IGNORE` keeps re-adds a
        // no-op like the local `add_tag_inner` path.
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tags (block_id, tag_id) \
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?)",
            block_id_str,
            tag_id,
            tag_id,
        )
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Re-project a block's soft-delete state from the engine into SQL
/// after a sync-pull import (PEND-80 Phase 2).
///
/// [`project_block_full_to_sql`] deliberately preserves `deleted_at`
/// (re-deriving it per-block would resurrect soft-deleted descendants),
/// so remote `DeleteBlock` / `RestoreBlock` changes never reach SQL
/// through it. This helper closes that gap. `apply_remote` calls it per
/// changed block with the engine's post-import seed timestamp
/// (`engine_deleted_at`, from
/// [`crate::loro::engine::LoroEngine::read_deleted_at`]).
///
/// The engine stores `deleted_at` on the **delete seed only** (the
/// descendant cascade is an SQL/app derivation per the PEND-80
/// boundary), so this helper re-derives the cascade in SQL rather than
/// trusting per-block engine state:
///
/// * `Some(ts)` — the block is deleted on the remote. Cascade-soft-
///   delete the block + every still-active descendant at `ts` (via
///   [`project_delete_block_to_sql`]). Idempotent: rows already deleted
///   (at any timestamp) are skipped by the active-CTE `deleted_at IS
///   NULL` filter.
/// * `None` — the block is alive on the remote. Restore it **only if it
///   is a genuine delete seed** — i.e. currently soft-deleted in SQL
///   *and* with no soft-deleted ancestor. A block whose ancestor is
///   still deleted is a descendant of a live soft-delete cohort, not a
///   restore target; clearing it would resurrect a soft-deleted subtree
///   (the exact bug [`project_block_full_to_sql`] guards against — the
///   engine's seed-only marking means a descendant reads back `None`
///   here even though it must stay deleted). When it IS a seed, the
///   cohort is cleared by `deleted_at` value (via
///   [`project_restore_block_to_sql`]).
///
/// ## Ordering within `apply_remote`
///
/// Must run AFTER the core-column pass ([`project_block_full_to_sql`])
/// so every changed block's `parent_id` row exists — the descendant /
/// ancestor CTE walks rely on it. Order relative to the property / tag
/// passes does not matter (they touch disjoint columns).
pub async fn reproject_block_deleted_at_from_engine(
    conn: &mut SqliteConnection,
    block_id: &crate::ulid::BlockId,
    engine_deleted_at: Option<&str>,
) -> Result<(), AppError> {
    match engine_deleted_at {
        Some(ts) => {
            // Cascade soft-delete the seed + active descendants at the
            // engine's timestamp. Re-uses the local delete projection so
            // the inbound-sync and local paths share one cascade shape.
            // #109 Phase 2: the engine seed carries `deleted_at` as a
            // serialized String slot; parse to i64 epoch-ms for the
            // INTEGER `blocks.deleted_at` column.
            let ts = ts.parse::<i64>().map_err(|e| {
                AppError::Validation(format!("engine deleted_at not an integer: {e}"))
            })?;
            project_delete_block_to_sql(conn, block_id.as_str(), ts).await?;
        }
        None => {
            // The remote says this block is alive. Read SQL's current
            // soft-delete state: nothing to do if it is already alive or
            // absent.
            let block_id_str = block_id.as_str();
            let current: Option<Option<i64>> =
                sqlx::query_scalar!("SELECT deleted_at FROM blocks WHERE id = ?", block_id_str)
                    .fetch_optional(&mut *conn)
                    .await?;
            let Some(Some(deleted_at_ref)) = current else {
                return Ok(());
            };

            // Resurrection guard: only a genuine delete seed (no
            // soft-deleted ancestor) is a restore target. A block under a
            // still-deleted ancestor must stay deleted — the engine marks
            // only the seed, so its `None` here means "descendant of a
            // live cohort", not "restore me". `ancestors_cte_standard!()`
            // emits the seed at depth 0; the `a.depth > 0` filter
            // restricts the check to strict ancestors.
            let has_deleted_ancestor: bool = sqlx::query_scalar(concat!(
                crate::ancestors_cte_standard!(),
                "SELECT EXISTS( \
                     SELECT 1 FROM ancestors a \
                     JOIN blocks b ON b.id = a.id \
                     WHERE a.depth > 0 AND b.deleted_at IS NOT NULL \
                 )",
            ))
            .bind(block_id.as_str())
            .fetch_one(&mut *conn)
            .await?;
            if has_deleted_ancestor {
                return Ok(());
            }

            // Genuine seed restore: clear the cohort (seed + descendants
            // soft-deleted at the same timestamp).
            project_restore_block_to_sql(conn, block_id.as_str(), deleted_at_ref).await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::loro::engine::PropertyValue;
    use crate::op::SetPropertyPayload;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;

    /// Test helper: a `Str`-valued engine property.
    fn pv(s: &str) -> PropertyValue {
        PropertyValue::Str(s.to_string())
    }
    use tempfile::TempDir;

    /// The five typed `block_properties` value columns, in canonical
    /// `value_text, value_num, value_date, value_ref, value_bool` order —
    /// used as the `query_as` row type in the projection tests.
    type PropValueColumns = (
        Option<String>,
        Option<f64>,
        Option<String>,
        Option<String>,
        Option<i64>,
    );

    const BLOCK_A: &str = "01HZ00000000000000000000A1";
    const BLOCK_B: &str = "01HZ00000000000000000000B2";
    const TAG_C: &str = "01HZ00000000000000000000C3";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("projection_test.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    fn snapshot(
        block_id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: i64,
    ) -> BlockSnapshot {
        BlockSnapshot {
            block_id: block_id.to_string(),
            block_type: block_type.to_string(),
            content: content.to_string(),
            parent_id: parent_id.map(std::string::ToString::to_string),
            position,
        }
    }

    #[tokio::test]
    async fn project_create_block_writes_blocks_row() {
        let (pool, _dir) = fresh_pool().await;
        let snap = snapshot(BLOCK_A, "content", "hello world", None, 5);

        let mut conn = pool.acquire().await.expect("acquire");
        project_create_block_to_sql(&mut conn, &snap)
            .await
            .expect("project");
        drop(conn);

        let row: (String, String, String, Option<String>, i64) = sqlx::query_as(
            "SELECT id, block_type, content, parent_id, position FROM blocks WHERE id = ?",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch row");
        assert_eq!(row.0, BLOCK_A);
        assert_eq!(row.1, "content");
        assert_eq!(row.2, "hello world");
        assert_eq!(row.3, None);
        assert_eq!(row.4, 5);
    }

    #[tokio::test]
    async fn project_create_block_idempotent_via_insert_or_ignore() {
        // A second call with the same block_id must not error and must
        // not overwrite — mirrors `apply_create_block_tx`'s
        // `INSERT OR IGNORE` semantics.
        let (pool, _dir) = fresh_pool().await;
        let snap_first = snapshot(BLOCK_A, "content", "first", None, 0);
        let snap_second = snapshot(BLOCK_A, "content", "second-should-be-ignored", None, 99);

        let mut conn = pool.acquire().await.expect("acquire");
        project_create_block_to_sql(&mut conn, &snap_first)
            .await
            .expect("first");
        project_create_block_to_sql(&mut conn, &snap_second)
            .await
            .expect("second");
        drop(conn);

        let row: (String, i64) =
            sqlx::query_as("SELECT content, position FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch row");
        assert_eq!(row.0, "first", "INSERT OR IGNORE keeps the first row");
        assert_eq!(row.1, 0);
    }

    #[tokio::test]
    async fn project_edit_block_updates_content() {
        let (pool, _dir) = fresh_pool().await;
        // Seed.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'original', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let snap = snapshot(BLOCK_A, "content", "edited content", None, 0);
        let mut conn = pool.acquire().await.expect("acquire");
        project_edit_block_to_sql(&mut conn, &snap)
            .await
            .expect("project");
        drop(conn);

        let row: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0, "edited content");
    }

    #[tokio::test]
    async fn project_edit_block_does_not_resurrect_deleted_block() {
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks \
                (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'original', NULL, 0, 1767225600000)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let snap = snapshot(BLOCK_A, "content", "should-not-apply", None, 0);
        let mut conn = pool.acquire().await.expect("acquire");
        project_edit_block_to_sql(&mut conn, &snap)
            .await
            .expect("project");
        drop(conn);

        // The WHERE deleted_at IS NULL filter must have prevented the
        // UPDATE; content is still 'original'.
        let row: (String,) = sqlx::query_as("SELECT content FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0, "original");
    }

    #[tokio::test]
    async fn project_set_property_writes_typed_value_and_hot_path_column() {
        let (pool, _dir) = fresh_pool().await;
        // Seed the block so the UPDATE (hot-path) has something to hit.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        // Hot-path key (`todo_state`).
        let hot_path_payload = SetPropertyPayload {
            block_id: BlockId::from_trusted(BLOCK_A),
            key: "todo_state".into(),
            value_text: Some("DOING".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        };
        let mut conn = pool.acquire().await.expect("acquire");
        project_set_property_to_sql(&mut conn, &hot_path_payload)
            .await
            .expect("project hot-path");
        drop(conn);

        let row: (Option<String>,) = sqlx::query_as("SELECT todo_state FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch hot-path");
        assert_eq!(
            row.0,
            Some("DOING".into()),
            "todo_state column must be updated for reserved key"
        );

        // Verify the hot-path key did NOT also write a block_properties row.
        let props_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'todo_state'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch props count");
        assert_eq!(
            props_count.0, 0,
            "reserved key must NOT write to block_properties"
        );

        // Non-reserved key — INSERT OR REPLACE into block_properties
        // with the typed value field.
        let non_reserved_payload = SetPropertyPayload {
            block_id: BlockId::from_trusted(BLOCK_A),
            key: "effort".into(),
            value_text: None,
            value_num: Some(2.5),
            value_date: None,
            value_ref: None,
            value_bool: None,
        };
        let mut conn = pool.acquire().await.expect("acquire");
        project_set_property_to_sql(&mut conn, &non_reserved_payload)
            .await
            .expect("project non-reserved");
        drop(conn);

        let prop_row: (Option<String>, Option<f64>, Option<String>) = sqlx::query_as(
            "SELECT value_text, value_num, value_date FROM block_properties \
             WHERE block_id = ? AND key = ?",
        )
        .bind(BLOCK_A)
        .bind("effort")
        .fetch_one(&pool)
        .await
        .expect("fetch effort row");
        assert_eq!(prop_row.0, None);
        assert_eq!(prop_row.1, Some(2.5));
        assert_eq!(prop_row.2, None);
    }

    #[tokio::test]
    async fn project_purge_block_cascades_to_properties_and_tags() {
        let (pool, _dir) = fresh_pool().await;
        // Seed the block, a property, a tag.  The purge must clean
        // all three.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'doomed', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        // Tag-block (referenced by block_tags FK).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'effort', '3')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .execute(&pool)
            .await
            .unwrap();

        // Sanity preconditions.
        let pre: (i64, i64, i64) = sqlx::query_as(
            "SELECT \
                (SELECT COUNT(*) FROM blocks WHERE id = ?), \
                (SELECT COUNT(*) FROM block_properties WHERE block_id = ?), \
                (SELECT COUNT(*) FROM block_tags WHERE block_id = ?)",
        )
        .bind(BLOCK_A)
        .bind(BLOCK_A)
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch pre");
        assert_eq!(pre, (1, 1, 1), "seed must produce one row in each table");

        let mut conn = pool.acquire().await.expect("acquire");
        project_purge_block_to_sql(&mut conn, BLOCK_A)
            .await
            .expect("project purge");
        drop(conn);

        let post: (i64, i64, i64) = sqlx::query_as(
            "SELECT \
                (SELECT COUNT(*) FROM blocks WHERE id = ?), \
                (SELECT COUNT(*) FROM block_properties WHERE block_id = ?), \
                (SELECT COUNT(*) FROM block_tags WHERE block_id = ?)",
        )
        .bind(BLOCK_A)
        .bind(BLOCK_A)
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch post");
        assert_eq!(post, (0, 0, 0), "purge must cascade to all three tables");
    }

    #[tokio::test]
    async fn project_delete_block_writes_deleted_at() {
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'soon-deleted', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let deleted_at: i64 = 1_778_414_400_000;
        let mut conn = pool.acquire().await.expect("acquire");
        project_delete_block_to_sql(&mut conn, BLOCK_A, deleted_at)
            .await
            .expect("project delete");
        drop(conn);

        let row: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0, Some(deleted_at));
    }

    #[tokio::test]
    async fn project_delete_block_idempotent() {
        // A second call with a later timestamp must NOT clobber the
        // first soft-delete's timestamp — the `WHERE deleted_at IS
        // NULL` filter enforces this. The cohort identity in
        // RestoreBlock relies on the same timestamp persisting across
        // re-applies of the delete op.
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'doomed', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let first_ts: i64 = 1_778_414_400_000;
        let second_ts: i64 = 1_778_511_600_000;
        let mut conn = pool.acquire().await.expect("acquire");
        project_delete_block_to_sql(&mut conn, BLOCK_A, first_ts)
            .await
            .expect("first delete");
        project_delete_block_to_sql(&mut conn, BLOCK_A, second_ts)
            .await
            .expect("second delete (should no-op)");
        drop(conn);

        let row: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(
            row.0,
            Some(first_ts),
            "WHERE deleted_at IS NULL filter must keep the first timestamp"
        );
    }

    #[tokio::test]
    async fn project_move_block_updates_parent_and_position() {
        let (pool, _dir) = fresh_pool().await;
        // Seed a parent and a child.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'page', 'old-parent', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'child', ?, 3)",
        )
        .bind(BLOCK_A)
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();

        // Move BLOCK_A to (parent=None, position=42).
        let snap = snapshot(BLOCK_A, "content", "child", None, 42);
        let mut conn = pool.acquire().await.expect("acquire");
        project_move_block_to_sql(&mut conn, &snap)
            .await
            .expect("project move");
        drop(conn);

        let row: (Option<String>, i64) =
            sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch row");
        assert_eq!(row.0, None, "parent_id must be cleared");
        assert_eq!(row.1, 42);

        // Move BLOCK_A back under BLOCK_B at position 7.
        let snap2 = snapshot(BLOCK_A, "content", "child", Some(BLOCK_B), 7);
        let mut conn = pool.acquire().await.expect("acquire");
        project_move_block_to_sql(&mut conn, &snap2)
            .await
            .expect("project move 2");
        drop(conn);

        let row: (Option<String>, i64) =
            sqlx::query_as("SELECT parent_id, position FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch row 2");
        assert_eq!(row.0.as_deref(), Some(BLOCK_B));
        assert_eq!(row.1, 7);
    }

    // ---------------------------------------------------------------------
    // Day-13 — Restore / DeleteProperty / AddTag / RemoveTag projections.
    // ---------------------------------------------------------------------

    #[tokio::test]
    async fn project_restore_block_clears_deleted_at_for_cohort() {
        // Seed a parent + 2 children all soft-deleted at the same
        // timestamp (the "cohort" the restore is meant to undo).
        // Verify the projection clears `deleted_at` for all three.
        let (pool, _dir) = fresh_pool().await;
        const CHILD_1: &str = "01HZ00000000000000000000C1";
        const CHILD_2: &str = "01HZ00000000000000000000C2";
        let cohort_ts: i64 = 1_778_414_400_000;

        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'parent', NULL, 0, ?)",
        )
        .bind(BLOCK_A)
        .bind(cohort_ts)
        .execute(&pool)
        .await
        .unwrap();
        for child in [CHILD_1, CHILD_2] {
            sqlx::query(
                "INSERT INTO blocks \
                     (id, block_type, content, parent_id, position, deleted_at) \
                 VALUES (?, 'content', 'child', ?, 0, ?)",
            )
            .bind(child)
            .bind(BLOCK_A)
            .bind(cohort_ts)
            .execute(&pool)
            .await
            .unwrap();
        }

        let mut conn = pool.acquire().await.expect("acquire");
        project_restore_block_to_sql(&mut conn, BLOCK_A, cohort_ts)
            .await
            .expect("project restore");
        drop(conn);

        for id in [BLOCK_A, CHILD_1, CHILD_2] {
            let row: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("fetch row");
            assert_eq!(row.0, None, "{id} must be restored");
        }
    }

    #[tokio::test]
    async fn project_restore_block_does_not_restore_other_cohorts() {
        // A child soft-deleted at a DIFFERENT timestamp must NOT be
        // restored — mirrors the cohort-identity invariant.
        let (pool, _dir) = fresh_pool().await;
        const CHILD_OTHER: &str = "01HZ00000000000000000000CX";
        let cohort_ts: i64 = 1_778_414_400_000;
        let other_ts: i64 = 1_735_689_600_000;

        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'parent', NULL, 0, ?)",
        )
        .bind(BLOCK_A)
        .bind(cohort_ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'old-deletion-child', ?, 0, ?)",
        )
        .bind(CHILD_OTHER)
        .bind(BLOCK_A)
        .bind(other_ts)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        project_restore_block_to_sql(&mut conn, BLOCK_A, cohort_ts)
            .await
            .expect("project restore");
        drop(conn);

        let parent_row: (Option<i64>,) =
            sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch parent");
        assert_eq!(parent_row.0, None);

        // CHILD_OTHER stays soft-deleted.
        let child_row: (Option<i64>,) =
            sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(CHILD_OTHER)
                .fetch_one(&pool)
                .await
                .expect("fetch other child");
        assert_eq!(
            child_row.0,
            Some(other_ts),
            "child from other cohort must NOT be restored"
        );
    }

    #[tokio::test]
    async fn project_delete_property_removes_block_property_row() {
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'effort', '3')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        project_delete_property_to_sql(&mut conn, BLOCK_A, "effort")
            .await
            .expect("project delete property");
        drop(conn);

        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ? AND key = 'effort'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch count");
        assert_eq!(count.0, 0, "effort row must be deleted");
    }

    #[tokio::test]
    async fn project_delete_property_clears_hot_path_column() {
        // Reserved-key path: clears the `blocks.todo_state` column,
        // does NOT touch `block_properties`.
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, todo_state) \
             VALUES (?, 'content', '', NULL, 0, 'DOING')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        project_delete_property_to_sql(&mut conn, BLOCK_A, "todo_state")
            .await
            .expect("project delete reserved");
        drop(conn);

        let row: (Option<String>,) = sqlx::query_as("SELECT todo_state FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0, None, "todo_state column must be cleared");
    }

    #[tokio::test]
    async fn project_delete_property_idempotent_on_missing_row() {
        // Second-call (or first-call on an already-clean state) is a
        // silent no-op.
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        let mut conn = pool.acquire().await.expect("acquire");
        // Key has never been written — must succeed without error.
        project_delete_property_to_sql(&mut conn, BLOCK_A, "absent_key")
            .await
            .expect("must no-op cleanly");
    }

    #[tokio::test]
    async fn project_add_tag_inserts_block_tags_row() {
        let (pool, _dir) = fresh_pool().await;
        // Both blocks must exist for the FK.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        project_add_tag_to_sql(&mut conn, BLOCK_A, BLOCK_B)
            .await
            .expect("project add tag");
        drop(conn);

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_A)
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("fetch count");
        assert_eq!(count.0, 1);
    }

    #[tokio::test]
    async fn project_add_tag_idempotent_via_insert_or_ignore() {
        // Second call with same (block_id, tag_id) is a silent no-op.
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        project_add_tag_to_sql(&mut conn, BLOCK_A, BLOCK_B)
            .await
            .expect("first add");
        project_add_tag_to_sql(&mut conn, BLOCK_A, BLOCK_B)
            .await
            .expect("second add must no-op");
        drop(conn);

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_A)
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("fetch count");
        assert_eq!(count.0, 1, "INSERT OR IGNORE keeps a single row");
    }

    #[tokio::test]
    async fn project_remove_tag_deletes_block_tags_row() {
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .execute(&pool)
            .await
            .unwrap();

        let mut conn = pool.acquire().await.expect("acquire");
        project_remove_tag_to_sql(&mut conn, BLOCK_A, BLOCK_B)
            .await
            .expect("project remove tag");
        drop(conn);

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?")
                .bind(BLOCK_A)
                .bind(BLOCK_B)
                .fetch_one(&pool)
                .await
                .expect("fetch count");
        assert_eq!(count.0, 0);
    }

    // ---------------------------------------------------------------------
    // PEND-76 F1 — inbound-sync full-block projection must UPSERT, not
    // REPLACE (REPLACE cascade-wipes the whole space's derived state).
    // ---------------------------------------------------------------------

    #[tokio::test]
    async fn project_block_full_upsert_preserves_derived_and_soft_delete_state() {
        let (pool, _dir) = fresh_pool().await;

        // Seed a block carrying soft-delete + a reserved hot-path column
        // (todo_state), a non-reserved property, and a tag.
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, deleted_at, todo_state) \
             VALUES (?, 'content', 'original', NULL, 0, 1767225600000, 'DOING')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        // Tag-block target for the block_tags FK.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'tag-X', NULL, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'effort', '3')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(BLOCK_A)
            .bind(BLOCK_B)
            .execute(&pool)
            .await
            .unwrap();

        // Project an engine snapshot that changes the content + position
        // (mirrors a remote edit arriving via apply_remote).
        let space = crate::space::SpaceId::from_trusted("01HZ00000000000000000000S1");
        let bid = BlockId::from_trusted(BLOCK_A);
        let snap = snapshot(BLOCK_A, "content", "edited-by-remote", None, 7);
        let mut conn = pool.acquire().await.expect("acquire");
        project_block_full_to_sql(&mut conn, &space, &bid, Some(&snap))
            .await
            .expect("project full");
        drop(conn);

        // Core columns updated from the snapshot.
        let core: (String, i64) =
            sqlx::query_as("SELECT content, position FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch core");
        assert_eq!(core.0, "edited-by-remote", "content must update");
        assert_eq!(core.1, 7, "position must update");

        // Soft-delete + hot-path column preserved (REPLACE would NULL these).
        let preserved: (Option<i64>, Option<String>) =
            sqlx::query_as("SELECT deleted_at, todo_state FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch preserved cols");
        assert_eq!(
            preserved.0,
            Some(1_767_225_600_000),
            "deleted_at must survive the upsert (no resurrection)"
        );
        assert_eq!(
            preserved.1.as_deref(),
            Some("DOING"),
            "todo_state hot-path column must survive the upsert"
        );

        // Derived rows preserved (REPLACE would cascade-delete these).
        let derived: (i64, i64) = sqlx::query_as(
            "SELECT \
                (SELECT COUNT(*) FROM block_properties WHERE block_id = ?), \
                (SELECT COUNT(*) FROM block_tags WHERE block_id = ?)",
        )
        .bind(BLOCK_A)
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch derived counts");
        assert_eq!(derived.0, 1, "block_properties row must survive the upsert");
        assert_eq!(derived.1, 1, "block_tags row must survive the upsert");
    }

    #[tokio::test]
    async fn project_block_full_reproject_does_not_resurrect_soft_deleted_cohort() {
        // A soft-deleted parent + descendant share a `deleted_at`
        // cohort timestamp (the per-op delete fans out to descendants via
        // an SQL CTE; the engine only marks the seed). An inbound sync
        // re-projects EVERY block in the space, so it calls this helper
        // for both the parent and the descendant. The upsert must leave
        // each one's `deleted_at` intact — re-deriving it from the engine
        // would resurrect the descendant (engine marks only the seed).
        let (pool, _dir) = fresh_pool().await;
        const CHILD: &str = "01HZ00000000000000000000C1";
        let cohort_ts: i64 = 1_778_414_400_000;

        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'parent', NULL, 0, ?)",
        )
        .bind(BLOCK_A)
        .bind(cohort_ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'content', 'child', ?, 0, ?)",
        )
        .bind(CHILD)
        .bind(BLOCK_A)
        .bind(cohort_ts)
        .execute(&pool)
        .await
        .unwrap();

        let space = crate::space::SpaceId::from_trusted("01HZ00000000000000000000S1");
        let mut conn = pool.acquire().await.expect("acquire");
        // Inbound edit to the parent, then the bulk re-projection of the child.
        let parent_snap = snapshot(BLOCK_A, "content", "parent-edited", None, 0);
        let child_snap = snapshot(CHILD, "content", "child", Some(BLOCK_A), 0);
        project_block_full_to_sql(
            &mut conn,
            &space,
            &BlockId::from_trusted(BLOCK_A),
            Some(&parent_snap),
        )
        .await
        .expect("project parent");
        project_block_full_to_sql(
            &mut conn,
            &space,
            &BlockId::from_trusted(CHILD),
            Some(&child_snap),
        )
        .await
        .expect("project child");
        drop(conn);

        for id in [BLOCK_A, CHILD] {
            let row: (Option<i64>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .expect("fetch deleted_at");
            assert_eq!(
                row.0,
                Some(cohort_ts),
                "{id} must stay soft-deleted after re-projection"
            );
        }
    }

    #[tokio::test]
    async fn project_block_full_inserts_new_block() {
        // A block not yet present in SQL (created on a remote peer) is
        // inserted via the INSERT side of the upsert.
        let (pool, _dir) = fresh_pool().await;
        let space = crate::space::SpaceId::from_trusted("01HZ00000000000000000000S1");
        let bid = BlockId::from_trusted(BLOCK_A);
        let snap = snapshot(BLOCK_A, "content", "remote-created", None, 4);

        let mut conn = pool.acquire().await.expect("acquire");
        project_block_full_to_sql(&mut conn, &space, &bid, Some(&snap))
            .await
            .expect("project full insert");
        drop(conn);

        let row: (String, String, Option<String>, i64) = sqlx::query_as(
            "SELECT block_type, content, parent_id, position FROM blocks WHERE id = ?",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch row");
        assert_eq!(row.0, "content");
        assert_eq!(row.1, "remote-created");
        assert_eq!(row.2, None);
        assert_eq!(row.3, 4);
    }

    // ---------------------------------------------------------------------
    // PEND-76 F1 — inbound property re-projection into block_properties.
    // ---------------------------------------------------------------------

    /// Seed the `property_definitions` rows the re-projection consults to
    /// recover SQL types, plus the owning block row (block_properties FK).
    async fn seed_block_and_property_defs(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(pool)
        .await
        .unwrap();
        // `INSERT OR REPLACE` so these test-chosen types win over any
        // builtin seed (e.g. migration 0014 seeds `effort` as `select`).
        for (key, value_type) in [
            ("note", "text"),
            ("effort", "number"),
            ("done", "boolean"),
            ("due", "date"),
            ("link", "ref"),
        ] {
            sqlx::query(
                "INSERT OR REPLACE INTO property_definitions (key, value_type, created_at) \
                 VALUES (?, ?, '2026-01-01T00:00:00Z')",
            )
            .bind(key)
            .bind(value_type)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn reproject_routes_values_into_typed_columns() {
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_property_defs(&pool).await;

        let bid = BlockId::from_trusted(BLOCK_A);
        // Native typed values (PEND-80 Phase 4): Num/Bool route directly to
        // value_num/value_bool with no string round-trip or value_type lookup.
        let props = vec![
            ("note".to_string(), pv("hello")),
            ("effort".to_string(), PropertyValue::Num(2.5)),
            ("done".to_string(), PropertyValue::Bool(true)),
            ("due".to_string(), pv("2026-01-01")),
        ];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject");
        drop(conn);

        // text → value_text only.
        let note: PropValueColumns = sqlx::query_as(
            "SELECT value_text, value_num, value_date, value_ref, value_bool \
                 FROM block_properties WHERE block_id = ? AND key = 'note'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch note");
        assert_eq!(note, (Some("hello".into()), None, None, None, None));

        // number → value_num only (parsed to f64).
        let effort: (Option<String>, Option<f64>) = sqlx::query_as(
            "SELECT value_text, value_num FROM block_properties \
             WHERE block_id = ? AND key = 'effort'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch effort");
        assert_eq!(effort, (None, Some(2.5)));

        // boolean → value_bool only ("true" → 1).
        let done: (Option<i64>, Option<String>) = sqlx::query_as(
            "SELECT value_bool, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'done'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch done");
        assert_eq!(done, (Some(1), None));

        // date → value_date only.
        let due: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT value_date, value_text FROM block_properties \
             WHERE block_id = ? AND key = 'due'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch due");
        assert_eq!(due, (Some("2026-01-01".into()), None));
    }

    #[tokio::test]
    async fn reproject_undefined_key_defaults_to_text() {
        // A key with no property_definitions row must default to the
        // text column rather than erroring.
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let bid = BlockId::from_trusted(BLOCK_A);
        let props = vec![("mystery".to_string(), pv("raw"))];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject undefined");
        drop(conn);

        let row: (Option<String>,) = sqlx::query_as(
            "SELECT value_text FROM block_properties WHERE block_id = ? AND key = 'mystery'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch mystery");
        assert_eq!(row.0, Some("raw".into()));
    }

    #[tokio::test]
    async fn reproject_clears_stale_rows_and_skips_reserved_keys() {
        // Pre-seed a stale property row; a re-projection whose `props`
        // omit it must sweep it (remote-delete propagation).  A reserved
        // key in `props` must NOT land in block_properties.
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_property_defs(&pool).await;
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) \
             VALUES (?, 'stale', 'gone-after-resync')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let bid = BlockId::from_trusted(BLOCK_A);
        // New engine state: only `note`, plus a reserved key that must
        // be skipped.  `stale` is absent → must be deleted.
        let props = vec![
            ("note".to_string(), pv("kept")),
            ("todo_state".to_string(), pv("DOING")),
        ];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject");
        drop(conn);

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT key FROM block_properties WHERE block_id = ? ORDER BY key")
                .bind(BLOCK_A)
                .fetch_all(&pool)
                .await
                .expect("fetch keys");
        let keys: Vec<String> = rows.into_iter().map(|r| r.0).collect();
        assert_eq!(
            keys,
            vec!["note".to_string()],
            "stale row swept, reserved key skipped, only `note` remains"
        );
    }

    #[tokio::test]
    async fn reproject_routes_ref_value() {
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_property_defs(&pool).await;

        // value_ref has a FK to blocks(id); point at the seeded BLOCK_A.
        let bid = BlockId::from_trusted(BLOCK_A);
        let props = vec![("link".to_string(), pv(BLOCK_A))];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject");
        drop(conn);

        let link: PropValueColumns = sqlx::query_as(
            "SELECT value_text, value_num, value_date, value_ref, value_bool \
                 FROM block_properties WHERE block_id = ? AND key = 'link'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch link");
        // ref value lands in value_ref (4th canonical column).
        assert_eq!(link, (None, None, None, Some(BLOCK_A.into()), None));
    }

    #[tokio::test]
    async fn reproject_native_num_ignores_diverged_value_type_and_avoids_fk_abort() {
        // PEND-80 Phase 4: a native `Num` routes straight to value_num,
        // ignoring `property_definitions.value_type`. This is the safety
        // win over the old string+value_type path: if a key is declared
        // `ref` here (e.g. a cross-peer definition divergence) but the
        // engine value is a native number, the old code would render "42",
        // route it to value_ref, and hit the `value_ref REFERENCES blocks(id)`
        // FK → abort the whole inbound-sync tx. The typed path writes
        // value_num and never touches the FK.
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_property_defs(&pool).await; // seeds `link` as `ref`

        let bid = BlockId::from_trusted(BLOCK_A);
        let props = vec![("link".to_string(), PropertyValue::Num(42.0))];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("native Num under a ref-declared key must not FK-abort");
        drop(conn);

        let row: (Option<f64>, Option<String>) = sqlx::query_as(
            "SELECT value_num, value_ref FROM block_properties \
             WHERE block_id = ? AND key = 'link'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch link");
        assert_eq!(
            row,
            (Some(42.0), None),
            "native Num routes to value_num, never value_ref"
        );
    }

    #[tokio::test]
    async fn reproject_skips_null_and_unparseable_values_without_violating_check() {
        // Regression for the `block_properties.exactly_one_value` CHECK
        // (migration 0062): an explicit-null value and a `number` value
        // whose string doesn't parse both route to no column. They must be
        // skipped (row-absent), NOT inserted as an all-NULL row — otherwise
        // the INSERT fails the CHECK and aborts the whole inbound-sync tx.
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_property_defs(&pool).await;
        // Pre-seed a stale `note` row so we also confirm the up-front DELETE
        // still clears it even when every replacement value is skipped.
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'note', 'stale')",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();

        let bid = BlockId::from_trusted(BLOCK_A);
        let props = vec![
            ("note".to_string(), PropertyValue::Null), // explicit null (cleared)
            ("effort".to_string(), pv("not-a-number")), // number-typed Str that won't parse
        ];
        let mut conn = pool.acquire().await.expect("acquire");
        // Must NOT error (no CHECK violation, no tx abort).
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject must succeed for null / unparseable values");
        drop(conn);

        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("count");
        assert_eq!(
            count.0, 0,
            "null/unparseable values produce no row; stale row swept"
        );
    }

    #[tokio::test]
    async fn reproject_routes_reserved_keys_to_blocks_columns() {
        // PEND-81 §2A: reserved hot-path keys must land on the dedicated
        // `blocks` columns (todo_state / priority / due_date /
        // scheduled_date), NOT in block_properties.
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_property_defs(&pool).await;

        let bid = BlockId::from_trusted(BLOCK_A);
        let props = vec![
            ("todo_state".to_string(), pv("DOING")),
            ("priority".to_string(), pv("A")),
            ("due_date".to_string(), pv("2026-02-01")),
            ("scheduled_date".to_string(), pv("2026-01-15")),
        ];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject reserved keys");
        drop(conn);

        let row: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT todo_state, priority, due_date, scheduled_date FROM blocks WHERE id = ?",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch reserved columns");
        assert_eq!(
            row,
            (
                Some("DOING".into()),
                Some("A".into()),
                Some("2026-02-01".into()),
                Some("2026-01-15".into()),
            ),
            "reserved keys routed to their dedicated blocks columns"
        );

        // None of them leaked into block_properties.
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("count props");
        assert_eq!(count.0, 0, "reserved keys never land in block_properties");
    }

    #[tokio::test]
    async fn reproject_clears_reserved_key_absent_from_props() {
        // A reserved key set on a first sync, then absent (cleared / deleted
        // on the remote) on a re-sync, must NULL its blocks column —
        // authoritative-replace, mirroring a remote DeleteProperty.
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_property_defs(&pool).await;
        let bid = BlockId::from_trusted(BLOCK_A);

        // Sync 1 — todo_state + due_date present.
        let props1 = vec![
            ("todo_state".to_string(), pv("TODO")),
            ("due_date".to_string(), pv("2026-03-03")),
        ];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props1)
            .await
            .expect("reproject 1");
        drop(conn);

        // Sync 2 — both absent (cleared on remote).
        let props2: Vec<(String, PropertyValue)> = vec![];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props2)
            .await
            .expect("reproject 2");
        drop(conn);

        let row: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT todo_state, due_date FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch reserved columns");
        assert_eq!(
            row,
            (None, None),
            "reserved keys absent from props on re-sync are NULLed"
        );
    }

    // ---------------------------------------------------------------------
    // PEND-81 §2A — inbound tag re-projection into block_tags.
    // ---------------------------------------------------------------------

    /// Seed the owning block plus two tag blocks so the `block_tags` FK
    /// (`tag_id` → `blocks(id)`) is satisfied for the re-projection tests.
    async fn seed_block_and_tag_blocks(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, 0)",
        )
        .bind(BLOCK_A)
        .execute(pool)
        .await
        .unwrap();
        for (id, label) in [(BLOCK_B, "tag-X"), (TAG_C, "tag-Y")] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'tag', ?, NULL, 0)",
            )
            .bind(id)
            .bind(label)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn reproject_tags_routes_multiple_tags() {
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_tag_blocks(&pool).await;

        let bid = BlockId::from_trusted(BLOCK_A);
        let tag_ids = vec![BLOCK_B.to_string(), TAG_C.to_string()];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_tags_from_engine(&mut conn, &bid, &tag_ids)
            .await
            .expect("reproject tags");
        drop(conn);

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT tag_id FROM block_tags WHERE block_id = ? ORDER BY tag_id")
                .bind(BLOCK_A)
                .fetch_all(&pool)
                .await
                .expect("fetch tag_ids");
        let ids: Vec<String> = rows.into_iter().map(|r| r.0).collect();
        assert_eq!(
            ids,
            vec![BLOCK_B.to_string(), TAG_C.to_string()],
            "both tag edges must be projected"
        );
    }

    #[tokio::test]
    async fn reproject_tags_sweeps_stale_tag_on_resync() {
        // A first projection routes two tags; a second projection whose
        // `tag_ids` omits one must sweep the stale edge (remote-removal
        // propagation via the authoritative-replace DELETE).
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_tag_blocks(&pool).await;

        let bid = BlockId::from_trusted(BLOCK_A);
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_tags_from_engine(
            &mut conn,
            &bid,
            &[BLOCK_B.to_string(), TAG_C.to_string()],
        )
        .await
        .expect("first reproject");
        // Resync: TAG_C removed on the remote → absent from the engine list.
        reproject_block_tags_from_engine(&mut conn, &bid, &[BLOCK_B.to_string()])
            .await
            .expect("second reproject");
        drop(conn);

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT tag_id FROM block_tags WHERE block_id = ? ORDER BY tag_id")
                .bind(BLOCK_A)
                .fetch_all(&pool)
                .await
                .expect("fetch tag_ids");
        let ids: Vec<String> = rows.into_iter().map(|r| r.0).collect();
        assert_eq!(
            ids,
            vec![BLOCK_B.to_string()],
            "stale TAG_C edge swept; only BLOCK_B remains"
        );
    }

    #[tokio::test]
    async fn reproject_tags_skips_dangling_tag_id_without_fk_abort() {
        // A tag_id with no `blocks` row — e.g. a purged tag block leaves a
        // dangling element in another block's engine tag list — must be
        // dropped, NOT FK-abort the inbound-sync tx. `INSERT OR IGNORE` does
        // not suppress FK violations, so the helper gates on existence.
        let (pool, _dir) = fresh_pool().await;
        seed_block_and_tag_blocks(&pool).await;

        let bid = BlockId::from_trusted(BLOCK_A);
        let tag_ids = vec![
            BLOCK_B.to_string(),                      // exists → projected
            "01J0000000000000000000000Z".to_string(), // dangling → dropped
        ];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_tags_from_engine(&mut conn, &bid, &tag_ids)
            .await
            .expect("must not FK-abort on a dangling tag id");
        drop(conn);

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT tag_id FROM block_tags WHERE block_id = ? ORDER BY tag_id")
                .bind(BLOCK_A)
                .fetch_all(&pool)
                .await
                .expect("fetch tag_ids");
        let ids: Vec<String> = rows.into_iter().map(|r| r.0).collect();
        assert_eq!(
            ids,
            vec![BLOCK_B.to_string()],
            "dangling tag id dropped; the valid edge is still projected"
        );
    }
}
