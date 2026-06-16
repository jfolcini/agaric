//! SQL-only apply fallbacks (`apply_*_sql_only`): the projection
//! path used when the Loro engine is unavailable / space unresolved.

use super::*;

/// SQL-only CreateBlock fallback.
pub(super) async fn apply_create_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: CreateBlockPayload,
) -> Result<(), AppError> {
    let parent_id_str = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
    let block_id_str = p.block_id.as_str();
    let parent_id_ref = parent_id_str.as_deref();
    // #400: a new-scheme op carries a 0-based `index` and no legacy `position`;
    // fall back to a 1-based position for this engine-less (test-only) path.
    let position = p.position.or_else(|| {
        p.index
            .map(crate::pagination::index_to_provisional_position)
    });
    // #1324: a page block's `page_id` is `id`, and the deferred
    // `SetBlockPageId` task is skipped for pages — so this engine-less fallback
    // must stamp it, else a replayed / space-unresolved page create lands with
    // NULL `page_id` and is invisible to `page_id`-scoped reads until a cache
    // rebuild. (The `page_id_self_for_pages` CHECK does not reject NULL — see
    // `loro/projection.rs`.) Non-page blocks keep NULL; the deferred task fills
    // them.
    let page_id = (p.block_type == "page").then_some(block_id_str);
    sqlx::query!(
        "INSERT OR IGNORE INTO blocks \
             (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, ?, ?, ?, ?, ?)",
        block_id_str,
        p.block_type,
        p.content,
        parent_id_ref,
        position,
        page_id,
    )
    .execute(&mut *conn)
    .await?;
    let parent_str = parent_id_str.as_deref();
    tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str).await?;
    Ok(())
}

/// SQL-only EditBlock fallback (formerly `apply_edit_block_tx`).
pub(super) async fn apply_edit_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: EditBlockPayload,
) -> Result<(), AppError> {
    let block_id_str = p.block_id.as_str();
    sqlx::query!(
        "UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL",
        p.to_text,
        block_id_str,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// SQL-only DeleteBlock fallback (formerly `apply_delete_block_tx`).
///
/// Cascade soft-delete: mark the target and every not-yet-deleted
/// descendant.  Mirror of the cascade in
/// `commands/blocks/crud.rs::delete_block_inner`, applied by the
/// materializer when the engine path can't resolve a space.
pub(super) async fn apply_delete_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteBlockPayload,
    now: i64,
) -> Result<(), AppError> {
    sqlx::query(concat!(
        crate::descendants_cte_active!(),
        "UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
    ))
    .bind(p.block_id.as_str())
    .bind(now)
    .execute(&mut *conn)
    .await?;
    tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// SQL-only RestoreBlock fallback (formerly `apply_restore_block_tx`).
pub(super) async fn apply_restore_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: RestoreBlockPayload,
) -> Result<(), AppError> {
    // #1055: cohort-contiguous walk (mirror `project_restore_block_to_sql`)
    // so the SQL-only fallback restores exactly the seed's connected
    // same-cohort subtree, not every block under the seed that merely
    // shares the `deleted_at` value (which collides across independent
    // deletes — `now_ms` is non-monotonic).
    sqlx::query(concat!(
        crate::descendants_cte_cohort!(),
        "UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
    ))
    .bind(p.block_id.as_str())
    .bind(p.deleted_at_ref)
    .bind(p.deleted_at_ref)
    .execute(&mut *conn)
    .await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// SQL-only MoveBlock fallback (formerly `apply_move_block_tx`).
pub(super) async fn apply_move_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: MoveBlockPayload,
) -> Result<(), AppError> {
    let new_parent_str = p.new_parent_id.as_ref().map(|id| id.as_str().to_owned());
    let new_parent_ref = new_parent_str.as_deref();
    let block_id_str = p.block_id.as_str();

    // #383: defensive cycle probe before the bare UPDATE. The engine path
    // (`commands/blocks/move_ops.rs::move_block_inner`) rejects a move that
    // would make the new parent a descendant of (or equal to) the block being
    // moved, but this SQL-only fallback wrote `parent_id` unconditionally — a
    // malformed/replayed op could install a parent_id cycle that then makes
    // every recursive CTE walk this subtree saturate at the depth-100 bound.
    // Mirror the cycle check from `move_block_inner`: walk the new parent's
    // ancestors (via `ancestors_cte_standard!`) and, if `block_id` appears
    // among them — or `new_parent == block_id` — skip the write and warn
    // rather than persisting the cycle. No-op-warn (not error) because this is
    // the sync-replay fallback arm; aborting would wedge inbound sync, whereas
    // dropping a self-evidently invalid move is recoverable.
    if let Some(parent) = new_parent_ref {
        let would_cycle = if parent == block_id_str {
            true
        } else {
            sqlx::query(concat!(
                crate::ancestors_cte_standard!(),
                "SELECT 1 FROM ancestors WHERE id = ?",
            ))
            .bind(parent)
            .bind(block_id_str)
            .fetch_optional(&mut *conn)
            .await?
            .is_some()
        };
        if would_cycle {
            tracing::warn!(
                block_id = %block_id_str,
                new_parent_id = %parent,
                "apply_move_block_sql_only: move would create a parent_id cycle \
                 (new parent is the block itself or one of its descendants); \
                 skipping the UPDATE (#383)"
            );
            return Ok(());
        }
    }

    // #400: prefer the new-scheme 0-based `new_index` (as a 1-based position)
    // on this engine-less (test-only) path; else the legacy `new_position`.
    let position = p
        .new_index
        .map(crate::pagination::index_to_provisional_position)
        .unwrap_or(p.new_position);
    sqlx::query!(
        "UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?",
        new_parent_ref,
        position,
        block_id_str,
    )
    .execute(&mut *conn)
    .await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// SQL-only AddTag fallback (formerly `apply_add_tag_tx`).
pub(super) async fn apply_add_tag_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: AddTagPayload,
) -> Result<(), AppError> {
    let block_id_str = p.block_id.as_str();
    let tag_id_str = p.tag_id.as_str();
    sqlx::query!(
        "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)",
        block_id_str,
        tag_id_str,
    )
    .execute(&mut *conn)
    .await?;
    tag_inheritance::propagate_tag_to_descendants(
        &mut *conn,
        p.block_id.as_str(),
        p.tag_id.as_str(),
    )
    .await?;
    Ok(())
}

/// SQL-only RemoveTag fallback (formerly `apply_remove_tag_tx`).
pub(super) async fn apply_remove_tag_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: RemoveTagPayload,
) -> Result<(), AppError> {
    let block_id_str = p.block_id.as_str();
    let tag_id_str = p.tag_id.as_str();
    sqlx::query!(
        "DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?",
        block_id_str,
        tag_id_str,
    )
    .execute(&mut *conn)
    .await?;
    tag_inheritance::remove_inherited_tag(&mut *conn, p.block_id.as_str(), p.tag_id.as_str())
        .await?;
    Ok(())
}

/// SQL-only SetProperty fallback (formerly `apply_set_property_tx`).
///
/// #802: delegates to [`crate::loro::projection::project_set_property_to_sql`]
/// — the exact projection the via-loro path runs after its engine apply.
/// This function used to re-spell the reserved-key routing inline and had
/// NO arm for the column-backed `space` key (#533): an engine-less replay
/// of a `SetProperty(space)` op fell into the generic `block_properties`
/// INSERT and aborted on migration 0088's `key_not_reserved` CHECK.
/// Delegating makes the fallback's routing identical to the projection's
/// by construction (reserved columns, `space` → `blocks.space_id` with the
/// #708 registered-space guard, generic rows), so the two can never drift
/// again.
pub(super) async fn apply_set_property_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: SetPropertyPayload,
) -> Result<(), AppError> {
    crate::loro::projection::project_set_property_to_sql(conn, &p).await
}

/// SQL-only DeleteProperty fallback (formerly `apply_delete_property_tx`).
///
/// #802 (parity with [`apply_set_property_sql_only`]): delegates to
/// [`crate::loro::projection::project_delete_property_to_sql`]. The inline
/// body it replaces also lacked a `space` arm — a `DeleteProperty(space)`
/// replayed engine-less issued a no-op `block_properties` DELETE (no 0088
/// abort, but `blocks.space_id` silently stayed set). The projection
/// clears the column for the whole owning-page group, matching the
/// via-loro path.
pub(super) async fn apply_delete_property_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: DeletePropertyPayload,
) -> Result<(), AppError> {
    crate::loro::projection::project_delete_property_to_sql(conn, p.block_id.as_str(), &p.key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::ulid::BlockId;
    use tempfile::TempDir;

    const PAGE_ID: &str = "01HZ00000000000000000000P1";
    const CONTENT_ID: &str = "01HZ00000000000000000000C1";

    fn create_block_payload(block_id: &str, block_type: &str) -> CreateBlockPayload {
        CreateBlockPayload {
            block_id: BlockId::from_trusted(block_id),
            block_type: block_type.to_string(),
            parent_id: None,
            position: None,
            index: Some(0),
            content: String::new(),
        }
    }

    /// #1324: the engine-less fallback must stamp `page_id = id` for a page
    /// block. Before the fix this INSERT left `page_id` NULL (the CHECK accepts
    /// NULL), and the deferred `SetBlockPageId` task is skipped for pages, so a
    /// replayed / space-unresolved page create stayed NULL-owned.
    #[tokio::test]
    async fn sql_only_create_page_block_stamps_page_id_self() {
        let dir = TempDir::new().expect("tempdir");
        let pool = init_pool(&dir.path().join("sql_only.db"))
            .await
            .expect("init_pool");

        let mut conn = pool.acquire().await.expect("acquire");
        apply_create_block_sql_only(&mut conn, create_block_payload(PAGE_ID, "page"))
            .await
            .expect("page fallback must satisfy the page_id CHECK, not trip it");
        drop(conn);

        let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(PAGE_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(page_id.as_deref(), Some(PAGE_ID));
    }

    /// A non-page block keeps NULL `page_id`; the deferred `SetBlockPageId`
    /// task fills it from the parent.
    #[tokio::test]
    async fn sql_only_create_non_page_block_keeps_null_page_id() {
        let dir = TempDir::new().expect("tempdir");
        let pool = init_pool(&dir.path().join("sql_only.db"))
            .await
            .expect("init_pool");

        let mut conn = pool.acquire().await.expect("acquire");
        apply_create_block_sql_only(&mut conn, create_block_payload(CONTENT_ID, "content"))
            .await
            .expect("project");
        drop(conn);

        let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
            .bind(CONTENT_ID)
            .fetch_one(&pool)
            .await
            .expect("fetch row");
        assert_eq!(page_id, None);
    }
}
