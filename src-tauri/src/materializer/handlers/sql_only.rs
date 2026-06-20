//! SQL-only apply fallbacks (`apply_*_sql_only`): the projection
//! path used when the Loro engine is unavailable / space unresolved.

use super::*;

/// SQL-only CreateBlock fallback.
///
/// #1323 (Step 3): the row INSERT is routed through the shared
/// [`crate::loro::projection::project_create_block_to_sql`] projection — the
/// same fn the engine arm calls — so the INSERT *shape* (column list, `page_id`
/// stamping #1324, `OR IGNORE`) cannot drift between the two arms. We
/// synthesize the engine's read-back [`crate::loro::engine::BlockSnapshot`]
/// from the [`CreateBlockPayload`], reproducing the engine-less position
/// formula exactly: `p.position.or_else(|| p.index.map(index_to_provisional_position))`.
///
/// **`position` is a documented divergence from the engine arm, not a value
/// this convergence equalizes** (#1245 / #1257). The engine arm runs
/// `reproject_dense_positions` AFTER the projection to re-rank the whole sibling
/// group into a dense 1-based order over the engine's fractional tree; this
/// engine-less fallback has no such tree and writes only the *provisional*
/// rank (`index + 1`, capped). For an index-only insert into a populated
/// sibling set the two legitimately differ. Step 3 converges the INSERT shape,
/// not the position value — see `create_edit_convergence_tests.rs`, which pins
/// this gap rather than masking it.
///
/// **`position == None` (both `position` and `index` absent).** The engine
/// `BlockSnapshot` carries `position: i64` (the engine read-back is always a
/// concrete rank), so it cannot represent the SQL NULL the old inline INSERT
/// wrote in that corner. This both-`None` case IS reachable in production: the
/// canonical create path `domain::block_ops::create_block_in_tx` takes
/// `index: Option<i64>` and builds `CreateBlockPayload { position: None, index,
/// .. }`, so a bare-append create (`index: None`) routed to this fallback on a
/// space-unresolved / engine-uninit miss hits it. We map it to the engine's own
/// append sentinel — `i64::MAX`, the exact value the engine arm feeds
/// `apply_create_block` for this case (`loro_apply.rs`:
/// `p.position.unwrap_or(i64::MAX)`). This changes the persisted byte from SQL
/// NULL to `i64::MAX`, but is **behavior-preserving**: the pagination layer
/// defines `NULL_POSITION_SENTINEL == i64::MAX` and substitutes NULL → i64::MAX
/// for every keyset/order comparison, and the next-provisional-position scan
/// (`WHERE position < 9223372036854775807`) excludes both NULL and i64::MAX
/// identically — so a NULL row and an i64::MAX row sort and aggregate the same.
/// No production code discriminates `position IS NULL` from the sentinel. This
/// is the only changed byte vs the old fallback; it is observationally inert.
/// All other inputs keep their exact prior `position`.
pub(super) async fn apply_create_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: CreateBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;

    let parent_id_str = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
    // #400: a new-scheme op carries a 0-based `index` and no legacy `position`;
    // fall back to a 1-based provisional position for this engine-less path.
    // Same formula the old inline INSERT bound; see the doc comment on the
    // #1245 / #1257 reproject-gap and on the unreachable both-`None` corner.
    let position = p
        .position
        .or_else(|| {
            p.index
                .map(crate::pagination::index_to_provisional_position)
        })
        .unwrap_or(i64::MAX);
    // Synthesize the engine's read-back snapshot. `project_create_block_to_sql`
    // derives `page_id` from `snapshot.block_type == "page"` (#1324) and binds
    // every column from these fields, so this reproduces the old INSERT's row
    // exactly (page_id stamping included).
    let snapshot = BlockSnapshot {
        block_id: p.block_id.as_str().to_owned(),
        block_type: p.block_type.clone(),
        content: p.content.clone(),
        parent_id: parent_id_str.clone(),
        position,
    };
    crate::loro::projection::project_create_block_to_sql(conn, &snapshot).await?;
    // Tag inheritance stays OUTSIDE the projection and is called after it,
    // exactly as before (and mirroring the engine arm).
    let parent_str = parent_id_str.as_deref();
    tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str).await?;
    Ok(())
}

/// SQL-only EditBlock fallback (formerly `apply_edit_block_tx`).
///
/// #1323 (Step 3): routes the content UPDATE through the shared
/// [`crate::loro::projection::project_edit_block_to_sql`] projection — the same
/// fn the engine arm calls — so the UPDATE *shape* (`SET content = ? WHERE id =
/// ? AND deleted_at IS NULL`) cannot drift between arms. We synthesize the
/// engine's read-back [`crate::loro::engine::BlockSnapshot`] from the
/// [`EditBlockPayload`], with `content = p.to_text`.
///
/// The projection reads `snapshot.content` and `snapshot.block_id` only — the
/// other snapshot fields are unused by an EditBlock projection, so we fill them
/// with inert placeholders. In the engine arm `snapshot.content` is the engine's
/// post-merge read-back, which equals `to_text` in the single-author case and
/// is the CRDT-merged result under concurrency; this engine-less fallback has
/// no merge, so `to_text` IS the content — byte-identical to the old inline
/// UPDATE.
pub(super) async fn apply_edit_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: EditBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;

    let snapshot = BlockSnapshot {
        block_id: p.block_id.as_str().to_owned(),
        // Unused by `project_edit_block_to_sql` (it binds only `content` +
        // `block_id`); inert placeholders.
        block_type: String::new(),
        content: p.to_text.clone(),
        parent_id: None,
        position: 0,
    };
    crate::loro::projection::project_edit_block_to_sql(conn, &snapshot).await?;
    Ok(())
}

/// SQL-only DeleteBlock fallback (formerly `apply_delete_block_tx`).
///
/// #1323 (Step 2): delegates the cascade soft-delete to
/// [`crate::loro::projection::project_delete_block_to_sql`] — the exact
/// projection the via-loro engine arm runs after its engine apply — so
/// the two arms can never drift on the cohort CTE (`descendants_cte_active!`)
/// or the `deleted_at` value. The `now` timestamp is the same value the
/// engine arm stamps (`record.created_at`, epoch-ms), threaded straight
/// through from the dispatcher. The inherited-tag sweep lives OUTSIDE the
/// projection (kept pure), so this fallback invokes the SAME
/// `tag_inheritance::remove_subtree_inherited` helper AFTER the
/// projection, mirroring `apply_delete_block_via_loro` exactly.
pub(super) async fn apply_delete_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: DeleteBlockPayload,
    now: i64,
) -> Result<(), AppError> {
    crate::loro::projection::project_delete_block_to_sql(conn, p.block_id.as_str(), now).await?;
    tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// SQL-only RestoreBlock fallback (formerly `apply_restore_block_tx`).
///
/// #1323 (Step 2): delegates the cohort-contiguous restore to
/// [`crate::loro::projection::project_restore_block_to_sql`] — the exact
/// projection the via-loro engine arm runs after its engine apply — so
/// the two arms can never drift on the cohort CTE (`descendants_cte_cohort!`,
/// the #1055 connected-cohort walk) or the `deleted_at_ref` filter. The
/// recompute-subtree-inheritance fan-out lives OUTSIDE the projection
/// (kept pure), so this fallback invokes the SAME
/// `tag_inheritance::recompute_subtree_inheritance` helper AFTER the
/// projection, mirroring `apply_restore_block_via_loro` exactly.
pub(super) async fn apply_restore_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: RestoreBlockPayload,
) -> Result<(), AppError> {
    crate::loro::projection::project_restore_block_to_sql(
        conn,
        p.block_id.as_str(),
        p.deleted_at_ref,
    )
    .await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// SQL-only MoveBlock fallback (formerly `apply_move_block_tx`).
///
/// #1323 (Step 4): the `parent_id` / `position` write is routed through the
/// shared [`crate::loro::projection::project_move_block_to_sql`] projection —
/// the same fn the engine arm calls — so the `UPDATE blocks SET parent_id = ?,
/// position = ? WHERE id = ?` shape cannot drift between the two arms. We
/// synthesize the engine's read-back [`crate::loro::engine::BlockSnapshot`]
/// from the [`MoveBlockPayload`] (`project_move_block_to_sql` reads only
/// `block_id` / `parent_id` / `position`; the other snapshot fields are
/// placeholders it never touches).
///
/// **`position` is a documented divergence from the engine arm, not a value
/// this convergence equalizes** (#1245 / #1257). The engine arm runs
/// `reproject_dense_positions` AFTER the projection on BOTH the source and the
/// target parent's sibling group, re-ranking them into a dense 1-based order
/// over the engine's fractional tree; this engine-less fallback has no such
/// tree and writes only the *provisional* rank (`new_index + 1`, capped, or
/// the legacy `new_position`). For a cross-parent move into a populated
/// sibling set the two legitimately differ. Step 4 converges the UPDATE shape,
/// not the position value — see `move_convergence_tests.rs`, which pins this
/// gap rather than masking it.
///
/// **Cycle probe.** The defensive cycle check (#383) — a malformed/replayed op
/// could install a `parent_id` cycle that saturates every recursive CTE walk
/// at the depth-100 bound — now uses the SHARED
/// [`crate::block_descendants::move_would_cycle`] helper, the SAME probe
/// `move_block_inner` (the command path) uses, so the two SQL-side paths
/// cannot drift. The rejection still differs by design: the command path errs,
/// this sync-replay fallback no-op-warns (aborting would wedge inbound sync;
/// dropping a self-evidently invalid move is recoverable).
pub(super) async fn apply_move_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: MoveBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;

    let new_parent_str = p.new_parent_id.as_ref().map(|id| id.as_str().to_owned());
    let block_id_str = p.block_id.as_str();

    // #383 / #1323: shared cycle probe (see helper docstring). No-op-warn (not
    // error) on this sync-replay fallback arm.
    if let Some(parent) = new_parent_str.as_deref()
        && crate::block_descendants::move_would_cycle(&mut *conn, block_id_str, parent).await?
    {
        tracing::warn!(
            block_id = %block_id_str,
            new_parent_id = %parent,
            "apply_move_block_sql_only: move would create a parent_id cycle \
             (new parent is the block itself or one of its descendants); \
             skipping the UPDATE (#383)"
        );
        return Ok(());
    }

    // #400: prefer the new-scheme 0-based `new_index` (as a 1-based position)
    // on this engine-less (test-only) path; else the legacy `new_position`.
    let position = p.new_index.map_or(
        p.new_position,
        crate::pagination::index_to_provisional_position,
    );
    // Synthesize the engine's read-back snapshot. `project_move_block_to_sql`
    // binds only `block_id` / `parent_id` / `position`; `block_type` / `content`
    // are inert placeholders it never reads.
    let snapshot = BlockSnapshot {
        block_id: block_id_str.to_owned(),
        block_type: String::new(),
        content: String::new(),
        parent_id: new_parent_str.clone(),
        position,
    };
    crate::loro::projection::project_move_block_to_sql(conn, &snapshot).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// SQL-only AddTag fallback (formerly `apply_add_tag_tx`).
///
/// #1323 (Step 1): delegates the `block_tags` write to
/// [`crate::loro::projection::project_add_tag_to_sql`] — the exact
/// projection the via-loro engine arm runs after its engine apply — so
/// the two arms can never drift on the `block_tags` row shape. The tag
/// inheritance fan-out lives OUTSIDE the projection (the projection is
/// kept pure), so this fallback invokes the SAME
/// `tag_inheritance::propagate_tag_to_descendants` helper AFTER the
/// projection, mirroring `apply_add_tag_via_loro` exactly. block_id and
/// tag_id come straight from the op payload — no engine read-back.
pub(super) async fn apply_add_tag_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: AddTagPayload,
) -> Result<(), AppError> {
    crate::loro::projection::project_add_tag_to_sql(conn, p.block_id.as_str(), p.tag_id.as_str())
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
///
/// #1323 (Step 1): delegates the `block_tags` delete to
/// [`crate::loro::projection::project_remove_tag_to_sql`] — the exact
/// projection the via-loro engine arm runs — so the two arms can never
/// drift on the `block_tags` delete shape. The inherited-tag cleanup
/// lives OUTSIDE the projection, so this fallback invokes the SAME
/// `tag_inheritance::remove_inherited_tag` helper AFTER the projection,
/// mirroring `apply_remove_tag_via_loro` exactly. block_id and tag_id
/// come straight from the op payload — no engine read-back.
pub(super) async fn apply_remove_tag_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: RemoveTagPayload,
) -> Result<(), AppError> {
    crate::loro::projection::project_remove_tag_to_sql(
        conn,
        p.block_id.as_str(),
        p.tag_id.as_str(),
    )
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
