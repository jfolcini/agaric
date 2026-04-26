//! Tests for the spaces bootstrap.
//!
//! Every test spins up a fresh SQLite pool via `test_pool()` so there is
//! no cross-test state.

use std::path::PathBuf;
use std::str::FromStr;

use sqlx::SqlitePool;
use tempfile::TempDir;

use super::bootstrap::{
    bootstrap_spaces, migrate_personal_pages_to_work, MIGRATION_THRESHOLD_ULID,
    SPACE_PERSONAL_ULID, SPACE_WORK_ULID,
};
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

#[test]
fn seeded_ulids_validate_via_bootstrap_constructor() {
    // L-126 regression: `bootstrap_spaces` now validates the seeded ULID
    // constants via `BlockId::from_string` (instead of the no-validation
    // `BlockId::from_trusted` shortcut). This test reproduces the exact
    // call path from `bootstrap.rs::ensure_space_block` so a future typo
    // (Crockford-banned `I`/`L`/`O`/`U`, or wrong length) will fail here
    // before it reaches the seeded migration on a real device.
    let personal = BlockId::from_string(SPACE_PERSONAL_ULID)
        .expect("SPACE_PERSONAL_ULID must validate via BlockId::from_string");
    assert_eq!(
        personal.as_str(),
        SPACE_PERSONAL_ULID,
        "round-trip through from_string must preserve the canonical form"
    );
    let work = BlockId::from_string(SPACE_WORK_ULID)
        .expect("SPACE_WORK_ULID must validate via BlockId::from_string");
    assert_eq!(
        work.as_str(),
        SPACE_WORK_ULID,
        "round-trip through from_string must preserve the canonical form"
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

// ---------------------------------------------------------------------
// MAINT-1 — One-shot migration: move existing Personal pages → Work.
// ---------------------------------------------------------------------

/// Pre-threshold page ULID. `01JABCD…` < `01KQ5WWYR…` because `J` < `K`
/// in Crockford-base32. Used to model the maintainer's pre-existing
/// vault content.
const PRE_THRESHOLD_PAGE_1: &str = "01JABCD0000000000000000001";
const PRE_THRESHOLD_PAGE_2: &str = "01JABCD0000000000000000002";
const PRE_THRESHOLD_PAGE_3: &str = "01JABCD0000000000000000003";

/// Post-threshold page ULID. `01KZZZ…` > `01KQ5WWYR…` because `Z` > `Q`
/// in Crockford-base32. Used to model fresh-install pages created
/// AFTER the migration shipped — these must NOT be moved.
const POST_THRESHOLD_PAGE: &str = "01KZZZZZZZ0000000000000001";

#[test]
fn migration_threshold_ulid_parses_as_valid_ulid() {
    let parsed = BlockId::from_string(MIGRATION_THRESHOLD_ULID);
    assert!(
        parsed.is_ok(),
        "MIGRATION_THRESHOLD_ULID must parse as a valid ULID"
    );
    // Round-trip through the low-level ulid crate so a Crockford-banned
    // char (`I`/`L`/`O`/`U`) typo would be caught here.
    ulid::Ulid::from_str(MIGRATION_THRESHOLD_ULID)
        .expect("MIGRATION_THRESHOLD_ULID parses via ulid crate");
    assert_eq!(
        MIGRATION_THRESHOLD_ULID.len(),
        26,
        "ULID strings are exactly 26 Crockford-base32 chars"
    );

    // Compare against the pre/post-threshold fixtures used by the rest
    // of the MAINT-1 tests so a future bump of the threshold (without
    // updating the fixtures) trips the assertion before the tests
    // silently start passing for the wrong reason.
    assert!(
        PRE_THRESHOLD_PAGE_1 < MIGRATION_THRESHOLD_ULID,
        "PRE_THRESHOLD_PAGE_1 must be lexicographically before threshold"
    );
    assert!(
        POST_THRESHOLD_PAGE > MIGRATION_THRESHOLD_ULID,
        "POST_THRESHOLD_PAGE must be lexicographically after threshold"
    );
}

/// Set `space = SPACE_PERSONAL_ULID` on a page directly in the DB to
/// simulate the post-`bootstrap_spaces` state where every old page has
/// been backfilled into Personal.
async fn assign_to_personal(pool: &SqlitePool, page_id: &str) {
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        page_id,
        SPACE_PERSONAL_ULID,
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Count rows in `op_log` whose `op_type = 'set_property'` AND whose
/// payload key matches the supplied filter. Used to verify exactly N
/// `space` rebind ops were emitted by the migration.
async fn count_set_property_ops_for_key(pool: &SqlitePool, key: &str) -> i64 {
    let pattern = format!("%\"key\":\"{}\"%", key);
    sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM op_log
           WHERE op_type = 'set_property'
             AND payload LIKE ?"#,
    )
    .bind(pattern)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Read the `personal_to_work_migration_v1` marker on the Personal
/// space block. `Some("true")` once the migration has committed.
async fn migration_marker_value(pool: &SqlitePool) -> Option<String> {
    sqlx::query_scalar!(
        r#"SELECT value_text FROM block_properties
           WHERE block_id = ?
             AND key = 'personal_to_work_migration_v1'"#,
        SPACE_PERSONAL_ULID,
    )
    .fetch_optional(pool)
    .await
    .unwrap()
    .flatten()
}

/// Scenario 1: existing vault, first boot after migration ships.
/// Every pre-threshold Personal page is rebound to Work and the
/// idempotency marker is set.
#[tokio::test]
async fn migrate_existing_vault_first_boot_moves_all_pre_threshold_pages_to_work() {
    let (pool, _dir) = test_pool().await;

    // Seed the Personal + Work space blocks (and seeds every pre-existing
    // page into Personal).
    bootstrap_spaces(&pool, DEV).await.unwrap();

    // Three pre-existing pages — bootstrap already gave them
    // `space = Personal` since they were inserted before bootstrap ran;
    // simulate that ordering by inserting AFTER bootstrap and assigning
    // explicitly.
    insert_page(&pool, PRE_THRESHOLD_PAGE_1, "Notes").await;
    insert_page(&pool, PRE_THRESHOLD_PAGE_2, "Journal").await;
    insert_page(&pool, PRE_THRESHOLD_PAGE_3, "Ideas").await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_1).await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_2).await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_3).await;

    let space_ops_before = count_set_property_ops_for_key(&pool, "space").await;

    migrate_personal_pages_to_work(&pool, DEV).await.unwrap();

    for pid in [
        PRE_THRESHOLD_PAGE_1,
        PRE_THRESHOLD_PAGE_2,
        PRE_THRESHOLD_PAGE_3,
    ] {
        assert_eq!(
            space_property(&pool, pid).await.as_deref(),
            Some(SPACE_WORK_ULID),
            "page {pid} must have been rebound to Work"
        );
    }

    assert_eq!(
        migration_marker_value(&pool).await.as_deref(),
        Some("true"),
        "personal_to_work_migration_v1 marker must be set after first run"
    );

    let space_ops_after = count_set_property_ops_for_key(&pool, "space").await;
    assert_eq!(
        space_ops_after - space_ops_before,
        3,
        "exactly three SetProperty(space) ops must be emitted (one per page)"
    );

    let marker_ops = count_set_property_ops_for_key(&pool, "personal_to_work_migration_v1").await;
    assert_eq!(
        marker_ops, 1,
        "exactly one SetProperty op must persist the migration marker"
    );
}

/// Scenario 2: existing vault, second boot. Marker fast-path makes the
/// run a pure no-op.
#[tokio::test]
async fn migrate_existing_vault_second_boot_is_noop() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();
    insert_page(&pool, PRE_THRESHOLD_PAGE_1, "Notes").await;
    insert_page(&pool, PRE_THRESHOLD_PAGE_2, "Journal").await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_1).await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_2).await;

    migrate_personal_pages_to_work(&pool, DEV).await.unwrap();

    let blocks_before = count_rows(&pool, "blocks").await;
    let props_before = count_rows(&pool, "block_properties").await;
    let ops_before = count_rows(&pool, "op_log").await;

    // Second run: marker is set, must short-circuit before any writes.
    migrate_personal_pages_to_work(&pool, DEV).await.unwrap();

    assert_eq!(
        count_rows(&pool, "blocks").await,
        blocks_before,
        "second migration run must not change blocks row count"
    );
    assert_eq!(
        count_rows(&pool, "block_properties").await,
        props_before,
        "second migration run must not change block_properties row count"
    );
    assert_eq!(
        count_rows(&pool, "op_log").await,
        ops_before,
        "second migration run must not append any new ops"
    );
}

/// Scenario 3: fresh install of the published app. No user pages
/// exist, so the migration loops over zero pages and only sets the
/// marker.
#[tokio::test]
async fn migrate_on_fresh_install_emits_only_the_marker_op() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    let space_ops_before = count_set_property_ops_for_key(&pool, "space").await;

    migrate_personal_pages_to_work(&pool, DEV).await.unwrap();

    let space_ops_after = count_set_property_ops_for_key(&pool, "space").await;
    assert_eq!(
        space_ops_after - space_ops_before,
        0,
        "fresh install: no candidate pages → no `space` rebind ops"
    );

    assert_eq!(
        migration_marker_value(&pool).await.as_deref(),
        Some("true"),
        "marker is set even on a fresh install (so the next boot fast-paths)"
    );

    let marker_ops = count_set_property_ops_for_key(&pool, "personal_to_work_migration_v1").await;
    assert_eq!(
        marker_ops, 1,
        "exactly one SetProperty op for the marker on fresh install"
    );
}

/// Scenario 4: time-gate. A modern (post-threshold) page assigned to
/// Personal must STAY in Personal — the threshold guard protects fresh
/// installs whose pages were created after the migration shipped.
#[tokio::test]
async fn migrate_skips_post_threshold_pages_in_personal() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    // A post-threshold page (e.g. created on a fresh install AFTER
    // this migration shipped) explicitly assigned to Personal.
    insert_page(&pool, POST_THRESHOLD_PAGE, "Modern Page").await;
    assign_to_personal(&pool, POST_THRESHOLD_PAGE).await;

    // A pre-threshold page in Personal — the regular case.
    insert_page(&pool, PRE_THRESHOLD_PAGE_1, "Old Page").await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_1).await;

    migrate_personal_pages_to_work(&pool, DEV).await.unwrap();

    assert_eq!(
        space_property(&pool, POST_THRESHOLD_PAGE).await.as_deref(),
        Some(SPACE_PERSONAL_ULID),
        "post-threshold page must NOT be moved (time-gate guard)"
    );
    assert_eq!(
        space_property(&pool, PRE_THRESHOLD_PAGE_1).await.as_deref(),
        Some(SPACE_WORK_ULID),
        "pre-threshold page must be moved as the control case"
    );
}

/// Scenario 5: skip space blocks. A user-created space block (carrying
/// `is_space = "true"` AND `space = Personal`) must NOT be moved by
/// the migration even though it satisfies the time-gate and
/// space-equals-Personal predicates.
#[tokio::test]
async fn migrate_skips_user_created_space_blocks() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    // A pre-threshold ULID for a hypothetical user-created space.
    let user_space_id = "01JUSER0000000000000000000A";
    insert_page(&pool, user_space_id, "My Space").await;
    // Mark it as a space.
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
        user_space_id,
    )
    .execute(&pool)
    .await
    .unwrap();
    // And, for argument's sake, also assign it to Personal (mirrors the
    // pathological state the spec's "Skip space blocks" guard defends
    // against).
    sqlx::query!(
        "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        user_space_id,
        SPACE_PERSONAL_ULID,
    )
    .execute(&pool)
    .await
    .unwrap();

    // Plus a regular page so the run actually emits ops (sanity check
    // that the loop body fires for non-space rows).
    insert_page(&pool, PRE_THRESHOLD_PAGE_1, "Regular").await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_1).await;

    migrate_personal_pages_to_work(&pool, DEV).await.unwrap();

    assert_eq!(
        space_property(&pool, user_space_id).await.as_deref(),
        Some(SPACE_PERSONAL_ULID),
        "user-created space block must NOT be moved (is_space exclusion)"
    );
    assert_eq!(
        space_property(&pool, PRE_THRESHOLD_PAGE_1).await.as_deref(),
        Some(SPACE_WORK_ULID),
        "regular pre-threshold page is moved as the control case"
    );
}

/// Scenario 6: idempotency under concurrent boot. Two tasks both call
/// `migrate_personal_pages_to_work` simultaneously on the same pool;
/// `BEGIN IMMEDIATE` serialises them and the loser observes the
/// committed marker and becomes a no-op. The total set of `space`
/// rebind ops in op_log MUST equal exactly N (the number of candidate
/// pages) — never 2N.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn migrate_concurrent_runs_emit_each_op_exactly_once() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    insert_page(&pool, PRE_THRESHOLD_PAGE_1, "A").await;
    insert_page(&pool, PRE_THRESHOLD_PAGE_2, "B").await;
    insert_page(&pool, PRE_THRESHOLD_PAGE_3, "C").await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_1).await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_2).await;
    assign_to_personal(&pool, PRE_THRESHOLD_PAGE_3).await;

    let space_ops_before = count_set_property_ops_for_key(&pool, "space").await;

    let pool_a = pool.clone();
    let pool_b = pool.clone();
    let task_a = tokio::spawn(async move { migrate_personal_pages_to_work(&pool_a, DEV).await });
    let task_b = tokio::spawn(async move { migrate_personal_pages_to_work(&pool_b, DEV).await });

    // Both tasks must succeed; the BEGIN IMMEDIATE serialises them so
    // the loser's marker re-check inside the tx finds the marker
    // already set and rolls back to a no-op.
    task_a.await.unwrap().unwrap();
    task_b.await.unwrap().unwrap();

    for pid in [
        PRE_THRESHOLD_PAGE_1,
        PRE_THRESHOLD_PAGE_2,
        PRE_THRESHOLD_PAGE_3,
    ] {
        assert_eq!(
            space_property(&pool, pid).await.as_deref(),
            Some(SPACE_WORK_ULID),
            "page {pid} must be in Work after concurrent migration"
        );
    }

    let space_ops_after = count_set_property_ops_for_key(&pool, "space").await;
    assert_eq!(
        space_ops_after - space_ops_before,
        3,
        "BEGIN IMMEDIATE must serialise the two runs so each page is rebound exactly once"
    );

    assert_eq!(
        migration_marker_value(&pool).await.as_deref(),
        Some("true"),
        "marker is set after concurrent run completes"
    );
    let marker_ops = count_set_property_ops_for_key(&pool, "personal_to_work_migration_v1").await;
    assert_eq!(
        marker_ops, 1,
        "marker op is emitted exactly once even under concurrent boot"
    );
}
