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

    // #2895 slice 1: the store-owned satellite / derived-cache purge (block_tags,
    // block_tag_inherited, block_properties×2, block_links, agenda_cache,
    // tags_cache, pages_cache, fts_blocks, page_aliases, projected_agenda_cache)
    // now lives behind the owning crate's
    // `agaric_store::cache::purge_block_satellite_caches`, threading the SAME
    // borrowed connection so the caller's IMMEDIATE tx is preserved. FK checks
    // remain deferred by the caller; `blocks` is deleted last (below).
    agaric_store::cache::purge_block_satellite_caches(conn, cte_prefix, member_subquery, bind)
        .await?;

    // attachments (keyed on block_id) — app-owned, fs-backed satellite; the
    // captured on-disk paths are unlinked post-commit by the caller.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM attachments \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // block_drafts (keyed on block_id) — device-local, never synced/snapshotted.
    exec(
        conn,
        bind,
        &format!(
            "{cte_prefix}DELETE FROM block_drafts \
             WHERE block_id IN ({member_subquery})"
        ),
    )
    .await?;

    // blocks themselves (keyed on id; deferred FK lets the single DELETE sweep
    // the whole subtree). #2895 slice 1: the engine owns the `blocks`
    // projection, so the final delete lives behind
    // `agaric_engine::block_ops::delete_blocks_in_subtree`.
    let rows =
        agaric_engine::block_ops::delete_blocks_in_subtree(conn, cte_prefix, member_subquery, bind)
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

// #2621 (THE INVERSION): `rederive_page_and_space_ids` is pure `blocks`-table
// SQL (recursive descendant CTEs with the depth-100 cap), so it moved DOWN into
// `agaric-store` beside the other block-descendant CTE helpers
// (`agaric_store::block_descendants`). This re-export shim keeps every existing
// `crate::commands::block_cleanup::rederive_page_and_space_ids` call site
// (`move_ops.rs`, `crud.rs` restore, the two `history.rs` reverse arms, the
// materializer projections) compiling unchanged.
pub use agaric_store::block_descendants::rederive_page_and_space_ids;
