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
    sqlx::query(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&snapshot.block_id)
    .bind(&snapshot.block_type)
    .bind(&snapshot.content)
    .bind(snapshot.parent_id.as_deref())
    .bind(snapshot.position)
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
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(&snapshot.content)
        .bind(&snapshot.block_id)
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
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(payload.block_id.as_str())
        .bind(&payload.key)
        .bind(&payload.value_text)
        .bind(payload.value_num)
        .bind(&payload.value_date)
        .bind(&payload.value_ref)
        .bind(value_bool_int)
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
    sqlx::query("DELETE FROM block_tags WHERE block_id = ?")
        .bind(block_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM block_properties WHERE block_id = ?")
        .bind(block_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM blocks WHERE id = ?")
        .bind(block_id)
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
    deleted_at: &str,
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
    sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
        .bind(snapshot.parent_id.as_deref())
        .bind(snapshot.position)
        .bind(&snapshot.block_id)
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
    deleted_at_ref: &str,
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
        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(block_id)
            .bind(key)
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
    sqlx::query("INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
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
    sqlx::query("DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?")
        .bind(block_id)
        .bind(tag_id)
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
///   (`SESSION-LOG.md` Session 699 Phase 3 §3 day 4) defers the
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
            sqlx::query(
                "INSERT INTO blocks \
                     (id, block_type, content, parent_id, position) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                     block_type = excluded.block_type, \
                     content = excluded.content, \
                     parent_id = excluded.parent_id, \
                     position = excluded.position",
            )
            .bind(&snap.block_id)
            .bind(&snap.block_type)
            .bind(&snap.content)
            .bind(snap.parent_id.as_deref())
            .bind(snap.position)
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
/// `block_properties` table after a sync-pull import.
///
/// This closes the PEND-76 F1 property-propagation residual:
/// [`project_block_full_to_sql`] deliberately touches only the core
/// `blocks` columns, so remote `SetProperty` / `DeleteProperty` changes
/// would otherwise never reach SQL.  `apply_remote` calls this helper
/// per changed block with the engine's post-import property snapshot
/// (`props`, from [`crate::loro::engine::LoroEngine::read_all_properties`]).
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
/// ## Typed-column routing
///
/// The engine compresses each value to a single string (or explicit
/// null); the SQL types are recovered from `property_definitions.value_type`
/// (defaulting to `"text"` if the key has no definition row).  The
/// `value: Option<String>` is routed into exactly one typed column per
/// the value type; the others stay NULL.  An explicit-null value
/// (`None`), or a `number` whose string fails to parse, routes to no
/// column — and since `block_properties` has an `exactly_one_value`
/// CHECK (migration 0062) that forbids an all-NULL row, such a value is
/// represented as row-absent (no INSERT; the up-front DELETE already
/// cleared any prior row), matching "cleared property" semantics.
///
/// ## Reserved keys are out of scope
///
/// Reserved property keys (`todo_state`, `priority`, `due_date`,
/// `scheduled_date`) live on dedicated `blocks` columns, not in
/// `block_properties`, so they are skipped here.  Re-projecting those
/// hot-path columns from the engine on inbound sync is a follow-up
/// (it must coordinate with `project_block_full_to_sql`'s deliberate
/// non-touching of those columns to avoid resurrecting soft-deleted
/// cohorts).
pub async fn reproject_block_properties_from_engine(
    conn: &mut SqliteConnection,
    block_id: &crate::ulid::BlockId,
    props: &[(String, Option<String>)],
) -> Result<(), AppError> {
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
    sqlx::query("DELETE FROM block_properties WHERE block_id = ?")
        .bind(block_id.as_str())
        .execute(&mut *conn)
        .await?;

    for (key, value) in props {
        if is_reserved_property_key(key) {
            // Reserved keys map to dedicated `blocks` columns, never
            // `block_properties`.  Skip (see fn-level doc / follow-up).
            continue;
        }

        // Recover the SQL type from the property definition; default to
        // "text" for an undefined key (warn once so a missing definition
        // is observable without spamming the log per-property).
        let value_type: String =
            sqlx::query_scalar("SELECT value_type FROM property_definitions WHERE key = ?")
                .bind(key)
                .fetch_optional(&mut *conn)
                .await?
                .unwrap_or_else(|| {
                    tracing::warn!(
                        key = %key,
                        block_id = %block_id.as_str(),
                        "reproject_block_properties_from_engine: no property_definitions row; \
                         defaulting to 'text'"
                    );
                    "text".to_string()
                });

        // Route the single string value into exactly one typed column.
        let mut value_text: Option<&str> = None;
        let mut value_num: Option<f64> = None;
        let mut value_date: Option<&str> = None;
        let mut value_ref: Option<&str> = None;
        let mut value_bool: Option<i64> = None;
        match value_type.as_str() {
            "number" => value_num = value.as_deref().and_then(|s| s.parse::<f64>().ok()),
            "boolean" => value_bool = value.as_deref().map(|s| i64::from(s == "true")),
            "date" => value_date = value.as_deref(),
            "ref" => value_ref = value.as_deref(),
            // "select" | "text" | anything unrecognised → text column.
            _ => value_text = value.as_deref(),
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

        sqlx::query(
            "INSERT INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(block_id.as_str())
        .bind(key)
        .bind(value_text)
        .bind(value_num)
        .bind(value_date)
        .bind(value_ref)
        .bind(value_bool)
        .execute(&mut *conn)
        .await?;
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
    use crate::op::SetPropertyPayload;
    use crate::ulid::BlockId;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const BLOCK_A: &str = "01HZ00000000000000000000A1";
    const BLOCK_B: &str = "01HZ00000000000000000000B2";

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
             VALUES (?, 'content', 'original', NULL, 0, '2026-01-01T00:00:00Z')",
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

        let deleted_at = "2026-05-10T12:00:00Z";
        let mut conn = pool.acquire().await.expect("acquire");
        project_delete_block_to_sql(&mut conn, BLOCK_A, deleted_at)
            .await
            .expect("project delete");
        drop(conn);

        let row: (Option<String>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(row.0.as_deref(), Some(deleted_at));
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

        let first_ts = "2026-05-10T12:00:00Z";
        let second_ts = "2026-05-11T15:00:00Z";
        let mut conn = pool.acquire().await.expect("acquire");
        project_delete_block_to_sql(&mut conn, BLOCK_A, first_ts)
            .await
            .expect("first delete");
        project_delete_block_to_sql(&mut conn, BLOCK_A, second_ts)
            .await
            .expect("second delete (should no-op)");
        drop(conn);

        let row: (Option<String>,) = sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(
            row.0.as_deref(),
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
        let cohort_ts = "2026-05-10T12:00:00Z";

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
            let row: (Option<String>,) =
                sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
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
        let cohort_ts = "2026-05-10T12:00:00Z";
        let other_ts = "2025-01-01T00:00:00Z";

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

        let parent_row: (Option<String>,) =
            sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch parent");
        assert_eq!(parent_row.0, None);

        // CHILD_OTHER stays soft-deleted.
        let child_row: (Option<String>,) =
            sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                .bind(CHILD_OTHER)
                .fetch_one(&pool)
                .await
                .expect("fetch other child");
        assert_eq!(
            child_row.0.as_deref(),
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
             VALUES (?, 'content', 'original', NULL, 0, '2026-01-01T00:00:00Z', 'DOING')",
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
        let preserved: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT deleted_at, todo_state FROM blocks WHERE id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .expect("fetch preserved cols");
        assert_eq!(
            preserved.0.as_deref(),
            Some("2026-01-01T00:00:00Z"),
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
        let cohort_ts = "2026-05-10T12:00:00Z";

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
            let row: (Option<String>,) =
                sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .expect("fetch deleted_at");
            assert_eq!(
                row.0.as_deref(),
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
        let props = vec![
            ("note".to_string(), Some("hello".to_string())),
            ("effort".to_string(), Some("3.14".to_string())),
            ("done".to_string(), Some("true".to_string())),
            ("due".to_string(), Some("2026-01-01".to_string())),
        ];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject");
        drop(conn);

        // text → value_text only.
        let note: (
            Option<String>,
            Option<f64>,
            Option<String>,
            Option<String>,
            Option<i64>,
        ) = sqlx::query_as(
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
        assert_eq!(effort, (None, Some(3.14)));

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
        let props = vec![("mystery".to_string(), Some("raw".to_string()))];
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
            ("note".to_string(), Some("kept".to_string())),
            ("todo_state".to_string(), Some("DOING".to_string())),
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
        let props = vec![("link".to_string(), Some(BLOCK_A.to_string()))];
        let mut conn = pool.acquire().await.expect("acquire");
        reproject_block_properties_from_engine(&mut conn, &bid, &props)
            .await
            .expect("reproject");
        drop(conn);

        let link: (
            Option<String>,
            Option<String>,
            Option<f64>,
            Option<String>,
            Option<i64>,
        ) = sqlx::query_as(
            "SELECT value_ref, value_text, value_num, value_date, value_bool \
                 FROM block_properties WHERE block_id = ? AND key = 'link'",
        )
        .bind(BLOCK_A)
        .fetch_one(&pool)
        .await
        .expect("fetch link");
        assert_eq!(link, (Some(BLOCK_A.into()), None, None, None, None));
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
            ("note".to_string(), None), // explicit null (cleared)
            ("effort".to_string(), Some("not-a-number".to_string())), // number that won't parse
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
}
