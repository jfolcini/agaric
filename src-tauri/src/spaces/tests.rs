//! Tests for the spaces bootstrap.
//!
//! Every test spins up a fresh SQLite pool via `test_pool()` so there is
//! no cross-test state.

use std::path::PathBuf;
use std::str::FromStr;

use sqlx::SqlitePool;
use tempfile::TempDir;

use super::bootstrap::{bootstrap_spaces, SPACE_PERSONAL_ULID, SPACE_WORK_ULID};
use crate::db::init_pool;
use crate::ulid::BlockId;

const DEV: &str = "test-device";

/// Create a temp-file-backed SQLite pool with migrations applied.
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Insert a page block directly (bypasses the command layer). Used to
/// simulate pre-existing content when exercising the upgrade path.
async fn insert_page(pool: &SqlitePool, id: &str, content: &str) {
    sqlx::query!(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict) \
         VALUES (?, 'page', ?, NULL, 1, ?, 0)",
        id,
        content,
        id,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Insert a soft-deleted page block.
async fn insert_deleted_page(pool: &SqlitePool, id: &str, content: &str) {
    sqlx::query!(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict, deleted_at) \
         VALUES (?, 'page', ?, NULL, 1, ?, 0, '2025-01-01T00:00:00Z')",
        id,
        content,
        id,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Insert a conflict-copy page block.
async fn insert_conflict_page(pool: &SqlitePool, id: &str, content: &str) {
    sqlx::query!(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict) \
         VALUES (?, 'page', ?, NULL, 1, ?, 1)",
        id,
        content,
        id,
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn count_space_blocks(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "n!: i64" FROM blocks b
           WHERE b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn count_rows(pool: &SqlitePool, table: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {}", table);
    sqlx::query_scalar::<_, i64>(&sql)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn space_property(pool: &SqlitePool, block_id: &str) -> Option<String> {
    sqlx::query_scalar!(
        r#"SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'space'"#,
        block_id,
    )
    .fetch_optional(pool)
    .await
    .unwrap()
    .flatten()
}

#[test]
fn seeded_ulids_parse_as_valid_ulids() {
    let personal = BlockId::from_string(SPACE_PERSONAL_ULID);
    assert!(
        personal.is_ok(),
        "SPACE_PERSONAL_ULID must parse as a valid ULID"
    );
    let work = BlockId::from_string(SPACE_WORK_ULID);
    assert!(work.is_ok(), "SPACE_WORK_ULID must parse as a valid ULID");

    // Also exercise the low-level `ulid::Ulid` parser directly so a
    // future typo in a Crockford-banned char (`I`/`L`/`O`/`U`) is caught
    // before the BlockId wrapper swallows it.
    ulid::Ulid::from_str(SPACE_PERSONAL_ULID).expect("Personal ULID parses via ulid crate");
    ulid::Ulid::from_str(SPACE_WORK_ULID).expect("Work ULID parses via ulid crate");
}

#[test]
fn seeded_ulids_are_distinct() {
    assert_ne!(
        SPACE_PERSONAL_ULID, SPACE_WORK_ULID,
        "Personal and Work ULIDs must not collide"
    );
}

#[tokio::test]
async fn bootstrap_on_fresh_db_creates_two_spaces_and_no_other_state() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    assert_eq!(
        count_space_blocks(&pool).await,
        2,
        "fresh boot must create exactly two space blocks"
    );

    // No pre-existing pages, so no `space` property rows should exist.
    let space_prop_count: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "n!: i64" FROM block_properties WHERE key = 'space'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        space_prop_count, 0,
        "no pre-existing pages means no `space` property rows"
    );

    // Op log must contain exactly two CreateBlock + two SetProperty ops.
    let create_ops: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "n!: i64" FROM op_log WHERE op_type = 'create_block'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        create_ops, 2,
        "exactly 2 CreateBlock ops on fresh bootstrap"
    );

    let set_prop_ops: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "n!: i64" FROM op_log WHERE op_type = 'set_property'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        set_prop_ops, 2,
        "exactly 2 SetProperty ops (is_space on Personal + Work) on fresh bootstrap"
    );
}

#[tokio::test]
async fn bootstrap_on_fresh_db_with_existing_pages_assigns_all_to_personal() {
    let (pool, _dir) = test_pool().await;

    // Three pre-existing pages that predate the spaces feature.
    insert_page(&pool, "01JABCD0000000000000000001", "Notes").await;
    insert_page(&pool, "01JABCD0000000000000000002", "Journal").await;
    insert_page(&pool, "01JABCD0000000000000000003", "Ideas").await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    assert_eq!(
        count_space_blocks(&pool).await,
        2,
        "two space blocks after bootstrap"
    );

    for pid in [
        "01JABCD0000000000000000001",
        "01JABCD0000000000000000002",
        "01JABCD0000000000000000003",
    ] {
        let space_ref = space_property(&pool, pid).await;
        assert_eq!(
            space_ref.as_deref(),
            Some(SPACE_PERSONAL_ULID),
            "page {pid} must be assigned to the Personal space"
        );
    }

    // The two seeded space blocks themselves must NOT have been migrated
    // into Personal — they are spaces, not members of one.
    for space_id in [SPACE_PERSONAL_ULID, SPACE_WORK_ULID] {
        assert!(
            space_property(&pool, space_id).await.is_none(),
            "space block {space_id} must not carry its own `space` property"
        );
    }
}

#[tokio::test]
async fn bootstrap_is_idempotent() {
    let (pool, _dir) = test_pool().await;

    insert_page(&pool, "01JABCD0000000000000000001", "Notes").await;
    insert_page(&pool, "01JABCD0000000000000000002", "Journal").await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    let blocks_before = count_rows(&pool, "blocks").await;
    let props_before = count_rows(&pool, "block_properties").await;
    let ops_before = count_rows(&pool, "op_log").await;

    // Second run must be a pure no-op via the fast-path check.
    bootstrap_spaces(&pool, DEV).await.unwrap();

    let blocks_after = count_rows(&pool, "blocks").await;
    let props_after = count_rows(&pool, "block_properties").await;
    let ops_after = count_rows(&pool, "op_log").await;

    assert_eq!(
        blocks_before, blocks_after,
        "idempotent bootstrap must not change blocks row count"
    );
    assert_eq!(
        props_before, props_after,
        "idempotent bootstrap must not change block_properties row count"
    );
    assert_eq!(
        ops_before, ops_after,
        "idempotent bootstrap must not append any new ops"
    );
}

#[tokio::test]
async fn bootstrap_skips_pages_that_already_have_space_property() {
    let (pool, _dir) = test_pool().await;

    // Pre-seed the Work space block (but not the is_space marker) so the
    // `value_ref` FK on block_properties can reference it. Simulates a
    // mid-state where a peer synced the space block ahead of the
    // `is_space` property, then the local device's bootstrap fires.
    sqlx::query!(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict) \
         VALUES (?, 'page', 'Work', NULL, 1, ?, 0)",
        SPACE_WORK_ULID,
        SPACE_WORK_ULID,
    )
    .execute(&pool)
    .await
    .unwrap();

    insert_page(&pool, "01JABCD0000000000000000001", "Already Scoped").await;
    // Simulate a page that was previously assigned to the Work space
    // (e.g. via a sync from another device that ran bootstrap first).
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        "01JABCD0000000000000000001",
        SPACE_WORK_ULID,
    )
    .execute(&pool)
    .await
    .unwrap();

    insert_page(&pool, "01JABCD0000000000000000002", "Unscoped").await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    assert_eq!(
        space_property(&pool, "01JABCD0000000000000000001")
            .await
            .as_deref(),
        Some(SPACE_WORK_ULID),
        "existing `space` property must not be overwritten"
    );
    assert_eq!(
        space_property(&pool, "01JABCD0000000000000000002")
            .await
            .as_deref(),
        Some(SPACE_PERSONAL_ULID),
        "unscoped page must be migrated to Personal"
    );
}

#[tokio::test]
async fn bootstrap_skips_space_blocks_themselves() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    // Bootstrap must never assign the space blocks to themselves — they
    // carry `is_space = "true"`, not `space = <self>`.
    for space_id in [SPACE_PERSONAL_ULID, SPACE_WORK_ULID] {
        assert!(
            space_property(&pool, space_id).await.is_none(),
            "space block {space_id} must not be assigned a `space` property"
        );
    }
}

#[tokio::test]
async fn bootstrap_skips_deleted_and_conflict_pages() {
    let (pool, _dir) = test_pool().await;

    insert_page(&pool, "01JABCD0000000000000000001", "Live").await;
    insert_deleted_page(&pool, "01JABCD0000000000000000002", "Deleted").await;
    insert_conflict_page(&pool, "01JABCD0000000000000000003", "Conflict").await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    assert_eq!(
        space_property(&pool, "01JABCD0000000000000000001")
            .await
            .as_deref(),
        Some(SPACE_PERSONAL_ULID),
        "live page must be migrated"
    );
    assert!(
        space_property(&pool, "01JABCD0000000000000000002")
            .await
            .is_none(),
        "soft-deleted page must not be migrated"
    );
    assert!(
        space_property(&pool, "01JABCD0000000000000000003")
            .await
            .is_none(),
        "conflict copy must not be migrated"
    );
}

#[tokio::test]
async fn bootstrap_resumes_after_partial_state() {
    let (pool, _dir) = test_pool().await;

    insert_page(&pool, "01JABCD0000000000000000001", "Existing").await;

    // Simulate a crashed prior bootstrap that created Personal but not
    // Work. The function must finish the job on the next call.
    sqlx::query!(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict) \
         VALUES (?, 'page', 'Personal', NULL, 1, ?, 0)",
        SPACE_PERSONAL_ULID,
        SPACE_PERSONAL_ULID,
    )
    .execute(&pool)
    .await
    .unwrap();

    bootstrap_spaces(&pool, DEV).await.unwrap();

    assert_eq!(
        count_space_blocks(&pool).await,
        2,
        "both space blocks must be present after partial-state resume"
    );
    assert_eq!(
        space_property(&pool, "01JABCD0000000000000000001")
            .await
            .as_deref(),
        Some(SPACE_PERSONAL_ULID),
        "existing page must be migrated"
    );
}
