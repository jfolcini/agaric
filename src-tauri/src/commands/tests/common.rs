// Shared test helpers for command tests
pub use crate::db::ReadPool;
use crate::db::init_pool;
use crate::materializer::Materializer;
pub use crate::space::{SpaceId, SpaceScope};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

// -- Deterministic test fixtures --

pub const DEV: &str = "test-device-001";
pub const FIXED_TS: i64 = 1_735_689_600_000; // 2025-01-01T00:00:00Z

/// Synthetic space ULID for tests that need to satisfy the FEAT-3 Phase 7
/// space-scoped query path (e.g. `batch_resolve_inner`, `get_page_inner`)
/// without going through the full `bootstrap_spaces` flow. Tests that care
/// about real Personal/Work semantics should use the constants in
/// `crate::spaces` instead.
pub const TEST_SPACE_ID: &str = "01TESTSPACE000000000000001";

/// Second synthetic space ULID for FEAT-3p4 cross-space tests that need
/// two distinct spaces in the same fixture (e.g. asserting a query
/// scoped to space A excludes blocks in space B).
pub const TEST_SPACE_B_ID: &str = "01TESTSPACE000000000000002";

// -- Helpers --

/// Wait for background materializer tasks to finish so assertions see
/// fully-consistent state.
pub async fn settle(mat: &Materializer) {
    mat.flush_background().await.unwrap();
}

/// Creates a temporary SQLite database with all migrations applied.
pub async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Insert a block directly into the blocks table (bypasses command layer).
///
/// SQL-review §5.3 — stamps `page_id` per the post-migration-0066
/// invariant: pages → self, non-pages → parent or self. Matches the
/// production `create_block_in_tx` cascade.
pub async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
) {
    let page_id: Option<String> = if block_type == "page" {
        Some(id.to_string())
    } else {
        Some(parent_id.unwrap_or(id).to_string())
    };
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Insert the synthetic [`TEST_SPACE_ID`] block (idempotent). The
/// `block_properties.value_ref → blocks(id)` FK requires this row to
/// exist before any `assign_to_test_space` call lands. Tests that need
/// the full Personal/Work seed should call `bootstrap_spaces` instead.
pub async fn ensure_test_space(pool: &SqlitePool) {
    // SQL-review §5.3 — stamp `page_id = id` to match the
    // post-migration-0066 invariant.
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'TestSpace', NULL, NULL, ?)",
    )
    .bind(TEST_SPACE_ID)
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
}

/// PEND-35 — stamp `is_space = 'true'` on `space_id` so the block
/// satisfies `import_markdown_inner` / `create_page_in_space_inner`'s
/// upfront space-validity check (which requires the target to carry
/// `is_space = 'true'`). Idempotent (`INSERT OR IGNORE`). Caller must
/// have seeded the underlying block via `ensure_test_space` /
/// `ensure_test_space_b` first.
pub async fn mark_block_as_space(pool: &SqlitePool, space_id: &str) {
    sqlx::query(
        "INSERT OR IGNORE INTO block_properties (block_id, key, value_text) \
         VALUES (?, 'is_space', 'true')",
    )
    .bind(space_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Assign a block to [`TEST_SPACE_ID`] by stamping the denormalized
/// `blocks.space_id` column directly. Bypasses `set_property_in_tx`
/// intentionally — the query layer reads `blocks.space_id` regardless of
/// how it got set.
pub async fn assign_to_test_space(pool: &SqlitePool, block_id: &str) {
    ensure_test_space(pool).await;
    // #533: stamp the denormalized `blocks.space_id` column the way the
    // materializer would. Space membership covers the block itself
    // (`id = ?`, e.g. a top-level content block whose `page_id` is NULL)
    // AND every block whose owning page is `block_id` (`page_id = ?`,
    // covering a page's descendants; a page carries `page_id = id` so it
    // is included by either arm). Matches the `id = ? OR page_id = ?`
    // grouping `set_property_in_tx`/`project_set_property_to_sql` use.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(TEST_SPACE_ID)
        .bind(block_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

/// FEAT-3p4 — variant of [`ensure_test_space`] that seeds the
/// [`TEST_SPACE_B_ID`] block. Idempotent. Used by cross-space tests
/// that need two distinct spaces in the same fixture.
pub async fn ensure_test_space_b(pool: &SqlitePool) {
    // SQL-review §5.3 — see `ensure_test_space`.
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'TestSpaceB', NULL, NULL, ?)",
    )
    .bind(TEST_SPACE_B_ID)
    .bind(TEST_SPACE_B_ID)
    .execute(pool)
    .await
    .unwrap();
}

/// FEAT-3p4 — assign `block_id` to an arbitrary space ULID. Used by
/// cross-space tests so the same helper drives both the A and B
/// branches. Caller must seed the space block separately
/// (`ensure_test_space` / `ensure_test_space_b`) so the FK on
/// `blocks.space_id → blocks(id)` is satisfied.
pub async fn assign_to_space(pool: &SqlitePool, block_id: &str, space_id: &str) {
    // #533: stamp the denormalized `blocks.space_id` column (see
    // `assign_to_test_space`) — cover the block itself AND its page
    // descendants via the `id = ? OR page_id = ?` grouping.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(space_id)
        .bind(block_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

/// FEAT-3p4 — bulk-assign every block currently in the DB (excluding the
/// space block itself and any block already in a space) to
/// [`TEST_SPACE_ID`]. Use this at the end of a test's seed phase so the
/// FEAT-3p4 hard-filter paths (`list_blocks_inner`, `search_blocks_inner`)
/// return everything the test set up.
///
/// Phase 2 (#533): space membership is the `blocks.space_id` column (the
/// sole source of truth; the `block_properties(key='space')` row was
/// retired in migration 0087). Idempotent — the `space_id IS NULL` guard
/// skips blocks already assigned to ANY space, so blocks stamped via the
/// command path (`set_property_in_tx`) OR explicitly placed in
/// `TEST_SPACE_B_ID` by cross-space tests keep their space.
pub async fn assign_all_to_test_space(pool: &SqlitePool) {
    ensure_test_space(pool).await;
    // SQL-review §5.3 — first stamp `page_id = id` on every block that
    // still has NULL page_id (e.g. top-level non-page blocks created
    // via `create_block_inner`, which leaves `page_id = NULL` for
    // `block_type != 'page'`). The post-migration `b.page_id IN (...)`
    // filter needs a non-NULL page_id; pre-§5.3 the COALESCE fallback
    // resolved to `b.id` implicitly.
    sqlx::query("UPDATE blocks SET page_id = id WHERE page_id IS NULL")
        .execute(pool)
        .await
        .unwrap();
    // #533: stamp the `blocks.space_id` column directly. Only blocks with
    // a NULL `space_id` are touched, so any block already in a space
    // (command-path creates, cross-space pre-assignments) is preserved.
    sqlx::query(
        "UPDATE blocks SET space_id = ? \
         WHERE space_id IS NULL AND id <> ?",
    )
    .bind(TEST_SPACE_ID)
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
}
