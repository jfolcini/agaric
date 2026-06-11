//! Engine-routed apply handlers (`apply_*_via_loro`) plus the SQL
//! purge cascade. Each fn applies an op through the per-space Loro
//! engine then projects the result to SQL.

use super::*;

/// Apply CreateBlock through the engine then project to SQL.
///
/// 1. Resolves the block's space (parent_id-based for content blocks;
///    self-id for pages).
/// 2. Acquires the per-space [`crate::loro::engine::LoroEngine`] via
///    the registry.
/// 3. Applies `apply_create_block` to the engine.
/// 4. Reads back the engine's `BlockSnapshot` for the freshly-created
///    block.
/// 5. Drops the registry guard (the `MutexGuard` is `!Send` so it
///    cannot cross an `.await`).
/// 6. Projects the snapshot into SQL via
///    [`crate::loro::projection::project_create_block_to_sql`].
/// 7. Calls `tag_inheritance::inherit_parent_tags`, so derived tag
///    rows stay correct.
///
/// ## Atomic semantics
///
/// The SQL projection runs in the caller's transaction, so a
/// projection failure rolls back atomically with the rest of the
/// `apply_op_tx` work (cursor advance, etc.). The engine's apply is
/// NOT rolled back automatically.
///
/// ## Space resolution
///
/// For a `CreateBlock`, the `parent_id` is the resolution anchor when
/// present (content blocks descend from a page); otherwise the
/// block's own id is used (page-create with no parent).
///
/// ## Fallback modes
///
/// The engine path falls back to a SQL-only path
/// (`apply_*_sql_only` below) when:
/// - Loro state isn't initialised (test scaffolding without
///   `install_for_test`).
/// - Space cannot be resolved (orphan block, no `space` ancestor,
///   pre-FEAT-3 row, fresh page-create with no SetProperty(space)
///   yet).
///
/// In production both arms are unreachable — `init` runs at boot and
/// space resolution succeeds on every well-formed op. The SQL-only
/// fallback exists so that materializer / recovery / sync_daemon
/// tests can thread synthetic bare-block ops through `apply_op`
/// without a registered space.
pub(super) async fn apply_create_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &CreateBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;
    use crate::ulid::BlockId;

    // Resolve space via parent_id (or self for a page-create that
    // has no parent).  Fall back to SQL-only on any resolve miss.
    let resolution_anchor: BlockId = match &p.parent_id {
        Some(parent) => parent.clone(),
        None => p.block_id.clone(),
    };
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        return apply_create_block_sql_only(conn, p.clone()).await;
    };

    // Acquire engine guard, apply, read-back, drop guard.  The guard
    // is `!Send` so it cannot live across an `.await` — we keep all
    // engine work inside this sync block.
    let (snapshot, siblings): (BlockSnapshot, Vec<String>) = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_create_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let parent = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        // #400 routing: new ops carry a 0-based `index`; pre-#400 ops carry the
        // legacy sparse `position` (mapped to a slot by the engine); neither ⇒
        // append at the end.
        match p.index {
            Some(index) => engine.apply_create_block_at(
                p.block_id.as_str(),
                &p.block_type,
                &p.content,
                parent,
                usize::try_from(index.max(0)).unwrap_or(usize::MAX),
            )?,
            None => engine.apply_create_block(
                p.block_id.as_str(),
                &p.block_type,
                &p.content,
                parent,
                p.position.unwrap_or(i64::MAX), // None ⇒ sort last (append)
            )?,
        }
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        // Authoritative sibling order for the dense-rank reprojection.
        let siblings = engine.children_ordered_block_ids(parent)?;
        drop(guard);
        let snap = snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_create_block_via_loro: engine read_block returned None \
                 immediately after apply_create_block for {}",
                p.block_id.as_str()
            ))
        })?;
        (snap, siblings)
    };

    // Project the engine's post-apply state into SQL, then reproject the whole
    // sibling group to dense 1-based positions matching the tree order (#400).
    projection::project_create_block_to_sql(conn, &snapshot).await?;
    projection::reproject_dense_positions(conn, &siblings).await?;

    // Tag inheritance — derived tag rows for the new block.
    let parent_str = p.parent_id.as_ref().map(crate::ulid::BlockId::as_str);
    tag_inheritance::inherit_parent_tags(&mut *conn, p.block_id.as_str(), parent_str).await?;
    Ok(())
}

/// Apply EditBlock through the engine then project to SQL.
///
/// Same shape as [`apply_create_block_via_loro`]: resolve space, take
/// the engine guard inside a sync scope, apply
/// `apply_edit_via_diff_splice`, read the post-apply snapshot, drop
/// the guard, project. Edit ops carry no `parent_id`, so the
/// resolution anchor is the `block_id` itself (which already has a
/// `parent_id` row in `blocks` — the resolution walks up from there).
pub(super) async fn apply_edit_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &EditBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_edit_block_sql_only(conn, p.clone()).await;
    };

    let snapshot: BlockSnapshot = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_edit_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)?;
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        drop(guard);
        snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_edit_block_via_loro: engine read_block returned None for {} \
                 (the block must exist for an EditBlock op to make sense)",
                p.block_id.as_str()
            ))
        })?
    };

    projection::project_edit_block_to_sql(conn, &snapshot).await?;
    Ok(())
}

/// Apply SetProperty through the engine then project to SQL.
///
/// Same shape as the per-block helpers: resolve space via the block's
/// id, take the engine guard, apply, drop, project. The engine apply
/// flattens all property values to a single string; the SQL projection
/// reads the typed-shape fields straight off the payload (the engine's
/// post-apply state for the typed fields equals the payload's fields
/// by construction, so this is correct — see the projection helper's
/// docstring). An unresolvable space falls back to the SQL-only
/// path.
pub(super) async fn apply_set_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &SetPropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_set_property_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_set_property_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        // PEND-80 §2.1: store the value with its native type so the engine is
        // type-lossless (`value_num`→`Num`, `value_bool`→`Bool`); text/date/ref
        // are all strings, disambiguated at the SQL projection by
        // `property_definitions.value_type`. No typed field set ⇒ explicit
        // clear (`Null`). The typed SQL columns are still written from the
        // payload directly by `project_set_property_to_sql` below.
        use crate::loro::engine::PropertyValue;
        let value = if let Some(v) = &p.value_text {
            PropertyValue::Str(v.clone())
        } else if let Some(v) = p.value_num {
            PropertyValue::Num(v)
        } else if let Some(v) = &p.value_date {
            PropertyValue::Str(v.clone())
        } else if let Some(v) = &p.value_ref {
            PropertyValue::Str(v.as_str().to_owned())
        } else if let Some(b) = p.value_bool {
            PropertyValue::Bool(b)
        } else {
            PropertyValue::Null
        };
        engine.apply_set_property_typed(p.block_id.as_str(), &p.key, &value)?;
        drop(guard);
    }

    projection::project_set_property_to_sql(conn, p).await?;
    Ok(())
}

/// Apply DeleteBlock through the engine then project to SQL.
///
/// Engine `apply_delete_block` now stores the real `record.created_at`
/// timestamp on the seed (PEND-80 Phase 2) — the same value the SQL
/// projection stamps — so cohort identity for restore lookups is
/// consistent between the engine and SQL, and lossless across sync.
/// The cascade (descendant fanout) is handled on the SQL side via the
/// projection's CTE-driven UPDATE; the engine only sees the seed
/// block's apply, with the post-commit
/// `dispatch_delete_descendants` fanning out the cohort to the
/// engine. An unresolvable space falls back to the SQL-only path.
pub(super) async fn apply_delete_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &DeleteBlockPayload,
    now: i64,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_delete_block_sql_only(conn, p.clone(), now).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_delete_block_sql_only(conn, p.clone(), now).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        // #109 Phase 2: the engine seed carries `deleted_at` as a String
        // slot (bridged to i64 at the SQL boundary); stringify here.
        engine.apply_delete_block(p.block_id.as_str(), &now.to_string())?;
        drop(guard);
    }

    projection::project_delete_block_to_sql(conn, p.block_id.as_str(), now).await?;
    // Sweep inherited tag rows for the deleted subtree.
    tag_inheritance::remove_subtree_inherited(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply MoveBlock through the engine then project to SQL.
///
/// Engine `apply_move_block` writes parent_id + position via per-key
/// LWW; we read back the engine's post-apply snapshot and project
/// both fields into SQL. No sibling-shift on either side (see
/// projection helper's docstring for the rationale).
pub(super) async fn apply_move_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &MoveBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_move_block_sql_only(conn, p.clone()).await;
    };

    // `(snapshot, old_parent_siblings, new_parent_siblings)`. A move can change
    // parent, so both the source and the target sibling groups need a dense
    // reprojection (#400). The resulting parent may differ from the requested
    // one (a cyclic/unknown-parent move keeps the current parent), so the
    // authoritative new parent is the post-apply snapshot's `parent_id`.
    let (snapshot, old_siblings, new_siblings): (BlockSnapshot, Vec<String>, Vec<String>) = {
        let Some(state) = crate::loro::shared::get() else {
            return apply_move_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        let new_parent = p.new_parent_id.as_ref().map(crate::ulid::BlockId::as_str);
        let old_parent = engine.read_parent(p.block_id.as_str())?;
        // #400 routing: new ops carry a 0-based `new_index`; pre-#400 ops carry
        // the legacy sparse `new_position` (mapped to a slot by the engine).
        match p.new_index {
            Some(index) => engine.apply_move_block_to(
                p.block_id.as_str(),
                new_parent,
                usize::try_from(index.max(0)).unwrap_or(usize::MAX),
            )?,
            None => engine.apply_move_block(p.block_id.as_str(), new_parent, p.new_position)?,
        }
        let snap_opt = engine.read_block(p.block_id.as_str())?;
        let snap = snap_opt.ok_or_else(|| {
            AppError::Validation(format!(
                "apply_move_block_via_loro: engine read_block returned None for {} \
                 (a MoveBlock op presupposes the block exists)",
                p.block_id.as_str()
            ))
        })?;
        let old_siblings = engine.children_ordered_block_ids(old_parent.as_deref())?;
        // Same-parent reorder (the common DnD / moveUp / moveDown case): source
        // and target groups are identical, so reproject once. Only fetch the
        // second group when the parent actually changed (#400, review perf).
        let new_siblings = if old_parent.as_deref() == snap.parent_id.as_deref() {
            Vec::new()
        } else {
            engine.children_ordered_block_ids(snap.parent_id.as_deref())?
        };
        drop(guard);
        (snap, old_siblings, new_siblings)
    };

    projection::project_move_block_to_sql(conn, &snapshot).await?;
    // Reproject the source group (it shrank, or — for a same-parent move — it is
    // the single affected group). `new_siblings` is empty on a same-parent move.
    projection::reproject_dense_positions(conn, &old_siblings).await?;
    if !new_siblings.is_empty() {
        projection::reproject_dense_positions(conn, &new_siblings).await?;
    }
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply RestoreBlock through the engine then project to SQL.
///
/// Engine apply for the SEED only + SQL projection that walks the
/// cohort via the descendants CTE. The per-descendant engine fan-out
/// lives in the post-commit helper `dispatch_restore_descendants`
/// (the engine apply is idempotent, so re-running it is safe).
///
/// **Why the engine sees only the seed.** The engine's
/// `apply_restore_block` is per-block-id; walking descendants would
/// duplicate work that `dispatch_restore_descendants` already does
/// post-commit. The split keeps the engine API simple (1 block in, 1
/// mutation out) and keeps cohort semantics on the SQL side. If a
/// crash drops the fanout, the next op-log replay rebuilds the engine
/// from scratch.
///
/// **Space resolution on a soft-deleted block.** `resolve_block_space`
/// filters `deleted_at IS NULL` (AGENTS.md invariant #9 — tombstones
/// must not participate in space resolution). But a `RestoreBlock` op
/// TARGETS a tombstoned block by definition, so the canonical resolver
/// returns `None`. We work around this by reading `parent_id` directly
/// from `blocks` (no `deleted_at` filter) and resolving the parent's
/// space — correct because the parent is in the same space as the
/// soft-deleted child by the per-space-tree invariant. When the block
/// has no parent (orphan / page-level restore), the path falls back to
/// the SQL-only restore.
pub(super) async fn apply_restore_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &RestoreBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;
    use crate::ulid::BlockId;

    // Read parent_id directly (the canonical resolver filters out
    // soft-deleted rows, which would always be the case here).
    let block_id_str = p.block_id.as_str();
    let parent_row = sqlx::query!("SELECT parent_id FROM blocks WHERE id = ?", block_id_str)
        .fetch_optional(&mut *conn)
        .await?;
    let resolution_anchor: BlockId = match parent_row.and_then(|r| r.parent_id) {
        Some(parent) => BlockId::from_trusted(&parent),
        None => p.block_id.clone(),
    };
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        return apply_restore_block_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_restore_block_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_restore_block(p.block_id.as_str())?;
        drop(guard);
    }

    projection::project_restore_block_to_sql(conn, p.block_id.as_str(), p.deleted_at_ref).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    Ok(())
}

/// Apply PurgeBlock through the engine then run the SQL cascade.
///
/// Engine apply is per-block-id (deletes the seed's `blocks`,
/// `block_properties`, `block_tags` entries from the LoroDoc). The
/// SQL side then runs the full cascade inline — the cascade is much
/// wider than the engine state (purges agenda_cache, tags_cache,
/// fts_blocks, etc. that the engine doesn't model) so it stays in
/// this helper rather than getting absorbed into a projection. The
/// engine descendant state is reconciled via op-log replay; per-
/// descendant engine purges may be added later if needed. The SQL
/// cascade is the source of truth users observe. SQL-only fallback
/// shape mirrors the other helpers; in production both arms are
/// unreachable.
pub(super) async fn apply_purge_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return purge_block_sql_cascade(conn, p).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return purge_block_sql_cascade(conn, p).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_purge_block(p.block_id.as_str())?;
        drop(guard);
    }

    purge_block_sql_cascade(conn, p).await?;
    Ok(())
}

/// SQL-side purge cascade.
///
/// PURGE walks many tables — much broader than the engine's three
/// (`blocks`, `block_properties`, `block_tags`) — so it stays SQL-side
/// rather than being absorbed into a projection. Every row that
/// descends from the purged block must go. `depth < 100` is the
/// runaway-recursion guard.
pub(super) async fn purge_block_sql_cascade(
    conn: &mut sqlx::SqliteConnection,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    let block_id = p.block_id.as_str();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    // PEND-20 C: materialise the descendants set ONCE into a TEMP
    // table, then read from the table in each cascade statement.
    // Pre-refactor each statement re-evaluated the recursive
    // `descendants_cte_purge!()` CTE end-to-end against the same
    // subtree (15× walks per cascade), needlessly extending the
    // writer-lock window.
    //
    // Cleanup pattern: SQLite TEMP tables are connection-scoped and
    // the connection comes from a pool, so the table can outlive the
    // handler unless we explicitly DROP it.  The defensive
    // `DROP TABLE IF EXISTS` at the top guards against a prior crash
    // that leaked the table on this connection; the explicit
    // `DROP TABLE` at the bottom keeps the connection's temp namespace
    // clean for the next caller.
    sqlx::query("DROP TABLE IF EXISTS _purge_descendants")
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "CREATE TEMP TABLE _purge_descendants AS \
         WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) \
         SELECT id FROM descendants",
    )
    .bind(block_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants) \
            OR inherited_from IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    // block_properties: value_ref pointing into the subtree — DELETE the
    // property row rather than NULLing the ref. Under migration 0062's
    // exactly_one_value CHECK a `value_ref`-typed property has no other
    // typed value to fall back on, so a SET-NULL produces an invariant-
    // violating all-NULL row. Mirrors the equivalent crud.rs change
    // (see crud.rs:~1249 / 1613 / 2063 and migration 0062's header).
    sqlx::query(
        "DELETE FROM block_properties \
         WHERE value_ref IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM _purge_descendants) \
            OR target_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM page_aliases \
         WHERE page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM projected_agenda_cache \
         WHERE block_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM blocks \
         WHERE id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    // PEND-20 C: explicitly drop the temp table so the pooled
    // connection's temp namespace is empty for the next caller.
    sqlx::query("DROP TABLE _purge_descendants")
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Apply AddTag through the engine then project to SQL.
///
/// Engine apply pushes the tag id onto the block's `block_tags` list
/// (idempotent — engine de-dupes). SQL projection writes the
/// `block_tags` row via `INSERT OR IGNORE`. Tag inheritance fanout
/// runs AFTER the projection. An unresolvable space falls back to the
/// SQL-only path.
pub(super) async fn apply_add_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &AddTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_add_tag_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_add_tag_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_add_tag(p.block_id.as_str(), p.tag_id.as_str())?;
        drop(guard);
    }

    projection::project_add_tag_to_sql(conn, p.block_id.as_str(), p.tag_id.as_str()).await?;
    tag_inheritance::propagate_tag_to_descendants(
        &mut *conn,
        p.block_id.as_str(),
        p.tag_id.as_str(),
    )
    .await?;
    Ok(())
}

/// Apply RemoveTag through the engine then project to SQL.
///
/// Engine apply removes the tag id from the block's `block_tags` list
/// (idempotent — engine no-ops on missing tag). SQL projection
/// deletes the `block_tags` row. Tag inheritance cleanup runs AFTER
/// the projection. An unresolvable space falls back to the SQL-only
/// path.
pub(super) async fn apply_remove_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &RemoveTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_remove_tag_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_remove_tag_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_remove_tag(p.block_id.as_str(), p.tag_id.as_str())?;
        drop(guard);
    }

    projection::project_remove_tag_to_sql(conn, p.block_id.as_str(), p.tag_id.as_str()).await?;
    tag_inheritance::remove_inherited_tag(&mut *conn, p.block_id.as_str(), p.tag_id.as_str())
        .await?;
    Ok(())
}

/// Apply DeleteProperty through the engine then project to SQL.
///
/// Engine apply removes the key from the block's properties map
/// (idempotent — engine no-ops on missing key). SQL projection runs
/// the per-key match (reserved key → UPDATE column to NULL;
/// non-reserved key → DELETE block_properties row). No
/// tag-inheritance fanout — properties don't propagate. An
/// unresolvable space falls back to the SQL-only path.
pub(super) async fn apply_delete_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    device_id: &str,
    p: &DeletePropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = crate::space::resolve_block_space(&mut *conn, &p.block_id).await? else {
        return apply_delete_property_sql_only(conn, p.clone()).await;
    };

    {
        let Some(state) = crate::loro::shared::get() else {
            return apply_delete_property_sql_only(conn, p.clone()).await;
        };
        let mut guard = state.registry.for_space(&space_id, device_id)?;
        let engine = guard.engine_mut();
        engine.apply_delete_property(p.block_id.as_str(), &p.key)?;
        drop(guard);
    }

    projection::project_delete_property_to_sql(conn, p.block_id.as_str(), &p.key).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// SQL-only fallback helpers.
//
// Used by the `apply_*_via_loro` helpers when:
//
// - Loro state is uninitialised (test scaffolding that doesn't call
//   `crate::loro::shared::install_for_test`). Production always
//   initialises via `crate::loro::shared::init` at boot.
// - Space resolution fails (orphan block, no `space` ancestor, pre-
//   FEAT-3 row). These rows write SQL but skip the engine apply; a
//   later op-log replay will reconcile engine state if the row gets a
//   space.
//
// In production both arms are unreachable. The fallback exists so
// that ~55 materializer / recovery / sync_daemon tests can thread
// synthetic ops through `apply_op` against bare-block fixtures with
// no space chain.
// ---------------------------------------------------------------------------
