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
/// #4390 — returns the ids [`unsweep_inherited_cohort_after_move`] cleared, so
/// the caller can mirror the re-derivation onto the per-space engine after the
/// transaction commits. Empty on every path that did not un-sweep, which is
/// every path but the tombstoned-INHERITED subject: the cycle skip, a live
/// subject, and an INTRINSIC tombstone all return `vec![]`. This arm has no
/// engine by construction — that is what `resolve_block_space`'s
/// `deleted_at IS NULL` filter routes here — so threading the ids out is the
/// only way the clear can reach one.
pub async fn apply_move_block_sql_only(
    conn: &mut sqlx::SqliteConnection,
    p: MoveBlockPayload,
) -> Result<Vec<String>, AppError> {
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
        return Ok(Vec::new());
    }

    // #4204: classify the subject's tombstone BEFORE the reparent — inheritance
    // is a fact about the OLD parent, and one `UPDATE … SET parent_id` from now
    // that parent is unrecoverable. See `inherited_cohort_before_move`.
    let inherited = inherited_cohort_before_move(&mut *conn, block_id_str).await?;

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
    // #4204: an INHERITED tombstone is positional, so the reparent above
    // invalidated it. Clear it and let the sweep below re-derive the cohort
    // from the new position. This arm has no engine to mirror the clear onto,
    // and it is the arm that RUNS for a tombstoned subject — so #4390 threads
    // the cleared ids OUT to a post-commit mirror instead. See
    // `unsweep_inherited_cohort_after_move`'s "Why it returns the cleared ids".
    // #4390: the cleared ids are threaded back out to `apply_op_tx`, which
    // reads their FINAL `deleted_at` (the sweep below may re-stamp them) into
    // `ApplyEffects::unswept_cohort` for the post-commit engine mirror.
    let unswept = match inherited {
        Some(inherited_ts) => {
            unsweep_inherited_cohort_after_move(&mut *conn, block_id_str, inherited_ts).await?
        }
        None => Vec::new(),
    };
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
    Ok(unswept)
}

/// #4204/#4188 — the pre-`MoveBlock` half of the shared tail: is the subject's
/// tombstone **INHERITED** (it is a cascade member of its parent's cohort) or
/// **INTRINSIC** (it is a cohort ROOT — something deleted this block itself)?
///
/// ## The rule this classification serves
///
/// > `deleted_at` is a function of the CONVERGED TREE, not of replay order.
/// > A cohort ROOT keeps its own stamp. Every other block's `deleted_at` is
/// > the nearest tombstoned ancestor's `deleted_at` in the tree it is in NOW,
/// > and NULL when that whole chain is live.
///
/// [`sweep_move_under_tombstoned_ancestor`] is the second clause read
/// downwards (live block, tombstoned chain → inherit). This helper opens the
/// same clause read upwards (inherited tombstone, chain that no longer implies
/// it → re-derive). A `MoveBlock` is precisely the event that changes "the tree
/// it is in NOW", so it is where the re-derivation belongs.
///
/// Order-independence: after every op has been applied, `parent_id` is
/// converged (engine per-key LWW — both #4188 and #4204 measured it converging
/// today) and the cohort roots with their stamps are converged (a root's stamp
/// is its `DeleteBlock` record's `created_at`, an immutable op field). The rule
/// makes every other `deleted_at` a pure function of those two converged
/// inputs, so it cannot depend on the order the ops arrived in.
///
/// ## Why the test is structural
///
/// Cohort identity in this codebase is `(seed, deleted_at)`-STRUCTURAL, not an
/// explicit stored cohort id (#1055 / #1549): a cohort is a *contiguous* chain
/// of equal `deleted_at`, which is what
/// [`agaric_store::block_descendants::DescendantWalkFilter::Cohort`] walks and
/// what `restore_deleted_ancestor_chain` (#1884) climbs. So "my parent carries
/// the same non-NULL `deleted_at`" IS this codebase's existing definition of
/// "I am not the top of my own cohort", and reusing it keeps this arm from
/// introducing a second, competing notion of cohort membership.
///
/// It is not free of the pre-existing limitation that comes with a structural
/// cohort. `{Delete(P)@t1, Delete(B)@t3}` on a nested `P > B` already resolves
/// order-dependently *today* (delete-P-first leaves `B` at `t1` because the
/// second cascade's `deleted_at IS NULL` filter skips it; delete-B-first leaves
/// it at `t3` because the outer cascade's active walk stops at it), so the ROOT
/// SET itself is not converged for that shape — and any rule keyed on
/// root-ness inherits that. It is out of scope here (neither #4188 nor #4204
/// deletes the same block twice), it predates this change, and only an explicit
/// cohort id — the #1055/#1549 schema change — dissolves it.
///
/// ## Why not the engine's `deleted_at` register instead
///
/// [`crate::loro::projection::reproject_block_deleted_at_from_engine`]'s docs
/// say the engine holds `deleted_at` on the delete SEED only, which would make
/// the register an authoritative root marker. That is true of the import path
/// and FALSE of the op path: `apply_op_projected` fans
/// `ApplyEffects::deleted_cohort` — seed *plus* descendants — onto the engine
/// through `dispatch_delete_descendants`, so a cascade member's register is set
/// too. The register therefore cannot distinguish root from member here, which
/// is why the classification is structural.
///
/// It is also why the SQL clear this helper opens is NOT durable across a
/// snapshot import, and that residue is the open half of #4204 — see
/// [`unsweep_inherited_cohort_after_move`]'s "What this does NOT fix".
///
/// Returns `Some(ts)` when the subject is an inherited cascade member (its
/// tombstone is positional), `None` when it is live, parentless, a cohort root,
/// or has no row.
pub(crate) async fn inherited_cohort_before_move(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Option<i64>, AppError> {
    let inherited: Option<i64> = sqlx::query_scalar!(
        "SELECT b.deleted_at FROM blocks b \
           JOIN blocks parent ON parent.id = b.parent_id \
          WHERE b.id = ? \
            AND b.deleted_at IS NOT NULL \
            AND parent.deleted_at IS NOT NULL \
            AND parent.deleted_at = b.deleted_at",
        block_id
    )
    .fetch_optional(&mut *conn)
    .await?
    .flatten();
    Ok(inherited)
}

/// #4204/#4188 — the post-`MoveBlock` half: re-derive an INHERITED tombstone
/// from the subject's NEW position by clearing it, leaving
/// [`sweep_move_under_tombstoned_ancestor`] (which the caller runs next) to
/// stamp whatever the new ancestor chain implies.
///
/// `inherited_ts` is [`inherited_cohort_before_move`]'s answer, captured before
/// the reparent.
///
/// ## The short-circuit is load-bearing, not an optimisation
///
/// When the new position's nearest tombstoned ancestor already carries
/// `inherited_ts` the clear is skipped entirely. That covers the same-parent
/// reorder, the move WITHIN one cohort, and — the case with teeth — the
/// idempotent REPLAY of a move that this very tail swept on its first pass
/// (`replayed_move_into_a_tombstone_is_idempotent_4112`): on the second pass
/// the subject looks exactly like a cascade member of its new parent's cohort,
/// because it now is one. Clearing and re-stamping would land on the same
/// value, but it would churn the engine register through a restore/delete pair
/// for no state change.
///
/// ## The two outcomes
///
/// * The new chain has a DIFFERENT tombstoned ancestor (#4188's shape, both
///   endpoints deleted): cleared here, re-stamped at the new ancestor's cohort
///   by the sweep. The block stays trashed; only its restore cohort moves —
///   to the one its new position implies.
/// * The new chain is entirely LIVE (#4204's shape, a move OUT of a deleted
///   parent onto a live one): cleared here, and the sweep finds nothing, so the
///   block stays live. This is a genuine resurrection on the device that
///   replayed the delete first, and it is the only implementable convergent
///   answer: `DeleteBlockPayload` carries only `block_id`, so a device that
///   replayed the MOVE first has no record the subject was ever the deleted
///   parent's child and no "delete wins" rule can recover one. It is also not a
///   new semantic — the sweep's mirror image already ships it on the
///   snapshot-import path, as
///   `reproject_block_deleted_at_from_engine`'s `(Some(deleted_at_ref), None)`
///   arm: SQL-tombstoned, engine-live, live ancestor chain → restore the
///   cohort. What is new is the op path agreeing with it.
///
/// Only a CONCURRENT authoring can reach either outcome: `validate_move_in_tx`
/// refuses to move a trashed block, so no device that had already seen the
/// delete could have authored this move.
///
/// ## Why it returns the cleared ids (#4390)
///
/// The clear is SQL-only, and on its own that is not durable. On the device
/// that replayed the delete first, the subject's per-space engine `deleted_at`
/// register still holds the OLD cohort's timestamp, because
/// `apply_op_projected` fans a delete's whole `deleted_cohort` — seed plus
/// descendants — onto the engine (`dispatch_delete_descendants`). The next
/// [`crate::loro::projection::reproject_block_deleted_at_from_engine`] would
/// take its `Some(ts)` branch and re-trash the subtree, so the convergence
/// this helper produces survived op replay and boot recovery but NOT a
/// snapshot import.
///
/// The mirror cannot live HERE, nor in `apply_move_block_via_loro`: a move
/// whose subject is TOMBSTONED — the only kind this helper ever sees — is
/// routed to [`apply_move_block_sql_only`] by `resolve_block_space`'s
/// `deleted_at IS NULL` filter, and that arm has no engine by construction. So
/// #4390 threads the answer OUT instead: this helper returns the ids it
/// cleared, [`apply_move_block_sql_only`] returns them to its caller,
/// `apply_op_tx` re-reads their FINAL `deleted_at` into
/// `ApplyEffects::unswept_cohort`, and the post-commit
/// `materializer::handlers::apply::dispatch_unswept_cohort` mirrors that final
/// state onto the per-space engine — the shape of #2868's purge fix
/// (`resolve_soft_deleted_block_space` + a mirror dispatch).
///
/// FINAL state, not "restore them all": the tail's other half
/// ([`sweep_move_under_tombstoned_ancestor`], which the caller runs next) may
/// re-stamp the very rows this one cleared, at the cohort the NEW position
/// implies. That is #4188's shape, and mirroring a blanket restore there would
/// leave the engine holding `NULL` while SQL holds `t2` — trading #4204's
/// divergence for #4188's. Reading the committed SQL value per id is the only
/// form that answers both.
///
/// The resurrection this propagates to the DELETING peer is SETTLED, and this
/// docstring is the canonical record of that. The maintainer ruling of
/// 2026-08-26 adopts the
/// converged-tree rule —
/// <https://github.com/jfolcini/agaric/issues/4204#issuecomment-5420988056> —
/// "a block moved out of a deleted parent onto a live one stays live — a real
/// resurrection, accepted deliberately", on three grounds: it is the only rule
/// that converges BOTH #4188 (measured inseparable: "re-stamp, never
/// resurrect" still diverges on the order `D(P1), M, D(P2)`) and #4204; it
/// makes the op path AGREE with the import path, which already ships that
/// answer as R9's `(Some(sql), None)` cell, so it removes a disagreement
/// rather than adding a second rule; and cohort membership is positional, so
/// an explicit move out of a trashed subtree wins over an inherited stamp the
/// block never carried intrinsically.
///
/// The plumbing that was open when the ruling landed is #4390, and it is
/// written: the return value below is its first link.
///
/// ## The interpreter this does NOT reach
///
/// `db/recovery.rs`'s `move_block` arm hand-rolls the same un-sweep (the third
/// interpreter of the op, #2894) and #4390 deliberately does not extend the
/// mirror to it. That arm runs BEFORE `sqlx::migrate!`, at whatever era
/// `max_applied_migration` names, on a raw executor — there is no `LoroState`
/// and no per-space engine in scope at that point, so the mirror has no call
/// site to live at, and the statements there are era-agnostic by construction
/// precisely because they never move `deleted_at` through Rust. The residue is
/// recorded at that arm rather than left implicit.
///
/// Three other sites bear on the mechanism and CROSS-REFERENCE here rather
/// than restating it — keep the argument in one place:
/// [`crate::loro::projection::reproject_block_deleted_at_from_engine`] (the
/// branch that used to undo the clear), `apply_move_block_via_loro` (why the
/// mirror cannot be bolted on there), and
/// `unsweep_reaches_the_engine_register_4204_4390` (the measurement, flipped
/// from characterisation to convergence by #4390).
///
/// Returns the ids the clear touched — empty when the short-circuit fired, so
/// "nothing was cleared" and "nothing needs mirroring" are the same value.
pub(crate) async fn unsweep_inherited_cohort_after_move(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    inherited_ts: i64,
) -> Result<Vec<String>, AppError> {
    let new_ancestor =
        agaric_store::block_descendants::nearest_tombstoned_ancestor(&mut *conn, block_id).await?;
    if let Some((_, ancestor_ts)) = new_ancestor
        && ancestor_ts == inherited_ts
    {
        return Ok(Vec::new());
    }

    // Loud for the same reason the sweep is: a cross-device reconciliation, not
    // a user action.
    tracing::warn!(
        block_id = %block_id,
        inherited_cohort_ts = inherited_ts,
        new_ancestor_cohort_ts = new_ancestor.as_ref().map(|(_, ts)| *ts),
        "MoveBlock carried an INHERITED tombstone to a position that no longer \
         implies it (concurrent delete-vs-move-out merge, #4204/#4188); \
         clearing the inherited cohort so the sweep can re-derive it",
    );
    // DOWNWARD only. The block has already been reparented, so
    // `project_restore_block_to_sql`'s upward `restore_deleted_ancestor_chain`
    // half would climb the block's NEW ancestors and resurrect the target
    // subtree — a cohort nobody asked to restore.
    crate::loro::projection::clear_cohort_deleted_at_downward(&mut *conn, block_id, inherited_ts)
        .await
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
/// A move whose SUBJECT is already tombstoned is applied unchanged — and, once
/// #4204 landed the un-sweep above, its COHORT is kept unchanged too whenever
/// that tombstone is INTRINSIC (the subject is a cohort root: `Delete` was
/// aimed at the subject itself, so its parent is live or in a different
/// cohort). A tombstoned block under a live parent is the ordinary trash shape
/// (that is exactly what `delete_block` produces), it is what R9's
/// `(Some(_), Some(_))`
/// resurrection-guard arm preserves, and applying the move is what CONVERGES:
/// `Delete(B)` then `Move(B → Q)` and `Move(B → Q)` then `Delete(B)` both end
/// with `B` under `Q`, tombstoned. `validate_move_in_tx` rejects that case too,
/// but as a UI affordance (do not let a user drag a trashed block), not as a
/// state invariant — so it is the half of the local guard that must NOT be
/// mirrored here. Pinned by
/// `move_of_a_tombstoned_block_is_applied_not_dropped_4112`, which reddens
/// when the local path's subject probe IS mirrored onto this arm.
///
/// That choice left two residues, #4188 and #4204, both of them the case where
/// the subject arrives at the move ALREADY tombstoned by a cascade rather than
/// by a delete aimed at it. #4188: with BOTH endpoints deleted
/// (`{Delete(P1)@t1, Delete(P2)@t2, Move(B: P1 → P2)}`) whichever cascade
/// caught `B` first owned its cohort, so three of the six orders answered `t1`
/// and three `t2`. #4204: with only the OLD parent deleted and the target LIVE
/// (`{Delete(P1), Move(C1A: P1 → P2)}`) the delete-first order carried `C1A`
/// under `P2` still TRASHED while the move-first order — where
/// `collect_subtree_ids_unbounded(P1)` never reached it — left it LIVE, so the
/// two devices disagreed about whether the subtree was in the tree at all.
///
/// Both are now closed by the pre-move half of this tail
/// ([`inherited_cohort_before_move`] + [`unsweep_inherited_cohort_after_move`]),
/// which re-derives an INHERITED tombstone from the subject's new position and
/// leaves this sweep to supply the second clause. This sweep is unchanged: it
/// still only ever fires on a subject whose own row is live — which after an
/// un-sweep it is.
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
