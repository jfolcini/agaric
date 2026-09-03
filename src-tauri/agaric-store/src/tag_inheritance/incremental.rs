//! Per-op incremental updates to the `block_tag_inherited` cache table (P-4).
//!
//! These helpers are the building blocks dispatched by
//! [`super::apply_op_tag_inheritance`] and are also called directly from a
//! handful of command handlers (`commands/blocks/crud.rs`,
//! `commands/blocks/move_ops.rs`, `commands/tags.rs`) and the materializer
//! (`materializer/handlers.rs`). They are `pub(crate)` because the documented
//! single entry point is [`super::apply_op_tag_inheritance`]; in-crate
//! call-sites that pre-date the consolidation continue to invoke specific
//! helpers directly.
//!
//! See [`crate::tag_inheritance`] for the recursive-CTE policy and macro
//! family.

use sqlx::SqliteConnection;

use agaric_core::error::AppError;

/// After adding a tag to a block, propagate it to all descendants.
///
/// Inserts `(descendant, tag_id, block_id)` for every non-deleted, non-conflict
/// descendant of `block_id`. Uses `INSERT OR IGNORE` to handle races and
/// re-application safely (a descendant might already inherit the same tag from
/// a closer ancestor — the PK constraint keeps the existing row).
///
/// #4121 — a soft-deleted `block_id` propagates NOTHING. This is #3944's
/// deleted-SUBJECT direction on the AddTag side: for `R(soft-deleted, #T) >
/// D(live)` this helper used to write `(D, T, R)`, attributing the tag to a
/// tombstoned tagger, while [`crate::tag_inheritance::rebuild_all`]'s
/// `tag_inh_descendant_tags_full!` seed carries `tagged.deleted_at IS NULL`
/// and emits nothing. The subject filter now lives in
/// [`crate::tag_inh_descendants_active`]'s seed — sound there because that
/// CTE feeds INSERTs only at both of its call-sites (here, and
/// [`remove_inherited_tag`] step 3), which is exactly the property
/// `tag_inh_subtree_active!` lacks.
///
/// Reached from `apply_add_tag_via_loro` / `apply_add_tag_sql_only`, the
/// remote/replay shape where the local command path's own liveness guard does
/// not apply. Materially less severe than #3944 because AddTag keeps its
/// whole-vault `RebuildTagInheritanceCache` fan-out, so the bad row self-heals
/// rather than persisting the way a `RemoveTag`-written one does (#2669) —
/// but a window in which the incremental path disagrees with the arbiter is a
/// window in which the oracle cannot be trusted as a gate, which is the reason
/// the whole family gets closed. Pinned by
/// `propagate_tag_rooted_at_soft_deleted_block_matches_rebuild_4121`.
pub async fn propagate_tag_to_descendants(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendants_active!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT id, ?2, ?1 FROM descendants",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// After removing a tag from a block, clean up inherited entries.
///
/// 1. Delete all rows where `inherited_from = block_id AND tag_id = tag_id`.
/// 2. Re-attribute descendants from a direct tagger that sits **inside** the
///    deleted subtree. A child `C` of `block_id` that holds `tag_id` directly
///    in `block_tags` must keep propagating the tag to its own descendants —
///    those rows were wiped in step 1 (they carried `inherited_from = block_id`
///    because of the `(block_id, tag_id)` PK / `INSERT OR IGNORE` ordering) and
///    must be re-seeded with `inherited_from = C`. The nearest such tagger wins.
/// 3. For each remaining affected descendant, walk up ancestors ABOVE
///    `block_id` to find the next block that directly has this tag. If found,
///    re-insert with that ancestor as the new `inherited_from`.
///
/// Step 3 handles the case where grandparent and parent both have the same tag:
/// removing it from the parent re-attributes inheritance to the grandparent.
/// Step 2 handles the symmetric case where a tagger lives strictly INSIDE the
/// removed subtree (#675): without it, that tagger's descendants would silently
/// lose the tag.
///
/// #3923 — like [`recompute_subtree_inheritance`] (#3876), none of the three
/// inserts excludes a block that holds the tag DIRECTLY. The inheritance
/// relation is independent of `block_tags`, which is
/// [`crate::tag_inheritance::rebuild_all`]'s definition and therefore the one
/// every incremental maintainer must converge on. This path matters more than
/// the #3876 one: the RemoveTag materializer fan-out carries NO
/// `RebuildTagInheritanceCache` (#2669 dropped it), so a row missed here is
/// never healed. `remove_tag_incremental_matches_full_rebuild_2669` and
/// `remove_tag_keeps_direct_holder_descendant_inheriting_3923` pin the
/// convergence.
///
/// #3944 — a soft-deleted `block_id`. Step 1's `DELETE … WHERE
/// inherited_from = ?1` is unconditional and stays so (dropping rows
/// attributed to a tombstoned tagger is what the arbiter wants). Steps 2
/// and 3 must NOT re-attribute anything, though: for
/// `A[#T] > R(deleted, #T) > D(live)`, `rebuild_all` yields nothing, while
/// this helper used to reach `D` via `descendants_active` and `A` via
/// `tag_inh_ancestors_walk!`'s then-unchecked seed, writing `(D, T, A)` at
/// site 2 and `(R, T, A)` at site 3. The seed now requires `?1` to be live,
/// so `nearest_ancestor` is empty for a tombstoned subject and both inserts
/// are no-ops; site 3 additionally joins `blocks` on `?1` so its own
/// projection states the rule. Step 2's in-subtree re-attribution is
/// unaffected and stays correct under a tombstoned `?1`: it only ever
/// attributes a live descendant to a live tagger STRICTLY below `?1`, which
/// is a chain the arbiter propagates through. Pinned by
/// `remove_tag_rooted_at_soft_deleted_block_matches_rebuild_3944`.
///
/// #4121 — step 3's `descendants` CTE gained the same subject filter, and
/// that is a NON-change here by construction: step 3 CROSS JOINs
/// `descendants` with `nearest_ancestor`, which comes from
/// `tag_inh_ancestors_walk!(1)` and has been empty for a tombstoned `?1`
/// since #3944, so the step already inserted nothing in that case. The
/// filter removes the second, redundant reason rather than an outcome.
/// Step 1's `DELETE` is keyed on `inherited_from = ?1` and never touched the
/// CTE, so no repair scope narrows — the #3944 trap (filtering a seed that
/// also scopes a `DELETE`) does not apply to `descendants_active` at either
/// call-site. Step 2 hand-rolls its own copy of the descendants walk and is
/// untouched.
///
/// ## No backfill for pre-#3923 vaults — and why none is needed
///
/// This PR does not migrate existing rows. A vault that hit the bug before
/// upgrading is still missing whatever `(descendant, tag, ancestor)` rows the
/// old exclusions refused to (re-)insert, and nothing here retroactively
/// scans `block_tag_inherited` for that shape.
///
/// It doesn't need to: every row this bug could drop belongs to a
/// descendant that ALSO holds the tag DIRECTLY (all three removed
/// exclusions were `NOT IN block_tags`-shaped — a descendant with no direct
/// row of its own was never excluded). For such a descendant the missing
/// row is provably silent: every "does this block have tag T, including
/// inherited" read (`resolve_tag_leaves` & friends) is a `UNION` of
/// `block_tags` with `block_tag_inherited`, and the inherited-chip UI
/// (`useBlockTags.ts`) subtracts direct tags before rendering the
/// "inherited" badge — so the missing row changes no query result and no
/// pixel for as long as the descendant keeps the tag directly.
///
/// The state stops being latent only when that direct hold ends — and the
/// two ways it can end both recompute the row instead of trusting the
/// table: (a) `remove_tag(descendant, tag)` runs this very function with
/// `block_id = descendant`, and the trailing `#3923 site 3 of 3` INSERT
/// below re-derives the descendant's row from the LIVE ancestor chain,
/// independent of whatever was (or wasn't) there before; (b) the descendant
/// or its tag is deleted/purged/restored, which goes through the subtree
/// maintenance or a full rebuild rather than reading the stale row. So the
/// same event that would ever make a dropped row observable is also the
/// event that fixes it — there is no window in which a user can see wrong
/// data from this class of row.
///
/// Independently of that, a whole-vault `RebuildTagInheritanceCache` (fired
/// by any `add_tag`, any `restore_block`, or a `delete_block` /
/// `purge_block` of a non-`"content"`-hinted block — see
/// `materializer::dispatch::lifecycle_rebuild_tasks`) heals every dropped
/// row vault-wide as a side effect, and is common enough in an actively
/// used vault (tagging anything, trashing/restoring anything, deleting a
/// page) that convergence is typically incidental long before a
/// descendant's own tag is ever re-touched. There is no bounded SLA on
/// this — a vault that only ever removes tags, on a single device, with no
/// restores and no non-content deletes, could carry a dropped row
/// indefinitely — but per the above that row is inert, not a migration
/// candidate.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub async fn remove_inherited_tag(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    // Step 1: Delete all entries inherited from this block for this tag
    sqlx::query("DELETE FROM block_tag_inherited WHERE inherited_from = ?1 AND tag_id = ?2")
        .bind(block_id)
        .bind(tag_id)
        .execute(&mut *conn)
        .await?;

    // Step 2 (#675): Re-seed inheritance from direct taggers INSIDE the subtree.
    //
    // For every active descendant D of block_id that no longer has an inherited
    // row and is not itself a direct tagger, find the NEAREST ancestor C that
    // (a) sits at or below the level of block_id's children (i.e. C is in the
    // descendants set), and (b) holds the tag directly in block_tags. Re-insert
    // (D, tag, C). The ancestor walk is seeded from D and ranked by depth so the
    // closest in-subtree tagger wins; ancestors at or above block_id are
    // excluded here (those are handled by step 3).
    //
    // `subtree_descendants` reuses the same children-and-below walk as the
    // descendants set; `taggers` are the descendants that hold the tag directly.
    // For each descendant we re-walk its own ancestor chain, intersect with the
    // in-subtree taggers, and take the closest.
    // depth<100: DESCENDANT_DEPTH_CAP, see block_descendants (both the
    // descendants and anc recursive arms below carry the cap)
    // dynamic-sql: #675 — static concat! CTE, all values bound (?1/?2), no interpolation.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        // descendants(id, depth): children-and-below of block_id (?1).
        "descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ), ",
        // taggers: descendants that hold the tag directly (active rows only).
        "taggers AS ( \
             SELECT d.id FROM descendants d \
             JOIN block_tags bt ON bt.block_id = d.id AND bt.tag_id = ?2 \
         ), ",
        // For each descendant, walk up its parent chain (bounded) collecting
        // (descendant, ancestor, depth) so we can find the nearest in-subtree
        // tagger ancestor. The walk stops climbing once it reaches block_id
        // (block_id's own ancestors are step 3's responsibility) — but we keep
        // walking the id up to and including the chain inside the subtree.
        //
        // invariant #9 exception (2 of 2 — see tag_inheritance/mod.rs module
        // doc): unlike every other walk in this module, `anc` climbs
        // parent_id with NO `deleted_at` filter of its own. It is still
        // safe: `d` ranges over `descendants` (the CTE above), which admits
        // a block only via an all-live parent_id chain down from block_id
        // (?1) — every block on that chain already satisfied
        // `b.deleted_at IS NULL` when `descendants` emitted it. `anc`
        // starts at such a `d` and climbs the SAME chain back up towards a
        // `taggers` row, so any segment it walks between a descendant and
        // an in-subtree tagger is a suffix of that already-proven-live
        // chain — it does not need to re-check what `descendants` already
        // guaranteed. (`a.id <> ?1` only stops the climb AT block_id;
        // anything above block_id is step 3's responsibility, not this
        // CTE's.)
        "anc(start_id, id, depth) AS ( \
             SELECT d.id, b.parent_id, 1 FROM descendants d \
             JOIN blocks b ON b.id = d.id \
             WHERE b.parent_id IS NOT NULL \
             UNION ALL \
             SELECT a.start_id, b.parent_id, a.depth + 1 FROM anc a \
             JOIN blocks b ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND a.id <> ?1 AND a.depth < 100 \
         ), ",
        // nearest in-subtree tagger ancestor per descendant.
        "reseed AS ( \
             SELECT a.start_id AS block_id, t.id AS inherited_from \
             FROM anc a \
             JOIN taggers t ON t.id = a.id \
             WHERE a.depth = ( \
                 SELECT MIN(a2.depth) FROM anc a2 \
                 JOIN taggers t2 ON t2.id = a2.id \
                 WHERE a2.start_id = a.start_id \
             ) \
         ) ",
        // #3923 site 1 of 3: no `NOT IN block_tags` exclusion. A descendant
        // that holds the tag DIRECTLY still gets its inherited row — `reseed`
        // only ever names a tagger STRICTLY above it (the `anc` walk starts at
        // the parent), so the provenance is the same one `rebuild_all` picks.
        // The surviving `NOT IN block_tag_inherited` guard doesn't change the
        // result: the `(block_id, tag_id)` PK already makes `INSERT OR IGNORE`
        // skip any row step 1 didn't delete (a nearer tagger's), so this WHERE
        // is redundant with that PK. Kept anyway so the "only rows missing an
        // inherited entry get reseeded" intent is legible at the call site
        // instead of relying on silently-ignored PK conflicts.
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT r.block_id, ?2, r.inherited_from \
         FROM reseed r \
         WHERE r.block_id NOT IN ( \
             SELECT block_id FROM block_tag_inherited WHERE tag_id = ?2 \
         )",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    // Step 3: For descendants of block_id, check if any OTHER ancestor still
    // has this tag. If so, re-insert with the closest such ancestor.
    // We find all descendants of block_id, then for each, walk UP ancestors
    // (starting from block_id's parent) to find the nearest ancestor with the tag.
    //
    // Use a single SQL statement: for each descendant of block_id that doesn't
    // already have an entry in block_tag_inherited for this tag, find the
    // nearest ancestor with the tag via a lateral ancestor walk.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_descendants_active!(),
        ", ",
        crate::tag_inh_ancestors_walk!(1),
        ", ",
        "nearest_ancestor AS ( \
             SELECT a.id FROM ancestors a \
             JOIN block_tags bt ON bt.block_id = a.id AND bt.tag_id = ?2 \
             JOIN blocks b ON b.id = a.id \
             WHERE b.deleted_at IS NULL \
             ORDER BY a.depth ASC \
             LIMIT 1 \
         ) ",
        // #3923 site 2 of 3 — the REACHABLE one. This exclusion is what
        // dropped `(C, T, A)` for the issue's `A[#T] > B[#T] > C[#T]` fixture:
        // C's row was attributed to B, step 1 deleted it, and C was then
        // refused a replacement purely because it holds T directly. RemoveTag
        // carries no `RebuildTagInheritanceCache` (#2669), so that missing row
        // was durable. Pinned by
        // `remove_tag_keeps_direct_holder_descendant_inheriting_3923`.
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT d.id, ?2, na.id \
         FROM descendants d, nearest_ancestor na \
         WHERE d.id NOT IN ( \
             SELECT block_id FROM block_tag_inherited WHERE tag_id = ?2 \
         )",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    // Also re-insert for block_id itself if it's a descendant of the ancestor
    // (block_id no longer has the tag directly, but might inherit from above)
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_ancestors_walk!(1),
        ", ",
        "nearest_ancestor AS ( \
             SELECT a.id FROM ancestors a \
             JOIN block_tags bt ON bt.block_id = a.id AND bt.tag_id = ?2 \
             JOIN blocks b ON b.id = a.id \
             WHERE b.deleted_at IS NULL \
             ORDER BY a.depth ASC \
             LIMIT 1 \
         ) ",
        // #3923 site 3 of 3. Vacuous in the production flow — every caller
        // projects the `block_tags` DELETE before calling this helper, so ?1
        // never holds the tag directly here — but it encoded the same wrong
        // rule, so it goes with the other two rather than being left as a trap
        // for whoever next reads this function.
        //
        // #3944: this insert names ?1 as a literal rather than selecting it
        // from `blocks`, so it used to write a row on a soft-deleted subject —
        // `rebuild_all` never emits a row whose `block_id` is a tombstone. The
        // `blocks` join makes the projection state that rule locally. It is
        // now redundant with `tag_inh_ancestors_walk!`'s own #3944 seed filter
        // (a deleted ?1 makes `ancestors`, and hence `nearest_ancestor`,
        // empty), and is kept for the same reason the sibling `NOT IN
        // block_tag_inherited` guards are: the rule is legible at the call
        // site instead of resting on a property of a CTE declared above it.
        // Being redundant, it is also UNFALSIFIABLE — no test reddens if it is
        // deleted, and none can while the seed filter above it stands. Treat
        // it as documentation with a `WHERE` clause, not as a covered guard.
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, ?2, na.id \
         FROM nearest_ancestor na \
         JOIN blocks b ON b.id = ?1 \
         WHERE b.deleted_at IS NULL",
    ))
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Recompute all inherited tags for a block and its entire subtree.
///
/// Used after `move_block` (ancestry changed), `delete_block` (subtree
/// soft-deleted), and `restore_block` (subtree un-deleted). This is the
/// "nuclear option" — deletes all inherited entries for the subtree, then
/// recomputes from scratch by walking up ancestors for each block.
///
/// #3876 — the result must equal what [`crate::tag_inheritance::rebuild_all`]
/// would produce for the same tree: in particular a block that holds a tag
/// BOTH directly and by inheritance keeps its inherited row. The
/// `*_converges_with_rebuild_3876` tests pin that both paths agree.
///
/// Two further ways that equality used to fail, both fixed here:
///
/// * **#3925 — provenance.** Steps 2 and 3 each `INSERT OR IGNORE` from a
///   walk that emits one row per tagging ancestor, and let the
///   `(block_id, tag_id)` PK pick the survivor. That made `inherited_from`
///   a function of the order SQLite happened to emit rows in. Step 3 did
///   not merely rely on it, it got the answer WRONG: with two taggers above
///   the subtree it attributed to the FURTHEST. Both steps now collapse to
///   the nearest tagger explicitly, the same way `rebuild_all` does.
/// * **#3926 — reachability.** `tag_inh_ancestors_walk!` climbed through
///   soft-deleted ancestors, so step 3 could pull a tag across a tombstone
///   that `rebuild_all`'s descendant walk refuses to cross. The macro now
///   stops at the first deleted ancestor, which also makes step 3 agree
///   with step 2's own descendant walk — `recompute_subtree_skips_deleted`
///   has always asserted that a deleted intermediate breaks inheritance
///   when recomputing from ABOVE it, and the same fixture recomputed from
///   BELOW used to give the opposite answer.
/// * **#3944 — the SUBJECT.** Rooted at a TOMBSTONE, this helper used to
///   write inherited rows FOR the tombstone and re-derive its live
///   descendants' rows from an ancestor chain that is broken at the
///   tombstone. The remote path reaches this — `move_block_inner` guards
///   its root, but `apply_move_block_via_loro` /
///   `apply_move_block_sql_only` call this helper unconditionally and
///   `project_move_block_to_sql` has no `deleted_at` filter.
///
///   Both wrong writes came from step 3's ancestor walk, and both are
///   closed by [`crate::tag_inh_ancestors_walk`]'s #3944 seed filter: with
///   `root_id` deleted the walk is empty, so `ancestor_tags_nearest` is
///   empty and step 3's CROSS JOIN inserts nothing — neither for the
///   tombstone nor for anything under it. Step 2 was never a source: its
///   `tagged_descendants` seed rejects a soft-deleted tagger and only ever
///   emits LIVE children, so it re-derives exactly the in-subtree
///   inheritance the arbiter computes. Pinned by
///   `recompute_rooted_at_soft_deleted_block_matches_rebuild_3944` and
///   `recompute_at_tombstone_keeps_live_descendant_inheritance_3944`.
///
///   **Step 1's DELETE scope is deliberately UNCHANGED**, and
///   `tag_inh_subtree_active!`'s seed is deliberately left admitting a
///   tombstoned `root_id` so that it stays that way. All four
///   `tag_inh_subtree_active!` call-sites below share that CTE, so
///   filtering its seed would empty `subtree` for a tombstoned root and
///   turn this whole helper into a no-op. That is not equivalent to "the
///   arbiter has nothing to say about a tombstone": the helper is a
///   from-scratch repair pass over `root_id`'s subtree, and a tombstoned
///   root can have a LIVE descendant subtree (exactly what the remote path
///   produces) whose rows a structural change strictly BELOW `root_id` has
///   invalidated. `loro_sync.rs`'s `TagScope::Subtrees(roots)` dedupes a
///   batch's structural roots to the TOP-MOST one, so such a change is
///   covered by — and only by — the recompute rooted at that possibly
///   tombstoned ancestor. Skipping the sweep leaves the stale row and makes
///   the incremental path yield MORE than the arbiter. Pinned by
///   `recompute_at_tombstone_after_structural_change_below_matches_rebuild_3944`;
///   `recompute_delete_scope_sweeps_the_whole_subtree_3944` keeps both
///   DELETEs load-bearing for a live root.
pub async fn recompute_subtree_inheritance(
    conn: &mut SqliteConnection,
    root_id: &str,
) -> Result<(), AppError> {
    // Step 1: Delete all inherited entries where block_id is in the subtree
    //
    // #3944: this scope is UNCHANGED, and `tag_inh_subtree_active!`'s seed is
    // left admitting a soft-deleted `?1` precisely so that it can stay that
    // way — `subtree` must still contain the root and its LIVE descendants
    // when the root is a tombstone, or this sweep silently stops running for
    // the one state the remote path actually produces. See the fn docstring.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_active!(),
        " DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Also delete entries where inherited_from is in the subtree
    // (other blocks outside the subtree shouldn't be affected, but entries
    // inherited FROM a subtree block that has been moved need cleanup)
    //
    // #3944: unchanged for the same reason as the sweep above — a row
    // attributed to a block inside the subtree is stale whether or not the
    // subtree's ROOT is a tombstone, and `rebuild_all` never attributes a row
    // to a soft-deleted tagger at all.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_active!(),
        " DELETE FROM block_tag_inherited \
         WHERE inherited_from IN (SELECT id FROM subtree) \
           AND block_id NOT IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Step 2: Recompute for the subtree. For each (block, tag) pair where
    // a block in the subtree has a direct tag, propagate to all its descendants
    // within the subtree.
    //
    // #3925: `tagged_descendants` emits one row per tagging ancestor, so a
    // block under TWO in-subtree taggers appears twice with different
    // `inherited_from`. Collapsing to the MIN-depth row makes the nearest
    // tagger win by construction; inserting straight from the walk let the
    // recursive-CTE emission order pick, which is a planner property rather
    // than something the SQL states. `tag_inh_subtree_nearest!` is the same
    // collapse `rebuild_all` applies (`tag_inh_rebuild_nearest!`), so the two
    // paths agree because they compute the same thing, not because the queue
    // happened to run nearest-first.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_active!(),
        ", ",
        crate::tag_inh_tagged_descendants_in_subtree!(),
        ", ",
        crate::tag_inh_subtree_nearest!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT block_id, tag_id, inherited_from FROM tagged_descendants_nearest",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Step 3: Handle tags inherited FROM OUTSIDE the subtree.
    // Walk up ancestors of root_id to find all tags that root_id and its
    // descendants should inherit from above.
    //
    // #3876: a block that ALSO holds the tag directly still gets its
    // inherited row. The inheritance relation is true independently of
    // whether a direct `block_tags` row exists, this is what `rebuild_all`
    // has always produced (as did migration 0021's backfill), and it is
    // what the two paths must agree on. Consumers that want "inherited but
    // not direct" subtract `block_tags` themselves — `useBlockTags` does,
    // and `list_inherited_tags_for_block` documents the overlap. No
    // consumer counts the two tables additively (every read is a `UNION`
    // or an `EXISTS`), so keeping the row cannot double-count.
    //
    // I-Search-4: same ancestor-walk invariant as in `remove_inherited_tag`
    // above — `tag_inh_ancestors_walk!(0)` climbs the parent chain and (since
    // #3926) stops at the first soft-deleted ancestor, so a tag cannot reach
    // the subtree through a tombstone; the projection below still joins
    // `blocks` to reject the deleted ancestor the walk stopped ON as a tag
    // source.
    //
    // #3925: `ancestor_tags` carries `depth` and is collapsed to the NEAREST
    // tagging ancestor per tag before the CROSS JOIN. Cross-joining the whole
    // set and letting `INSERT OR IGNORE` + the `(block_id, tag_id)` PK pick a
    // winner made the attribution depend on the order the planner happened to
    // emit rows in — and it picked WRONG: for `TOP[#T] > MID[#T] > root`, the
    // subtree was attributed to TOP where `rebuild_all` (the arbiter,
    // `tag_inh_rebuild_nearest!`) says MID. The collapse below is the same
    // MIN-depth + `MIN(inherited_from)` rule the arbiter uses.
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_ancestors_walk!(0),
        ", ",
        "ancestor_tags AS ( \
             SELECT bt.block_id AS inherited_from, bt.tag_id, anc.depth AS depth \
             FROM ancestors anc \
             JOIN block_tags bt ON bt.block_id = anc.id \
             JOIN blocks b ON b.id = anc.id \
             WHERE b.deleted_at IS NULL \
         ), ",
        "ancestor_tags_nearest AS ( \
             SELECT at1.tag_id, MIN(at1.inherited_from) AS inherited_from \
             FROM ancestor_tags at1 \
             WHERE at1.depth = ( \
                 SELECT MIN(at3.depth) FROM ancestor_tags at3 \
                 WHERE at3.tag_id = at1.tag_id \
             ) \
             GROUP BY at1.tag_id \
         ), ",
        crate::tag_inh_subtree_active!(),
        " INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT st.id, at2.tag_id, at2.inherited_from \
         FROM subtree st \
         CROSS JOIN ancestor_tags_nearest at2",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// After creating a new block, inherit all tags from its parent.
///
/// The new block has no children yet, so we only need to copy the parent's
/// effective tags (direct from `block_tags` + inherited from `block_tag_inherited`).
pub async fn inherit_parent_tags(
    conn: &mut SqliteConnection,
    block_id: &str,
    parent_id: Option<&str>,
) -> Result<(), AppError> {
    let Some(parent_id) = parent_id else {
        return Ok(()); // Top-level block, no parent to inherit from
    };

    // Insert all of parent's direct tags as inherited
    sqlx::query(
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, bt.tag_id, bt.block_id \
         FROM block_tags bt \
         JOIN blocks b ON b.id = bt.block_id \
         WHERE bt.block_id = ?2 AND b.deleted_at IS NULL",
    )
    .bind(block_id)
    .bind(parent_id)
    .execute(&mut *conn)
    .await?;

    // Insert all of parent's inherited tags (pass through inherited_from)
    sqlx::query(
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, bti.tag_id, bti.inherited_from \
         FROM block_tag_inherited bti \
         WHERE bti.block_id = ?2",
    )
    .bind(block_id)
    .bind(parent_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Remove all inherited tag entries for a subtree being soft-deleted.
///
/// Also removes entries where other blocks inherited tags FROM blocks in this
/// subtree (since those blocks are now deleted, their tags shouldn't propagate).
///
/// **CTE policy exception:** the two CTEs below deliberately do NOT
/// filter `deleted_at IS NULL` — this helper is called AFTER the
/// subtree has been soft-deleted (`remove_subtree_inherited` runs in the
/// same transaction as the cascade UPDATE). Filtering `deleted_at IS NULL`
/// here would miss every descendant we just marked deleted, leaving
/// orphaned inheritance rows.
///
/// The depth bound (`MAX_TAG_INHERITANCE_DEPTH`) still guards against
/// runaway recursion on corrupted parent_id chains.
pub async fn remove_subtree_inherited(
    conn: &mut SqliteConnection,
    root_id: &str,
) -> Result<(), AppError> {
    // Remove entries where block_id is in subtree
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_unfiltered!(),
        " DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Remove entries where inherited_from is in subtree (tags from deleted blocks)
    sqlx::query(concat!(
        "WITH RECURSIVE ",
        crate::tag_inh_subtree_unfiltered!(),
        " DELETE FROM block_tag_inherited \
         WHERE inherited_from IN (SELECT id FROM subtree)",
    ))
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}
