//! PEND-09 Phase 2 day-11 — Loro-to-SQL projection helpers.
//!
//! ## Why this module exists
//!
//! The cutover plan §3 day-9 + §8.4 calls for a reorder where, when
//! `is_loro_authoritative()` returns `true`, the materializer applies
//! each op to the per-space [`crate::loro::engine::LoroEngine`] FIRST,
//! reads the post-apply state, and PROJECTS that state into SQL — so
//! the SQL `blocks` / `block_properties` / `block_tags` rows are
//! derived from the CRDT, not computed by diffy.
//!
//! Each function in this module is a per-op-type projection helper:
//! given a typed payload (or a read-back snapshot from the engine) and
//! a borrowed `&mut SqliteConnection` from the caller's transaction, it
//! writes the SQL rows that mirror the engine's post-apply state.
//!
//! ## Atomic semantics
//!
//! Each helper uses the SAME `&mut SqliteConnection` the caller is
//! using.  If the projection fails, the caller's transaction rolls
//! back (no partial SQL state escapes); but the engine state is NOT
//! rolled back (Loro 1.x does not expose a transaction primitive we
//! can wrap).  This trade-off is acceptable because the op_log is the
//! source of truth: a snapshot+replay rebuilds engine state from the
//! same op_log the materializer reads.  See
//! `pending/PEND-09-apply-op-reorder.md` §5 for the full rationale.
//!
//! ## Coverage
//!
//! Day-11 shipped Create / Edit / SetProperty / Purge (with unit tests).
//! Day-12 added Delete + Move (with cascade UPDATE for delete).
//! **Day-13** adds the final five op types: Restore, DeleteProperty,
//! AddTag, RemoveTag (with the `apply_*_via_loro` wrappers in
//! `materializer/handlers.rs` running the post-projection
//! `tag_inheritance::*` calls AFTER the projection, exactly as the
//! diffy-side path does), and PurgeBlock's cutover branch wired
//! through.  All 12 op types now have projection helpers + cutover
//! branches; only the two attachment ops bypass the projection (per
//! the cutover plan §8.2 — file blobs live outside CRDT state).
//!
//! ## What this module does NOT do
//!
//! - Run the engine apply.  The caller is responsible for invoking
//!   `engine.apply_*` and reading back the post-apply state before
//!   calling these projection helpers.  This split keeps the engine
//!   guard's lifetime bounded (the projection runs after the guard is
//!   dropped) and makes the helpers unit-testable from synthetic
//!   payloads.
//! - Project attachment ops.  `AddAttachment` / `DeleteAttachment`
//!   carry file blobs that live outside the CRDT state per the cutover
//!   plan §8.2; their SQL UPDATEs continue to run unconditionally on
//!   the diffy-side path regardless of the cutover flag.
//! - Rebuild derived caches (`block_links`, `block_tag_inherited`).
//!   The caller continues to invoke `cache::reindex_*` /
//!   `tag_inheritance::*` AFTER projection, exactly as today's
//!   `apply_*_tx` helpers do — only the source of truth (engine vs
//!   diffy) shifts.

use sqlx::SqliteConnection;

use crate::error::AppError;
use crate::loro::engine::BlockSnapshot;
use crate::op::{is_reserved_property_key, SetPropertyPayload};

/// Project a `CreateBlock` engine state into SQL.  Mirrors the
/// existing `apply_create_block_tx` shape so that flipping the cutover
/// flag does not change the written SQL row's columns.
///
/// `snapshot` is the engine's read-back state for the freshly-created
/// block (after `engine.apply_create_block(...)` ran).  `payload.position`
/// is `Option<i64>` on the payload but the engine flattens to `i64`,
/// so the snapshot's `position` is the source of truth here.
///
/// **Note on `tag_inheritance::inherit_parent_tags`.**  Today's
/// `apply_create_block_tx` invokes this helper as the second step.
/// The projection helper does **not** call it — the caller (the
/// branch in `apply_op_tx`) is responsible for invoking it after the
/// projection, mirroring the diffy-side ordering.  Keeps the helper
/// pure (just the row INSERT) so it's directly unit-testable.
pub async fn project_create_block_to_sql(
    conn: &mut SqliteConnection,
    snapshot: &BlockSnapshot,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position, is_conflict) \
         VALUES (?, ?, ?, ?, ?, 0)",
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

/// Project an `EditBlock` engine state into SQL.  Mirrors
/// `apply_edit_block_tx`'s `UPDATE blocks SET content = ? WHERE id = ?
/// AND deleted_at IS NULL` shape — the only difference is the
/// `content` value comes from the engine's post-apply read-back, not
/// the payload's `to_text` field directly.  In a single-author
/// scenario the two are identical; in a concurrent-edit scenario the
/// engine's character-level merge produces different content from
/// either peer's `to_text` (that's the headline win of the cutover).
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

/// Project a `SetProperty` engine state into SQL.  Mirrors the per-key
/// match in `apply_set_property_tx`:
///
/// - **Reserved keys** (`todo_state`, `priority`, `due_date`,
///   `scheduled_date`) update the dedicated `blocks` column, NOT
///   `block_properties`.
/// - **Non-reserved keys** INSERT-OR-REPLACE a row in
///   `block_properties` with the typed value columns set per the
///   payload.
///
/// Today's diffy-side helper takes a `SetPropertyPayload` and reads
/// the value fields directly off it.  The projection helper does the
/// same — the engine's post-apply state for a property is "the value
/// just written", which equals the payload's value field by
/// construction.  We keep the payload reference rather than going
/// through `engine.read_property` because the property's typed-vs-text
/// shape (`value_num`, `value_date`, `value_ref`, `value_bool`) is
/// flattened to a single string in the engine; SQL needs the typed
/// columns separately.
///
/// This is the engine-state-vs-payload-state asymmetry the cutover
/// plan §8.2 calls out: the engine compresses to "a string", SQL
/// preserves the typed shape for read-side filters
/// (`WHERE value_num > ?` etc.).  Day-11 keeps the typed-shape source
/// of truth on the payload side — the engine's post-apply state on
/// `block_properties` is "this key was set"; the typed value flows
/// through unchanged.
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

/// Project a `PurgeBlock` engine state into SQL.  Hard-delete: the
/// row in `blocks` plus the row in `block_properties` plus rows in
/// `block_tags` keyed on this `block_id`.
///
/// **Day-11 simplification.**  Today's full `apply_purge_block_tx`
/// runs a 15-statement cascade against a TEMP table of descendants —
/// the cascade walks `block_tags`, `block_tag_inherited`,
/// `block_properties`, `block_links`, `agenda_cache`, `tags_cache`,
/// `pages_cache`, `attachments`, `block_drafts`, `conflict_source`,
/// `fts_blocks`, `page_aliases`, `projected_agenda_cache`, then
/// `blocks`.  The projection helper here only handles the per-block-id
/// rows in the three tables the engine knows about (`blocks`,
/// `block_properties`, `block_tags`).  The full descendant cascade
/// remains with the SQL-side `apply_purge_block_tx` and does NOT move
/// into the projection — when the cutover branch runs, it invokes the
/// engine's `apply_purge_block` (per-block-id) for the seed AND every
/// descendant, then runs `apply_purge_block_tx` for the SQL-side
/// cascade unchanged.  Keeping the SQL cascade outside the projection
/// keeps day-11's scope bounded.  Day-12+ may consolidate.
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

/// Project a `DeleteBlock` engine state into SQL.  The engine's
/// `apply_delete_block` writes a fixed-marker `deleted_at` value (the
/// CRDT only needs to know "deleted vs not"); the SQL side stamps the
/// real timestamp from `record.created_at` so `block_lifecycle`
/// reports / restore-cohort lookups remain accurate.  The caller passes
/// the timestamp string explicitly rather than reading it back from
/// the engine — see `apply_delete_block_via_loro` for the wiring.
///
/// **Cascade scope.**  This projection only updates the per-block row.
/// The diffy-side `apply_delete_block_tx` walks the descendant CTE and
/// soft-deletes every active descendant in one UPDATE; the cutover-on
/// path keeps that cascade behaviour by running the same CTE-driven
/// UPDATE here.  The engine's `apply_delete_block` is per-block-id only,
/// so the engine-side fan-out for descendants is a separate concern
/// (today's diffy path only calls the engine on the seed; a complete
/// cutover-on cascade fanout is a follow-up — same shape as
/// `dispatch_restore_descendants_shadow`).  Day-12 keeps the projection
/// behaviour SQL-equivalent to the diffy path.
///
/// **Idempotence.**  The `WHERE deleted_at IS NULL` filter on the CTE
/// makes a re-apply a no-op for rows already soft-deleted at any earlier
/// timestamp.
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
/// **Sibling-shift.**  The diffy-side `apply_move_block_tx` does NOT
/// shift sibling positions either: a `MoveBlock` op's `new_position` is
/// taken at face value, with whatever ordering collisions accepting the
/// LWW outcome.  Loro's per-key LWW means two devices moving distinct
/// blocks to the same position resolve to the same final state on both
/// sides (same `(parent_id, position)` per block), and a single SQL row
/// per block keeps the projection 1:1 with the engine state.  Net: no
/// sibling-shift on either side.  Position uniqueness is not enforced
/// in the schema; concurrent moves to the same position are an
/// application-layer concern.
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

/// Project a `RestoreBlock` engine state into SQL.  Mirrors the cohort
/// UPDATE in `apply_restore_block_tx` — clears `deleted_at` for every
/// block in the descendant CTE that was soft-deleted at the same
/// `deleted_at_ref` timestamp.
///
/// **Engine fan-out trade-off (day-13).**  The engine's
/// `apply_restore_block` is per-block-id only, so the cutover-on path
/// only applies the SEED block to the engine.  The descendant cohort's
/// engine state is NOT reconciled by the projection — it relies on
/// `dispatch_restore_descendants_shadow` running post-commit (which
/// already exists from day-9).  This matches day-12's delete-cascade
/// approach: SQL handles the full cohort; engine state for descendants
/// will be reconciled by op-log replay if/when the engine is rebuilt.
/// The cohort-fanout-on-engine integration is a day-14+ TODO — same
/// shape as the delete-cascade fanout.
///
/// **Idempotence.**  The `WHERE deleted_at = ?` filter on the CTE makes
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

/// Project an `AddTag` engine state into SQL.  Mirrors the
/// `INSERT OR IGNORE INTO block_tags` shape of `apply_add_tag_tx`.
///
/// **Note on `tag_inheritance::propagate_tag_to_descendants`.**  The
/// caller (the cutover branch in `apply_op_tx`) is responsible for
/// invoking it AFTER the projection, mirroring the diffy-side ordering.
/// Keeps the helper pure.
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

/// PEND-09 Phase 3 day-4 — project an engine-side block snapshot to
/// SQL after a sync-pull import.  Drives the `apply_remote` side of
/// [`crate::sync_protocol::loro_sync`].
///
/// Behaviour:
///
/// * `Some(snapshot)` → `INSERT OR REPLACE` the `blocks` row with
///   `(id, block_type, content, parent_id, position, is_conflict=0)`.
///   Other columns (`deleted_at`, reserved-property hot-path columns)
///   are left to per-op projection helpers running alongside this
///   one — day-4's scope is the core block shape that
///   [`crate::loro::engine::BlockSnapshot`] carries.  Day-5 / day-12
///   may extend.
/// * `None` → engine has no record of `block_id`.  The plan
///   (`pending/PEND-09-PHASE-3-PLAN.md` §3 day 4) defers the
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
                "INSERT OR REPLACE INTO blocks \
                     (id, block_type, content, parent_id, position, is_conflict) \
                 VALUES (?, ?, ?, ?, ?, 0)",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', 'original', NULL, 0, 0)",
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
                (id, block_type, content, parent_id, position, is_conflict, deleted_at) \
             VALUES (?, 'content', 'original', NULL, 0, 0, '2026-01-01T00:00:00Z')",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', '', NULL, 0, 0)",
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
            "reserved key must NOT write to block_properties (matches diffy-side semantics)"
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', 'doomed', NULL, 0, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        // Tag-block (referenced by block_tags FK).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'tag', 'tag-X', NULL, 0, 0)",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', 'soon-deleted', NULL, 0, 0)",
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
        // first soft-delete's timestamp — mirrors the diffy-side
        // `WHERE deleted_at IS NULL` filter.  The cohort identity in
        // RestoreBlock relies on the same timestamp persisting across
        // re-applies of the delete op.
        let (pool, _dir) = fresh_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', 'doomed', NULL, 0, 0)",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'page', 'old-parent', NULL, 0, 0)",
        )
        .bind(BLOCK_B)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', 'child', ?, 3, 0)",
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
                 (id, block_type, content, parent_id, position, is_conflict, deleted_at) \
             VALUES (?, 'content', 'parent', NULL, 0, 0, ?)",
        )
        .bind(BLOCK_A)
        .bind(cohort_ts)
        .execute(&pool)
        .await
        .unwrap();
        for child in [CHILD_1, CHILD_2] {
            sqlx::query(
                "INSERT INTO blocks \
                     (id, block_type, content, parent_id, position, is_conflict, deleted_at) \
                 VALUES (?, 'content', 'child', ?, 0, 0, ?)",
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
                 (id, block_type, content, parent_id, position, is_conflict, deleted_at) \
             VALUES (?, 'content', 'parent', NULL, 0, 0, ?)",
        )
        .bind(BLOCK_A)
        .bind(cohort_ts)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, is_conflict, deleted_at) \
             VALUES (?, 'content', 'old-deletion-child', ?, 0, 0, ?)",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', '', NULL, 0, 0)",
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
                 (id, block_type, content, parent_id, position, is_conflict, todo_state) \
             VALUES (?, 'content', '', NULL, 0, 0, 'DOING')",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', '', NULL, 0, 0)",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', '', NULL, 0, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'tag', 'tag-X', NULL, 0, 0)",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', '', NULL, 0, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'tag', 'tag-X', NULL, 0, 0)",
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
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', '', NULL, 0, 0)",
        )
        .bind(BLOCK_A)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'tag', 'tag-X', NULL, 0, 0)",
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
}
