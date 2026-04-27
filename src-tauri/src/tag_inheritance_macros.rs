//! Recursive-CTE macros for `tag_inheritance`.
//!
//! `tag_inheritance` walks the block tree to maintain the
//! `block_tag_inherited` cache (P-4). It needs four flavours of recursive
//! walk that are similar enough to share macros, but different enough that
//! `block_descendants.rs` (which only knows about descendant walks of
//! `blocks`) cannot host them:
//!
//! * `tag_inh_descendants_active!()` — walks the **children** of `?1` and
//!   their descendants, skipping deleted / conflict rows. Used by
//!   propagation queries (`propagate_tag_to_descendants`,
//!   `remove_inherited_tag`).
//! * `tag_inh_subtree_active!()` — walks `?1` itself and its descendants,
//!   skipping deleted / conflict rows. Used by `recompute_subtree_inheritance`.
//! * `tag_inh_subtree_unfiltered!()` — same shape as `subtree_active` but
//!   does **not** filter `deleted_at` / `is_conflict`. The documented
//!   invariant-#9 exception used exclusively by `remove_subtree_inherited`,
//!   which runs AFTER the subtree has been soft-deleted (filtering would
//!   miss the very rows we need to clean up). The depth bound is kept.
//! * `tag_inh_ancestors_walk!(seed_depth)` — walks the parent chain
//!   starting from `?1`'s `parent_id`. The seed depth is parameterised
//!   because two call-sites use depth=1 (so `nearest_ancestor` can rank by
//!   distance) and one uses depth=0. The walk does **not** filter
//!   `is_conflict` in the recursive member — by module convention,
//!   ancestor walks defer that filter to the consumer query (see the
//!   per-call-site doc comments in `tag_inheritance.rs`).
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
//! * Every descendant walk filters `b.is_conflict = 0` in BOTH the seed
//!   and the recursive member (invariant #9). The unfiltered subtree
//!   variant is the documented purge-style exception.
//! * Every walk bounds depth at `MAX_TAG_INHERITANCE_DEPTH` (= 100). The
//!   bound is inlined into the SQL string at macro expansion; see
//!   `MAX_TAG_INHERITANCE_DEPTH` for the canonical Rust value. The
//!   `macro_depth_literal_matches_constant` test asserts the two stay in
//!   sync.

/// Maximum recursion depth for tag-inheritance walks.
///
/// Defends against pathologically deep / cyclic block trees in the
/// presence of materializer races; identical to the bound used by
/// `block_descendants.rs` macros (see invariant #9 in AGENTS.md).
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
/// Filters `deleted_at IS NULL AND is_conflict = 0` in both the seed and
/// the recursive member, and bounds recursion at
/// [`MAX_TAG_INHERITANCE_DEPTH`].
///
/// CTE name `descendants(id, depth)`, recursive alias `d`. Caller must bind
/// the seed block-id to position `?1`.
#[macro_export]
macro_rules! tag_inh_descendants_active {
    () => {
        "descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
         )"
    };
}

/// Recursive CTE body: walk `?1` itself and all of its descendants
/// (subtree including the seed).
///
/// Filters `deleted_at IS NULL AND is_conflict = 0` in the recursive
/// member, and bounds recursion at [`MAX_TAG_INHERITANCE_DEPTH`].
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
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND s.depth < 100 \
         )"
    };
}

/// Recursive CTE body: walk `?1` itself and all of its descendants
/// **without** filtering deleted / conflict rows.
///
/// Documented invariant-#9 exception: `remove_subtree_inherited` runs
/// AFTER the subtree has been soft-deleted, so filtering `deleted_at IS
/// NULL` here would miss the very rows we need to clean up. Conflict
/// copies are likewise swept so their inherited rows do not dangle. The
/// depth bound is kept — it is the only defence against runaway recursion
/// on corrupted `parent_id` chains.
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
/// **Note:** unlike the descendant macros, this macro does NOT filter
/// `is_conflict = 0` in the recursive member. The two existing
/// `nearest_ancestor` consumers re-filter `b.is_conflict = 0` and
/// `b.deleted_at IS NULL` after joining `blocks` themselves; preserving
/// that pattern keeps the refactor byte-for-byte equivalent. Bounds
/// recursion at [`MAX_TAG_INHERITANCE_DEPTH`].
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
             WHERE tagged.deleted_at IS NULL AND tagged.is_conflict = 0 \
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id, td.tag_id, td.inherited_from, td.depth + 1 \
             FROM tagged_descendants td \
             JOIN blocks b ON b.parent_id = td.block_id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND td.depth < 100 \
         )"
    };
}

/// Recursive CTE body: full-database descendant-tags walk.
///
/// Carries `(block_id, tag_id, inherited_from, depth)` along the
/// recursion. The seed selects every block whose parent has a direct tag,
/// filtering deleted / conflict rows on both the tagged ancestor and the
/// child. The recursive member walks down via `parent_id`, propagating
/// the `(tag_id, inherited_from)` pair unchanged.
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
             WHERE tagged.deleted_at IS NULL AND tagged.is_conflict = 0 \
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id AS block_id, dt.tag_id, dt.inherited_from, dt.depth + 1 \
             FROM descendant_tags dt \
             JOIN blocks b ON b.parent_id = dt.block_id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND dt.depth < 100 \
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

    /// Invariant #9: every CTE that walks descendants via `parent_id`
    /// must filter `is_conflict = 0` in the recursive member. The
    /// `subtree_unfiltered` variant is the documented exception used by
    /// `remove_subtree_inherited`.
    #[test]
    fn descendant_walks_filter_is_conflict() {
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
                body.contains("b.is_conflict = 0"),
                "{name} must filter conflict copies (invariant #9)",
            );
        }
        assert!(
            !tag_inh_subtree_unfiltered!().contains("is_conflict"),
            "subtree_unfiltered is the documented invariant-#9 exception — it must NOT filter conflicts",
        );
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

    /// Byte-exact equivalence harness: for each macro, assert that the
    /// emitted SQL (after collapsing whitespace) matches the SQL that
    /// `tag_inheritance.rs` used to inline before MAINT-141. Catches
    /// accidental drift between this file and the call sites.
    ///
    /// Whitespace is normalised (any run of ASCII whitespace → single
    /// space, plus trim) because the original used Rust line-continuation
    /// (`\<newline>`) backslashes that strip leading whitespace at parse
    /// time, while the macros use the same continuation style — both
    /// produce equivalent SQL but the comparison should not depend on
    /// the exact byte alignment of the source.
    #[test]
    fn macros_match_pre_maint141_sql_byte_for_byte() {
        fn norm(s: &str) -> String {
            s.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
        }

        // shape A: descendants_active — propagate / remove_inherited_tag query 1
        let original_descendants = "descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
         )";
        assert_eq!(
            norm(tag_inh_descendants_active!()),
            norm(original_descendants),
            "descendants_active drifted from pre-MAINT-141 SQL",
        );

        // shape B: subtree_active — recompute_subtree_inheritance queries 1/2/3/4
        let original_subtree = "subtree(id, depth) AS ( \
             SELECT ?1 AS id, 0 AS depth \
             UNION ALL \
             SELECT b.id, s.depth + 1 FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND s.depth < 100 \
         )";
        assert_eq!(
            norm(tag_inh_subtree_active!()),
            norm(original_subtree),
            "subtree_active drifted from pre-MAINT-141 SQL",
        );

        // shape C: subtree_unfiltered — remove_subtree_inherited (the documented
        // invariant-#9 exception). Pre-MAINT-141 used `AND s.depth < 100` in the
        // JOIN clause; the macro normalises to `WHERE s.depth < 100`. Both
        // produce identical results for an INNER JOIN.
        let original_subtree_unfiltered_join_form = "subtree(id, depth) AS ( \
             SELECT ?1 AS id, 0 AS depth \
             UNION ALL \
             SELECT b.id, s.depth + 1 FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
             AND s.depth < 100 \
         )";
        let original_subtree_unfiltered_where_form = "subtree(id, depth) AS ( \
             SELECT ?1 AS id, 0 AS depth \
             UNION ALL \
             SELECT b.id, s.depth + 1 FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
             WHERE s.depth < 100 \
         )";
        let macro_norm = norm(tag_inh_subtree_unfiltered!());
        assert!(
            macro_norm == norm(original_subtree_unfiltered_join_form)
                || macro_norm == norm(original_subtree_unfiltered_where_form),
            "subtree_unfiltered drifted from pre-MAINT-141 SQL (allowing JOIN-AND vs WHERE form): got {macro_norm}",
        );

        // shape D: ancestors_walk — two seed depths
        let original_ancestors_1 = "ancestors(id, depth) AS ( \
             SELECT parent_id AS id, 1 AS depth FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.parent_id, a.depth + 1 FROM blocks b \
             JOIN ancestors a ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND a.depth < 100 \
         )";
        assert_eq!(
            norm(tag_inh_ancestors_walk!(1)),
            norm(original_ancestors_1),
            "ancestors_walk(1) drifted from pre-MAINT-141 SQL",
        );
        let original_ancestors_0 = "ancestors(id, depth) AS ( \
             SELECT parent_id AS id, 0 AS depth FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.parent_id, a.depth + 1 FROM blocks b \
             JOIN ancestors a ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND a.depth < 100 \
         )";
        assert_eq!(
            norm(tag_inh_ancestors_walk!(0)),
            norm(original_ancestors_0),
            "ancestors_walk(0) drifted from pre-MAINT-141 SQL",
        );

        // shape E: descendant_tags_full — rebuild_all / rebuild_all_split
        let original_descendant_tags =
            "descendant_tags(block_id, tag_id, inherited_from, depth) AS ( \
             SELECT b.id AS block_id, bt.tag_id, bt.block_id AS inherited_from, 0 AS depth \
             FROM block_tags bt \
             JOIN blocks tagged ON tagged.id = bt.block_id \
             JOIN blocks b ON b.parent_id = bt.block_id \
             WHERE tagged.deleted_at IS NULL AND tagged.is_conflict = 0 \
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id AS block_id, dt.tag_id, dt.inherited_from, dt.depth + 1 \
             FROM descendant_tags dt \
             JOIN blocks b ON b.parent_id = dt.block_id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND dt.depth < 100 \
         )";
        assert_eq!(
            norm(tag_inh_descendant_tags_full!()),
            norm(original_descendant_tags),
            "descendant_tags_full drifted from pre-MAINT-141 SQL",
        );

        // shape F: tagged_descendants_in_subtree — recompute query 3 (only
        // call site)
        let original_tagged_descendants =
            "tagged_descendants(block_id, tag_id, inherited_from, depth) AS ( \
             SELECT b.id AS block_id, bt.tag_id, bt.block_id AS inherited_from, 0 AS depth \
             FROM subtree st \
             JOIN block_tags bt ON bt.block_id = st.id \
             JOIN blocks tagged ON tagged.id = bt.block_id \
             JOIN blocks b ON b.parent_id = bt.block_id \
             WHERE tagged.deleted_at IS NULL AND tagged.is_conflict = 0 \
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id, td.tag_id, td.inherited_from, td.depth + 1 \
             FROM tagged_descendants td \
             JOIN blocks b ON b.parent_id = td.block_id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND td.depth < 100 \
         )";
        assert_eq!(
            norm(tag_inh_tagged_descendants_in_subtree!()),
            norm(original_tagged_descendants),
            "tagged_descendants_in_subtree drifted from pre-MAINT-141 SQL",
        );
    }
}
