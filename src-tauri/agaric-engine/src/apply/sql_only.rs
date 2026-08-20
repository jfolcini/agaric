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
pub async fn apply_create_block_sql_only(
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
                .map(agaric_store::pagination::index_to_provisional_position)
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
pub async fn apply_edit_block_sql_only(
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
pub async fn apply_delete_block_sql_only(
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
///
/// #1884: `project_restore_block_to_sql` also restores the contiguous
/// soft-deleted ANCESTOR chain above the block (closing the live-orphan
/// gap). A restored ancestor had its OWN `block_tag_inherited` rows swept
/// at delete time (`remove_subtree_inherited`), so the recompute must be
/// rooted at the TOPMOST now-live ancestor — not the block itself — or the
/// restored ancestors keep stale/missing inherited-tag rows. This is the
/// PRIMARY orphan path: `apply_restore_block_via_loro` ALWAYS routes here
/// when the parent is still tombstoned (space resolves off the parent,
/// which is soft-deleted), so its own re-rooting at `topmost_live_ancestor`
/// is bypassed and must be mirrored here to keep the command and
/// projection paths converged on the derived `block_tag_inherited` view.
///
/// #2017: returns the restored ancestor chain (the ids whose `deleted_at` the
/// projection cleared upward) so the caller can fan the restore out to the
/// per-space Loro engine. On this SQL-only fallback path the engine arm did not
/// run (space unresolved / engine uninit), so the engine state for those
/// ancestors is reconciled lazily on the next op-log replay; the chain is still
/// returned for symmetry and for callers that DO have an engine available.
pub async fn apply_restore_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: RestoreBlockPayload,
) -> Result<Vec<String>, AppError> {
    let restored_ancestors = crate::loro::projection::project_restore_block_to_sql(
        conn,
        p.block_id.as_str(),
        p.deleted_at_ref,
    )
    .await?;
    let inheritance_root = topmost_live_ancestor(&mut *conn, p.block_id.as_str()).await?;
    tag_inheritance::recompute_subtree_inheritance(&mut *conn, &inheritance_root).await?;
    Ok(restored_ancestors)
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
/// [`agaric_store::block_descendants::move_would_cycle`] helper, the SAME probe
/// `move_block_inner` (the command path) uses, so the two SQL-side paths
/// cannot drift. The rejection still differs by design: the command path errs,
/// this sync-replay fallback no-op-warns (aborting would wedge inbound sync;
/// dropping a self-evidently invalid move is recoverable).
pub async fn apply_move_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: MoveBlockPayload,
) -> Result<(), AppError> {
    use crate::loro::engine::BlockSnapshot;

    let new_parent_str = p.new_parent_id.as_ref().map(|id| id.as_str().to_owned());
    let block_id_str = p.block_id.as_str();

    // #383 / #1323: shared cycle probe (see helper docstring). No-op-warn (not
    // error) on this sync-replay fallback arm.
    if let Some(parent) = new_parent_str.as_deref()
        && agaric_store::block_descendants::move_would_cycle(&mut *conn, block_id_str, parent)
            .await?
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
        agaric_store::pagination::index_to_provisional_position,
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
    // #4112: the moved block may now sit LIVE under a tombstone. Sweep it into
    // the tombstone's cohort — the SAME R9 rule the sync-import path applies —
    // and let the sweep own the tag maintenance when it fires (a fully
    // tombstoned subtree wants `remove_subtree_inherited`'s unfiltered wipe,
    // not a recompute whose `subtree_active` walk can no longer see past the
    // root it just tombstoned — `sweep_converges_the_inherited_tag_cache_with_the_arbiter_4112`
    // reddens on that substitution).
    //
    // The engine arm runs the SAME sweep, then additionally mirrors the cohort
    // onto its per-space engine; this arm has no engine to mirror to in its
    // primary case (`SpaceUnresolved` — the block never entered one). In the
    // `EngineMissingTarget` sub-case the block CAN be in an engine that now
    // disagrees (engine live / SQL deleted), which is the pre-existing #2250
    // fallback degradation boot replay reconciles: it cannot RESURRECT the row,
    // because `reproject_block_deleted_at_from_engine`'s `(Some(_), Some(_))`
    // resurrection-guard arm is exactly "SQL-deleted under a tombstoned
    // ancestor → no-op".
    if sweep_move_under_tombstoned_ancestor(&mut *conn, block_id_str)
        .await?
        .is_none()
    {
        tag_inheritance::recompute_subtree_inheritance(&mut *conn, p.block_id.as_str()).await?;
    }
    Ok(())
}

/// #4112 — the shared post-`MoveBlock` repair for the one tree shape a remote
/// move can create and no local command can: a **LIVE block under a
/// TOMBSTONED ancestor**.
///
/// ## What the local path does, and why the replay path cannot copy it
///
/// `commands::blocks::move_ops::validate_move_in_tx` probes
/// `SELECT 1 FROM blocks WHERE id = ? AND deleted_at IS NULL` for BOTH the
/// subject and the target parent and returns [`AppError::NotFound`] — so a
/// user-driven move into the trash never becomes an op at all. The replay path
/// is structurally different in the way that matters: by the time it runs, the
/// op EXISTS. It was authored on a peer against a state where the parent was
/// still live, and refusing it here is not "validation", it is **dropping a
/// peer's op on one device only** — the divergence that is strictly worse than
/// the state it would prevent. Concretely, for the op set
/// `{Delete(P), Move(B → P)}`:
///
/// * replayed `Delete` first, a refusing guard leaves `B` live under its OLD
///   parent;
/// * replayed `Move` first, `Delete`'s cascade tombstones `B` under `P`.
///
/// Two devices, same ops, different states. Applying the move unguarded (the
/// pre-#4112 behaviour) diverges the same way — `B` live under a tombstone
/// versus `B` trashed. The sweep is the only one of the candidate behaviours
/// that converges: BOTH orders end with `B` under `P`, tombstoned at `P`'s
/// `deleted_at`, because the sweep computes exactly the cascade the
/// delete-last order computes.
///
/// ## This is not a new semantics — it is R9's, applied on the op path
///
/// [`crate::loro::projection::reproject_block_deleted_at_from_engine`] already
/// resolves this exact merge on the SNAPSHOT-import path, and already names it:
/// *"LIVE in both engine and SQL but sitting under a tombstoned ancestor — the
/// concurrent delete-vs-move-in merge. Inherit the nearest tombstoned
/// ancestor's cohort."* So #4112's open question ("is a live block under a
/// tombstoned parent legal?") is already answered NO in this codebase; the gap
/// was that the answer was only enforced where blocks arrive as an imported
/// CRDT snapshot, not where they arrive as replayed `MoveBlock` ops. This
/// helper reuses the same ancestor probe
/// ([`agaric_store::block_descendants::nearest_tombstoned_ancestor`]), the same
/// cohort source ([`crate::loro::projection::project_delete_block_to_sql`]) and
/// the same cohort timestamp, so the two entry points cannot drift.
///
/// ## What it deliberately does NOT do
///
/// A move whose SUBJECT is already tombstoned is applied unchanged. A
/// tombstoned block under a live parent is the ordinary trash shape (that is
/// exactly what `delete_block` produces), it is what R9's `(Some(_), Some(_))`
/// resurrection-guard arm preserves, and applying the move is what CONVERGES:
/// `Delete(B)` then `Move(B → Q)` and `Move(B → Q)` then `Delete(B)` both end
/// with `B` under `Q`, tombstoned. `validate_move_in_tx` rejects that case too,
/// but as a UI affordance (do not let a user drag a trashed block), not as a
/// state invariant — so it is the half of the local guard that must NOT be
/// mirrored here. Pinned by
/// `move_of_a_tombstoned_block_is_applied_not_dropped_4112`, which reddens
/// when the local path's subject probe IS mirrored onto this arm.
///
/// The residue of that choice is #4188: when BOTH the source and the target
/// parent are deleted concurrently, whichever cascade catches the block first
/// owns its cohort, so `{Delete(P1), Delete(P2), Move(B: P1 → P2)}` still
/// resolves `deleted_at` order-dependently. That divergence predates #4112 and
/// lives in the `DeleteBlock` cascade's skip-an-already-stamped-row rule, not
/// here — this sweep narrows it (it no longer leaves `B` live) rather than
/// closing it.
///
/// #4204 is the neighbouring residue, and it is NOT covered by #4188's
/// "both endpoints deleted" scoping: a delete of the OLD parent racing a move
/// OUT, with the target parent LIVE. For `{Delete(P1), Move(C1A: P1 → P2)}`
/// with `P2` live, replayed delete-first, `P1`'s cascade stamps `C1A` and the
/// move — which does not refuse a tombstoned subject, see above — carries it
/// under `P2` still trashed; replayed move-first,
/// `collect_subtree_ids_unbounded(P1)` no longer reaches `C1A` and it stays
/// LIVE under `P2`. This sweep never fires in either order (after the move the
/// whole ancestor chain is live, so `nearest_tombstoned_ancestor` returns
/// `None`), so the divergence predates #4112 and is untouched by it — but it is
/// strictly worse than #4188's, which diverges only on WHICH restore cohort a
/// block that is trashed everywhere belongs to. Here the two devices disagree
/// about whether the subtree is in the tree at all.
///
/// This list is the set of shapes that have been WALKED, not a proof of
/// exhaustiveness. It covers what the sweep's own choices imply; a new op
/// combination that resolves `deleted_at` by replay order belongs here (and in
/// an issue) rather than being assumed absent because it is unlisted.
///
/// Returns `Some((cohort_ts, cohort))` when it swept — the ids it stamped,
/// for the caller's engine fan-out — and `None` when the block is healthy
/// (the overwhelmingly common case). The healthy path costs one PK lookup
/// PLUS one depth-bounded `parent_id` climb
/// ([`agaric_store::block_descendants::nearest_tombstoned_ancestor`]) — the
/// climb is what decides "healthy", so it cannot be skipped on a block whose
/// own row is live. It is not skipped on a same-parent reorder either: the
/// helper doubles as a repair pass for a subtree that was ALREADY an invisible
/// orphan (a pre-#4112 vault, or a `sql_only`-fallback move), and a reorder is
/// a legitimate occasion to notice.
pub(crate) async fn sweep_move_under_tombstoned_ancestor(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Option<(i64, Vec<String>)>, AppError> {
    // Only a LIVE block can be an invisible orphan. `Some(None)` = the row
    // exists and `deleted_at IS NULL`; `Some(Some(_))` = ordinary trash (see
    // the "deliberately does NOT" note above); `None` = no row, nothing to
    // sweep.
    let own_deleted_at: Option<Option<i64>> =
        sqlx::query_scalar!("SELECT deleted_at FROM blocks WHERE id = ?", block_id)
            .fetch_optional(&mut *conn)
            .await?;
    if !matches!(own_deleted_at, Some(None)) {
        return Ok(None);
    }

    let Some((ancestor_id, ancestor_ts)) =
        agaric_store::block_descendants::nearest_tombstoned_ancestor(&mut *conn, block_id).await?
    else {
        return Ok(None);
    };

    // Loud: this is a cross-device reconciliation, not a user action — the
    // same reason R9's sweep warns.
    tracing::warn!(
        block_id = %block_id,
        ancestor_id = %ancestor_id,
        cohort_ts = ancestor_ts,
        "MoveBlock landed a live block under a tombstoned ancestor \
         (concurrent delete-vs-move merge, #4112); sweeping it into the \
         ancestor's trash cohort",
    );
    // Same cohort source and same timestamp as R9's sweep, so a device that
    // learns of this move by op replay and one that learns of it by snapshot
    // import stamp the identical rows at the identical `deleted_at` — which is
    // also what makes the cohort restorable as one unit (`RestoreBlock` keys on
    // the shared `deleted_at`).
    let cohort =
        crate::loro::projection::project_delete_block_to_sql(&mut *conn, block_id, ancestor_ts)
            .await?;
    // Mirror `apply_delete_block_via_loro`'s tag maintenance for a newly
    // tombstoned subtree: `remove_subtree_inherited` walks UNFILTERED, so it
    // still reaches the descendants the cascade just tombstoned, which
    // `recompute_subtree_inheritance` (whose `subtree_active` walk stops at
    // them) no longer can.
    tag_inheritance::remove_subtree_inherited(&mut *conn, block_id).await?;
    Ok(Some((ancestor_ts, cohort)))
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
pub async fn apply_add_tag_sql_only(
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
pub async fn apply_remove_tag_sql_only(
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
pub async fn apply_set_property_sql_only(
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
pub async fn apply_delete_property_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: DeletePropertyPayload,
) -> Result<(), AppError> {
    crate::loro::projection::project_delete_property_to_sql(conn, p.block_id.as_str(), &p.key).await
}
