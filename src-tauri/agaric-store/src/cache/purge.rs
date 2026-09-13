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
    purge_tag_property_and_link_rows(conn, cte_prefix, member_subquery, bind).await?;
    purge_cache_and_lookup_rows(conn, cte_prefix, member_subquery, bind).await?;
    Ok(())
}

/// The first half of the chain: the rows that name a member block directly —
/// `block_tags` → `block_tag_inherited` → the two `block_properties` sweeps →
/// `block_links`. Several of these can reference a member from more than one
/// column, which is why each carries its own predicate.
async fn purge_tag_property_and_link_rows(
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

    Ok(())
}

/// The second half of the chain: the derived caches and the id-keyed lookup
/// satellites — `agenda_cache` → `tags_cache` → `pages_cache` → `fts_blocks`
/// → `page_aliases` → `projected_agenda_cache`. Each is keyed on a single
/// member id column.
async fn purge_cache_and_lookup_rows(
    conn: &mut SqliteConnection,
    cte_prefix: &str,
    member_subquery: &str,
    bind: Option<&str>,
) -> Result<(), AppError> {
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

    /// The FIRST half of the chain, in isolation: `block_tags`,
    /// `block_tag_inherited`, both `block_properties` sweeps and `block_links`.
    ///
    /// Every one of those FKs is `REFERENCES blocks(id) ON DELETE CASCADE`
    /// (migrations 0061/0062), so at the single production call site — where
    /// the caller's own `blocks` DELETE follows immediately — the cascade
    /// reaches the same rows and the sweep is invisible. It is kept explicit
    /// for the reason #1583 records on the sibling purge chain in
    /// `agaric-engine`'s `loro_apply`: the list is the canonical record of what
    /// PURGE touches, and a future migration adding a block-referencing table
    /// without CASCADE would silently leak. This test is what makes that
    /// explicit sweep falsifiable — it never deletes a `blocks` row, so no
    /// cascade can stand in for it.
    #[tokio::test]
    async fn purges_tag_property_and_link_rows_without_any_blocks_delete() {
        let (pool, _tmp) = test_pool().await;
        let mut conn = pool.acquire().await.expect("acquire");

        // `victim` is the member set; every other block is a bystander whose
        // rows must survive. `ref_holder` owns a property pointing INTO the
        // member set, which is the one sweep keyed on something other than the
        // member's own id.
        for id in ["victim", "bystander", "tag", "ref_holder"] {
            sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', '')")
                .bind(id)
                .execute(&mut *conn)
                .await
                .expect("seed block");
        }

        // One member row and one bystander row per swept predicate.
        for (block_id, tag_id) in [("victim", "tag"), ("bystander", "tag")] {
            sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
                .bind(block_id)
                .bind(tag_id)
                .execute(&mut *conn)
                .await
                .expect("seed block_tags");
        }
        // `inherited_from = 'victim'` on a row whose block_id is a bystander:
        // the third predicate of the `block_tag_inherited` sweep, and the only
        // one that fires for it.
        for (block_id, inherited_from) in [("victim", "bystander"), ("bystander", "victim")] {
            sqlx::query(
                "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) \
                 VALUES (?, 'tag', ?)",
            )
            .bind(block_id)
            .bind(inherited_from)
            .execute(&mut *conn)
            .await
            .expect("seed block_tag_inherited");
        }
        for id in ["victim", "bystander"] {
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'k', 'v')",
            )
            .bind(id)
            .execute(&mut *conn)
            .await
            .expect("seed block_properties");
        }
        // The `value_ref` sweep: owned by `ref_holder`, pointing at the member.
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) \
             VALUES ('ref_holder', 'ref', 'victim')",
        )
        .execute(&mut *conn)
        .await
        .expect("seed value_ref property");
        for (source_id, target_id) in [("victim", "bystander"), ("bystander", "victim")] {
            sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
                .bind(source_id)
                .bind(target_id)
                .execute(&mut *conn)
                .await
                .expect("seed block_links");
        }

        purge_block_satellite_caches(
            &mut conn,
            "",
            "SELECT id FROM blocks WHERE id = 'victim'",
            None,
        )
        .await
        .expect("purge");

        let block_tags: Vec<String> =
            sqlx::query_scalar::<_, String>("SELECT block_id FROM block_tags ORDER BY block_id")
                .fetch_all(&mut *conn)
                .await
                .expect("read block_tags");
        assert_eq!(block_tags, vec!["bystander".to_string()]);

        // Both seeded rows name the member — one as `block_id`, one as
        // `inherited_from` — so the sweep clears the table.
        let inherited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_tag_inherited")
            .fetch_one(&mut *conn)
            .await
            .expect("count block_tag_inherited");
        assert_eq!(inherited, 0);

        let props: Vec<String> = sqlx::query_scalar::<_, String>(
            "SELECT block_id FROM block_properties ORDER BY block_id",
        )
        .fetch_all(&mut *conn)
        .await
        .expect("read block_properties");
        assert_eq!(
            props,
            vec!["bystander".to_string()],
            "`ref_holder`'s row points INTO the member set and goes with it"
        );

        let links: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_links")
            .fetch_one(&mut *conn)
            .await
            .expect("count block_links");
        assert_eq!(links, 0, "either end in the member set is swept");

        let block_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
            .fetch_one(&mut *conn)
            .await
            .expect("count blocks");
        assert_eq!(
            block_count, 4,
            "no blocks row is deleted here, so no ON DELETE CASCADE can have done this work"
        );
    }
}
