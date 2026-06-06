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

/// Assign a block to [`TEST_SPACE_ID`] by writing the materialised
/// `block_properties(key='space', value_ref=TEST_SPACE_ID)` row directly.
/// Bypasses `set_property_in_tx` intentionally — the FEAT-3 Phase 7 query
/// layer reads `block_properties` regardless of how the row got there.
pub async fn assign_to_test_space(pool: &SqlitePool, block_id: &str) {
    ensure_test_space(pool).await;
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)")
        .bind(block_id)
        .bind(TEST_SPACE_ID)
        .execute(pool)
        .await
        .unwrap();
    // #533: mirror the denormalized `blocks.space_id` column the way the
    // materializer would — every block whose owning page is `block_id`
    // (the page carries `page_id = id`, so the page itself is included)
    // belongs to this space. Equivalent to the old `b.page_id IN (...)`
    // filter the column replaced.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
        .bind(TEST_SPACE_ID)
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
/// `block_properties.value_ref → blocks(id)` is satisfied.
pub async fn assign_to_space(pool: &SqlitePool, block_id: &str, space_id: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)")
        .bind(block_id)
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
    // #533: keep the denormalized `blocks.space_id` column in step (see
    // `assign_to_test_space`).
    sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
        .bind(space_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

/// FEAT-3p4 — bulk-assign every block currently in the DB (excluding the
/// space block itself and any block that already carries a `space`
/// property) to [`TEST_SPACE_ID`]. Use this at the end of a test's seed
/// phase so the FEAT-3p4 hard-filter paths (`list_blocks_inner`,
/// `search_blocks_inner`) return everything the test set up. Idempotent —
/// the `NOT EXISTS` guard skips blocks that are already assigned to any
/// space (so cross-space tests that explicitly assign some blocks to
/// `TEST_SPACE_B_ID` still work).
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
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_ref) \
         SELECT b.id, 'space', ? FROM blocks b \
         WHERE b.id <> ? \
           AND NOT EXISTS ( \
                SELECT 1 FROM block_properties bp \
                WHERE bp.block_id = b.id AND bp.key = 'space' \
           )",
    )
    .bind(TEST_SPACE_ID)
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    // #533: derive the denormalized `blocks.space_id` column from the
    // freshly seeded `space` properties — identical to `rebuild_space_ids`
    // / migration 0086. Runs last so it observes every block's `page_id`
    // (stamped above) and every `space` property (incl. cross-space
    // pre-assignments preserved by the NOT EXISTS guard).
    sqlx::query(
        "UPDATE blocks SET space_id = ( \
             SELECT bp.value_ref FROM block_properties bp \
             WHERE bp.key = 'space' AND bp.block_id = blocks.page_id \
         )",
    )
    .execute(pool)
    .await
    .unwrap();
}
