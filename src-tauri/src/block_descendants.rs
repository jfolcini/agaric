//! Shared recursive CTEs for block-descendant and block-ancestor walks.
//!
//! Five SQL snippets that walk the `blocks` tree via the `parent_id`
//! chain. They are CTE prefixes: a call site prepends one of them to its
//! own `SELECT`/`UPDATE`/`DELETE` using `descendants` (downward walks)
//! or `ancestors` (upward walks) as the CTE name.
//!
//! # Variants
//!
//! | Macro / constant              | Direction   | Extra recursive filter                                         | When to use                                  |
//! |-------------------------------|-------------|----------------------------------------------------------------|----------------------------------------------|
//! | [`descendants_cte_standard`]  | downward    | `b.is_conflict = 0 AND d.depth < 100`                          | Generic descendant lookup / restore cascade. |
//! | [`descendants_cte_active`]    | downward    | `b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100` | Soft-delete cascade (skip already-deleted descendants). |
//! | [`descendants_cte_purge`]     | downward    | `d.depth < 100` only                                           | Physical purge (must sweep conflict copies too). |
//! | [`ancestors_cte_standard`]    | upward      | `b.is_conflict = 0 AND a.depth < 100`                          | Cycle detection / depth-limit checks on parent chains. |
//! | [`ancestors_cte_active`]      | upward      | `b.deleted_at IS NULL AND b.is_conflict = 0 AND a.depth < 100` | Reserved for future soft-delete-aware ancestor walks (no current caller). |
//!
//! Every recursive CTE that walks the `blocks` tree MUST include either the
//! `is_conflict = 0` filter (variants `*_standard` / `*_active`) or be the
//! documented purge-only exception (variant `descendants_cte_purge`). See
//! invariant #9 in AGENTS.md. The `depth < 100` bound is unconditional —
//! it prevents runaway recursion on corrupted `parent_id` chains.
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
//! * `commands::blocks::move_ops::move_block_inner` (combined depth-check
//!   query at `move_ops.rs:130-153`) — defines `path` AND `descendants`
//!   in one `WITH RECURSIVE` to compute parent-chain depth and subtree
//!   depth in a single round trip; the macro family emits each CTE with
//!   its own `WITH RECURSIVE` prefix and cannot be composed into one
//!   multi-CTE `WITH` block.
//!
//! (Pre-MAINT-113-M1 a fourth site existed: `soft_delete::get_descendants`
//! mirrored `descendants_cte_standard!()`. It was dead code with zero
//! production callers and was removed when the `ActiveBlockId` newtype
//! landed; the cascade / restore / purge paths use the macros above.)
//!
//! Keeping compile-time type safety was judged more valuable than removing
//! the last three copies. If sqlx ever learns to accept `concat!()`, migrate
//! those sites too.

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

/// Recursive ancestor CTE, standard variant.
///
/// Walks `blocks.parent_id` UPWARD from a seed id, excluding conflict
/// copies. Mirrors [`descendants_cte_standard`] with the recursion
/// direction inverted: each recursive step looks up the row whose `id`
/// equals the previous step's id and emits that row's `parent_id`.
///
/// Caller binds the seed id to the `?` placeholder. The CTE emits the
/// seed itself at depth 0 and then one row per ancestor (parent at 1,
/// grandparent at 2, …). The recursive member's `b.parent_id IS NOT NULL`
/// guard suppresses the trailing NULL row that would otherwise appear
/// once the walk reaches a root.
///
/// Invariant #9: the `b.is_conflict = 0` filter prunes recursion through
/// conflict copies — an unfiltered walk would either climb through a
/// conflict ancestor's parent chain (causing false-positive cycle
/// reports / inflated depth counts) or stop at it without distinguishing
/// the two. `a.depth < 100` bounds the walk against runaway recursion on
/// corrupted `parent_id` chains.
#[macro_export]
macro_rules! ancestors_cte_standard {
    () => {
        "WITH RECURSIVE ancestors(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.parent_id, a.depth + 1 FROM blocks b \
             INNER JOIN ancestors a ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND b.is_conflict = 0 AND a.depth < 100 \
         ) "
    };
}

/// Recursive ancestor CTE, active-only variant.
///
/// Like [`ancestors_cte_standard`] but additionally skips ancestors that
/// have `deleted_at IS NOT NULL`. Reserved for future soft-delete-aware
/// ancestor walks; no production caller uses it today, but it's exposed
/// for symmetry with [`descendants_cte_active`] so a fifth migration is
/// trivial.
#[macro_export]
macro_rules! ancestors_cte_active {
    () => {
        "WITH RECURSIVE ancestors(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.parent_id, a.depth + 1 FROM blocks b \
             INNER JOIN ancestors a ON b.id = a.id \
             WHERE b.parent_id IS NOT NULL AND b.deleted_at IS NULL AND b.is_conflict = 0 AND a.depth < 100 \
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

/// String form of [`ancestors_cte_standard`]. See [`DESCENDANTS_CTE_STANDARD`].
pub const ANCESTORS_CTE_STANDARD: &str = ancestors_cte_standard!();

/// String form of [`ancestors_cte_active`]. See [`DESCENDANTS_CTE_STANDARD`].
pub const ANCESTORS_CTE_ACTIVE: &str = ancestors_cte_active!();

/// PEND-26 N2: did the depth-100 cap on the recursive descendants walk
/// actually fire for this `root_id`?
///
/// AGENTS.md invariant #9 caps every `descendants_cte_*!()` walk at
/// `d.depth < 100` to prevent runaway recursion on corrupted
/// `parent_id` chains. This is correct as a guard, but cascade callers
/// (`delete_block_inner`, `restore_block_inner`, `purge_block_inner`,
/// `cascade_soft_delete`, `restore_block`) silently miss any descendants
/// below depth 100 on legitimately deep trees.
///
/// This helper re-walks the non-conflict subtree under `root_id` and
/// reports whether `MAX(depth)` reached the cap region. Callers should
/// invoke it and either:
/// * `tracing::warn!` (default — best-effort cascades like soft-delete
///   and restore should not break on a pathological tree).
/// * `Err(AppError::Validation(...))` (purge — hard delete should be
///   all-or-nothing; a saturating cascade leaves orphans behind).
///
/// # Variant choice
///
/// The PEND-26 plan body suggested `descendants_cte_active!()`, but
/// that variant filters `b.deleted_at IS NULL` in the recursive arm —
/// which means **after** a soft-delete cascade the recursive walk
/// finds nothing (every descendant now has `deleted_at = now`) and the
/// helper would erroneously report "not saturated". The standard
/// variant (`descendants_cte_standard!()`) filters only
/// `b.is_conflict = 0 AND d.depth < 100` and is invariant to whether
/// the cascade has run — callers can place the check pre- or
/// post-cascade as appropriate without changing the result.
///
/// For purge cascades the standard variant under-detects conflict
/// copies (purge sweeps conflicts; standard prunes them). That is
/// acceptable: this helper is a safety net for an extreme corner
/// case (>100-level deep tree), not a primary correctness check.
///
/// # Threshold
///
/// `>= 99` per the PEND-26 plan: the recursive arm's `d.depth < 100`
/// filter allows the walk to step from `d.depth=99` to
/// `d.depth+1=100`, so MAX(depth) can be 100 when saturation occurs.
/// The slightly conservative `>= 99` boundary catches both the genuine
/// 100-level saturation and the boundary case of a tree exactly at the
/// cap leaf level — both deserve operator attention.
pub async fn cascade_depth_saturated<'e, E>(executor: E, root_id: &str) -> Result<bool, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    // `sqlx::query_scalar!` rejects `concat!(macro!(), "...")` even
    // though that expands to a string literal at compile time — it
    // wants a bare literal token. Use the dynamic-string `query_scalar`
    // form instead, mirroring the established idiom in this crate
    // (see `move_ops.rs:180,193` and the `ancestor_db_tests` here at
    // lines 408+).
    let max_depth: Option<i64> = sqlx::query_scalar::<_, Option<i64>>(concat!(
        descendants_cte_standard!(),
        "SELECT MAX(depth) FROM descendants",
    ))
    .bind(root_id)
    .fetch_one(executor)
    .await?;
    Ok(max_depth.unwrap_or(0) >= 99)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: all three descendant CTEs start with the recursive header
    /// and end with the closing `) `.
    #[test]
    fn descendant_ctes_have_well_formed_structure() {
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

    /// Smoke test: both ancestor CTEs start with the recursive header and
    /// end with the closing `) `.
    #[test]
    fn ancestor_ctes_have_well_formed_structure() {
        for cte in [ANCESTORS_CTE_STANDARD, ANCESTORS_CTE_ACTIVE] {
            assert!(
                cte.starts_with("WITH RECURSIVE ancestors(id, depth) AS ("),
                "CTE must start with the canonical ancestor header",
            );
            assert!(
                cte.trim_end().ends_with(')'),
                "CTE must end with the closing paren of the recursive block",
            );
            assert!(
                cte.contains("a.depth < 100"),
                "ancestor CTE must bound recursion depth to prevent runaway walks on corrupted parent_id chains",
            );
            assert!(
                cte.contains("b.parent_id IS NOT NULL"),
                "ancestor CTE must guard the recursive emit against NULL parent_id (root sentinel)",
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
        assert!(
            ANCESTORS_CTE_STANDARD.contains("b.is_conflict = 0"),
            "standard ancestor CTE must filter conflict copies (invariant #9)",
        );
        assert!(
            ANCESTORS_CTE_ACTIVE.contains("b.is_conflict = 0"),
            "active ancestor CTE must filter conflict copies (invariant #9)",
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
        assert!(
            ANCESTORS_CTE_ACTIVE.contains("b.deleted_at IS NULL"),
            "active ancestor CTE must skip already-deleted ancestors",
        );
        assert!(
            !ANCESTORS_CTE_STANDARD.contains("deleted_at"),
            "standard ancestor CTE must not reference deleted_at",
        );
    }

    /// The macro and the const must agree byte-for-byte.
    #[test]
    fn macros_match_constants() {
        assert_eq!(descendants_cte_standard!(), DESCENDANTS_CTE_STANDARD);
        assert_eq!(descendants_cte_active!(), DESCENDANTS_CTE_ACTIVE);
        assert_eq!(descendants_cte_purge!(), DESCENDANTS_CTE_PURGE);
        assert_eq!(ancestors_cte_standard!(), ANCESTORS_CTE_STANDARD);
        assert_eq!(ancestors_cte_active!(), ANCESTORS_CTE_ACTIVE);
    }
}

/// DB-backed integration tests for the ancestor-walk macro family.
///
/// These tests exercise the macros against a real SQLite pool (rather
/// than just asserting on the emitted string) so the AGENTS.md
/// invariant #9 contract — `is_conflict = 0` filter + `depth < 100`
/// bound — is anchored by behavioural tests, not just textual ones.
#[cfg(test)]
mod ancestor_db_tests {
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Direct INSERT bypassing the command layer. `is_conflict` defaults to
    /// 0 unless the test wants to model a conflict copy.
    async fn insert_block(pool: &SqlitePool, id: &str, parent_id: Option<&str>, is_conflict: bool) {
        let conflict_flag: i64 = if is_conflict { 1 } else { 0 };
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict) \
             VALUES (?, 'content', '', ?, 1, ?)",
        )
        .bind(id)
        .bind(parent_id)
        .bind(conflict_flag)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Happy path: walk a 3-block chain ROOT → MID → LEAF and assert the
    /// CTE returns all three rows in the expected order. Anchors the
    /// pre-/post-migration parity for `crud.rs` and `move_ops.rs`.
    #[tokio::test]
    async fn ancestors_cte_standard_walks_full_chain() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "ANCROOT", None, false).await;
        insert_block(&pool, "ANCMID", Some("ANCROOT"), false).await;
        insert_block(&pool, "ANCLEAF", Some("ANCMID"), false).await;

        let ids: Vec<String> = sqlx::query_scalar(concat!(
            ancestors_cte_standard!(),
            "SELECT id FROM ancestors ORDER BY depth"
        ))
        .bind("ANCLEAF")
        .fetch_all(&pool)
        .await
        .unwrap();

        assert_eq!(
            ids,
            vec![
                "ANCLEAF".to_string(),
                "ANCMID".to_string(),
                "ANCROOT".to_string()
            ],
            "ancestor walk must emit seed + every ancestor in depth order",
        );
    }

    /// Negative — invariant #9 (`is_conflict = 0`):
    /// chain ROOT → CC (conflict copy) → LEAF. The walk from LEAF must
    /// stop at the conflict-copy parent: ROOT must NOT be reachable
    /// because the recursive member filters out `b.is_conflict = 1`.
    ///
    /// The conflict-copy id itself can still appear in `ancestors`
    /// (it's the leaf's literal parent_id), but its own ancestors must
    /// be pruned. That mirrors the contract relied on by
    /// `move_block_cycle_detection_ignores_conflict_copies_i_commandscrud_13`.
    #[tokio::test]
    async fn ancestors_cte_standard_does_not_walk_through_conflict_copies() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "CFROOT", None, false).await;
        insert_block(&pool, "CFCC", Some("CFROOT"), true).await;
        insert_block(&pool, "CFLEAF", Some("CFCC"), false).await;

        let ids: Vec<String> = sqlx::query_scalar(concat!(
            ancestors_cte_standard!(),
            "SELECT id FROM ancestors ORDER BY depth"
        ))
        .bind("CFLEAF")
        .fetch_all(&pool)
        .await
        .unwrap();

        assert!(
            !ids.contains(&"CFROOT".to_string()),
            "ancestor walk must NOT continue through a conflict copy: \
             CFROOT is reachable only by traversing the is_conflict = 1 row \
             CFCC, which the filter must prune. Got: {ids:?}",
        );
    }

    /// Negative — invariant #9 (`depth < 100`):
    /// build a 150-block linear chain (A0 → A1 → … → A150) and walk
    /// ancestors from A150. The result must be capped at 101 rows
    /// (seed at depth 0 + 100 ancestors). Without the bound, a corrupt
    /// `parent_id` chain could blow up SQLite's recursion budget.
    #[tokio::test]
    async fn ancestors_cte_standard_caps_walk_at_depth_100() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "A0", None, false).await;
        for i in 1..=150 {
            let id = format!("A{i}");
            let parent = format!("A{}", i - 1);
            insert_block(&pool, &id, Some(parent.as_str()), false).await;
        }

        let count: i64 = sqlx::query_scalar(concat!(
            ancestors_cte_standard!(),
            "SELECT COUNT(*) FROM ancestors"
        ))
        .bind("A150")
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(
            count, 101,
            "ancestor walk must be bounded at depth < 100 (seed + 100 ancestors), got {count}",
        );
    }

    /// PEND-26 N2: a 105-block linear chain saturates the depth-100
    /// cap. `cascade_depth_saturated` must report `true`.
    #[tokio::test]
    async fn cascade_depth_saturated_fires_on_pathological_chain() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PEND26N2_R", None, false).await;
        for i in 1..=104 {
            let id = format!("PEND26N2_{i}");
            let parent = if i == 1 {
                "PEND26N2_R".to_string()
            } else {
                format!("PEND26N2_{}", i - 1)
            };
            insert_block(&pool, &id, Some(parent.as_str()), false).await;
        }

        let saturated = super::cascade_depth_saturated(&pool, "PEND26N2_R")
            .await
            .unwrap();
        assert!(
            saturated,
            "PEND-26 N2: a 105-block chain MUST trip the saturation flag; \
             the recursive CTE caps at depth 100 and the helper detects it"
        );
    }

    /// PEND-26 N2: a 99-level tree (depths 0..98 — 99 blocks) does NOT
    /// reach the depth-100 cap. `cascade_depth_saturated` must report
    /// `false` so the warn does not fire on legitimate trees.
    #[tokio::test]
    async fn cascade_depth_saturated_does_not_fire_under_threshold() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PEND26N2_OK_R", None, false).await;
        for i in 1..=98 {
            let id = format!("PEND26N2_OK_{i}");
            let parent = if i == 1 {
                "PEND26N2_OK_R".to_string()
            } else {
                format!("PEND26N2_OK_{}", i - 1)
            };
            insert_block(&pool, &id, Some(parent.as_str()), false).await;
        }

        let saturated = super::cascade_depth_saturated(&pool, "PEND26N2_OK_R")
            .await
            .unwrap();
        assert!(
            !saturated,
            "PEND-26 N2: a 99-block chain (max depth 98) MUST NOT \
             trip the saturation flag — that is below the >=99 threshold"
        );
    }
}
