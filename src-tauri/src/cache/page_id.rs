//! Rebuild the denormalized `page_id` column on `blocks`.

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use sqlx::SqlitePool;

// The split rebuild's chunked CASE-expression UPDATE binds 2 params per
// row in the `CASE id WHEN ? THEN ? ...` clause plus 1 param per row in
// the trailing `WHERE id IN (?, ?, ...)` list — total 3 params per row,
// so each statement binds at most `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS`.
// Mirrors the chunk-size derivation in `cache/pages.rs`,
// `cache/agenda.rs`, and the M-18 chunked-INSERT convention.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

/// Full rebuild of `page_id` for all blocks using a recursive CTE.
pub async fn rebuild_page_ids(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("page_id", || rebuild_page_ids_impl(pool)).await
}

async fn rebuild_page_ids_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    // Invariant #9: recursive CTE over `blocks` must bound `depth < 100`
    // to defend against runaway recursion on corrupted `parent_id`
    // chains.
    let result = sqlx::query(
        "WITH RECURSIVE ancestors(block_id, cur_id, cur_type, depth) AS ( \
             SELECT b.id, b.id, b.block_type, 0 FROM blocks b \
             UNION ALL \
             SELECT a.block_id, parent.id, parent.block_type, a.depth + 1 \
             FROM ancestors a \
             JOIN blocks child ON child.id = a.cur_id \
             JOIN blocks parent ON parent.id = child.parent_id \
             WHERE a.cur_type != 'page' \
               AND a.depth < 100 \
         ), \
         page_ancestors AS ( \
             SELECT block_id, cur_id AS page_id \
             FROM ancestors \
             WHERE cur_type = 'page' \
         ) \
         UPDATE blocks SET page_id = ( \
             SELECT pa.page_id FROM page_ancestors pa WHERE pa.block_id = blocks.id \
         ) \
         ",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// Read/write split variant (M-17)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_page_ids`] (M-17).
///
/// Runs the recursive ancestor-walk CTE as a SELECT on `read_pool`
/// inside a snapshot-isolated transaction, materialises the
/// `(block_id, page_id)` pairs into memory, then resets every non-
/// conflict block's `page_id` to NULL and applies a chunked CASE-
/// expression UPDATE on `write_pool` so the writer is held only for
/// the final write transaction.
///
/// Stale-while-revalidate: between dropping the read tx and beginning
/// the write tx another writer may mutate `blocks`. The next rebuild
/// reconciles any churn — cache rebuilds are background, eventually
/// consistent (AGENTS.md "Performance Conventions / Split read/write
/// pool pattern").
///
/// Invariant #9: the read-side CTE bounds `depth < 100`.
pub async fn rebuild_page_ids_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("page_id", || {
        rebuild_page_ids_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_page_ids_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Read phase — snapshot-isolated SELECT on `read_pool`. Same recursive
    // CTE shape as `rebuild_page_ids_impl` but materialises the
    // `(block_id, page_id)` mapping instead of folding into an inline
    // UPDATE. Invariant #9 filters apply identically.
    let mut read_tx = read_pool.begin().await?;
    let pairs: Vec<(String, String)> = sqlx::query_as(
        "WITH RECURSIVE ancestors(block_id, cur_id, cur_type, depth) AS ( \
             SELECT b.id, b.id, b.block_type, 0 FROM blocks b \
             UNION ALL \
             SELECT a.block_id, parent.id, parent.block_type, a.depth + 1 \
             FROM ancestors a \
             JOIN blocks child ON child.id = a.cur_id \
             JOIN blocks parent ON parent.id = child.parent_id \
             WHERE a.cur_type != 'page' \
               AND a.depth < 100 \
         ) \
         SELECT block_id, cur_id AS page_id \
         FROM ancestors \
         WHERE cur_type = 'page'",
    )
    .fetch_all(&mut *read_tx)
    .await?;
    drop(read_tx);

    // Write phase — single tx wrapping the NULL-reset and every chunked
    // UPDATE. Mirrors the single-pool variant's atomic semantics.
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_page_id_rebuild_write").await?;

    // Reset every block's `page_id` to NULL. Mirrors the single-pool
    // UPDATE semantics: blocks not present in the CTE result (orphans)
    // get `page_id = NULL` because the correlated subquery returns
    // NULL for them.
    let reset = sqlx::query!("UPDATE blocks SET page_id = NULL ")
        .execute(&mut *tx)
        .await?;
    let mut updated: u64 = reset.rows_affected();

    // Chunked CASE-expression UPDATE: 2 binds per row in the CASE +
    // 1 bind per row in the trailing IN list = 3 binds per row,
    // bounded by `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS`. The IN clause
    // restricts the UPDATE to the chunk's rows so we do not rewrite
    // unrelated blocks via the CASE's `ELSE page_id` no-op.
    for chunk in pairs.chunks(REBUILD_CHUNK) {
        let case_clauses: String = std::iter::repeat_n("WHEN ? THEN ?", chunk.len())
            .collect::<Vec<_>>()
            .join(" ");
        let in_placeholders: String = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE blocks SET page_id = CASE id {case_clauses} ELSE page_id END \
             WHERE id IN ({in_placeholders})",
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        // CASE binds: (block_id, page_id) per row.
        for (block_id, page_id) in chunk {
            q = q.bind(block_id).bind(page_id);
        }
        // IN-list binds: just the block ids, in the same order.
        for (block_id, _) in chunk {
            q = q.bind(block_id);
        }
        let res = q.execute(&mut *tx).await?;
        updated += res.rows_affected();
    }

    tx.commit().await?;
    Ok(updated)
}

/// Set `page_id` for a single newly created block by inheriting from its parent.
///
/// Used instead of the full `RebuildPageIds` rebuild on `create_block` — a
/// fresh block has no descendants, so only one row ever changes.
pub async fn set_block_page_id_from_parent(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE blocks \
         SET page_id = (SELECT b2.page_id FROM blocks b2 WHERE b2.id = blocks.parent_id) \
         WHERE id = ?",
        block_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Full rebuild of the denormalized `space_id` column on `blocks` (#533).
///
/// `space_id` is a derived cache: a block belongs to the space named by
/// the `space` property attached to its owning page. The owning page is
/// `blocks.page_id` (a page's own `page_id` equals its id per the
/// `page_id_self_for_pages` CHECK, so pages pick up their own space too).
/// This mirrors the canonical read filter and the 0086 backfill verbatim,
/// so it is the source-of-truth reconciliation for any drift. It must run
/// AFTER [`rebuild_page_ids`] — it reads the freshly materialized
/// `page_id`. Orphan blocks (NULL `page_id`) reset to NULL `space_id`.
pub async fn rebuild_space_ids(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("space_id", || rebuild_space_ids_impl(pool)).await
}

async fn rebuild_space_ids_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let result = sqlx::query!(
        "UPDATE blocks SET space_id = ( \
             SELECT bp.value_ref FROM block_properties bp \
             WHERE bp.key = 'space' AND bp.block_id = blocks.page_id \
         )"
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Set `space_id` for a single newly created block by inheriting from its
/// parent (#533). A fresh block lives in the same space as its parent's
/// page, so it copies the parent's already-materialized `space_id`. Used
/// alongside [`set_block_page_id_from_parent`] on `create_block` — only
/// the one new row ever changes, so the full `rebuild_space_ids` is
/// unnecessary.
pub async fn set_block_space_id_from_parent(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    sqlx::query!(
        "UPDATE blocks \
         SET space_id = (SELECT b2.space_id FROM blocks b2 WHERE b2.id = blocks.parent_id) \
         WHERE id = ?",
        block_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Issue #111 — regression tests for migration 0073's
    //! `page_id_self_for_pages` CHECK constraint on `blocks`. The
    //! constraint promotes the invariant "every `block_type = 'page'`
    //! row carries `page_id = id`" from a Rust-side write-time check
    //! into a storage-layer guarantee. Patterned after the 0062
    //! `exactly_one_value` regression test in `op_log.rs`.
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        (pool, dir)
    }

    /// A fresh database (with every migration applied) must contain no
    /// page rows violating the invariant. Belt-and-braces against a
    /// hypothetical future migration that backfills page rows without
    /// setting `page_id`.
    #[tokio::test]
    async fn page_id_invariant_holds_on_fresh_database_111() {
        let (pool, _dir) = test_pool().await;
        let bad: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE block_type = 'page' AND page_id != id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            bad, 0,
            "page_id_self_for_pages CHECK requires every page row to carry page_id = id"
        );
    }

    /// Inserting a page row with `page_id` mismatching `id` must
    /// violate the CHECK at the storage layer.
    #[tokio::test]
    async fn page_id_check_rejects_mismatched_page_id_111() {
        let (pool, _dir) = test_pool().await;

        // Seed a parent page so a child page can plausibly point at it
        // via page_id (the test below would otherwise leave page_id
        // dangling, which is the second case we want to keep open).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('PARENTPAGE000000000000001', 'page', 'parent', NULL, 1, \
                     'PARENTPAGE000000000000001')",
        )
        .execute(&pool)
        .await
        .expect("seeding a well-formed parent page must succeed");

        let err = sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('BADPAGEROW00000000000001', 'page', 'bad', NULL, 1, \
                     'PARENTPAGE000000000000001')",
        )
        .execute(&pool)
        .await
        .expect_err("page row whose page_id != id must violate page_id_self_for_pages CHECK");

        let msg = format!("{err:?}");
        assert!(
            msg.contains("CHECK constraint failed"),
            "expected CHECK constraint failure for mismatched page_id, got: {msg}"
        );
    }

    /// `block_type != 'page'` rows are exempt — a content block may
    /// carry any page_id (or none), and the CHECK must not fire.
    #[tokio::test]
    async fn page_id_check_allows_non_page_rows_with_any_page_id_111() {
        let (pool, _dir) = test_pool().await;

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('OWNERPAGE0000000000000001', 'page', 'owner', NULL, 1, \
                     'OWNERPAGE0000000000000001')",
        )
        .execute(&pool)
        .await
        .expect("seeding the owning page must succeed");

        // A child content block whose page_id points at the owning
        // page (the normal denormalised shape post-MAINT-187).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('CHILDCONTENT0000000000001', 'content', 'child', \
                     'OWNERPAGE0000000000000001', 1, 'OWNERPAGE0000000000000001')",
        )
        .execute(&pool)
        .await
        .expect("content block with page_id pointing at owning page must succeed");

        // A tag block with NULL page_id (tag rows historically carry
        // NULL page_id; this is the second exempt shape).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('TAGBLOCKROW00000000000001', 'tag', 'tag', NULL, NULL, NULL)",
        )
        .execute(&pool)
        .await
        .expect("tag row with NULL page_id must succeed (exempt from page_id_self_for_pages)");
    }

    /// `set_block_page_id_from_parent` inherits `page_id` from the
    /// parent row — the O(1) incremental path used on `create_block` (#460).
    #[tokio::test]
    async fn set_block_page_id_from_parent_inherits_page_id_460() {
        let (pool, _dir) = test_pool().await;

        // Seed a page (page_id = id by constraint).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('PAGE01', 'page', 'p', NULL, 1, 'PAGE01')",
        )
        .execute(&pool)
        .await
        .expect("page seed");

        // Seed a content block as the parent (page_id already set to PAGE01).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('PARENT01', 'content', 'parent', 'PAGE01', 1, 'PAGE01')",
        )
        .execute(&pool)
        .await
        .expect("parent content seed");

        // Insert the new child block with page_id = NULL (simulates the moment
        // right after create_block before the materializer runs).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('CHILD01', 'content', 'child', 'PARENT01', 1, NULL)",
        )
        .execute(&pool)
        .await
        .expect("child block seed with NULL page_id");

        super::set_block_page_id_from_parent(&pool, "CHILD01")
            .await
            .expect("set_block_page_id_from_parent must succeed");

        let page_id: Option<String> =
            sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'CHILD01'")
                .fetch_one(&pool)
                .await
                .expect("page_id lookup");

        assert_eq!(
            page_id.as_deref(),
            Some("PAGE01"),
            "child block must inherit page_id from its ancestor page via parent chain"
        );
    }

    /// #533: `rebuild_space_ids` derives `space_id` for every block from
    /// the `space` property attached to its owning page (the page being
    /// `blocks.page_id`, which equals the page's own id). Children inherit
    /// their page's space; a block whose page has no space property gets
    /// NULL.
    #[tokio::test]
    async fn rebuild_space_ids_derives_from_page_space_property_533() {
        let (pool, _dir) = test_pool().await;

        // A space block, a page assigned to it, and a child under the page.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) VALUES \
             ('SPACE01', 'page', 'space', NULL, 1, 'SPACE01'), \
             ('PAGE01',  'page', 'p',     NULL, 2, 'PAGE01'), \
             ('CHILD01', 'content', 'c',  'PAGE01', 1, 'PAGE01')",
        )
        .execute(&pool)
        .await
        .expect("seed blocks");

        // PAGE01 belongs to SPACE01 via the `space` property (on the page).
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) \
             VALUES ('PAGE01', 'space', 'SPACE01')",
        )
        .execute(&pool)
        .await
        .expect("seed space property");

        super::rebuild_space_ids(&pool)
            .await
            .expect("rebuild_space_ids must succeed");

        let space_of = |id: &str| {
            let pool = pool.clone();
            let id = id.to_string();
            async move {
                sqlx::query_scalar::<_, Option<String>>("SELECT space_id FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .expect("space_id lookup")
            }
        };

        assert_eq!(
            space_of("PAGE01").await.as_deref(),
            Some("SPACE01"),
            "the page carries its own space_id"
        );
        assert_eq!(
            space_of("CHILD01").await.as_deref(),
            Some("SPACE01"),
            "a child inherits its page's space_id"
        );
        assert_eq!(
            space_of("SPACE01").await,
            None,
            "a block whose page has no space property gets NULL space_id"
        );
    }

    /// #533: `set_block_space_id_from_parent` is the O(1) incremental path
    /// used on `create_block` — a fresh child copies its parent's
    /// already-materialized `space_id`.
    #[tokio::test]
    async fn set_block_space_id_from_parent_inherits_space_533() {
        let (pool, _dir) = test_pool().await;

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) VALUES \
             ('SPACE01', 'page',    's', NULL,     1, 'SPACE01', NULL), \
             ('PAGE01',  'page',    'p', NULL,     2, 'PAGE01', 'SPACE01'), \
             ('PARENT1', 'content', 'a', 'PAGE01', 1, 'PAGE01', 'SPACE01')",
        )
        .execute(&pool)
        .await
        .expect("seed page + parent with space_id");

        // New child inserted before the materializer runs (space_id NULL).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES ('CHILD1', 'content', 'c', 'PARENT1', 1, 'PAGE01', NULL)",
        )
        .execute(&pool)
        .await
        .expect("seed child with NULL space_id");

        super::set_block_space_id_from_parent(&pool, "CHILD1")
            .await
            .expect("set_block_space_id_from_parent must succeed");

        let space_id: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'CHILD1'")
                .fetch_one(&pool)
                .await
                .expect("space_id lookup");
        assert_eq!(
            space_id.as_deref(),
            Some("SPACE01"),
            "child inherits space_id from its parent"
        );
    }

    /// A well-formed page row (id == page_id) inserts cleanly.
    #[tokio::test]
    async fn page_id_check_allows_self_referential_page_rows_111() {
        let (pool, _dir) = test_pool().await;

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('GOODPAGEROW0000000000001', 'page', 'good', NULL, 1, \
                     'GOODPAGEROW0000000000001')",
        )
        .execute(&pool)
        .await
        .expect("page row with id = page_id must satisfy the CHECK");
    }
}
