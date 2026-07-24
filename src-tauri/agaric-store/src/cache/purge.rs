//! Physical subtree purge of the store-owned satellite / derived-cache tables
//! (#2895 slice 1).
//!
//! Extracted verbatim from the app crate's
//! `commands::block_cleanup::purge_subtree_tables` so the store — the owning
//! crate for the derived caches (`agenda_cache`, `block_links`,
//! `block_tag_inherited`, `pages_cache`, `projected_agenda_cache`,
//! `tags_cache`) and for the block-satellite tables (`block_tags`,
//! `block_properties`, `fts_blocks`, `page_aliases`) — is the single home for
//! their raw purge writes. The final `blocks` DELETE (engine-owned) and the
//! app-local `attachments` / `block_drafts` deletes stay in the app-side
//! orchestrator, which threads the SAME borrowed connection.
//!
//! Operates on a borrowed `&mut SqliteConnection` (never a pool): it opens no
//! transaction of its own and runs inside the caller's IMMEDIATE tx, preserving
//! the #110 raw-write-tx convention. FK checks are assumed already deferred by
//! the caller (`PRAGMA defer_foreign_keys = ON`); this chain relies on it.

use agaric_core::error::AppError;
use sqlx::SqliteConnection;

/// Purge every store-owned satellite / derived-cache row for the subtree
/// `blocks` selected by `member_subquery`.
///
/// `member_subquery` is the SQL that yields the set of block ids being purged
/// (referenced per-table as `DELETE … IN (<member_subquery>)`), and
/// `cte_prefix` is the optional `WITH RECURSIVE …` prefix that defines the
/// relation `member_subquery` selects from. `bind` is the single value bound
/// to the `?` / `?1` placeholder in `cte_prefix` (a seed block id, or a JSON
/// id array for the multi-root variant); pass `None` for the "all
/// soft-deleted" variant, whose member set carries no placeholder.
///
/// The table list, order, and per-table column predicates match the store-side
/// slice of the pre-refactor purge chain byte-for-byte (block_tags →
/// block_tag_inherited → two block_properties sweeps → block_links →
/// agenda_cache → tags_cache → pages_cache → fts_blocks → page_aliases →
/// projected_agenda_cache). The app-owned `attachments` / `block_drafts`
/// deletes and the engine-owned final `blocks` DELETE are run by the caller.
///
/// The SQL here is genuinely dynamic — the same chain is emitted against three
/// membership shapes (single-root recursive CTE, multi-root `json_each` CTE,
/// flat `deleted_at IS NOT NULL` set) — so a runtime `sqlx::query(...)` is
/// required; the macro form cannot take a runtime-assembled query string.
pub async fn purge_block_satellite_caches(
    conn: &mut SqliteConnection,
    cte_prefix: &str,
    member_subquery: &str,
    bind: Option<&str>,
) -> Result<(), AppError> {
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
    // value, so SET-NULL would produce an invariant-violating all-NULL
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

    Ok(())
}

/// Execute one dynamic `DELETE`, optionally binding a single placeholder.
async fn exec(conn: &mut SqliteConnection, bind: Option<&str>, sql: &str) -> Result<u64, AppError> {
    // dynamic-sql: #664/#2895 — one purge chain emitted against three runtime
    // membership shapes (single-root CTE / json_each CTE / flat deleted-set);
    // the macro form cannot take a runtime query string.
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_string()));
    if let Some(b) = bind {
        q = q.bind(b.to_string());
    }
    Ok(q.execute(conn).await?.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::test_pool;

    /// End-to-end: `purge_block_satellite_caches` deletes exactly the
    /// store-owned satellite rows for the member set and leaves the `blocks`
    /// row (engine-owned, purged by the caller) and unrelated rows intact.
    #[tokio::test]
    async fn purges_store_owned_satellites_for_member_set() {
        let (pool, _tmp) = test_pool().await;
        let mut conn = pool.acquire().await.expect("acquire");

        // Two blocks: `victim` (purged) and `bystander` (untouched).
        for id in ["victim", "bystander"] {
            sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', '')")
                .bind(id)
                .execute(&mut *conn)
                .await
                .expect("seed block");
        }
        // A store-owned satellite row per member + a bystander row.
        for id in ["victim", "bystander"] {
            sqlx::query(
                "INSERT INTO agenda_cache (date, block_id, source) \
                 VALUES ('2026-01-01', ?, 'property:scheduled')",
            )
            .bind(id)
            .execute(&mut *conn)
            .await
            .expect("seed agenda_cache");
        }

        purge_block_satellite_caches(
            &mut conn,
            "",
            "SELECT id FROM blocks WHERE id = 'victim'",
            None,
        )
        .await
        .expect("purge");

        let remaining: Vec<String> =
            sqlx::query_scalar::<_, String>("SELECT block_id FROM agenda_cache ORDER BY block_id")
                .fetch_all(&mut *conn)
                .await
                .expect("read back");
        assert_eq!(
            remaining,
            vec!["bystander".to_string()],
            "only the member's satellite row should be purged"
        );
        // The engine-owned `blocks` row is NOT deleted by this fn.
        let block_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
            .fetch_one(&mut *conn)
            .await
            .expect("count blocks");
        assert_eq!(block_count, 2, "purge fn must not delete blocks rows");
    }
}
