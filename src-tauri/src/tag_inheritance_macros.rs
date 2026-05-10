//! Recursive-CTE macros for `tag_inheritance`.
//!
//! `tag_inheritance` walks the block tree to maintain the
//! `block_tag_inherited` cache (P-4). It needs four flavours of recursive
//! walk that are similar enough to share macros, but different enough that
//! `block_descendants.rs` (which only knows about descendant walks of
//! `blocks`) cannot host them:
//!
//! * `tag_inh_descendants_active!()` — walks the **children** of `?1` and
//!   their descendants, skipping deleted rows. Used by
//!   propagation queries (`propagate_tag_to_descendants`,
//!   `remove_inherited_tag`).
//! * `tag_inh_subtree_active!()` — walks `?1` itself and its descendants,
//!   skipping deleted rows. Used by `recompute_subtree_inheritance`.
//! * `tag_inh_subtree_unfiltered!()` — same shape as `subtree_active` but
//!   does **not** filter `deleted_at`. Used exclusively by
//!   `remove_subtree_inherited`, which runs AFTER the subtree has been
//!   soft-deleted (filtering would miss the very rows we need to clean
//!   up). The depth bound is kept.
//! * `tag_inh_ancestors_walk!(seed_depth)` — walks the parent chain
//!   starting from `?1`'s `parent_id`. The seed depth is parameterised
//!   because two call-sites use depth=1 (so `nearest_ancestor` can rank by
//!   distance) and one uses depth=0.
//! * `tag_inh_descendant_tags_full!()` — full-database descendant-tags
//!   walk used by `rebuild_all` / `rebuild_all_split`. Carries
//!   `(block_id, tag_id, inherited_from, depth)` along the recursion.
//!
//! Every macro expands to a **CTE body only** (no `WITH RECURSIVE` keyword,
//! no trailing comma) so call-sites can compose multiple CTEs in one
//! query, e.g.
//!
//! ```ignore
//! sqlx::query(concat!(
//!     "WITH RECURSIVE ",
//!     tag_inh_subtree_active!(), ", ",
//!     "tagged_descendants(...) AS ( ... ) ",
//!     "INSERT OR IGNORE INTO block_tag_inherited (...) ",
//!     "SELECT ... FROM ...",
//! ))
//! ```
//!
//! `sqlx::query!()` cannot accept anything but a string literal so the
//! macros return literals and the call-site composes via `concat!()`.
//!
//! # Invariants baked in
//!
//! * Every active descendant walk filters `b.deleted_at IS NULL` in the
//!   recursive member. The unfiltered subtree variant is the documented
//!   purge-style exception.
//! * Every walk bounds depth at `MAX_TAG_INHERITANCE_DEPTH` (= 100). The
//!   bound is inlined into the SQL string at macro expansion; see
//!   `MAX_TAG_INHERITANCE_DEPTH` for the canonical Rust value. The
//!   `macro_depth_literal_matches_constant` test asserts the two stay in
//!   sync.

/// Maximum recursion depth for tag-inheritance walks.
///
/// Defends against pathologically deep / cyclic block trees in the
/// presence of materializer races; identical to the bound used by
/// `block_descendants.rs` macros.
///
/// The integer value is mirrored as the literal `100` inside the SQL
/// strings emitted by the macros below. If you change this constant, you
/// must update the literal in every macro body in lockstep — the test
/// `macro_depth_literal_matches_constant` enforces the invariant at
/// compile-and-test time.
///
/// Marked `#[allow(dead_code)]` because every production caller embeds
/// the bound through one of the macros below (sqlx's compile-time
/// machinery requires a string literal, not a `const`). The constant is
/// the canonical Rust value that the test harness asserts against.
#[allow(dead_code)]
pub(crate) const MAX_TAG_INHERITANCE_DEPTH: i32 = 100;

/// Recursive CTE body: walk the descendants of `?1` (children-and-below).
///
/// Filters `deleted_at IS NULL` in both the seed and the recursive
/// member, and bounds recursion at [`MAX_TAG_INHERITANCE_DEPTH`].
///
/// CTE name `descendants(id, depth)`, recursive alias `d`. Caller must bind
/// the seed block-id to position `?1`.
#[macro_export]
macro_rules! tag_inh_descendants_active {
    () => {
        "descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         )"
    };
}

/// Recursive CTE body: walk `?1` itself and all of its descendants
/// (subtree including the seed).
///
/// Filters `deleted_at IS NULL` in the recursive member, and bounds
/// recursion at [`MAX_TAG_INHERITANCE_DEPTH`].
///
/// CTE name `subtree(id, depth)`, recursive alias `s`. Caller must bind
/// the seed block-id to position `?1`.
#[macro_export]
macro_rules! tag_inh_subtree_active {
    () => {
        "subtree(id, depth) AS ( \
             SELECT ?1 AS id, 0 AS depth \
             UNION ALL \
             SELECT b.id, s.depth + 1 FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
             WHERE b.deleted_at IS NULL AND s.depth < 100 \
         )"
    };
}

/// Recursive CTE body: walk `?1` itself and all of its descendants
/// **without** filtering deleted rows.
///
/// `remove_subtree_inherited` runs AFTER the subtree has been
/// soft-deleted, so filtering `deleted_at IS NULL` here would miss the
/// very rows we need to clean up. The depth bound is kept — it is the
/// only defence against runaway recursion on corrupted `parent_id`
/// chains.
///
/// CTE name `subtree(id, depth)`, recursive alias `s`. Caller must bind
/// the seed block-id to position `?1`.
#[macro_export]
macro_rules! tag_inh_subtree_unfiltered {
    () => {
        "subtree(id, depth) AS ( \
             SELECT ?1 AS id, 0 AS depth \
             UNION ALL \
             SELECT b.id, s.depth + 1 FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
             WHERE s.depth < 100 \
         )"
    };
}

/// Recursive CTE body: walk the parent chain starting from `?1`'s
/// `parent_id`.
///
/// The seed depth is parameterised: pass `1` when the consumer needs to
/// rank ancestors by distance (so the closest ancestor has the smallest
/// depth, e.g. `nearest_ancestor`); pass `0` when only enumeration is
/// needed.
///
/// Bounds recursion at [`MAX_TAG_INHERITANCE_DEPTH`].
///
/// CTE name `ancestors(id, depth)`, recursive alias `a`. Caller must bind
/// the seed block-id to position `?1`.
#[macro_export]
macro_rules! tag_inh_ancestors_walk {
    (0) => {
        "ancestors(id, depth) AS ( \
             SELECT parent_id AS id, 0 AS depth FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.parent_id, a.depth + 1 FROM blocks b \
             JOIN ancestors a ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND a.depth < 100 \
         )"
    };
    (1) => {
        "ancestors(id, depth) AS ( \
             SELECT parent_id AS id, 1 AS depth FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.parent_id, a.depth + 1 FROM blocks b \
             JOIN ancestors a ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND a.depth < 100 \
         )"
    };
}

/// Recursive CTE body: descendant-tags walk **restricted to a `subtree`
/// CTE** declared earlier in the same `WITH RECURSIVE` block.
///
/// Carries `(block_id, tag_id, inherited_from, depth)` like
/// [`tag_inh_descendant_tags_full`], but the seed is filtered through
/// `JOIN subtree st ON bt.block_id = st.id` — so the walk only emits
/// rows for blocks whose tag-bearing ancestor sits inside the recompute
/// subtree. Used exclusively by `recompute_subtree_inheritance`.
///
/// Caller responsibility: emit a [`tag_inh_subtree_active`] CTE earlier
/// in the same `WITH RECURSIVE` block. Bound is
/// [`MAX_TAG_INHERITANCE_DEPTH`].
///
/// CTE name `tagged_descendants(block_id, tag_id, inherited_from, depth)`,
/// recursive alias `td`.
#[macro_export]
macro_rules! tag_inh_tagged_descendants_in_subtree {
    () => {
        "tagged_descendants(block_id, tag_id, inherited_from, depth) AS ( \
             SELECT b.id AS block_id, bt.tag_id, bt.block_id AS inherited_from, 0 AS depth \
             FROM subtree st \
             JOIN block_tags bt ON bt.block_id = st.id \
             JOIN blocks tagged ON tagged.id = bt.block_id \
             JOIN blocks b ON b.parent_id = bt.block_id \
             WHERE tagged.deleted_at IS NULL \
               AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, td.tag_id, td.inherited_from, td.depth + 1 \
             FROM tagged_descendants td \
             JOIN blocks b ON b.parent_id = td.block_id \
             WHERE b.deleted_at IS NULL AND td.depth < 100 \
         )"
    };
}

/// Recursive CTE body: full-database descendant-tags walk.
///
/// Carries `(block_id, tag_id, inherited_from, depth)` along the
/// recursion. The seed selects every block whose parent has a direct tag,
/// filtering deleted rows on both the tagged ancestor and the child. The
/// recursive member walks down via `parent_id`, propagating the
/// `(tag_id, inherited_from)` pair unchanged.
///
/// Used exclusively by `rebuild_all` / `rebuild_all_split` to recompute
/// the entire `block_tag_inherited` table from scratch. The bound is
/// [`MAX_TAG_INHERITANCE_DEPTH`].
///
/// CTE name `descendant_tags(block_id, tag_id, inherited_from, depth)`,
/// recursive alias `dt`.
#[macro_export]
macro_rules! tag_inh_descendant_tags_full {
    () => {
        "descendant_tags(block_id, tag_id, inherited_from, depth) AS ( \
             SELECT b.id AS block_id, bt.tag_id, bt.block_id AS inherited_from, 0 AS depth \
             FROM block_tags bt \
             JOIN blocks tagged ON tagged.id = bt.block_id \
             JOIN blocks b ON b.parent_id = bt.block_id \
             WHERE tagged.deleted_at IS NULL \
               AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id AS block_id, dt.tag_id, dt.inherited_from, dt.depth + 1 \
             FROM descendant_tags dt \
             JOIN blocks b ON b.parent_id = dt.block_id \
             WHERE b.deleted_at IS NULL AND dt.depth < 100 \
         )"
    };
}

#[cfg(test)]
mod tests {
    use super::MAX_TAG_INHERITANCE_DEPTH;

    /// The Rust constant and the SQL literal embedded in the macros must
    /// agree. If [`MAX_TAG_INHERITANCE_DEPTH`] is changed, every macro
    /// body in this file must be updated to match.
    #[test]
    fn macro_depth_literal_matches_constant() {
        let needle = format!("depth < {MAX_TAG_INHERITANCE_DEPTH}");
        for (name, body) in [
            ("descendants_active", tag_inh_descendants_active!()),
            ("subtree_active", tag_inh_subtree_active!()),
            ("subtree_unfiltered", tag_inh_subtree_unfiltered!()),
            ("ancestors_walk(0)", tag_inh_ancestors_walk!(0)),
            ("ancestors_walk(1)", tag_inh_ancestors_walk!(1)),
            ("descendant_tags_full", tag_inh_descendant_tags_full!()),
            (
                "tagged_descendants_in_subtree",
                tag_inh_tagged_descendants_in_subtree!(),
            ),
        ] {
            assert!(
                body.contains(&needle),
                "{name} must contain `{needle}` (current MAX_TAG_INHERITANCE_DEPTH = {MAX_TAG_INHERITANCE_DEPTH})",
            );
        }
    }

    /// `descendants_active`, `subtree_active`, and `descendant_tags_full`
    /// also filter soft-deleted descendants. `subtree_unfiltered` must
    /// not.
    #[test]
    fn active_walks_filter_deleted_at() {
        for (name, body) in [
            ("descendants_active", tag_inh_descendants_active!()),
            ("subtree_active", tag_inh_subtree_active!()),
            ("descendant_tags_full", tag_inh_descendant_tags_full!()),
            (
                "tagged_descendants_in_subtree",
                tag_inh_tagged_descendants_in_subtree!(),
            ),
        ] {
            assert!(
                body.contains("b.deleted_at IS NULL"),
                "{name} must skip soft-deleted descendants",
            );
        }
        assert!(
            !tag_inh_subtree_unfiltered!().contains("deleted_at"),
            "subtree_unfiltered runs after soft-delete and must not filter deleted_at",
        );
    }

    /// Sanity-check the structural shape of every macro: each must be a
    /// well-formed CTE body (a single closing paren at the end, no
    /// stray `WITH RECURSIVE` prefix that would corrupt composition).
    #[test]
    fn macros_are_cte_bodies_only() {
        for (name, body) in [
            ("descendants_active", tag_inh_descendants_active!()),
            ("subtree_active", tag_inh_subtree_active!()),
            ("subtree_unfiltered", tag_inh_subtree_unfiltered!()),
            ("ancestors_walk(0)", tag_inh_ancestors_walk!(0)),
            ("ancestors_walk(1)", tag_inh_ancestors_walk!(1)),
            ("descendant_tags_full", tag_inh_descendant_tags_full!()),
            (
                "tagged_descendants_in_subtree",
                tag_inh_tagged_descendants_in_subtree!(),
            ),
        ] {
            assert!(
                !body.contains("WITH RECURSIVE"),
                "{name} must NOT include the `WITH RECURSIVE` keyword — caller composes it",
            );
            assert!(
                body.trim_end().ends_with(')'),
                "{name} must end with the closing paren of the CTE body",
            );
            assert!(
                body.contains(" AS ("),
                "{name} must declare its CTE with `... AS ( ... )`",
            );
        }
    }

    /// Smoke check: `ancestors_walk(0)` and `ancestors_walk(1)` differ
    /// only in the seed depth. Catches accidental skew between the two
    /// match arms.
    #[test]
    fn ancestors_walk_arms_differ_only_in_seed_depth() {
        let zero = tag_inh_ancestors_walk!(0).replace("0 AS depth", "X AS depth");
        let one = tag_inh_ancestors_walk!(1).replace("1 AS depth", "X AS depth");
        assert_eq!(
            zero, one,
            "the two ancestors_walk arms must be identical apart from the seed depth literal",
        );
    }

    /// None of the macro bodies should contain a stray `is_conflict`
    /// reference after PEND-09 Phase 4 dropped the column.
    #[test]
    fn macros_do_not_reference_is_conflict() {
        for (name, body) in [
            ("descendants_active", tag_inh_descendants_active!()),
            ("subtree_active", tag_inh_subtree_active!()),
            ("subtree_unfiltered", tag_inh_subtree_unfiltered!()),
            ("ancestors_walk(0)", tag_inh_ancestors_walk!(0)),
            ("ancestors_walk(1)", tag_inh_ancestors_walk!(1)),
            ("descendant_tags_full", tag_inh_descendant_tags_full!()),
            (
                "tagged_descendants_in_subtree",
                tag_inh_tagged_descendants_in_subtree!(),
            ),
        ] {
            assert!(
                !body.contains("is_conflict"),
                "{name} must not reference the dropped is_conflict column",
            );
        }
    }
}
