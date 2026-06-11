//! Shared subtree-cleanup helpers (#664).
//!
//! Two SQL chains used to be hand-duplicated across the block command
//! handlers, and the duplication had already drifted:
//!
//! * The ~13-table **physical purge** chain (every `DELETE FROM
//!   <satellite>` for a subtree's block ids) appeared three times in
//!   `commands/blocks/crud.rs` — the `purge_descendants_table!` macro
//!   variant (`purge_block_inner`), the `query!` variant
//!   (`purge_all_deleted_inner`), and the `format!("{cte}…")` variant
//!   (`purge_blocks_by_ids_inner`). Adding a new satellite table meant
//!   hand-editing all three; this is the exact bug class #417/#446/#533
//!   kept patching.
//! * The **`page_id` + `space_id` rederive** CTE appeared four times
//!   (`move_ops.rs`, `crud.rs` restore, and the two reverse arms in
//!   `history.rs`). The two `history.rs` arms had drifted to rederive
//!   only `page_id` and skip `space_id` (the #533 step), so a moved /
//!   restored subtree read stale space membership after an undo until
//!   the async `RebuildPageIds` chain landed.
//!
//! Collapsing every call site onto [`rederive_page_and_space_ids`] makes
//! the complete (both-column) behaviour structurally impossible to drift
//! again, and [`purge_subtree_tables`] gives the satellite-table list one
//! home.
//!
//! Both helpers operate on a borrowed `&mut SqliteConnection` (obtained by
//! the callers via `&mut **tx` from their existing `CommandTx` /
//! `Transaction`). They open no transaction of their own — they run inside
//! the caller's IMMEDIATE tx, preserving the #110 raw-write-tx convention.

use sqlx::SqliteConnection;

use crate::error::AppError;

/// Run the full satellite-table purge chain for a subtree of `blocks`.
///
/// `member_subquery` is the SQL that yields the set of block ids to purge
/// (it is referenced by every per-table `DELETE … IN (<member_subquery>)`),
/// and `cte_prefix` is an optional `WITH RECURSIVE …` prefix that defines
/// the relation `member_subquery` selects from. `bind` is the single value
/// bound to the `?` / `?1` placeholder in `cte_prefix` (the seed block id,
/// or the JSON id array for the multi-root variant); pass `None` for the
/// "all soft-deleted" variant, whose member set carries no placeholder.
///
/// The table list, order, and per-table column predicates are byte-for-byte
/// the chains they replace (block_tags → block_tag_inherited → two
/// block_properties sweeps → block_links → agenda_cache → tags_cache →
/// pages_cache → attachments → block_drafts → fts_blocks → page_aliases →
/// projected_agenda_cache → blocks). FK checks must already be deferred by
/// the caller (`PRAGMA defer_foreign_keys = ON`) — the chain assumes it.
///
/// Returns `(attachment_fs_paths, blocks_rows_affected)`: the attachment
/// on-disk paths captured BEFORE their rows are deleted (so the caller can
/// unlink them post-commit) and the row count of the final `blocks` DELETE.
///
/// All SQL here is genuinely dynamic — the same chain is emitted against
/// three different membership shapes (single-root recursive CTE, multi-root
/// `json_each` CTE, and the flat `deleted_at IS NOT NULL` set) — so the
/// runtime `sqlx::query(...)` form is required; the macro form cannot take a
/// runtime-assembled query string.
pub async fn purge_subtree_tables(
    conn: &mut SqliteConnection,
    cte_prefix: &str,
    member_subquery: &str,
    bind: Option<&str>,
) -> Result<(Vec<String>, u64), AppError> {
    // block_tags: either column may reference a member block.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_tags \
             WHERE block_id IN ({member_subquery}) \
                OR tag_id IN ({member_subquery})"
        ),
    )
    .await?;

    // block_tag_inherited (P-4): block_id, tag_id, or inherited_from.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_tag_inherited \
             WHERE block_id IN ({member_subquery}) \
                OR tag_id IN ({member_subquery}) \
                OR inherited_from IN ({member_subquery})"
        ),
    )
    .await?;

    // block_properties: owned by a member block.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_properties \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // block_properties: value_ref pointing into the subtree — DELETE the
    // property row rather than NULLing the ref. Under the exactly-one-value
    // CHECK (migration 0062) a value_ref-only row has no fallback typed
    // value, so a SET-NULL would produce an invariant-violating all-NULL
    // row; migration 0062 aligned the value_ref FK to ON DELETE CASCADE and
    // this application-level cascade matches that direction.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_properties \
             WHERE value_ref IN ({member_subquery})"
        ),
    )
    .await?;

    // block_links: either end may be in the subtree.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_links \
             WHERE source_id IN ({member_subquery}) \
                OR target_id IN ({member_subquery})"
        ),
    )
    .await?;

    // agenda_cache (keyed on block_id).
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM agenda_cache \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // tags_cache (keyed on tag_id).
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM tags_cache \
             WHERE tag_id IN ({member_subquery})"
        ),
    )
    .await?;

    // pages_cache (keyed on page_id).
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM pages_cache \
             WHERE page_id IN ({member_subquery})"
        ),
    )
    .await?;

    // #85 F2: capture attachment file paths for the post-commit unlink
    // BEFORE the rows are deleted, else the rows vanish and the files leak.
    let attachment_paths = query_strings(
        conn,
        bind,
        &format!(
            "{cte_prefix}SELECT fs_path FROM attachments \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // attachments (keyed on block_id).
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM attachments \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // block_drafts (keyed on block_id).
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_drafts \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // fts_blocks — FTS5 virtual table, no FK, must be cleaned explicitly.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM fts_blocks \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // page_aliases (keyed on page_id).
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM page_aliases \
             WHERE page_id IN ({member_subquery})"
        ),
    )
    .await?;

    // projected_agenda_cache (keyed on block_id).
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM projected_agenda_cache \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // blocks themselves (keyed on id; deferred FK lets the single DELETE
    // sweep the whole subtree).
    let rows = exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM blocks \
             WHERE id IN ({member_subquery})"
        ),
    )
    .await?;

    Ok((attachment_paths, rows))
}

/// Execute one dynamic `DELETE`, optionally binding a single placeholder.
async fn exec(conn: &mut SqliteConnection, bind: Option<&str>, sql: &str) -> Result<u64, AppError> {
    // dynamic-sql: #664 — one purge chain emitted against three runtime
    // membership shapes (single-root CTE / json_each CTE / flat
    // deleted-set); the macro form cannot take a runtime query string.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
    if let Some(b) = bind {
        q = q.bind(b.to_string());
    }
    Ok(q.execute(conn).await?.rows_affected())
}

/// Run one dynamic `SELECT <text-col>` returning the column values,
/// optionally binding a single placeholder.
async fn query_strings(
    conn: &mut SqliteConnection,
    bind: Option<&str>,
    sql: &str,
) -> Result<Vec<String>, AppError> {
    // dynamic-sql: #664 — see `exec` above; same runtime-shape rationale.
    let mut q = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.to_string()));
    if let Some(b) = bind {
        q = q.bind(b.to_string());
    }
    Ok(q.fetch_all(conn).await?)
}

/// Recompute `page_id` AND `space_id` for the subtree rooted at `root`,
/// synchronously, inside the caller's transaction.
///
/// This is the canonical rederive shared by every structural-change path
/// that reparents a subtree: `move_block_inner`, `restore_block_inner`, and
/// the `MoveBlock` / `RestoreBlock` reverse arms in `history.rs`. Before
/// #664 each path open-coded the chain and the two `history.rs` arms had
/// drifted to skip the `space_id` step (#533), leaving stale space
/// membership after an undo until the async `RebuildPageIds` task landed.
///
/// Behaviour (mirrors the forward `move_block_inner` template):
///   1. Compute the new `page_id`: the parent's `page_id` (or the parent's
///      own `id` if the parent is itself a page) for a non-page root; the
///      root's own `id` for a page.
///   2. UPDATE the root's `page_id` (skipped for pages — a page is always
///      its own `page_id`).
///   3. Cascade `page_id` to every non-page active descendant.
///   4. Cascade `space_id` to the root + every non-page active descendant,
///      deriving it from each row's owning page's `space_id`.
///
/// The recursive CTEs filter `deleted_at IS NULL` in both members (a
/// conflict copy inherits `parent_id` from the original and would otherwise
/// be reparented under the subtree) and bound `depth < 100` (invariant #9).
pub async fn rederive_page_and_space_ids(
    conn: &mut SqliteConnection,
    root: &str,
) -> Result<(), AppError> {
    // 1. New page_id from the (possibly NULL) parent.
    let parent_id: Option<String> =
        sqlx::query_scalar!("SELECT parent_id FROM blocks WHERE id = ?", root)
            .fetch_one(&mut *conn)
            .await?;
    let new_page_id: Option<String> = if let Some(ref pid) = parent_id {
        sqlx::query_scalar!(
            "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END \
             FROM blocks WHERE id = ?",
            pid,
        )
        .fetch_optional(&mut *conn)
        .await?
        .flatten()
    } else {
        None
    };
    let is_page: bool = sqlx::query_scalar!("SELECT block_type FROM blocks WHERE id = ?", root)
        .fetch_one(&mut *conn)
        .await?
        == "page";

    // 2. The root itself (pages keep their own id as page_id).
    if !is_page {
        sqlx::query!(
            "UPDATE blocks SET page_id = ? WHERE id = ?",
            new_page_id,
            root,
        )
        .execute(&mut *conn)
        .await?;
    }
    let effective_page_id = if is_page {
        Some(root.to_string())
    } else {
        new_page_id
    };

    // 3. Cascade page_id to non-page active descendants.
    sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ) \
         UPDATE blocks SET page_id = ?2 \
         WHERE id IN (SELECT id FROM descendants) AND block_type != 'page'",
        root,
        effective_page_id,
    )
    .execute(&mut *conn)
    .await?;

    // 4. #533: keep space_id in step with the just-refreshed page_id for the
    //    whole subtree (root + non-page active descendants), synchronously —
    //    space-scoped lists are read right after commit. Non-page rows derive
    //    space_id from their owning page; pages keep their own.
    sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ) \
         UPDATE blocks SET space_id = ( \
             SELECT p.space_id FROM blocks p WHERE p.id = blocks.page_id \
         ) \
         WHERE (id = ?1 OR id IN (SELECT id FROM descendants)) \
           AND block_type != 'page' AND page_id IS NOT NULL",
        root,
    )
    .execute(&mut *conn)
    .await?;

    Ok(())
}
