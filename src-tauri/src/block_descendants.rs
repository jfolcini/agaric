//! Shared recursive CTE for block-descendant walks.
//!
//! Three SQL snippets that walk a block and all of its descendants via a
//! `parent_id` chain. They are prefixes: a call site prepends one of them to
//! its own `SELECT`/`UPDATE`/`DELETE` using `descendants` as the CTE name.
//!
//! # Variants
//!
//! | Macro / constant              | Extra recursive filter                         | When to use                                  |
//! |-------------------------------|------------------------------------------------|----------------------------------------------|
//! | [`descendants_cte_standard`]  | `b.is_conflict = 0 AND d.depth < 100`          | Generic descendant lookup / restore cascade. |
//! | [`descendants_cte_active`]    | `b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100` | Soft-delete cascade (skip already-deleted descendants). |
//! | [`descendants_cte_purge`]     | `d.depth < 100` only                           | Physical purge (must sweep conflict copies too). |
//!
//! Every recursive CTE that walks the `blocks` tree MUST include either the
//! `is_conflict = 0` filter (variants `standard` / `active`) or be the
//! documented purge-only exception (variant `purge`). See invariant #9 in
//! AGENTS.md. The `depth < 100` bound is unconditional — it prevents runaway
//! recursion on corrupted `parent_id` chains.
//!
//! # Why both macros and constants?
//!
//! `sqlx::query!()` requires its first argument to be a string literal, so it
//! cannot accept a runtime `&str` or a `concat!()` of a `const`. To keep
//! deduplication at compile time, we expose the CTE as a `macro_rules!`
//! returning a literal, usable via `concat!(descendants_cte_*!(), " …")`
//! inside `sqlx::query(…)` (non-macro). The `pub const` forms allow the rare
//! `format!()` call that isn't inside a compile-time boundary.
//!
//! # Sites that still inline the CTE
//!
//! Three production paths use `sqlx::query!()` (compile-time checked) and
//! therefore cannot use these macros (sqlx's macro rejects anything other
//! than a raw string literal). They intentionally duplicate the CTE body:
//!
//! * `soft_delete::trash::cascade_soft_delete` — mirrors `descendants_cte_active!()`
//! * `soft_delete::restore::restore_block`    — mirrors `descendants_cte_standard!()`
//! * `soft_delete::get_descendants`           — mirrors `descendants_cte_standard!()`
//!
//! Keeping compile-time type safety was judged more valuable than removing
//! the last three copies. If sqlx ever learns to accept `concat!()`, migrate
//! those three sites too.

/// Recursive descendant CTE, standard variant.
///
/// Walks `blocks.parent_id` from a seed id, excluding conflict copies.
/// Expands to a string literal, so it can be combined via `concat!()` in
/// `sqlx::query(…)` call sites.
///
/// See the module-level docs for the invariant rationale.
#[macro_export]
macro_rules! descendants_cte_standard {
    () => {
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.is_conflict = 0 AND d.depth < 100 \
         ) "
    };
}

/// Recursive descendant CTE, active-only variant.
///
/// Like [`descendants_cte_standard`] but additionally skips descendants that
/// already have `deleted_at IS NOT NULL`. Used exclusively by the soft-delete
/// cascade so that independently-trashed subtrees are not re-swept with a new
/// `deleted_at` timestamp.
#[macro_export]
macro_rules! descendants_cte_active {
    () => {
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
         ) "
    };
}

/// Recursive descendant CTE, purge variant.
///
/// Purge deliberately sweeps every row descended from the target block —
/// including conflict copies — because the goal is to erase every trace of
/// the subtree. This is the documented exception to invariant #9. The
/// `depth < 100` bound is kept.
#[macro_export]
macro_rules! descendants_cte_purge {
    () => {
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) "
    };
}

/// String form of [`descendants_cte_standard`] for the rare `format!()` call
/// site. Prefer `concat!(descendants_cte_standard!(), " …")` when the SQL
/// prefix is static — it avoids the runtime format! allocation.
pub const DESCENDANTS_CTE_STANDARD: &str = descendants_cte_standard!();

/// String form of [`descendants_cte_active`]. See [`DESCENDANTS_CTE_STANDARD`].
pub const DESCENDANTS_CTE_ACTIVE: &str = descendants_cte_active!();

/// String form of [`descendants_cte_purge`]. See [`DESCENDANTS_CTE_STANDARD`].
pub const DESCENDANTS_CTE_PURGE: &str = descendants_cte_purge!();

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: all three CTEs start with the recursive header and
    /// end with the closing `) `.
    #[test]
    fn ctes_have_well_formed_structure() {
        for cte in [
            DESCENDANTS_CTE_STANDARD,
            DESCENDANTS_CTE_ACTIVE,
            DESCENDANTS_CTE_PURGE,
        ] {
            assert!(
                cte.starts_with("WITH RECURSIVE descendants(id, depth) AS ("),
                "CTE must start with the canonical header",
            );
            assert!(
                cte.trim_end().ends_with(')'),
                "CTE must end with the closing paren of the recursive block",
            );
            assert!(
                cte.contains("d.depth < 100"),
                "CTE must bound recursion depth to prevent runaway walks on corrupted parent_id chains",
            );
        }
    }

    /// Invariant #9: every non-purge CTE must filter conflict copies out of
    /// the recursive member. The purge variant is the documented exception.
    #[test]
    fn non_purge_ctes_filter_is_conflict() {
        assert!(
            DESCENDANTS_CTE_STANDARD.contains("b.is_conflict = 0"),
            "standard CTE must filter conflict copies (invariant #9)",
        );
        assert!(
            DESCENDANTS_CTE_ACTIVE.contains("b.is_conflict = 0"),
            "active CTE must filter conflict copies (invariant #9)",
        );
        assert!(
            !DESCENDANTS_CTE_PURGE.contains("is_conflict"),
            "purge CTE must NOT filter conflicts — it intentionally sweeps them",
        );
    }

    /// The active variant additionally filters already-deleted descendants
    /// so the soft-delete cascade doesn't re-sweep them with a new
    /// `deleted_at` timestamp.
    #[test]
    fn active_cte_skips_already_deleted() {
        assert!(
            DESCENDANTS_CTE_ACTIVE.contains("b.deleted_at IS NULL"),
            "active CTE must skip already-deleted descendants",
        );
        assert!(
            !DESCENDANTS_CTE_STANDARD.contains("deleted_at"),
            "standard CTE must not reference deleted_at",
        );
        assert!(
            !DESCENDANTS_CTE_PURGE.contains("deleted_at"),
            "purge CTE must not reference deleted_at",
        );
    }

    /// The macro and the const must agree byte-for-byte.
    #[test]
    fn macros_match_constants() {
        assert_eq!(descendants_cte_standard!(), DESCENDANTS_CTE_STANDARD);
        assert_eq!(descendants_cte_active!(), DESCENDANTS_CTE_ACTIVE);
        assert_eq!(descendants_cte_purge!(), DESCENDANTS_CTE_PURGE);
    }
}
