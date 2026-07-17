//! Rebuild the denormalized `page_id` column on `blocks`.

use crate::db::MAX_SQL_PARAMS;
use agaric_core::error::AppError;
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::HashMap;

// The chunked CASE-expression UPDATE binds 2 params per row in the
// `CASE id WHEN ? THEN ? ...` clause plus 1 param per row in the trailing
// `WHERE id IN (?, ?, ...)` list — total 3 params per row, so each
// statement binds at most `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS`.
// Mirrors the chunk-size derivation in `cache/pages.rs`,
// `cache/agenda.rs`, and the chunked-INSERT convention.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

// The chunked NULL-reset UPDATE binds 1 param per row in its
// `WHERE id IN (?, ?, ...)` list, so it can pack up to `MAX_SQL_PARAMS`
// ids per statement.
const NULL_CHUNK: usize = MAX_SQL_PARAMS; // 999

// The within-depth-cap ancestor walk. Materialises `(block_id, page_id)`
// for every block that resolves to an owning page within
// `DESCENDANT_DEPTH_CAP` parent-steps. Shared by both the single-pool and
// the read/write-split rebuilds so the two cannot silently diverge.
//
// Invariant #9: the recursive CTE bounds `depth < 100`
// (`DESCENDANT_DEPTH_CAP`, see block_descendants) to defend against
// runaway recursion on corrupted `parent_id` chains.
const DESIRED_PAGE_ID_SQL: &str = "WITH RECURSIVE ancestors(block_id, cur_id, cur_type, depth) AS ( \
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
     WHERE cur_type = 'page'";

/// A `page_id` diff: the rows whose denormalised `page_id` must change to
/// reach the desired (source-of-truth) state, split into value-sets and
/// NULL-resets. A byte-identical cache is reached by applying ONLY these
/// rows — every block already carrying its correct `page_id` is skipped,
/// so an up-to-date vault writes zero `blocks` rows (#2668).
struct PageIdDiff {
    /// Blocks whose `page_id` must be set to `Some(page_id)`.
    to_set: Vec<(String, String)>,
    /// Blocks whose `page_id` must be reset to NULL (orphans / tags /
    /// cycle members that currently carry a stale value).
    to_null: Vec<String>,
    /// Number of blocks whose `page_id` was resolved past the depth-100
    /// ancestor-CTE cap by the iterative extension (R27). Non-zero only
    /// for pathologically deep (merged-sync) trees; surfaced as a warn.
    extended: u64,
}

/// Compute the desired `block_id → page_id` mapping and diff it against the
/// current `blocks.page_id` column, reading everything from `conn`.
///
/// Desired state is derived exactly as the old full-rewrite did — the
/// within-cap ancestor CTE ([`DESIRED_PAGE_ID_SQL`]) plus the R27 iterative
/// extension for blocks deeper than `DESCENDANT_DEPTH_CAP` — but into an
/// in-memory map instead of an inline `blocks` UPDATE. The returned
/// [`PageIdDiff`] therefore reaches a state byte-identical to the old
/// unconditional rewrite while touching only the rows that actually change.
///
/// Mirrors the diff-based writers in `cache/block_tag_refs.rs` and
/// `cache/agenda.rs`.
async fn compute_page_id_diff(conn: &mut SqliteConnection) -> Result<PageIdDiff, AppError> {
    // Desired within the depth cap: same recursive ancestor walk the old
    // rebuild folded into an inline UPDATE. Pages resolve to themselves
    // (depth-0, `cur_type = 'page'`), matching the `page_id_self_for_pages`
    // CHECK, so a page's row never appears in the diff.
    let pairs: Vec<(String, String)> = sqlx::query_as(DESIRED_PAGE_ID_SQL)
        .fetch_all(&mut *conn)
        .await?;
    let mut desired: HashMap<String, String> = pairs.into_iter().collect();

    // R27 extension: blocks deeper than the depth-100 cap resolved no page
    // ancestor within the CTE. Copy the parent's already-resolved page_id
    // one level further down, iterating to a fixpoint — the exact monotone
    // fill the old `extend_page_ids_below_depth_cap` did in SQL, but on the
    // in-memory desired map. Only non-page blocks WITH a parent participate
    // (mirrors the SQL guards `block_type != 'page' AND parent_id IS NOT
    // NULL`); orphans / cycle members never resolve and stay unmapped (→
    // NULL), exactly as before.
    let candidates: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, parent_id FROM blocks WHERE block_type != 'page'")
            .fetch_all(&mut *conn)
            .await?;
    let mut extended: u64 = 0;
    loop {
        let mut progressed = false;
        for (id, parent_id) in &candidates {
            if desired.contains_key(id) {
                continue;
            }
            let Some(parent_id) = parent_id else { continue };
            if let Some(page_id) = desired.get(parent_id).cloned() {
                desired.insert(id.clone(), page_id);
                extended += 1;
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }

    // Diff against the live column. `to_set` for blocks whose desired
    // page_id differs from the current value; `to_null` for blocks that
    // resolve to no page (unmapped) but still carry a stale non-NULL value.
    let current: Vec<(String, Option<String>)> = sqlx::query_as("SELECT id, page_id FROM blocks")
        .fetch_all(&mut *conn)
        .await?;
    let mut to_set: Vec<(String, String)> = Vec::new();
    let mut to_null: Vec<String> = Vec::new();
    for (id, cur) in current {
        match desired.get(&id) {
            Some(want) if cur.as_deref() != Some(want.as_str()) => {
                to_set.push((id, want.clone()));
            }
            None if cur.is_some() => to_null.push(id),
            _ => {}
        }
    }

    Ok(PageIdDiff {
        to_set,
        to_null,
        extended,
    })
}

/// Apply a computed [`PageIdDiff`] inside an open write transaction, in
/// chunks bounded by [`MAX_SQL_PARAMS`]. Returns the number of `blocks`
/// rows written (0 when the cache was already up to date).
///
/// NULL-resets run before value-sets — neither set overlaps (a block is in
/// at most one), so ordering is immaterial, but it matches the
/// delete-before-insert apply-style of the sibling diff writers.
async fn apply_page_id_diff(tx: &mut SqliteConnection, diff: &PageIdDiff) -> Result<u64, AppError> {
    let mut written: u64 = 0;

    for chunk in diff.to_null.chunks(NULL_CHUNK) {
        let placeholders: String = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("UPDATE blocks SET page_id = NULL WHERE id IN ({placeholders})");
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for id in chunk {
            q = q.bind(id);
        }
        written += q.execute(&mut *tx).await?.rows_affected();
    }

    // Chunked CASE-expression UPDATE: 2 binds per row in the CASE +
    // 1 bind per row in the trailing IN list = 3 binds per row, bounded by
    // `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS`. The IN clause restricts the
    // UPDATE to the chunk's rows so the CASE's `ELSE page_id` no-op never
    // rewrites an unrelated block.
    for chunk in diff.to_set.chunks(REBUILD_CHUNK) {
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
        for (block_id, page_id) in chunk {
            q = q.bind(block_id).bind(page_id);
        }
        for (block_id, _) in chunk {
            q = q.bind(block_id);
        }
        written += q.execute(&mut *tx).await?.rows_affected();
    }

    Ok(written)
}

/// Emit the R27 depth-cap-crossing warn (LOUD, never a silent NULL) when
/// the extension resolved any block past the depth-100 ancestor-CTE cap.
fn warn_if_extended(extended: u64) {
    if extended > 0 {
        tracing::warn!(
            extended,
            "page_id derivation extended past the depth-100 ancestor-CTE cap \
             (tree deeper than DESCENDANT_DEPTH_CAP — merged sync trees can \
             legally exceed the local depth bound, R27)",
        );
    }
}

/// Diff-based rebuild of `page_id` for all blocks (#2668).
///
/// Computes the desired `block_id → page_id` mapping (the recursive
/// ancestor walk plus the R27 depth-cap extension), diffs it against the
/// live `blocks.page_id` column, and writes ONLY the rows whose value
/// changed. The final cache state is byte-identical to the pre-#2668
/// full-rewrite; an up-to-date vault writes zero `blocks` rows.
///
/// Reads and writes run in a single transaction so the diff is computed and
/// applied atomically (no TOCTOU window for the single-pool path).
pub async fn rebuild_page_ids(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("page_id", || rebuild_page_ids_impl(pool)).await
}

async fn rebuild_page_ids_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_page_id_rebuild").await?;
    // Compute the diff INSIDE the write tx so the read snapshot and the
    // applied writes are atomic (the single-pool path keeps the old
    // one-statement UPDATE's no-TOCTOU guarantee).
    let diff = compute_page_id_diff(&mut tx).await?;
    warn_if_extended(diff.extended);
    let written = apply_page_id_diff(&mut tx, &diff).await?;
    if written == 0 {
        // Nothing changed — transaction rolls back on drop.
        return Ok(0);
    }
    tx.commit().await?;
    Ok(written)
}

// ---------------------------------------------------------------------------
// Read/write split variant
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_page_ids`].
///
/// Computes the desired mapping + diff on `read_pool` (a snapshot-isolated
/// connection), then applies only the changed rows on `write_pool` so the
/// writer lock is held for the final write transaction only.
///
/// Stale-while-revalidate: between reading on `read_pool` and beginning the
/// write tx another writer may mutate `blocks`. The next rebuild reconciles
/// any churn — cache rebuilds are background, eventually consistent
/// (AGENTS.md "Performance Conventions / Split read/write pool pattern").
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
    // Read phase — desired mapping + current column + diff, all on a single
    // `read_pool` connection (consistent snapshot).
    let mut read_conn = read_pool.acquire().await?;
    let diff = compute_page_id_diff(&mut read_conn).await?;
    drop(read_conn);
    warn_if_extended(diff.extended);

    if diff.to_set.is_empty() && diff.to_null.is_empty() {
        // Nothing changed — skip the writer lock entirely.
        return Ok(0);
    }

    // Write phase — single tx applying only the changed rows.
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_page_id_rebuild_write").await?;
    let written = apply_page_id_diff(&mut tx, &diff).await?;
    tx.commit().await?;
    Ok(written)
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
    // #533 Phase 2: `space_id` is the source of truth. A page's own
    // `space_id` (set by the `space` op via the command/replay paths) is
    // authoritative; this rebuild only PROPAGATES it to the page's
    // descendants. Non-page blocks inherit their owning page's column
    // (`blocks.page_id` → that page's `space_id`); pages are left untouched
    // (excluding them also avoids any read-during-write ambiguity, since
    // the correlated subquery only reads page rows, which are never in the
    // update set). Orphans (NULL `page_id`) reset to NULL `space_id`.
    // Only PROPAGATE to blocks that have an owning page (`page_id IS NOT
    // NULL`). Pages are authoritative (excluded). Tags are top-level with
    // `page_id = NULL` (migration 0027) but carry their OWN authoritative
    // `space_id` (set directly by the `space` op) — they have no page to
    // re-derive from, so they must NOT be touched here or the rebuild would
    // null every tag's space (data loss). Orphan content (page purged →
    // NULL page_id) likewise keeps its last value rather than being cleared.
    //
    // #2668: the trailing null-safe `space_id IS NOT (<owning page's
    // space_id>)` guard restricts the UPDATE to rows whose value actually
    // changes, so an up-to-date vault writes zero `blocks` rows. The target
    // row set (non-page blocks with a page_id) is unchanged — only rows
    // already carrying the correct `space_id` are skipped — so the final
    // cache state is byte-identical to the pre-#2668 unconditional UPDATE.
    // The correlated subquery is evaluated twice per candidate row (SET +
    // WHERE) but reads only; `IS NOT` is SQLite's null-safe distinct
    // operator, so a NULL owning-page value correctly matches a NULL current
    // `space_id` (no spurious write).
    let result = sqlx::query!(
        "UPDATE blocks SET space_id = ( \
             SELECT p.space_id FROM blocks p WHERE p.id = blocks.page_id \
         ) \
         WHERE block_type != 'page' AND page_id IS NOT NULL \
           AND space_id IS NOT ( \
             SELECT p.space_id FROM blocks p WHERE p.id = blocks.page_id \
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
    // Only inherit when the block HAS a parent. A parentless (top-level)
    // block has no parent to inherit from and owns its `space_id` directly
    // (set by the `space` op / explicit scope); the `parent_id IS NOT NULL`
    // guard stops this incremental path from nulling that authoritative
    // value — the same hazard the `rebuild_space_ids` page-guard avoids.
    sqlx::query!(
        "UPDATE blocks \
         SET space_id = (SELECT b2.space_id FROM blocks b2 WHERE b2.id = blocks.parent_id) \
         WHERE id = ? AND parent_id IS NOT NULL",
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
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        crate::test_support::test_pool().await
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
        // Page (the normal denormalised shape post-).
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

    /// #533 Phase 2 regression: `rebuild_space_ids` must NOT clobber a
    /// top-level tag's own `space_id`. Tags carry `page_id = NULL` and own
    /// their space directly; deriving from a (NULL) page would null it —
    /// irreversible data loss.
    #[tokio::test]
    async fn rebuild_space_ids_preserves_top_level_tag_space_533() {
        let (pool, _dir) = test_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('SPACE01', 'page', 'space', NULL, 1, 'SPACE01')",
        )
        .execute(&pool)
        .await
        .expect("seed space block");
        // #708: register SPACE01 (blocks.space_id REFERENCES spaces(id)).
        sqlx::query("INSERT INTO spaces (id) VALUES ('SPACE01')")
            .execute(&pool)
            .await
            .expect("register space (#708)");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) VALUES \
             ('TAG0001', 'tag',  'proj',  NULL, 2, NULL,      'SPACE01')",
        )
        .execute(&pool)
        .await
        .expect("seed tag with own space_id");

        super::rebuild_space_ids(&pool)
            .await
            .expect("rebuild_space_ids must succeed");

        let tag_space: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'TAG0001'")
                .fetch_one(&pool)
                .await
                .expect("space_id lookup");
        assert_eq!(
            tag_space.as_deref(),
            Some("SPACE01"),
            "a top-level tag's own space_id must survive the rebuild (page_id is NULL)"
        );
    }

    /// #533 Phase 2: `rebuild_space_ids` PROPAGATES the owning page's
    /// authoritative `blocks.space_id` to its descendants. A page's own
    /// `space_id` (column, set by the `space` op) is left untouched;
    /// children inherit it; a child whose page has NULL space_id (or an
    /// orphan) gets NULL.
    #[tokio::test]
    async fn rebuild_space_ids_derives_from_page_space_property_533() {
        let (pool, _dir) = test_pool().await;

        // A page authoritatively in SPACE01 (its own space_id column set),
        // a child whose space_id is stale/NULL, and an orphan-page child.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('SPACE01', 'page', 'space', NULL, 1, 'SPACE01')",
        )
        .execute(&pool)
        .await
        .expect("seed space block");
        // #708: register SPACE01 (blocks.space_id REFERENCES spaces(id)).
        sqlx::query("INSERT INTO spaces (id) VALUES ('SPACE01')")
            .execute(&pool)
            .await
            .expect("register space (#708)");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) VALUES \
             ('PAGE01',  'page',    'p',     NULL,     2, 'PAGE01',  'SPACE01'), \
             ('CHILD01', 'content', 'c',     'PAGE01', 1, 'PAGE01',  NULL), \
             ('PAGE02',  'page',    'q',     NULL,     3, 'PAGE02',  NULL), \
             ('CHILD02', 'content', 'd',     'PAGE02', 1, 'PAGE02',  'SPACE01')",
        )
        .execute(&pool)
        .await
        .expect("seed blocks");

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
            "the page's own authoritative space_id is left untouched"
        );
        assert_eq!(
            space_of("CHILD01").await.as_deref(),
            Some("SPACE01"),
            "a child inherits its page's space_id"
        );
        assert_eq!(
            space_of("CHILD02").await,
            None,
            "a child whose page has NULL space_id is reset to NULL (stale value cleared)"
        );
        assert_eq!(
            space_of("SPACE01").await,
            None,
            "a page with no space stays NULL (pages are not propagated to)"
        );
    }

    /// #533: `set_block_space_id_from_parent` is the O(1) incremental path
    /// used on `create_block` — a fresh child copies its parent's
    /// already-materialized `space_id`.
    #[tokio::test]
    async fn set_block_space_id_from_parent_inherits_space_533() {
        let (pool, _dir) = test_pool().await;

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('SPACE01', 'page', 'space', NULL, 1, 'SPACE01')",
        )
        .execute(&pool)
        .await
        .expect("seed space block");
        // #708: register SPACE01 (blocks.space_id REFERENCES spaces(id)).
        sqlx::query("INSERT INTO spaces (id) VALUES ('SPACE01')")
            .execute(&pool)
            .await
            .expect("register space (#708)");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) VALUES \
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

    /// R27: a merged (sync-composed) tree can legally exceed the depth-100
    /// ancestor-CTE cap. The full rebuild must keep deriving `page_id` for
    /// blocks more than 100 parent-steps below their page (pre-fix they
    /// resolved no page ancestor and were left/reset to NULL — invisible to
    /// every `WHERE page_id = ?` read).
    #[tokio::test]
    async fn rebuild_page_ids_derives_deep_blocks_past_depth_cap() {
        let (pool, _dir) = test_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('DEEPPAGE01', 'page', 'p', NULL, 1, 'DEEPPAGE01')",
        )
        .execute(&pool)
        .await
        .expect("seed page");
        let mut parent = "DEEPPAGE01".to_string();
        for i in 0..120 {
            let id = format!("DEEPCHAIN{i:04}");
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'content', '', ?, 1)",
            )
            .bind(&id)
            .bind(&parent)
            .execute(&pool)
            .await
            .expect("seed chain row");
            parent = id;
        }

        super::rebuild_page_ids(&pool).await.expect("rebuild");

        let unresolved: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE block_type != 'page' AND page_id IS NULL",
        )
        .fetch_one(&pool)
        .await
        .expect("count unresolved");
        assert_eq!(
            unresolved, 0,
            "every block of the 120-deep chain must resolve page_id past the \
             depth-100 CTE cap (iterative extension)"
        );
        let deepest: Option<String> =
            sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'DEEPCHAIN0119'")
                .fetch_one(&pool)
                .await
                .expect("deepest page_id");
        assert_eq!(
            deepest.as_deref(),
            Some("DEEPPAGE01"),
            "the deepest block must resolve to the owning page"
        );
    }

    /// R27 (split variant): the read/write-split rebuild NULL-resets every
    /// `page_id` before re-stamping — it must not destroy a deep block's
    /// previously-correct value (pre-fix, blocks below the depth-100 cap
    /// were reset to NULL and never re-stamped).
    #[tokio::test]
    async fn rebuild_page_ids_split_preserves_deep_blocks_past_depth_cap() {
        let (pool, _dir) = test_pool().await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('DEEPPAGE02', 'page', 'p', NULL, 1, 'DEEPPAGE02')",
        )
        .execute(&pool)
        .await
        .expect("seed page");
        let mut parent = "DEEPPAGE02".to_string();
        for i in 0..120 {
            let id = format!("DEEPSPLIT{i:04}");
            // Seed with the CORRECT page_id already materialized.
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'content', '', ?, 1, 'DEEPPAGE02')",
            )
            .bind(&id)
            .bind(&parent)
            .execute(&pool)
            .await
            .expect("seed chain row");
            parent = id;
        }

        super::rebuild_page_ids_split(&pool, &pool)
            .await
            .expect("split rebuild");

        let deepest: Option<String> =
            sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'DEEPSPLIT0119'")
                .fetch_one(&pool)
                .await
                .expect("deepest page_id");
        assert_eq!(
            deepest.as_deref(),
            Some("DEEPPAGE02"),
            "the split rebuild must not NULL a deep block's previously-correct \
             page_id (iterative extension past the depth-100 cap)"
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

    // ===================================================================
    // #2668 — diff-based rebuilds write ONLY changed rows.
    //
    // `rebuild_page_ids_impl` / `rebuild_space_ids_impl` return the number
    // of `blocks` rows actually written; the assertions below drive that
    // count directly.
    // ===================================================================

    /// Seed a page → parent → child tree with every `page_id` already
    /// correct (as the materializer leaves it).
    async fn seed_correct_tree(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) VALUES \
             ('PG0001', 'page',    'p', NULL,     1, 'PG0001'), \
             ('PARENT', 'content', 'a', 'PG0001', 1, 'PG0001'), \
             ('CHILD1', 'content', 'b', 'PARENT', 1, 'PG0001'), \
             ('CHILD2', 'content', 'c', 'PARENT', 2, 'PG0001')",
        )
        .execute(pool)
        .await
        .expect("seed tree");
    }

    /// #2668: a rebuild over an already-correct `page_id` column writes ZERO
    /// `blocks` rows (the whole point of the diff-based rewrite).
    #[tokio::test]
    async fn rebuild_page_ids_writes_zero_when_unchanged_2668() {
        let (pool, _dir) = test_pool().await;
        seed_correct_tree(&pool).await;

        // Already correct — first pass must find nothing to write.
        let written = super::rebuild_page_ids_impl(&pool).await.expect("rebuild");
        assert_eq!(
            written, 0,
            "an already-correct page_id column must write zero blocks rows (#2668)"
        );
    }

    /// #2668: only the blocks whose `page_id` is stale get written, and the
    /// final state equals a from-scratch recompute.
    #[tokio::test]
    async fn rebuild_page_ids_writes_only_changed_rows_2668() {
        let (pool, _dir) = test_pool().await;
        seed_correct_tree(&pool).await;

        // A second (valid) page so a "wrong" page_id still satisfies the FK.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('PG0002', 'page', 'q', NULL, 9, 'PG0002')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Corrupt two rows: one stale (wrong page) value, one NULL that
        // should resolve.
        sqlx::query("UPDATE blocks SET page_id = 'PG0002' WHERE id = 'CHILD1'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE blocks SET page_id = NULL WHERE id = 'CHILD2'")
            .execute(&pool)
            .await
            .unwrap();

        let written = super::rebuild_page_ids_impl(&pool).await.expect("rebuild");
        assert_eq!(
            written, 2,
            "exactly the two corrupted blocks must be written (#2668)"
        );

        // Final state correct + byte-identical to a fresh recompute.
        for id in ["CHILD1", "CHILD2"] {
            let pid: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(
                pid.as_deref(),
                Some("PG0001"),
                "{id} must resolve to PG0001"
            );
        }
        // Idempotent: a follow-up rebuild writes nothing.
        let again = super::rebuild_page_ids_impl(&pool).await.expect("rebuild2");
        assert_eq!(again, 0, "second rebuild must be a no-op (#2668)");
    }

    /// #2668: a stale non-NULL value on an orphaned block (no page ancestor)
    /// is NULLed — but only that row, and only because it changed.
    #[tokio::test]
    async fn rebuild_page_ids_nulls_only_stale_orphans_2668() {
        let (pool, _dir) = test_pool().await;
        seed_correct_tree(&pool).await;
        // A top-level tag block carrying a stale page_id (should be NULL).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES ('TAG001', 'tag', 't', NULL, 5, 'PG0001')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let written = super::rebuild_page_ids_impl(&pool).await.expect("rebuild");
        assert_eq!(written, 1, "only the stale orphan is NULLed (#2668)");
        let pid: Option<String> =
            sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'TAG001'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pid, None,
            "orphan tag's stale page_id must be reset to NULL"
        );
    }

    /// #2668 (split variant): unchanged vault writes zero rows.
    #[tokio::test]
    async fn rebuild_page_ids_split_writes_zero_when_unchanged_2668() {
        let (pool, _dir) = test_pool().await;
        seed_correct_tree(&pool).await;
        let written = super::rebuild_page_ids_split_impl(&pool, &pool)
            .await
            .expect("split rebuild");
        assert_eq!(
            written, 0,
            "split rebuild over a correct column must write zero rows (#2668)"
        );
    }

    /// #2668: `rebuild_space_ids` writes zero rows when every `space_id` is
    /// already correct, and only the changed rows otherwise.
    #[tokio::test]
    async fn rebuild_space_ids_writes_only_changed_rows_2668() {
        let (pool, _dir) = test_pool().await;
        // `spaces.id` REFERENCES `blocks(id)` and `blocks.space_id`
        // REFERENCES `spaces(id)` — a chicken-and-egg cycle. Insert the
        // space block first (no space_id), register the space, THEN attach
        // space_id to every block.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) VALUES \
             ('SP0001', 'page',    'p', NULL,     1, 'SP0001'), \
             ('KID001', 'content', 'a', 'SP0001', 1, 'SP0001'), \
             ('KID002', 'content', 'b', 'SP0001', 2, 'SP0001')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO spaces (id) VALUES ('SP0001')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE blocks SET space_id = 'SP0001' WHERE id IN ('SP0001','KID001','KID002')",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Already correct → zero writes.
        let first = super::rebuild_space_ids_impl(&pool)
            .await
            .expect("space rebuild");
        assert_eq!(
            first, 0,
            "an already-correct space_id column must write zero rows (#2668)"
        );

        // Corrupt one child's space_id → exactly one write.
        sqlx::query("UPDATE blocks SET space_id = NULL WHERE id = 'KID002'")
            .execute(&pool)
            .await
            .unwrap();
        let second = super::rebuild_space_ids_impl(&pool)
            .await
            .expect("space rebuild2");
        assert_eq!(second, 1, "only the corrupted child is rewritten (#2668)");
        let sp: Option<String> =
            sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = 'KID002'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            sp.as_deref(),
            Some("SP0001"),
            "KID002 must re-derive SP0001"
        );
    }
}
