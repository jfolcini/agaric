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
/// 5. Drops the engine guard (the per-space guard is `!Send` so it
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
///   Pre- row, fresh page-create with no SetProperty(space)
///   yet).
///
/// In production both arms are unreachable — `init` runs at boot and
/// space resolution succeeds on every well-formed op. The SQL-only
/// fallback exists so that materializer / recovery / sync_daemon
/// tests can thread synthetic bare-block ops through `apply_op`
/// without a registered space.
/// `chunk`: #2200 Item 1. When `Some`, the caller is importing an N-block
/// chunk and wants the whole-sibling-group `reproject_dense_positions` DEFERRED
/// to a single end-of-chunk flush. Instead of reprojecting here, we record the
/// authoritative post-insert sibling ordering for this block's parent group in
/// the accumulator (overwriting any earlier entry for the same parent — the
/// latest ordering is the most complete). The end-of-chunk flush reprojects
/// each touched parent ONCE, which yields IDENTICAL final ranks: the engine's
/// `children_ordered_block_ids` returns the full post-insert order on every
/// call, the ordering key is insertion-stable (#400), and dense ranking is a
/// pure function of that final order. When `None` (single-op / LOCAL command
/// path) we reproject inline immediately, unchanged.
pub async fn apply_create_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &CreateBlockPayload,
    chunk: Option<&mut super::ChunkAccumulator>,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;
    use agaric_core::ulid::BlockId;

    // Resolve space via parent_id (or self for a page-create that
    // has no parent).  Fall back to SQL-only on any resolve miss.
    let resolution_anchor: BlockId = match &p.parent_id {
        Some(parent) => parent.clone(),
        None => p.block_id.clone(),
    };
    let Some(space_id) =
        agaric_store::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        super::sql_only_fallback::record(
            "create_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_create_block_sql_only(conn, p.clone()).await;
    };

    // Acquire engine guard, apply, read-back, drop guard.  The guard
    // is `!Send` so it cannot live across an `.await` — we keep all
    // engine work inside this sync block. `None` requests the SQL-only
    // fallback (handled after the scope closes, since an `.await` cannot
    // cross the guard).
    //
    // #2250 (#1257 reconciliation): if this create has a parent but that
    // parent is absent from the resolved space's engine tree — because the
    // parent was projected SQL-only during a no-space window (e.g. a page
    // created before its `SetProperty(space)`) and so never entered the engine
    // — `apply_create_block` would silently drop the child to the engine root
    // (parent → None), diverging from SQL. Defer to the authoritative SQL
    // projection instead and let boot-replay reconcile. (No parent ⇒ a
    // top-level create, which needs no parent lookup.)
    let create_result: Option<(BlockSnapshot, Vec<String>)> = {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        let parent = p.parent_id.as_ref().map(agaric_core::ulid::BlockId::as_str);
        let parent_absent = match parent {
            Some(pid) => engine.read_block(pid)?.is_none(),
            None => false,
        };
        if parent_absent {
            None
        } else {
            // #400 routing: new ops carry a 0-based `index`; pre-#400 ops carry
            // the legacy sparse `position` (mapped to a slot); neither ⇒ append.
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
                AppError::validation(format!(
                    "apply_create_block_via_loro: engine read_block returned None \
                     immediately after apply_create_block for {}",
                    p.block_id.as_str()
                ))
            })?;
            Some((snap, siblings))
        }
    };
    let Some((snapshot, siblings)) = create_result else {
        super::sql_only_fallback::record(
            "create_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::EngineMissingTarget,
        );
        return apply_create_block_sql_only(conn, p.clone()).await;
    };

    // Project the engine's post-apply state into SQL, then reproject the whole
    // sibling group to dense 1-based positions matching the tree order (#400).
    projection::project_create_block_to_sql(conn, &snapshot).await?;
    // #2200 Item 1: `siblings` is the FULL authoritative ordering of this
    // block's parent group after the insert. On the chunk path, record it in
    // the accumulator (keyed by parent) and defer the reprojection to the
    // end-of-chunk flush — the last create into a given parent carries the
    // complete final order, so reprojecting it once yields identical final
    // ranks. Off the chunk path, reproject inline immediately (unchanged).
    match chunk {
        Some(acc) => {
            let parent_key = p.parent_id.as_ref().map(|id| id.as_str().to_owned());
            // Space-qualify the key: an all-create chunk may span spaces, and
            // the `None` (top-level) parent key would otherwise collide across
            // spaces (see `ChunkAccumulator::reproject_groups`).
            acc.record_reproject(space_id.as_str().to_owned(), parent_key, siblings);
        }
        None => {
            // #2295: during boot replay the reprojection is suppressed and
            // deferred to a single end-of-replay reproject from the engine's
            // final state (see `LoroState::replay_suppress_reproject`). Record
            // this create's parent group instead of reprojecting inline. Off
            // replay (flag=false) this branch is byte-identical to before.
            if state.is_replay_suppressed() {
                let parent_key = p.parent_id.as_ref().map(agaric_core::ulid::BlockId::as_str);
                state.record_replay_dirty(space_id.as_str(), parent_key);
            } else {
                projection::reproject_dense_positions(conn, &siblings).await?;
            }
        }
    }

    // Tag inheritance — derived tag rows for the new block.
    let parent_str = p.parent_id.as_ref().map(agaric_core::ulid::BlockId::as_str);
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
pub async fn apply_edit_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &EditBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "edit_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_edit_block_sql_only(conn, p.clone()).await;
    };

    // #2250 (#1257 reconciliation): if the block is absent from this space's
    // engine tree (projected SQL-only during a no-space window),
    // `apply_edit_via_diff_splice` would error. Fall back to the authoritative
    // SQL projection (`None` below) and let boot-replay reconcile.
    let snapshot: Option<BlockSnapshot> = {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        if engine.read_block(p.block_id.as_str())?.is_none() {
            None
        } else {
            engine.apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)?;
            let snap_opt = engine.read_block(p.block_id.as_str())?;
            drop(guard);
            Some(snap_opt.ok_or_else(|| {
                AppError::validation(format!(
                    "apply_edit_block_via_loro: engine read_block returned None for {} \
                     (the block must exist for an EditBlock op to make sense)",
                    p.block_id.as_str()
                ))
            })?)
        }
    };
    let Some(snapshot) = snapshot else {
        super::sql_only_fallback::record(
            "edit_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::EngineMissingTarget,
        );
        return apply_edit_block_sql_only(conn, p.clone()).await;
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
pub async fn apply_set_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &SetPropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    // #2326: `SetProperty(space)` is the moment a page (and its whole block
    // subtree) acquires a space. Those blocks were created during the no-space
    // window and projected SQL-only, so they are absent from every engine. We
    // ALWAYS project the space assignment to SQL first — the projection is
    // idempotent and carries the #708 registered-space guard plus the
    // page-group `blocks.space_id` fan-out (or a NULL clear) — and THEN, if the
    // block now resolves to a space, hydrate its subtree into that space's
    // engine so subsequent ops on those blocks take the live engine path
    // instead of the `EngineMissingTarget` fallback. Re-resolving from the
    // freshly-written `blocks.space_id` naturally skips hydration when the
    // projection skipped an unregistered space (#708) or when the value cleared
    // the space (→ NULL). Handling `space` here (before the resolve gate below)
    // is required: pre-projection the page's `space_id` is still NULL, so
    // `resolve_block_space` would return `None` and the op would take a
    // (legitimate but now avoidable) SpaceUnresolved fallback.
    if p.key == agaric_store::op::SPACE_PROPERTY_KEY {
        // #2907: capture the block's CURRENTLY-resolved registered space BEFORE
        // the projection overwrites `blocks.space_id` to the target space.
        // `resolve_block_space` reads `COALESCE(blocks.space_id, page.space_id)`,
        // so pre-projection it yields the OLD space (or `None` for a first-time
        // assignment during the no-space window / an unregistered target #708)
        // and post-projection the NEW space. We need the OLD one to know whether
        // this is a genuine cross-space reassignment (below).
        let old_space = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?;

        projection::project_set_property_to_sql(conn, p).await?;
        if let Some(new_space) =
            agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
        {
            // #2907: a GENUINE reassignment — the block was already a member of a
            // DIFFERENT registered space — must PRUNE its whole subtree from the
            // OLD space's per-space LoroDoc before hydrating into the new one.
            // Otherwise the subtree stays durably a member of BOTH docs (both are
            // persisted as `loro_doc_state` snapshots): a peer importing the OLD
            // doc re-stamps the old `space_id` onto the moved blocks and
            // overwrites their content/parent_id/position from the stale copy
            // (projection.rs stamps `space_id` for every changed block), so
            // membership flip-flops and pre-move state resurrects.
            // `engine.apply_purge_block` records a deterministic subtree delete
            // into the OLD doc (seed + descendants; tree nodes + property/tag map
            // entries) and commits it, so every peer that applies OR imports this
            // op converges to "these blocks live only in the new space" — the
            // same convergence contract as a normal PurgeBlock.
            //
            // Gate: only when the block resolved to a DIFFERENT registered space
            // beforehand. A first-time assignment (`old_space == None`, the #2326
            // no-space window) or a same-space no-op (`old == new`, incl. an
            // unregistered target #708 that the projection left unchanged) prunes
            // nothing — behaviour there is unchanged.
            //
            // We call the engine method DIRECTLY, not `apply_purge_block_via_loro`
            // (which additionally runs the SQL purge cascade): the SQL rows must
            // SURVIVE — they now belong to the new space — so only the OLD doc's
            // CRDT membership is removed here.
            if let Some(old_space) = old_space.filter(|old| *old != new_space) {
                let mut guard =
                    state
                        .registry
                        .for_space_recording(&old_space, device_id, &state.revert)?;
                guard.engine_mut().apply_purge_block(p.block_id.as_str())?;
                drop(guard);
            }
            hydrate_page_subtree_into_engine(conn, state, device_id, &p.block_id, &new_space)
                .await?;
        }
        return Ok(());
    }

    let Some(space_id) = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "set_property",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_set_property_sql_only(conn, p.clone()).await;
    };

    // #2250 (#1257 reconciliation): if the block is absent from this space's
    // engine tree — projected SQL-only during a no-space window and never
    // reconciled into the engine (the #1257 LOCAL-applies / boot-replay-owns
    // window, or a cross-space case) — `apply_set_property_typed` would error.
    // (The #2326 create-then-`SetProperty(space)` case is handled by the space
    // branch above, which hydrates the subtree.) Fall back to the authoritative
    // payload-keyed SQL projection and let boot-replay reconcile the engine.
    // Mirrors the block-absent guard in `apply_edit_block_via_loro` /
    // `apply_delete_block_via_loro` (same `EngineMissingTarget` reason, same
    // `record` call, same sql_only path).
    let engine_applied = {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        if engine.read_block(p.block_id.as_str())?.is_none() {
            false
        } else {
            // Store the value with its native type so the engine is
            // type-lossless (`value_num`→`Num`, `value_bool`→`Bool`); text/date/ref
            // are all strings, disambiguated at the SQL projection by
            // `property_definitions.value_type`. No typed field set ⇒ explicit
            // clear (`Null`). The typed SQL columns are still written from the
            // payload directly by `project_set_property_to_sql` below.
            let value = crate::loro::engine::PropertyValue::from(p);
            engine.apply_set_property_typed(p.block_id.as_str(), &p.key, &value)?;
            drop(guard);
            true
        }
    };
    if !engine_applied {
        super::sql_only_fallback::record(
            "set_property",
            super::sql_only_fallback::SqlOnlyFallbackReason::EngineMissingTarget,
        );
        return apply_set_property_sql_only(conn, p.clone()).await;
    }

    projection::project_set_property_to_sql(conn, p).await?;
    Ok(())
}

/// #2326: Hydrate a page's whole block subtree into its (now-resolved) space
/// engine at space-assignment time.
///
/// When a page is created before its `SetProperty(space)` (the create-then-
/// assign ordering, e.g. #2249), every block in its group is projected SQL-only
/// during the no-space window and never enters any engine — so their later ops
/// take the `EngineMissingTarget` fallback until a boot-replay reconciles the
/// engine. This helper closes that window: as soon as the space is assigned we
/// seed the whole subtree (tree nodes + properties + tags) into the per-space
/// engine so subsequent ops route through the live engine path.
///
/// ## Order & scope
/// The subtree is read LIVE-only (`deleted_at IS NULL`), parent-before-child
/// (depth-ordered recursive descent from the page), so every parent is present
/// in the engine before its children are seeded.
///
/// ## Full seed (nodes + properties + tags)
/// Seeding only tree nodes would zero the `EngineMissingTarget` counter but
/// leave the exported CRDT missing this subtree's properties/tags — a peer
/// importing the export would not receive them. We therefore also replay each
/// block's `block_properties` and `block_tags` rows into the engine. (`space`
/// and the reserved keys are column-backed in `blocks`, not `block_properties`,
/// so they never appear here and need no engine property.)
///
/// ## Idempotency
/// Each node is skipped (`read_block(...).is_some()`) if already present, so the
/// helper is safe under partial prior hydration, re-assignment to the same
/// space, and a later boot-replay re-applying the original `CreateBlock` ops.
/// Only *newly-seeded* nodes' parent groups are reprojected, so a re-hydration
/// is a pure no-op (no SQL writes, no fallback-count change).
///
/// ## No sync duplicate-node hazard
/// These blocks were never in ANY engine export before, so this is their first
/// CRDT representation — the OPPOSITE of the `reload_registry_from_db` re-seed
/// warning (which concerns blocks peers already hold).
///
/// ## Non-transactional engine mutation
/// Per the pre-existing engine-vs-SQL contract, the engine seed is not rolled
/// back if the caller's tx aborts; the seeded nodes are harmless/idempotent and
/// self-correct on retry. We do NOT try to make it transactional.
async fn hydrate_page_subtree_into_engine(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    page_id: &agaric_core::ulid::BlockId,
    space_id: &agaric_store::space::SpaceId,
) -> Result<(), AppError> {
    use crate::loro::engine::PropertyValue;
    use crate::loro::projection;

    // 1. Read the whole owning-page group: LIVE rows only, parent-before-child
    //    (depth-ordered recursive descent from the page). The child ordering key
    //    is `position` so siblings seed in tree order.
    //    dynamic-sql: a static `concat!` of the `descendants_cte_active!` macro
    //    (a `const` recursive-CTE string) and a fixed SELECT — no runtime string
    //    interpolation. Runtime `query_as` only because the CTE prefix comes
    //    from the shared macro; mirrors `project_delete_block_to_sql`.
    #[derive(sqlx::FromRow)]
    struct SubtreeRow {
        id: String,
        block_type: String,
        content: String,
        parent_id: Option<String>,
        // Nullable: the both-`None` create sentinel writes SQL NULL.
        position: Option<i64>,
    }
    let rows: Vec<SubtreeRow> = sqlx::query_as(concat!(
        agaric_store::descendants_cte_active!(),
        "SELECT b.id, b.block_type, b.content, b.parent_id, b.position \
           FROM descendants d \
           JOIN blocks b ON b.id = d.id \
          ORDER BY d.depth ASC, b.position ASC",
    ))
    .bind(page_id.as_str())
    .fetch_all(&mut *conn)
    .await?;

    // 2. Read each node's properties + tags now (async), while we still hold no
    //    engine guard — the per-space guard is `!Send` and cannot cross an
    //    `.await`, so all SQL reads must complete before the sync seed scope.
    struct SeedNode {
        id: String,
        block_type: String,
        content: String,
        parent_id: Option<String>,
        position: i64,
        properties: Vec<(String, PropertyValue)>,
        tags: Vec<String>,
    }
    let mut nodes: Vec<SeedNode> = Vec::with_capacity(rows.len());
    for SubtreeRow {
        id,
        block_type,
        content,
        parent_id,
        position,
    } in rows
    {
        // A NULL `position` (the both-`None` create sentinel) maps to the
        // engine's append sentinel `i64::MAX`, exactly as the sql_only create
        // path feeds `apply_create_block`.
        let position = position.unwrap_or(i64::MAX);
        let prop_rows = sqlx::query!(
            r#"SELECT key, value_text, value_num, value_date, value_ref, value_bool
                 FROM block_properties WHERE block_id = ?"#,
            id,
        )
        .fetch_all(&mut *conn)
        .await?;
        // Recover the engine's native `PropertyValue` by the same precedence as
        // `PropertyValue::from(&SetPropertyPayload)` (text→num→date→ref→bool);
        // the `exactly_one_value` CHECK guarantees exactly one column is set.
        let properties = prop_rows
            .into_iter()
            .map(|r| {
                let pv = if let Some(t) = r.value_text {
                    PropertyValue::Str(t)
                } else if let Some(n) = r.value_num {
                    PropertyValue::Num(n)
                } else if let Some(d) = r.value_date {
                    PropertyValue::Str(d)
                } else if let Some(rf) = r.value_ref {
                    PropertyValue::Str(rf)
                } else if let Some(b) = r.value_bool {
                    PropertyValue::Bool(b != 0)
                } else {
                    PropertyValue::Null
                };
                (r.key, pv)
            })
            .collect();
        let tag_rows = sqlx::query!("SELECT tag_id FROM block_tags WHERE block_id = ?", id)
            .fetch_all(&mut *conn)
            .await?;
        let tags = tag_rows.into_iter().map(|r| r.tag_id).collect();
        nodes.push(SeedNode {
            id,
            block_type,
            content,
            parent_id,
            position,
            properties,
            tags,
        });
    }

    // 3. Seed into the (lazily-created) engine in ONE synchronous scope. The
    //    guard is `!Send`, so NO `.await` may run while it is alive. Skip nodes
    //    already present (idempotent), and record the post-seed sibling order of
    //    every parent group we actually touched for the dense reprojection.
    let touched_orders: Vec<Vec<String>> = {
        let mut guard = state
            .registry
            .for_space_recording(space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        let mut touched_parents: Vec<Option<String>> = Vec::new();
        for n in &nodes {
            if engine.read_block(&n.id)?.is_some() {
                continue;
            }
            engine.apply_create_block(
                &n.id,
                &n.block_type,
                &n.content,
                n.parent_id.as_deref(),
                n.position,
            )?;
            for (key, value) in &n.properties {
                engine.apply_set_property_typed(&n.id, key, value)?;
            }
            for tag_id in &n.tags {
                engine.apply_add_tag(&n.id, tag_id)?;
            }
            if !touched_parents.contains(&n.parent_id) {
                touched_parents.push(n.parent_id.clone());
            }
        }
        let mut orders = Vec::with_capacity(touched_parents.len());
        for parent in &touched_parents {
            orders.push(engine.children_ordered_block_ids(parent.as_deref())?);
        }
        drop(guard);
        orders
    };

    // 4. Reproject each touched parent group so the engine's sibling order and
    //    the SQL dense positions agree (mirrors the create path). Empty on a
    //    pure re-hydration (nothing newly seeded) ⇒ no writes.
    for order in &touched_orders {
        projection::reproject_dense_positions(conn, order).await?;
    }
    Ok(())
}

/// Apply DeleteBlock through the engine then project to SQL.
///
/// Engine `apply_delete_block` now stores the real `record.created_at`
/// Timestamp on the seed (Phase 2) — the same value the SQL
/// projection stamps — so cohort identity for restore lookups is
/// consistent between the engine and SQL, and lossless across sync.
/// The cascade (descendant fanout) is handled on the SQL side via the
/// projection's CTE-driven UPDATE; the engine only sees the seed
/// block's apply, with the post-commit
/// `dispatch_delete_descendants` fanning out the cohort to the
/// engine. An unresolvable space falls back to the SQL-only path.
pub async fn apply_delete_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &DeleteBlockPayload,
    now: i64,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "delete_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_delete_block_sql_only(conn, p.clone(), now).await;
    };

    // #2250 (#1257 reconciliation): if the block was projected SQL-only during
    // a no-space window and never entered this space's engine,
    // `apply_delete_block` would error ("block not found"). Fall back to the
    // authoritative SQL cascade for the tombstone; boot-replay reconciles the
    // engine.
    let engine_applied = {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        if engine.read_block(p.block_id.as_str())?.is_none() {
            false
        } else {
            // #109 Phase 2: the engine seed carries `deleted_at` as a String
            // slot (bridged to i64 at the SQL boundary); stringify here.
            engine.apply_delete_block(p.block_id.as_str(), &now.to_string())?;
            drop(guard);
            true
        }
    };
    if !engine_applied {
        super::sql_only_fallback::record(
            "delete_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::EngineMissingTarget,
        );
        return apply_delete_block_sql_only(conn, p.clone(), now).await;
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
pub async fn apply_move_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &MoveBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;
    use crate::loro::projection;

    let Some(space_id) = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "move_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_move_block_sql_only(conn, p.clone()).await;
    };

    // `Some((snapshot, old_parent_siblings, new_parent_siblings))` from the
    // engine path; `None` requests the SQL-only fallback (handled after the
    // guard scope closes, since an `.await` cannot cross the non-`Send`
    // `EngineGuard`). A move can change parent, so both the source and target
    // sibling groups need a dense reprojection (#400). The resulting parent may
    // differ from the requested one (a cyclic/unknown-parent move keeps the
    // current parent), so the authoritative new parent is the post-apply
    // snapshot's `parent_id`.
    #[allow(clippy::type_complexity)]
    let engine_result: Option<(BlockSnapshot, Option<String>, Vec<String>, Vec<String>)> = {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        let new_parent = p
            .new_parent_id
            .as_ref()
            .map(agaric_core::ulid::BlockId::as_str);
        // #2250 (#1257 reconciliation): this per-space engine can only apply
        // the move when BOTH the block and — for a reparent — its target
        // parent live in THIS space's tree. It cannot when (a) the block was
        // projected SQL-only during a no-space window (never entered any
        // engine) or (b) the move is cross-space (the target parent lives in
        // another space's tree). A single-engine `apply_move_block*` in either
        // case corrupts parent linkage (it drops the block to the root), so we
        // fall back to the authoritative SQL projection below and let
        // boot-replay reconcile the per-space engines.
        let block_in_engine = engine.read_block(p.block_id.as_str())?.is_some();
        let parent_in_engine = match new_parent {
            Some(pid) => engine.read_block(pid)?.is_some(),
            None => true,
        };
        if !block_in_engine || !parent_in_engine {
            None
        } else {
            let old_parent = engine.read_parent(p.block_id.as_str())?;
            // #400 routing: new ops carry a 0-based `new_index`; pre-#400 ops
            // carry the legacy sparse `new_position` (mapped to a slot).
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
                AppError::validation(format!(
                    "apply_move_block_via_loro: engine read_block returned None for {} \
                     (a MoveBlock op presupposes the block exists)",
                    p.block_id.as_str()
                ))
            })?;
            let old_siblings = engine.children_ordered_block_ids(old_parent.as_deref())?;
            // Same-parent reorder (the common DnD / moveUp / moveDown case):
            // source and target groups are identical, so reproject once. Only
            // fetch the second group when the parent actually changed (#400).
            let new_siblings = if old_parent.as_deref() == snap.parent_id.as_deref() {
                Vec::new()
            } else {
                engine.children_ordered_block_ids(snap.parent_id.as_deref())?
            };
            drop(guard);
            Some((snap, old_parent, old_siblings, new_siblings))
        }
    };
    let Some((snapshot, old_parent, old_siblings, new_siblings)) = engine_result else {
        super::sql_only_fallback::record(
            "move_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::EngineMissingTarget,
        );
        return apply_move_block_sql_only(conn, p.clone()).await;
    };

    projection::project_move_block_to_sql(conn, &snapshot).await?;
    // #2295: during boot replay both reprojections are suppressed and deferred
    // to a single end-of-replay reproject per touched parent from the engine's
    // final state (see `LoroState::replay_suppress_reproject`). Record the same
    // groups the inline path would have reprojected — the source (old-parent)
    // group always, and the target (new-parent) group only when reparenting
    // (`!new_siblings.is_empty()`, the exact condition guarding the second
    // inline reproject). Off replay (flag=false) the reproject calls below are
    // byte-identical to before.
    if state.is_replay_suppressed() {
        state.record_replay_dirty(space_id.as_str(), old_parent.as_deref());
        if !new_siblings.is_empty() {
            state.record_replay_dirty(space_id.as_str(), snapshot.parent_id.as_deref());
        }
    } else {
        // Reproject the source group (it shrank, or — for a same-parent move —
        // it is the single affected group). `new_siblings` is empty on a
        // same-parent move.
        projection::reproject_dense_positions(conn, &old_siblings).await?;
        if !new_siblings.is_empty() {
            projection::reproject_dense_positions(conn, &new_siblings).await?;
        }
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
///
/// #2017: returns the restored ANCESTOR chain (the contiguous soft-deleted
/// ancestors above the block that the projection un-deleted in SQL). The caller
/// (`apply_op_tx`) surfaces it in `ApplyEffects::restored_ancestors` and fans it
/// out to the engine post-commit (`dispatch_restore_ancestors`), mirroring the
/// descendant cohort fan-out. Without this the SQL un-deletes the ancestors but
/// the engine never hears, so the next reproject re-deletes them in SQL.
pub async fn apply_restore_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &RestoreBlockPayload,
) -> Result<Vec<String>, AppError> {
    use crate::loro::projection;
    use agaric_core::ulid::BlockId;

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
    let Some(space_id) =
        agaric_store::space::resolve_block_space(&mut *conn, &resolution_anchor).await?
    else {
        super::sql_only_fallback::record(
            "restore_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_restore_block_sql_only(conn, p.clone()).await;
    };

    {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
        let engine = guard.engine_mut();
        engine.apply_restore_block(p.block_id.as_str())?;
        drop(guard);
    }

    let restored_ancestors =
        projection::project_restore_block_to_sql(conn, p.block_id.as_str(), p.deleted_at_ref)
            .await?;

    // #1884: `project_restore_block_to_sql` also restores the contiguous
    // soft-deleted ANCESTOR chain above the block (closing the live-orphan
    // gap). Recompute tag inheritance from the TOPMOST now-live ancestor so
    // the whole reconnected subtree — not just the block's own subtree — is
    // refreshed, matching the command path (`restore_block_inner`). The walk
    // climbs `parent_id` from the block to the highest live ancestor; with no
    // restored ancestors it resolves to the block itself (unchanged
    // behaviour).
    let inheritance_root = topmost_live_ancestor(&mut *conn, p.block_id.as_str()).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, &inheritance_root).await?;

    // #2017: surface the restored ancestor chain so `apply_op_tx` can fan it
    // out to the per-space engine post-commit. The engine apply above targeted
    // only the SEED; the ancestors were un-deleted in SQL only.
    Ok(restored_ancestors)
}

/// #1884: id of the highest LIVE ancestor reachable by walking `parent_id`
/// upward from `block_id` (the block itself if its parent is deleted/absent
/// or the parent walk yields no higher live row). Used to root the
/// tag-inheritance recompute after the ancestor chain has been restored, so
/// the whole reconnected subtree is refreshed.
///
/// `depth < 100` bounds runaway recursion on corrupted `parent_id` chains
/// (AGENTS.md invariant #9).
pub async fn topmost_live_ancestor(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<String, AppError> {
    // Walk live ancestors upward; the deepest (greatest depth) is the
    // topmost. All ancestors are live by this point (the chain was restored).
    // dynamic-sql: recursive variable-depth ancestor walk; not expressible as
    // a compile-checked `query!` macro.
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants
    let top = sqlx::query_scalar::<_, String>(
        "WITH RECURSIVE live_anc(id, parent_id, depth) AS ( \
             SELECT b.id, b.parent_id, 0 FROM blocks b \
             WHERE b.id = ? AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT p.id, p.parent_id, a.depth + 1 FROM blocks p \
             INNER JOIN live_anc a ON p.id = a.parent_id \
             WHERE p.deleted_at IS NULL AND a.depth < 100 \
         ) \
         SELECT id FROM live_anc ORDER BY depth DESC LIMIT 1",
    )
    .bind(block_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(top.unwrap_or_else(|| block_id.to_string()))
}

/// Apply PurgeBlock through the engine then run the SQL cascade.
///
/// Engine apply is per-block-id (deletes the seed's `blocks`,
/// `block_properties`, `block_tags` entries from the LoroDoc). The
/// SQL side then runs the full cascade inline — the cascade is much
/// wider than the engine state (purges agenda_cache, tags_cache,
/// fts_blocks, etc. that the engine doesn't model) so it stays in
/// this helper rather than getting absorbed into a projection. The
/// engine descendant state is handled by `apply_purge_block` itself,
/// which collects seed + descendants and prunes the whole subtree from
/// the LoroDoc — so this single seed call keeps the engine in parity with
/// the SQL cascade. The SQL cascade is the source of truth users observe.
/// The SQL-only fallback arm is taken only when the block's space is
/// genuinely unresolvable (NULL `space_id`); it is not reachable for a
/// normally-spaced purge since #2868.
pub async fn apply_purge_block_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    // #2868: a purge targets an already SOFT-DELETED block, so the
    // canonical `resolve_block_space` (which filters `deleted_at IS NULL`)
    // returns `None` here — dropping the engine fan-out and clearing only
    // SQL, which leaves the per-space Loro tombstone in place to resurrect
    // the purged block on a snapshot-syncing peer. Resolve the space via the
    // soft-delete-tolerant reader (the denormalized `blocks.space_id` column
    // survives a soft-delete), captured BEFORE `purge_block_sql_cascade`
    // physically removes the row — mirroring the LOCAL purge path's
    // `capture_purge_engine_fanout` and the REMOTE delete/restore pre-capture
    // pattern. `engine.apply_purge_block` then prunes the whole subtree from
    // the LoroDoc (it collects seed + descendants internally), so a single
    // seed call clears the engine tombstone. A genuinely unresolvable space
    // (NULL `space_id`, pre-spaces data) still falls back to SQL-only.
    let Some(space_id) =
        agaric_store::space::resolve_soft_deleted_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "purge_block",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return purge_block_sql_cascade(conn, p).await;
    };

    {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
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
// `pub(crate)` (was `pub(super)`): the #2128 inbound-purge parity test in
// `sync_protocol::tests` drives this LOCAL cascade against an oracle DB to
// assert remote-purge SQL == local-purge SQL across every derived table.
pub async fn purge_block_sql_cascade(
    conn: &mut sqlx::SqliteConnection,
    p: &PurgeBlockPayload,
) -> Result<(), AppError> {
    let block_id = p.block_id.as_str();
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *conn)
        .await?;
    // C: materialise the descendants set ONCE into a TEMP
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
    // #1655: build the descendants set from the shared
    // `descendants_cte_purge!()` macro (single source of truth for the
    // purge CTE body — outer `deleted_at`-free filter, `depth < 100` cap)
    // rather than re-inlining it here. `concat!` is required because the
    // macro expands to a string literal that must be prefixed by the
    // `CREATE TEMP TABLE … AS` header and suffixed by the projection.
    sqlx::query(concat!(
        "CREATE TEMP TABLE _purge_descendants AS ",
        agaric_store::descendants_cte_purge!(),
        "SELECT id FROM descendants",
    ))
    .bind(block_id)
    .execute(&mut *conn)
    .await?;
    // #2275 — `descendants_cte_purge!()` caps at `depth < 100`, so a subtree
    // deeper than 100 levels leaves the depth-101+ descendants OUT of
    // `_purge_descendants`. Since `blocks.parent_id` is a deferred FK with no
    // ON DELETE action, deleting the collected rows (whose deepest members are
    // the depth-100 parents of those stragglers) would leave dangling
    // `parent_id` references and abort the whole COMMIT opaquely under
    // `PRAGMA defer_foreign_keys = ON`. Extend the set one generation at a time
    // until it reaches a fixpoint, so the full subtree is consumed regardless
    // of depth. In the common (shallow) case the first extension INSERT matches
    // zero rows — everything within 100 levels is already collected — so this
    // is a single cheap no-op query; it only loops when the cap was actually
    // saturated, which we surface once as a `cascade_depth_saturated` warn.
    let mut cascade_depth_saturated = false;
    loop {
        let added = sqlx::query(
            "INSERT INTO _purge_descendants (id) \
             SELECT b.id FROM blocks b \
             WHERE b.parent_id IN (SELECT id FROM _purge_descendants) \
               AND b.id NOT IN (SELECT id FROM _purge_descendants)",
        )
        .execute(&mut *conn)
        .await?
        .rows_affected();
        if added == 0 {
            break;
        }
        cascade_depth_saturated = true;
    }
    if cascade_depth_saturated {
        tracing::warn!(
            block_id,
            "purge cascade depth cap (100) saturated; extended the descendant \
             set to the full subtree to avoid a dangling-FK COMMIT abort"
        );
    }
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
    // block_tag_refs / page_link_cache: both columns of each table FK
    // into blocks(id) ON DELETE CASCADE, so the final `DELETE FROM blocks`
    // under `defer_foreign_keys = ON` would clean these up implicitly.
    // We delete them explicitly anyway (issue #1583): the explicit list
    // above is the canonical record of every derived table PURGE touches,
    // and relying on the cascade silently leaks stale rows if a future
    // migration alters the FK or adds a block-referencing cache without
    // CASCADE. Delete rows referencing the purged subtree on EITHER FK
    // column.
    sqlx::query(
        "DELETE FROM block_tag_refs \
         WHERE source_id IN (SELECT id FROM _purge_descendants) \
            OR tag_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM page_link_cache \
         WHERE source_page_id IN (SELECT id FROM _purge_descendants) \
            OR target_page_id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "DELETE FROM blocks \
         WHERE id IN (SELECT id FROM _purge_descendants)",
    )
    .execute(&mut *conn)
    .await?;
    // C: explicitly drop the temp table so the pooled
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
pub async fn apply_add_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &AddTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "add_tag",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_add_tag_sql_only(conn, p.clone()).await;
    };

    {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
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
pub async fn apply_remove_tag_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &RemoveTagPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "remove_tag",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_remove_tag_sql_only(conn, p.clone()).await;
    };

    {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
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
pub async fn apply_delete_property_via_loro(
    conn: &mut sqlx::SqliteConnection,
    state: &crate::loro::shared::LoroState,
    device_id: &str,
    p: &DeletePropertyPayload,
) -> Result<(), AppError> {
    use crate::loro::projection;

    let Some(space_id) = agaric_store::space::resolve_block_space(&mut *conn, &p.block_id).await?
    else {
        super::sql_only_fallback::record(
            "delete_property",
            super::sql_only_fallback::SqlOnlyFallbackReason::SpaceUnresolved,
        );
        return apply_delete_property_sql_only(conn, p.clone()).await;
    };

    {
        let mut guard = state
            .registry
            .for_space_recording(&space_id, device_id, &state.revert)?;
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
// Row). These rows write SQL but skip the engine apply; a
//   later op-log replay will reconcile engine state if the row gets a
//   space.
//
// In production both arms are unreachable. The fallback exists so
// that ~55 materializer / recovery / sync_daemon tests can thread
// synthetic ops through `apply_op` against bare-block fixtures with
// no space chain.
// ---------------------------------------------------------------------------
