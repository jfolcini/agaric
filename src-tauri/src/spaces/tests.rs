//! Tests for the spaces bootstrap.
//!
//! Every test spins up a fresh SQLite pool via `test_pool()` so there is
//! no cross-test state.

use std::path::PathBuf;
use std::str::FromStr;

use sqlx::SqlitePool;
use tempfile::TempDir;

use super::bootstrap::{
    SPACE_PERSONAL_DEFAULT_ACCENT, SPACE_PERSONAL_ULID, SPACE_WORK_DEFAULT_ACCENT, SPACE_WORK_ULID,
    bootstrap_spaces_for_test as bootstrap_spaces,
};
use crate::db::init_pool;
use agaric_core::ulid::BlockId;

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
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, ?)",
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
    let sql = format!("SELECT COUNT(*) FROM {table}");
    sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql.as_str()))
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn space_property(pool: &SqlitePool, block_id: &str) -> Option<String> {
    // Phase 2: `blocks.space_id` is the sole source of truth for space
    // membership (the `block_properties(key='space')` row is no longer
    // materialized). Read the column directly.
    sqlx::query_scalar!(r#"SELECT space_id FROM blocks WHERE id = ?"#, block_id,)
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
    // Regression: `bootstrap_spaces` now validates the seeded ULID
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

    // No pre-existing pages, so no block should carry a `space_id`
    // (Phase 2: membership lives on `blocks.space_id`; the seeded space
    // blocks themselves do not carry their own space_id).
    let space_member_count: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "n!: i64" FROM blocks WHERE space_id IS NOT NULL"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        space_member_count, 0,
        "no pre-existing pages means no block carries a space_id"
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
        set_prop_ops, 4,
        "exactly 4 SetProperty ops (is_space + accent_color on Personal + Work) on fresh bootstrap"
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
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'Work', NULL, 1, ?)",
        SPACE_WORK_ULID,
        SPACE_WORK_ULID,
    )
    .execute(&pool)
    .await
    .unwrap();
    // #708: register Work in the `spaces` table so the membership stamp
    // below satisfies the 0089 `blocks.space_id REFERENCES spaces(id)` FK.
    // (A registry row without the `is_space` property mirrors a
    // post-recovery mid-state: registry rows persist while property rows
    // are re-derived.)
    sqlx::query!(
        "INSERT OR IGNORE INTO spaces (id) VALUES (?)",
        SPACE_WORK_ULID
    )
    .execute(&pool)
    .await
    .unwrap();

    insert_page(&pool, "01JABCD0000000000000000001", "Already Scoped").await;
    // Simulate a page that was previously assigned to the Work space
    // (e.g. via a sync from another device that ran bootstrap first).
    // Phase 2: membership is the `blocks.space_id` column.
    sqlx::query!(
        "UPDATE blocks SET space_id = ? WHERE id = ?",
        SPACE_WORK_ULID,
        "01JABCD0000000000000000001",
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
async fn bootstrap_resumes_after_partial_state() {
    let (pool, _dir) = test_pool().await;

    insert_page(&pool, "01JABCD0000000000000000001", "Existing").await;

    // Simulate a crashed prior bootstrap that created Personal but not
    // Work. The function must finish the job on the next call.
    sqlx::query!(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'Personal', NULL, 1, ?)",
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
// Default accent_color seeding for Personal + Work.
// ---------------------------------------------------------------------

/// Read the `value_text` of the `accent_color` property on `block_id`,
/// or `None` if the property does not exist.
async fn accent_color_property(pool: &SqlitePool, block_id: &str) -> Option<String> {
    sqlx::query_scalar!(
        r#"SELECT value_text FROM block_properties
           WHERE block_id = ? AND key = 'accent_color'"#,
        block_id,
    )
    .fetch_optional(pool)
    .await
    .unwrap()
    .flatten()
}

/// Count `op_log` rows whose `op_type = 'set_property'` AND whose
/// payload key matches `key` AND whose `block_id` extraction matches
/// the supplied `block_id`. Used to verify the per-space op-count
/// invariant (each accent_color op is emitted at most once per
/// seeded block).
async fn count_set_property_ops_for_block_and_key(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
) -> i64 {
    let pattern = format!("%\"key\":\"{key}\"%");
    sqlx::query_scalar::<_, i64>(
        r"SELECT COUNT(*) FROM op_log
           WHERE op_type = 'set_property'
             AND block_id = ?
             AND payload LIKE ?",
    )
    .bind(block_id)
    .bind(pattern)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Fresh bootstrap seeds the two default accent tokens
/// (`accent-emerald` for Personal, `accent-blue` for Work).
#[tokio::test]
async fn bootstrap_seeds_default_accent_colors_for_personal_and_work() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    assert_eq!(
        accent_color_property(&pool, SPACE_PERSONAL_ULID)
            .await
            .as_deref(),
        Some(SPACE_PERSONAL_DEFAULT_ACCENT),
        "Personal must seed accent_color = '{SPACE_PERSONAL_DEFAULT_ACCENT}'"
    );
    assert_eq!(
        accent_color_property(&pool, SPACE_WORK_ULID)
            .await
            .as_deref(),
        Some(SPACE_WORK_DEFAULT_ACCENT),
        "Work must seed accent_color = '{SPACE_WORK_DEFAULT_ACCENT}'"
    );

    // Sanity check that bootstrap is operating in a valid steady state
    // — the seeded tokens must differ so the visual identity is
    // Distinguishable at a glance (the spec rationale for).
    assert_ne!(
        SPACE_PERSONAL_DEFAULT_ACCENT, SPACE_WORK_DEFAULT_ACCENT,
        "seeded defaults must differ to give the two spaces distinct identity"
    );
}

/// `key` sorted, as `space_id` declares them.
async fn property_def_keys(pool: &SqlitePool, space_id: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT key FROM property_definitions WHERE space_id = ? ORDER BY key")
        .bind(space_id)
        .fetch_all(pool)
        .await
        .unwrap()
}

/// #5841 — a fresh vault's Personal and Work start as a space `create_space`
/// makes does: the default property definitions, exactly, as ordinary rows.
#[tokio::test]
async fn bootstrap_gives_personal_and_work_the_default_property_defs_5841() {
    let (pool, _dir) = test_pool().await;
    assert!(
        property_def_keys(&pool, SPACE_PERSONAL_ULID)
            .await
            .is_empty(),
        "seed precondition: a fresh vault has no space, so 0129 kept no row"
    );

    bootstrap_spaces(&pool, DEV).await.unwrap();

    let defaults: Vec<String> = crate::commands::DEFAULT_PROPERTY_DEFS
        .iter()
        .map(|(key, _, _)| (*key).to_owned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    assert_eq!(
        defaults,
        ["assignee", "effort", "location", "status", "url"],
        "the defaults the maintainer chose"
    );
    for space in [SPACE_PERSONAL_ULID, SPACE_WORK_ULID] {
        assert_eq!(
            property_def_keys(&pool, space).await,
            defaults,
            "{space} holds exactly the defaults"
        );
    }
}

/// #5841 — a seeded space bootstrap RESTORES keeps its own definitions: a
/// default its user deleted is not added back.
#[tokio::test]
async fn bootstrap_restoring_a_seeded_space_does_not_re_add_a_deleted_default_5841() {
    let (pool, _dir) = test_pool().await;
    bootstrap_spaces(&pool, DEV).await.unwrap();
    let mat = crate::materializer::Materializer::new(pool.clone());
    crate::commands::delete_property_def_inner(&pool, DEV, &mat, SPACE_WORK_ULID, "effort".into())
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET deleted_at = 1 WHERE id = ?")
        .bind(SPACE_WORK_ULID)
        .execute(&pool)
        .await
        .unwrap();

    bootstrap_spaces(&pool, DEV).await.unwrap();

    let restored: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(SPACE_WORK_ULID)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(restored, None, "seed precondition: bootstrap restored Work");
    assert_eq!(
        property_def_keys(&pool, SPACE_WORK_ULID).await,
        ["assignee", "location", "status", "url"],
        "the deleted default stays deleted"
    );
}

/// Running bootstrap twice on a vanilla install must not
/// pile up duplicate `accent_color` ops in the op_log. Each seeded
/// block gets exactly ONE accent_color SetProperty op across both
/// boots (the fast-path skip is the load-bearing guard; the
/// `ensure_accent_color_property` helper is the defence-in-depth
/// guard for partial-resume scenarios).
#[tokio::test]
async fn bootstrap_does_not_re_emit_accent_color_on_second_boot() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();
    // Second boot: must short-circuit via the fast-path (every seeded
    // block already has is_space = "true"). The accent_color helper
    // also short-circuits if the fast-path were ever loosened in a
    // future bootstrap revision.
    bootstrap_spaces(&pool, DEV).await.unwrap();

    let personal_accent_ops =
        count_set_property_ops_for_block_and_key(&pool, SPACE_PERSONAL_ULID, "accent_color").await;
    assert_eq!(
        personal_accent_ops, 1,
        "exactly one accent_color op for Personal across two boots; got {personal_accent_ops}"
    );
    let work_accent_ops =
        count_set_property_ops_for_block_and_key(&pool, SPACE_WORK_ULID, "accent_color").await;
    assert_eq!(
        work_accent_ops, 1,
        "exactly one accent_color op for Work across two boots; got {work_accent_ops}"
    );

    // The seeded tokens must still match the defaults (no overwrite of
    // the original values on the second boot — the helper short-circuits).
    assert_eq!(
        accent_color_property(&pool, SPACE_PERSONAL_ULID)
            .await
            .as_deref(),
        Some(SPACE_PERSONAL_DEFAULT_ACCENT),
    );
    assert_eq!(
        accent_color_property(&pool, SPACE_WORK_ULID)
            .await
            .as_deref(),
        Some(SPACE_WORK_DEFAULT_ACCENT),
    );
}

// ---------------------------------------------------------------------
// Bootstrap re-runs `pages_without_space` every boot.
// ---------------------------------------------------------------------
//
// Pages that arrive without a `space` property — via a misbehaving
// frontend, a sync replay from a peer that bypassed the invariant, or
// any other path — are captured by the every-boot backfill and
// assigned to the seeded Personal space. The seeded-block fast-path
// (which avoids re-emitting `is_space` / `accent_color` ops) is
// preserved.

/// Keeps `is_space` ops fast-pathed to "emit once". This
/// counter is the load-bearing assertion for the second-boot test —
/// `is_space` SetProperty ops should fire on the first boot only.
async fn count_is_space_ops_for_block(pool: &SqlitePool, block_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM op_log
           WHERE op_type = 'set_property'
             AND block_id = ?
             AND payload LIKE '%"key":"is_space"%'"#,
    )
    .bind(block_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Regression — after the bootstrap-complete marker
/// is set (i.e. on every boot AFTER the first), a freshly-arrived
/// page WITHOUT a `space` property must STILL be migrated to the
/// Personal space on the next boot. Before the fix the fast-path
/// short-circuit returned early and left the page invisible to
/// `list_blocks(blockType='page', spaceId=Personal)`.
#[tokio::test]
async fn bootstrap_re_runs_pages_without_space_after_marker_set() {
    let (pool, _dir) = test_pool().await;

    // Boot 1 — seeds Personal + Work, leaves the marker state set.
    bootstrap_spaces(&pool, DEV).await.unwrap();

    // Simulate a page that arrives between boot 1 and boot 2 WITHOUT
    // A `space` property — exactly the bypass-path scenario
    // captures: `JournalPage`'s old `createBlock({ blockType: 'page' })`
    // call, a peer-synced page from a device on stale code, etc.
    insert_page(&pool, "01JABCD0000000000000000001", "Leaked page").await;

    // Pre-fix: the fast-path skip would short-circuit here and the page
    // would stay unscoped forever. Post-fix: the backfill runs and
    // assigns it to Personal.
    bootstrap_spaces(&pool, DEV).await.unwrap();

    assert_eq!(
        space_property(&pool, "01JABCD0000000000000000001")
            .await
            .as_deref(),
        Some(SPACE_PERSONAL_ULID),
        "a page without `space` arriving after first boot must be migrated on the next boot"
    );

    // Boot 3 — idempotent. The page is now scoped, so no further
    // SetProperty(space=…) op is appended for it.
    let space_ops_before_third = count_set_property_ops_for_key(&pool, "space").await;
    bootstrap_spaces(&pool, DEV).await.unwrap();
    let space_ops_after_third = count_set_property_ops_for_key(&pool, "space").await;
    assert_eq!(
        space_ops_after_third, space_ops_before_third,
        "second backfill run must be a pure no-op (no candidate pages)"
    );
}

/// #5371 — the backfill's `space` projection moves the page's `pages_cache`
/// row with the page: the Pages list reads the space from that row, and no
/// rebuild of it is queued.
#[tokio::test]
async fn bootstrap_placement_moves_the_pages_cache_row_with_the_page_5371() {
    let (pool, _dir) = test_pool().await;
    bootstrap_spaces(&pool, DEV).await.unwrap();
    let page = "01JABCD0000000000000005371";
    insert_page(&pool, page, "Leaked page").await;
    // The row a rebuild births while the page has no space.
    sqlx::query(
        "INSERT INTO pages_cache (page_id, title, title_sort_key, last_edited_ms, updated_at) \
         VALUES (?, 'Leaked page', 'leaked page', 1, 1)",
    )
    .bind(page)
    .execute(&pool)
    .await
    .unwrap();

    bootstrap_spaces(&pool, DEV).await.unwrap();

    let cached: Option<String> =
        sqlx::query_scalar("SELECT space_id FROM pages_cache WHERE page_id = ?")
            .bind(page)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(cached.as_deref(), Some(SPACE_PERSONAL_ULID));
}

/// The seeded-block fast path is intentionally
/// preserved. `is_space = "true"` SetProperty ops must fire ONLY on
/// the first boot (invariant). This test pins the fact
/// that loosening the fast-path was scoped to the
/// `pages_without_space` step, NOT the seeded `is_space` /
/// `accent_color` op emission.
#[tokio::test]
async fn bootstrap_does_not_re_emit_is_space_ops_on_second_boot() {
    let (pool, _dir) = test_pool().await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    let personal_after_first = count_is_space_ops_for_block(&pool, SPACE_PERSONAL_ULID).await;
    let work_after_first = count_is_space_ops_for_block(&pool, SPACE_WORK_ULID).await;
    assert_eq!(
        personal_after_first, 1,
        "exactly one is_space op for Personal after first boot"
    );
    assert_eq!(
        work_after_first, 1,
        "exactly one is_space op for Work after first boot"
    );

    // Snapshot total op_log count before the second boot. With no new
    // pages-without-space candidates, the second boot must add zero
    // ops at all.
    let total_ops_before = count_rows(&pool, "op_log").await;

    bootstrap_spaces(&pool, DEV).await.unwrap();

    let personal_after_second = count_is_space_ops_for_block(&pool, SPACE_PERSONAL_ULID).await;
    let work_after_second = count_is_space_ops_for_block(&pool, SPACE_WORK_ULID).await;
    assert_eq!(
        personal_after_second, 1,
        "is_space op count for Personal must NOT increase on second boot"
    );
    assert_eq!(
        work_after_second, 1,
        "is_space op count for Work must NOT increase on second boot"
    );

    let total_ops_after = count_rows(&pool, "op_log").await;
    assert_eq!(
        total_ops_after, total_ops_before,
        "second boot with no candidate pages must append zero ops to op_log"
    );
}

/// The backfill appends exactly one `SetProperty(space)` op per page it
/// places, and every page lands in Personal.
#[tokio::test]
async fn bootstrap_appends_one_space_op_per_placed_page() {
    let (pool, _dir) = test_pool().await;

    const N: usize = 3;
    let ids: Vec<String> = (0..N)
        .map(|i| format!("01JABCDE0000000000000{i:05}"))
        .collect();
    for id in &ids {
        insert_page(&pool, id, "page").await;
    }

    bootstrap_spaces(&pool, DEV).await.unwrap();

    for id in &ids {
        assert_eq!(
            space_property(&pool, id).await.as_deref(),
            Some(SPACE_PERSONAL_ULID),
            "page {id} must be migrated to Personal"
        );
    }
    let space_ops = count_set_property_ops_for_key(&pool, "space").await;
    assert_eq!(
        space_ops,
        i64::try_from(N).expect("test constant N fits i64"),
        "exactly {N} SetProperty(key='space') ops in op_log; got {space_ops}"
    );
}

// ---------------------------------------------------------------------
// H-3c — Property-test-style invariant: every page block has a
// `space` property.
// ---------------------------------------------------------------------
//
// Rust uses neither `proptest` nor `quickcheck` in this repo, so we
// ship a deterministic regression-style scenario test instead. The
// scenarios cover the three documented bypass paths:
//
//   1. Legacy `create_block(page)` direct IPC call — refused at the
//      IPC boundary by the IPC tightening (see `block_cmd_tests.rs`).
//   2. `create_page_in_space` — emits the page WITH its `space`
//      property atomically.
//   3. Sync replay of legacy ops (or any path that lands a page row
// Without `space` post-bootstrap) — caught by the
//      every-boot backfill.
//
// The invariant: AFTER `bootstrap_spaces` has run, EVERY live,
// non-conflict page block in the materialized state has either a
// `space` property pointing at a valid space block, OR carries
// `is_space = "true"` (i.e. is itself a space block).

/// Helper: assert the invariant holds for the entire pool.
async fn assert_every_page_has_space_or_is_space(pool: &SqlitePool) {
    // Phase 2: a page is "scoped" iff it carries a `blocks.space_id`
    // (the sole source of truth); a space block itself carries
    // `is_space = "true"` and no own space_id.
    let leaks: Vec<String> = sqlx::query_scalar!(
        r#"SELECT id as "id!: String" FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.space_id IS NULL
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
    )
    .fetch_all(pool)
    .await
    .unwrap();

    assert!(
        leaks.is_empty(),
        " invariant violated: pages missing `space` AND `is_space`: {leaks:?}"
    );
}

/// Property-style regression: scenario sequence covering every
/// bypass path. Models the user's daily workflow under the fix:
///
/// 1. Bootstrap fresh DB → Personal + Work seeded.
/// 2. `create_page_in_space_inner` → page lands with `space = Personal`.
///    (Simulates the post-fix `JournalPage` / `TemplatesView` /
///    `WelcomeModal` callsites.)
/// 3. Legacy bypass: a peer device synced an old `CreateBlock` op
///    that materialized a page WITHOUT a `space` property (modelled
///    via direct INSERT into `blocks`, mirroring the apply-op path).
/// 4. Reboot → bootstrap re-run sweeps the leak into Personal.
/// 5. Final invariant check: every page is scoped.
#[tokio::test]
async fn property_every_page_has_space_after_bootstrap_under_mixed_create_paths() {
    use crate::commands::create_page_in_space_inner;
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // 1. Bootstrap.
    bootstrap_spaces(&pool, DEV).await.unwrap();
    assert_every_page_has_space_or_is_space(&pool).await;

    // 2. Production callsite — atomic page-create with space.
    let p1 = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        None,
        "Notes from JournalPage".into(),
        SPACE_PERSONAL_ULID.to_owned(),
    )
    .await
    .unwrap();
    assert_every_page_has_space_or_is_space(&pool).await;

    // 3. Multiple pages across both spaces.
    let p2 = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        None,
        "Work brief".into(),
        SPACE_WORK_ULID.to_owned(),
    )
    .await
    .unwrap();
    let _p3 = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        Some(p1.as_str().to_owned()),
        "Sub-page".into(),
        SPACE_PERSONAL_ULID.to_owned(),
    )
    .await
    .unwrap();
    assert_every_page_has_space_or_is_space(&pool).await;

    // 4. Sync replay bypass: insert a page row WITHOUT a `space`
    //    property — simulates what would happen if a peer device on
    //    stale code synced over a `CreateBlock` op for a page block
    //    where the materialized row exists but the property never
    //    arrived. The materializer would have inserted the row from
    //    the op; the test inserts directly to keep the fixture
    //    minimal. Same outcome.
    insert_page(&pool, "01JABCD0000000000000000001", "Leaked from peer").await;

    // 5. Reboot — bootstrap's every-boot backfill captures the leak.
    bootstrap_spaces(&pool, DEV).await.unwrap();
    assert_every_page_has_space_or_is_space(&pool).await;

    // Final spot-check: every materialized page can be enumerated by
    // `list_blocks(blockType='page', spaceId=…)` for one of the two
    // seeded spaces.
    let personal_pages: Vec<String> = sqlx::query_scalar!(
        r#"SELECT id as "id!: String" FROM blocks
           WHERE space_id = ?"#,
        SPACE_PERSONAL_ULID,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let work_pages: Vec<String> = sqlx::query_scalar!(
        r#"SELECT id as "id!: String" FROM blocks
           WHERE space_id = ?"#,
        SPACE_WORK_ULID,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        personal_pages.contains(&p1.as_str().to_owned()),
        "Personal-created page must surface under Personal in `space` props"
    );
    assert!(
        work_pages.contains(&p2.as_str().to_owned()),
        "Work-created page must surface under Work in `space` props"
    );
    assert!(
        personal_pages.contains(&"01JABCD0000000000000000001".to_owned()),
        "the leaked-from-peer page must end up scoped to Personal via the backfill"
    );
}

/// #533: the universal "every block maps to a space" invariant — NO
/// non-deleted block may have a NULL `space_id`, the sole legitimate
/// exception being a space block itself (`is_space = 'true'`). Covers all
/// block types, not just pages.
async fn assert_every_block_maps_to_a_space(pool: &SqlitePool) {
    let orphans: Vec<(String, String)> = sqlx::query_as(
        "SELECT b.id, b.block_type FROM blocks b \
         WHERE b.deleted_at IS NULL \
           AND b.space_id IS NULL \
           AND NOT EXISTS ( \
               SELECT 1 FROM block_properties p \
               WHERE p.block_id = b.id AND p.key = 'is_space' AND p.value_text = 'true' \
           )",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(
        orphans.is_empty(),
        "#533 invariant violated: {} block(s) have no space (and aren't space blocks): {orphans:?}",
        orphans.len()
    );
}

/// #533: drive a realistic workflow (bootstrap → page in a space → nested
/// content children → an adopted tag) and assert EVERY resulting block
/// maps to a space. Guards against any creation path leaving a block
/// space-less (which would make it vanish from every space-filtered read).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_block_maps_to_a_space_after_realistic_workflow_533() {
    use crate::commands::{add_tag_inner, create_block_inner, create_page_in_space_inner};
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    bootstrap_spaces(&pool, DEV).await.unwrap();

    // Page in Personal + nested content children (create path).
    let page = create_page_in_space_inner(
        &pool,
        DEV,
        &mat,
        None,
        "Workflow page".into(),
        SPACE_PERSONAL_ULID.to_owned(),
    )
    .await
    .unwrap();
    let child = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "child".into(),
        Some(page.clone()),
        None,
    )
    .await
    .unwrap();
    let _grandchild = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "grandchild".into(),
        Some(child.id.clone()),
        None,
    )
    .await
    .unwrap();

    // A tag, adopted into the block's space via add_tag (orphan→space).
    let tag = create_block_inner(&pool, DEV, &mat, "tag".into(), "proj".into(), None, None)
        .await
        .unwrap();
    add_tag_inner(&pool, DEV, &mat, child.id.clone(), tag.id.clone())
        .await
        .unwrap();

    mat.flush_background().await.unwrap();

    // The invariant: every non-deleted, non-space block has a space_id.
    assert_every_block_maps_to_a_space(&pool).await;
    mat.shutdown();
}

/// `list_blocks_inner` (the IPC consumer path the frontend
/// hits via the `list_blocks` Tauri command) must enforce space
/// isolation end-to-end: given pages seeded across both spaces via
/// the real `create_page_in_space_inner` command path, a query with
/// `space_id = Personal` returns ONLY Personal pages, and a query
/// with `space_id = Work` returns ONLY Work pages. Complements the
/// property-table-level isolation tests above (which assert the raw
/// `block_properties` rows carry the right `space` refs) by pinning
/// the behaviour at the boundary the frontend actually consumes.
#[tokio::test]
async fn list_blocks_inner_isolates_blocks_by_space_id() {
    use crate::commands::{create_page_in_space_inner, list_blocks_inner};
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let materializer = Materializer::new(pool.clone());

    // 1. Bootstrap Personal + Work.
    bootstrap_spaces(&pool, DEV).await.unwrap();

    // 2. Create 2 pages in Personal and 2 pages in Work via the real
    //    command the frontend invokes (`create_page_in_space`).
    let personal_1 = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        None,
        "Personal note A".into(),
        SPACE_PERSONAL_ULID.to_owned(),
    )
    .await
    .unwrap();
    let personal_2 = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        None,
        "Personal note B".into(),
        SPACE_PERSONAL_ULID.to_owned(),
    )
    .await
    .unwrap();
    let work_1 = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        None,
        "Work brief A".into(),
        SPACE_WORK_ULID.to_owned(),
    )
    .await
    .unwrap();
    let work_2 = create_page_in_space_inner(
        &pool,
        DEV,
        &materializer,
        None,
        "Work brief B".into(),
        SPACE_WORK_ULID.to_owned(),
    )
    .await
    .unwrap();

    // 3. Query via the IPC consumer path with space_id = Personal.
    //    `block_type = "page"` matches the PageBrowser dispatch
    //    (`list_by_type`) in `commands/blocks/queries.rs`.
    let personal_resp = list_blocks_inner(
        &pool,
        None,                           // parent_id
        Some("page".into()),            // block_type
        None,                           // tag_id
        None,                           // agenda_date
        None,                           // agenda_date_start
        None,                           // agenda_date_end
        None,                           // agenda_source
        None,                           // exclude_todo_states
        None,                           // cursor
        Some(50),                       // limit
        SPACE_PERSONAL_ULID.to_owned(), // space_id
    )
    .await
    .unwrap();

    let personal_ids: Vec<String> = personal_resp
        .items
        .iter()
        .map(|r| r.id.as_str().to_string())
        .collect();
    assert!(
        personal_ids.contains(&personal_1.as_str().to_owned()),
        "Personal query must surface page 1 created in Personal; got {personal_ids:?}"
    );
    assert!(
        personal_ids.contains(&personal_2.as_str().to_owned()),
        "Personal query must surface page 2 created in Personal; got {personal_ids:?}"
    );
    assert!(
        !personal_ids.contains(&work_1.as_str().to_owned()),
        "Personal query must NOT leak page 1 from Work; got {personal_ids:?}"
    );
    assert!(
        !personal_ids.contains(&work_2.as_str().to_owned()),
        "Personal query must NOT leak page 2 from Work; got {personal_ids:?}"
    );

    // 4. Query via the same IPC consumer path with space_id = Work.
    let work_resp = list_blocks_inner(
        &pool,
        None,
        Some("page".into()),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        Some(50),
        SPACE_WORK_ULID.to_owned(),
    )
    .await
    .unwrap();

    let work_ids: Vec<String> = work_resp
        .items
        .iter()
        .map(|r| r.id.as_str().to_string())
        .collect();
    assert!(
        work_ids.contains(&work_1.as_str().to_owned()),
        "Work query must surface page 1 created in Work; got {work_ids:?}"
    );
    assert!(
        work_ids.contains(&work_2.as_str().to_owned()),
        "Work query must surface page 2 created in Work; got {work_ids:?}"
    );
    assert!(
        !work_ids.contains(&personal_1.as_str().to_owned()),
        "Work query must NOT leak page 1 from Personal; got {work_ids:?}"
    );
    assert!(
        !work_ids.contains(&personal_2.as_str().to_owned()),
        "Work query must NOT leak page 2 from Personal; got {work_ids:?}"
    );
}

/// Count rows in `op_log` whose `op_type = 'set_property'` AND whose
/// payload key matches the supplied filter. Used to verify exactly N
/// `space` ops were emitted by a bootstrap run.
async fn count_set_property_ops_for_key(pool: &SqlitePool, key: &str) -> i64 {
    sqlx::query_scalar!(
        r#"SELECT COUNT(*) FROM op_log
           WHERE op_type = 'set_property'
             AND json_extract(payload, '$.key') = ?"#,
        key,
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// #4775: a space created on device A reaches device B through the ordinary
/// per-space snapshot catch-up. B registers it — the `spaces` row and the
/// `is_space` / `accent_color` rows `list_spaces` reads — and a page A created
/// in it lands in that space on B, where the boot backfill leaves it alone
/// instead of stamping it Personal.
///
/// Counter-delta shape: none. Two `Materializer`s, each with its own
/// `LoroState`; no process-global state.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_created_on_one_device_reaches_its_peer_4775() {
    use crate::commands::{
        create_page_in_space_inner, create_space_inner, list_spaces_inner,
        move_blocks_to_space_inner,
    };
    use crate::materializer::Materializer;
    use agaric_store::space::SpaceId;
    use agaric_sync::sync_protocol::loro_sync::{apply_remote, prepare_outgoing_for_pool};

    const DEV_A: &str = "device-A";
    const DEV_B: &str = "device-B";

    // Device A: a page that predates the space (moved into it below — its
    // older ULID sorts it ahead of the space block in the import delta), the
    // space, and a page created in it, all through the real commands.
    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, DEV_A, &mat_a)
        .await
        .unwrap();
    let older = create_page_in_space_inner(
        &pool_a,
        DEV_A,
        &mat_a,
        None,
        "Older".into(),
        SPACE_PERSONAL_ULID.to_owned(),
    )
    .await
    .unwrap();
    let space = create_space_inner(
        &pool_a,
        DEV_A,
        &mat_a,
        "Research".into(),
        Some("accent-violet".into()),
    )
    .await
    .unwrap();
    let page = create_page_in_space_inner(
        &pool_a,
        DEV_A,
        &mat_a,
        None,
        "Paper".into(),
        space.as_str().to_owned(),
    )
    .await
    .unwrap();
    move_blocks_to_space_inner(
        &pool_a,
        DEV_A,
        &mat_a,
        vec![older.clone()],
        space.as_str().to_owned(),
        &[],
    )
    .await
    .unwrap();
    mat_a.flush_background().await.unwrap();

    // The catch-up export of the new space's doc, exactly as
    // `snapshot_transfer::try_offer_loro_snapshot_catchup` builds it.
    let space_id = SpaceId::from_trusted(space.as_str());
    let msg = prepare_outgoing_for_pool(
        &pool_a,
        &mat_a.loro_state().registry,
        &space_id,
        DEV_A,
        None,
    )
    .await
    .unwrap()
    .expect("#1257 freshness gate must not refuse a consistent engine");
    mat_a.shutdown();

    // Device B: a freshly bootstrapped vault that has never seen the space.
    let (pool_b, _dir_b) = test_pool().await;
    let mat_b = Materializer::new(pool_b.clone());
    super::bootstrap::bootstrap_spaces(&pool_b, DEV_B, &mat_b)
        .await
        .unwrap();
    apply_remote(&pool_b, &mat_b.loro_state().registry, DEV_B, msg)
        .await
        .unwrap();

    // Registered on B, with the name and accent the picker renders.
    let registered: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM spaces WHERE id = ?")
        .bind(space.as_str())
        .fetch_one(&pool_b)
        .await
        .unwrap();
    assert_eq!(registered, 1, "B must register the synced-in space");
    let spaces = list_spaces_inner(&pool_b).await.unwrap();
    let row = spaces
        .iter()
        .find(|s| s.id == space.as_str())
        .unwrap_or_else(|| {
            panic!("B's space picker must list the synced-in space; got {spaces:?}")
        });
    assert_eq!(row.name, "Research", "the space's name must travel with it");
    assert_eq!(
        row.accent_color.as_deref(),
        Some("accent-violet"),
        "the space's accent must travel with it"
    );
    // The space block is not a page OF its space: no `space_id`, on B as on A.
    assert_eq!(
        space_property(&pool_b, space.as_str()).await,
        None,
        "the space block itself must carry no space_id"
    );
    assert_eq!(
        space_property(&pool_b, page.as_str()).await,
        Some(space.as_str().to_owned()),
        "the page must land in the synced-in space on B"
    );
    assert_eq!(
        space_property(&pool_b, older.as_str()).await,
        Some(space.as_str().to_owned()),
        "the page moved into the space must land in it on B"
    );

    // The boot backfill (and the #4717 post-sync pass that shares its helper)
    // finds nothing to place.
    super::bootstrap::bootstrap_spaces(&pool_b, DEV_B, &mat_b)
        .await
        .unwrap();
    mat_b.flush_background().await.unwrap();
    for id in [&page, &older] {
        assert_eq!(
            space_property(&pool_b, id.as_str()).await,
            Some(space.as_str().to_owned()),
            "the boot backfill must not move the page to Personal"
        );
    }
    mat_b.shutdown();
}

/// Ship `space`'s doc from A to B the way the catch-up does: one full
/// snapshot, merged into B's engine and projected. Returns the blocks the
/// import reported changed.
async fn sync_space_a_to_b(
    pool_a: &SqlitePool,
    mat_a: &crate::materializer::Materializer,
    space: &str,
    pool_b: &SqlitePool,
    mat_b: &crate::materializer::Materializer,
) -> Vec<BlockId> {
    use agaric_sync::sync_protocol::loro_sync::{
        ApplyOutcome, apply_remote, prepare_outgoing_for_pool,
    };
    let space_id = agaric_store::space::SpaceId::from_trusted(space);
    let msg = prepare_outgoing_for_pool(
        pool_a,
        &mat_a.loro_state().registry,
        &space_id,
        "device-A",
        None,
    )
    .await
    .unwrap()
    .expect("#1257 freshness gate must not refuse a consistent engine");
    let outcome = apply_remote(pool_b, &mat_b.loro_state().registry, "device-B", msg)
        .await
        .unwrap();
    let ApplyOutcome::Imported { changed_blocks, .. } = outcome else {
        panic!("a snapshot imports, got {outcome:?}");
    };
    changed_blocks
}

async fn deleted_at_of(pool: &SqlitePool, block_id: &str) -> Option<i64> {
    sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(block_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// #4775: the space block's later ops route through the space's own doc, so
/// a rename and a delete on A reach B. The re-projection of the renamed block
/// must leave its `space_id` NULL (a space is not a page of itself), and the
/// engine-side delete keeps A's engine and SQL agreeing, so the freshness
/// gate keeps exporting the space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renaming_and_deleting_a_space_reach_its_peer_4775() {
    use crate::commands::{
        create_page_in_space_inner, create_space_inner, delete_block_inner, edit_block_inner,
        list_spaces_inner,
    };
    use crate::materializer::Materializer;

    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    let space = create_space_inner(&pool_a, "device-A", &mat_a, "Research".into(), None)
        .await
        .unwrap();
    let page = create_page_in_space_inner(
        &pool_a,
        "device-A",
        &mat_a,
        None,
        "Paper".into(),
        space.as_str().to_owned(),
    )
    .await
    .unwrap();
    let (pool_b, _dir_b) = test_pool().await;
    let mat_b = Materializer::new(pool_b.clone());
    super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
        .await
        .unwrap();
    mat_a.flush_background().await.unwrap();
    sync_space_a_to_b(&pool_a, &mat_a, space.as_str(), &pool_b, &mat_b).await;

    // Rename on A, sync, and B's picker shows the new name.
    edit_block_inner(&pool_a, "device-A", &mat_a, space.clone(), "Lab".into())
        .await
        .unwrap();
    mat_a.flush_background().await.unwrap();
    sync_space_a_to_b(&pool_a, &mat_a, space.as_str(), &pool_b, &mat_b).await;
    let names: Vec<String> = list_spaces_inner(&pool_b)
        .await
        .unwrap()
        .into_iter()
        .filter(|s| s.id == space.as_str())
        .map(|s| s.name)
        .collect();
    assert_eq!(names, vec!["Lab".to_owned()], "the rename must reach B");
    assert_eq!(
        space_property(&pool_b, space.as_str()).await,
        None,
        "re-projecting the space block must not stamp it as a page of itself"
    );

    // Empty the space and delete it on A; B's picker drops it.
    delete_block_inner(&pool_a, "device-A", &mat_a, page.clone())
        .await
        .unwrap();
    delete_block_inner(&pool_a, "device-A", &mat_a, space.clone())
        .await
        .unwrap();
    mat_a.flush_background().await.unwrap();
    sync_space_a_to_b(&pool_a, &mat_a, space.as_str(), &pool_b, &mat_b).await;
    assert!(
        deleted_at_of(&pool_b, space.as_str()).await.is_some(),
        "the space's deletion must reach B"
    );
    assert!(
        deleted_at_of(&pool_b, page.as_str()).await.is_some(),
        "the page's deletion must reach B"
    );
    let listed = list_spaces_inner(&pool_b).await.unwrap();
    assert!(
        listed.iter().all(|s| s.id != space.as_str()),
        "B's picker must drop the deleted space; got {listed:?}"
    );
    mat_a.shutdown();
    mat_b.shutdown();
}

/// #4775: a space created before its block had a doc (the pre-fix shape: a
/// registered `is_space` block in no engine, pages already in the space's
/// doc) is seeded into its doc by the boot pass, and arrives on B with its
/// pages in it — the space block is projected first even though it joined
/// the doc last.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_created_before_it_had_a_doc_reaches_its_peer_4775() {
    use crate::commands::create_page_in_space_inner;
    use crate::materializer::Materializer;

    const SPACE: &str = "01J4775PREFIXSPACE00000001";

    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    // The pre-fix shape, by hand: the block and its registering flag, in no doc.
    insert_page(&pool_a, SPACE, "Archive").await;
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
    )
    .bind(SPACE)
    .execute(&pool_a)
    .await
    .unwrap();
    let page = create_page_in_space_inner(
        &pool_a,
        "device-A",
        &mat_a,
        None,
        "Old paper".into(),
        SPACE.to_owned(),
    )
    .await
    .unwrap();
    mat_a.flush_background().await.unwrap();

    // The next boot seeds the space block into its doc.
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    mat_a.flush_background().await.unwrap();

    let (pool_b, _dir_b) = test_pool().await;
    let mat_b = Materializer::new(pool_b.clone());
    super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
        .await
        .unwrap();
    sync_space_a_to_b(&pool_a, &mat_a, SPACE, &pool_b, &mat_b).await;

    let registered: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM spaces WHERE id = ?")
        .bind(SPACE)
        .fetch_one(&pool_b)
        .await
        .unwrap();
    assert_eq!(registered, 1, "B must register the backfilled space");
    assert_eq!(
        space_property(&pool_b, page.as_str()).await,
        Some(SPACE.to_owned()),
        "the page must land in the backfilled space on B"
    );
    assert_eq!(
        space_property(&pool_b, SPACE).await,
        None,
        "the space block itself must carry no space_id"
    );
    mat_a.shutdown();
    mat_b.shutdown();
}

/// #6236: a page holds a ref to a page A then moves to another space. A
/// fresh B keeps the ref whichever space's doc it imports first. Imported
/// first, the holder's doc finds no row for the target, so the FK guard drops
/// the ref, and the target's import must give it back.
///
/// Counter-delta shape: none. Every `Materializer` has its own `LoroState`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_ref_into_another_space_lands_whichever_space_arrives_first_6236() {
    use crate::commands::{
        create_page_in_space_inner, create_property_def_inner, create_space_inner,
        move_blocks_to_space_inner, set_property_inner,
    };
    use crate::materializer::Materializer;

    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    let mut spaces = Vec::new();
    for name in ["Projects", "Archive"] {
        let space = create_space_inner(&pool_a, "device-A", &mat_a, name.into(), None)
            .await
            .unwrap();
        spaces.push(space.as_str().to_owned());
    }
    let [holder_space, target_space] = [&spaces[0], &spaces[1]];
    create_property_def_inner(
        &pool_a,
        "device-A",
        &mat_a,
        holder_space,
        "project".into(),
        "ref".into(),
        None,
    )
    .await
    .unwrap();
    let mut pages = Vec::new();
    for title in ["Holder", "Target"] {
        let page = create_page_in_space_inner(
            &pool_a,
            "device-A",
            &mat_a,
            None,
            title.into(),
            holder_space.clone(),
        )
        .await
        .unwrap();
        pages.push(page);
    }
    let [holder, target] = [&pages[0], &pages[1]];
    set_property_inner(
        &pool_a,
        "device-A",
        &mat_a,
        crate::ulid::verify_active(&pool_a, holder).await.unwrap(),
        "project".into(),
        None,
        None,
        None,
        Some(target.as_str().to_owned()),
        None,
        None,
    )
    .await
    .unwrap();
    move_blocks_to_space_inner(
        &pool_a,
        "device-A",
        &mat_a,
        vec![target.clone()],
        target_space.clone(),
        &[],
    )
    .await
    .unwrap();
    mat_a.flush_background().await.unwrap();

    for (label, order) in [
        ("target's space first", [target_space, holder_space]),
        ("holder's space first", [holder_space, target_space]),
    ] {
        let (pool_b, _dir_b) = test_pool().await;
        let mat_b = Materializer::new(pool_b.clone());
        super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
            .await
            .unwrap();
        let mut last_import = Vec::new();
        for space in order {
            last_import = sync_space_a_to_b(&pool_a, &mat_a, space, &pool_b, &mat_b).await;
        }
        let project: Option<Option<String>> = sqlx::query_scalar(
            "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'project'",
        )
        .bind(holder.as_str())
        .fetch_optional(&pool_b)
        .await
        .unwrap();
        assert_eq!(
            project,
            Some(Some(target.as_str().to_owned())),
            "{label}: B holds the holder's ref to the target"
        );
        assert!(
            last_import.contains(holder),
            "{label}: the last import reports the holder as changed, so its page refreshes"
        );
        let today = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).expect("valid date");
        let drift: Vec<String> =
            crate::reconciliation_oracle::reconcile_all(&pool_b, mat_b.loro_state(), None, today)
                .await
                .unwrap()
                .into_iter()
                .filter(|d| d.artefact == "engine.block_properties.row")
                .map(|d| d.key)
                .collect();
        assert_eq!(
            drift,
            Vec::<String>::new(),
            "{label}: B's property rows agree with its engines"
        );
        mat_b.shutdown();
    }
    mat_a.shutdown();
}

/// #6236: a page carries a tag, then the tag moves to another space. A fresh
/// B keeps the page's tag, and the page's child inherits it, whichever space's
/// doc B imports first. Imported first, the page's doc finds no row for the
/// tag, so the FK guard drops the edge, and the tag's import must give it
/// back. The tag moves into Work, which B seeds too, so that import gives the
/// tag alone its first row. Apart from the ref test, whose heal would report
/// the page changed on its own.
///
/// Counter-delta shape: none. Every `Materializer` has its own `LoroState`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tag_into_another_space_lands_whichever_space_arrives_first_6236() {
    use crate::commands::{
        add_tag_inner, create_block_inner, create_block_inner_with_space,
        create_page_in_space_inner, create_space_inner, move_blocks_to_space_inner,
    };
    use crate::materializer::Materializer;

    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    let holder_space = create_space_inner(&pool_a, "device-A", &mat_a, "Projects".into(), None)
        .await
        .unwrap()
        .as_str()
        .to_owned();
    let tag_space = SPACE_WORK_ULID.to_owned();
    let (holder_space, tag_space) = (&holder_space, &tag_space);
    let holder = create_page_in_space_inner(
        &pool_a,
        "device-A",
        &mat_a,
        None,
        "Holder".into(),
        holder_space.clone(),
    )
    .await
    .unwrap();
    let child = create_block_inner(
        &pool_a,
        "device-A",
        &mat_a,
        "content".into(),
        "detail".into(),
        Some(holder.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    let tag = create_block_inner_with_space(
        &pool_a,
        "device-A",
        &mat_a,
        "tag".into(),
        "urgent".into(),
        None,
        None,
        &agaric_store::space::SpaceScope::Active(agaric_store::space::SpaceId::from_trusted(
            holder_space,
        )),
        None,
    )
    .await
    .unwrap()
    .id;
    add_tag_inner(&pool_a, "device-A", &mat_a, holder.clone(), tag.clone())
        .await
        .unwrap();
    move_blocks_to_space_inner(
        &pool_a,
        "device-A",
        &mat_a,
        vec![tag.clone()],
        tag_space.clone(),
        &[],
    )
    .await
    .unwrap();
    mat_a.flush_background().await.unwrap();
    async fn tags_of(pool: &SqlitePool, block: &BlockId) -> Vec<String> {
        sqlx::query_scalar("SELECT tag_id FROM block_tags WHERE block_id = ?")
            .bind(block.as_str())
            .fetch_all(pool)
            .await
            .unwrap()
    }
    let a_tags = tags_of(&pool_a, &holder).await;
    assert_eq!(
        a_tags,
        vec![tag.as_str().to_owned()],
        "precondition: A's holder keeps its tag in the other space"
    );

    for (label, order) in [
        ("tag's space first", [tag_space, holder_space]),
        ("holder's space first", [holder_space, tag_space]),
    ] {
        let (pool_b, _dir_b) = test_pool().await;
        let mat_b = Materializer::new(pool_b.clone());
        super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
            .await
            .unwrap();
        let mut last_import = Vec::new();
        for space in order {
            last_import = sync_space_a_to_b(&pool_a, &mat_a, space, &pool_b, &mat_b).await;
        }
        assert_eq!(
            tags_of(&pool_b, &holder).await,
            a_tags,
            "{label}: B holds the holder's tag as A does"
        );
        let inherited: Vec<(String, String)> = sqlx::query_as(
            "SELECT tag_id, inherited_from FROM block_tag_inherited WHERE block_id = ?",
        )
        .bind(child.as_str())
        .fetch_all(&pool_b)
        .await
        .unwrap();
        assert_eq!(
            inherited,
            vec![(tag.as_str().to_owned(), holder.as_str().to_owned())],
            "{label}: the holder's child inherits its tag"
        );
        assert!(
            last_import.contains(&holder),
            "{label}: the last import reports the holder as changed, so its page refreshes"
        );
        let today = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).expect("valid date");
        let drift: Vec<String> =
            crate::reconciliation_oracle::reconcile_all(&pool_b, mat_b.loro_state(), None, today)
                .await
                .unwrap()
                .into_iter()
                .filter(|d| {
                    d.artefact == "engine.block_tags.row"
                        || d.artefact.starts_with("block_tag_inherited.")
                })
                .map(|d| format!("{}: {}", d.artefact, d.key))
                .collect();
        assert_eq!(
            drift,
            Vec::<String>::new(),
            "{label}: B's tag rows agree with its engines, and its inheritance with its tags"
        );
        mat_b.shutdown();
    }
    mat_a.shutdown();
}

/// #4801: a page moved to another space keeps its tasks' reserved columns
/// (`todo_state`, `due_date`, …) on the paired device. The move hydrates the
/// page's subtree into the target space's doc; the doc must carry the reserved
/// keys too, because the peer's import replaces all four `blocks` columns from
/// the doc, NULL for any key absent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_moved_page_keeps_its_task_dates_on_its_peer_4801() {
    use crate::commands::{
        create_block_inner, create_page_in_space_inner, create_space_inner,
        move_blocks_to_space_inner, set_due_date_inner, set_todo_state_inner,
    };
    use crate::materializer::Materializer;

    let (pool_a, _dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    let page = create_page_in_space_inner(
        &pool_a,
        "device-A",
        &mat_a,
        None,
        "Plan".into(),
        SPACE_PERSONAL_ULID.to_owned(),
    )
    .await
    .unwrap();
    let task = create_block_inner(
        &pool_a,
        "device-A",
        &mat_a,
        "content".into(),
        "Ship it".into(),
        Some(page.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    set_todo_state_inner(
        &pool_a,
        "device-A",
        &mat_a,
        task.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    set_due_date_inner(
        &pool_a,
        "device-A",
        &mat_a,
        task.as_str().into(),
        Some("2026-09-10".into()),
    )
    .await
    .unwrap();
    let space = create_space_inner(&pool_a, "device-A", &mat_a, "Research".into(), None)
        .await
        .unwrap();
    move_blocks_to_space_inner(
        &pool_a,
        "device-A",
        &mat_a,
        vec![page.clone()],
        space.as_str().to_owned(),
        &[],
    )
    .await
    .unwrap();
    mat_a.flush_background().await.unwrap();

    let (pool_b, _dir_b) = test_pool().await;
    let mat_b = Materializer::new(pool_b.clone());
    super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
        .await
        .unwrap();
    sync_space_a_to_b(&pool_a, &mat_a, space.as_str(), &pool_b, &mat_b).await;
    mat_b.flush_background().await.unwrap();

    let (todo_state, due_date): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT todo_state, due_date FROM blocks WHERE id = ?")
            .bind(task.as_str())
            .fetch_one(&pool_b)
            .await
            .unwrap();
    assert_eq!(
        (todo_state.as_deref(), due_date.as_deref()),
        (Some("TODO"), Some("2026-09-10")),
        "the moved task's state and due date must reach B"
    );
    // The agenda reads `agenda_cache`, which production refills after an
    // inbound sync (`Materializer::enqueue_inbound_sync_rebuilds`, on a
    // trailing debounce). Run that rebuild directly so the assertion below
    // pins the dates, not a timer.
    agaric_store::cache::rebuild_agenda_cache(&pool_b)
        .await
        .unwrap();
    let agenda = agaric_store::pagination::list_agenda(
        &pool_b,
        "2026-09-10",
        None,
        &agaric_store::pagination::PageRequest::new(None, None).unwrap(),
        None,
        &[],
    )
    .await
    .unwrap()
    .items;
    let listed: Vec<&str> = agenda.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        listed,
        vec![task.as_str()],
        "B's agenda must list the moved task"
    );
    mat_a.shutdown();
    mat_b.shutdown();
}

// ---------------------------------------------------------------------------
// #5712 — a page moved to another space keeps every row on its peer, whatever
// order the two spaces' docs arrive in
// ---------------------------------------------------------------------------

/// Two vaults holding the same content. On A, the page `page` (with `first`
/// and `second` under it and `nested` under `first`) and the tag `tag` live
/// in space `old`. The page `notes` stays there and points at both: its block
/// `note` links to the page, refers to it through the ref property
/// `related`, mentions the tag inline and carries it, and `note`'s child
/// inherits the tag. `first` holds an attachment. B also holds rows only B
/// has on the page: a draft on `first`, an open, and a Last-edited time its
/// own op log cannot reproduce.
struct MoveFixture {
    pool_a: SqlitePool,
    mat_a: crate::materializer::Materializer,
    pool_b: SqlitePool,
    mat_b: crate::materializer::Materializer,
    old: BlockId,
    new: BlockId,
    page: BlockId,
    first: BlockId,
    tag: BlockId,
    note: BlockId,
    /// The rows only B has, as the fixture left them.
    b_only: BOnlyRows,
    _dir_a: TempDir,
    _dir_b: TempDir,
}

/// A `blocks` row: id, type, content, parent, space, `deleted_at`.
type BlockRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

/// Every row of the tables a purge of a moved block would touch that A and
/// B must agree on. Positions and timestamps are left out: each device
/// stamps its own.
#[derive(Debug, PartialEq)]
pub(super) struct SharedRows {
    blocks: Vec<BlockRow>,
    attachments: Vec<(String, String, String)>,
    value_refs: Vec<(String, String, String)>,
    links: Vec<(String, String)>,
    tags: Vec<(String, String)>,
    inherited: Vec<(String, String, String)>,
    tag_refs: Vec<(String, String)>,
    page_links: Vec<(String, String, i64)>,
}

/// B's device-local rows: no doc holds them, so nothing brings them back.
#[derive(Debug, Clone, PartialEq)]
struct BOnlyRows {
    drafts: Vec<(String, String)>,
    opens: Vec<(String, i64)>,
    last_edited: Vec<(String, i64)>,
}

impl BOnlyRows {
    const NONE: Self = Self {
        drafts: Vec::new(),
        opens: Vec::new(),
        last_edited: Vec::new(),
    };
}

pub(super) async fn shared_rows(pool: &SqlitePool) -> SharedRows {
    async fn rows<T>(pool: &SqlitePool, sql: &'static str) -> Vec<T>
    where
        T: Send + Unpin + for<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow>,
    {
        sqlx::query_as(sql).fetch_all(pool).await.unwrap()
    }
    SharedRows {
        blocks: rows(
            pool,
            "SELECT id, block_type, content, parent_id, space_id, deleted_at FROM blocks ORDER BY id",
        )
        .await,
        attachments: rows(
            pool,
            "SELECT id, block_id, filename FROM attachments ORDER BY id",
        )
        .await,
        value_refs: rows(
            pool,
            "SELECT block_id, key, value_ref FROM block_properties \
             WHERE value_ref IS NOT NULL ORDER BY block_id, key",
        )
        .await,
        links: rows(
            pool,
            "SELECT source_id, target_id FROM block_links ORDER BY source_id, target_id",
        )
        .await,
        tags: rows(
            pool,
            "SELECT block_id, tag_id FROM block_tags ORDER BY block_id, tag_id",
        )
        .await,
        inherited: rows(
            pool,
            "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
             ORDER BY block_id, tag_id",
        )
        .await,
        tag_refs: rows(
            pool,
            "SELECT source_id, tag_id FROM block_tag_refs ORDER BY source_id, tag_id",
        )
        .await,
        page_links: rows(
            pool,
            "SELECT source_page_id, target_page_id, edge_count FROM page_link_cache \
             ORDER BY source_page_id, target_page_id",
        )
        .await,
    }
}

/// B's device-local rows on the fixture's page and its blocks.
async fn b_only_rows(pool: &SqlitePool, page: &BlockId) -> BOnlyRows {
    BOnlyRows {
        drafts: sqlx::query_as("SELECT block_id, content FROM block_drafts ORDER BY block_id")
            .fetch_all(pool)
            .await
            .unwrap(),
        opens: sqlx::query_as("SELECT page_id, opened_ms FROM page_opens ORDER BY page_id")
            .fetch_all(pool)
            .await
            .unwrap(),
        last_edited: sqlx::query_as(
            "SELECT page_id, last_edited_ms FROM pages_cache WHERE page_id = ?",
        )
        .bind(page.as_str())
        .fetch_all(pool)
        .await
        .unwrap(),
    }
}

/// The ids B's `sync_deferred_purges` holds, sorted.
pub(super) async fn deferred_purges(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT block_id FROM sync_deferred_purges ORDER BY block_id")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// Each live block of `space`'s engine, sorted by id.
fn engine_view(
    mat: &crate::materializer::Materializer,
    device: &str,
    space: &BlockId,
) -> Vec<Option<agaric_engine::loro::engine::BlockSnapshot>> {
    let space_id = agaric_store::space::SpaceId::from_trusted(space.as_str());
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space_id, device)
        .unwrap();
    let engine = guard.engine_mut();
    let mut live = engine.live_block_ids().unwrap();
    live.sort_unstable();
    live.iter()
        .map(|id| engine.read_block(id).unwrap())
        .collect()
}

/// How a pull session ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionEnd {
    /// Every doc landed and the session swept, as `complete_pull_session` does.
    Completed,
    /// The session stopped before its end: nothing is swept.
    Interrupted,
}

async fn move_fixture() -> MoveFixture {
    use crate::commands::pages::record_page_open_inner;
    use crate::commands::{
        add_attachment_with_bytes_inner, add_tag_inner, create_block_inner,
        create_block_inner_with_space, create_page_in_space_inner, create_property_def_inner,
        create_space_inner, set_property_inner,
    };
    use crate::materializer::Materializer;

    let (pool_a, dir_a) = test_pool().await;
    let mat_a = Materializer::new(pool_a.clone());
    super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
        .await
        .unwrap();
    let old = create_space_inner(&pool_a, "device-A", &mat_a, "Old".into(), None)
        .await
        .unwrap();
    let new = create_space_inner(&pool_a, "device-A", &mat_a, "New".into(), None)
        .await
        .unwrap();
    let in_old = |content: &str| {
        create_page_in_space_inner(
            &pool_a,
            "device-A",
            &mat_a,
            None,
            content.into(),
            old.as_str().to_owned(),
        )
    };
    let page = in_old("Plan").await.unwrap();
    let notes = in_old("Notes").await.unwrap();
    let child = |parent: &BlockId, content: String| {
        create_block_inner(
            &pool_a,
            "device-A",
            &mat_a,
            "content".into(),
            content,
            Some(parent.clone()),
            None,
        )
    };
    let first = child(&page, "first".into()).await.unwrap().id;
    child(&page, "second".into()).await.unwrap();
    child(&first, "nested".into()).await.unwrap();
    let tag = create_block_inner_with_space(
        &pool_a,
        "device-A",
        &mat_a,
        "tag".into(),
        "urgent".into(),
        None,
        None,
        &agaric_store::space::SpaceScope::Active(agaric_store::space::SpaceId::from_trusted(
            old.as_str(),
        )),
        None,
    )
    .await
    .unwrap()
    .id;
    let note = child(&notes, format!("see [[{page}]] #[{tag}]"))
        .await
        .unwrap()
        .id;
    child(&note, "detail".into()).await.unwrap();
    add_tag_inner(&pool_a, "device-A", &mat_a, note.clone(), tag.clone())
        .await
        .unwrap();
    // Definitions are per space (#5841): each device declares `related` in
    // both spaces the note lives in before the devices first meet.
    for space in [&old, &new] {
        create_property_def_inner(
            &pool_a,
            "device-A",
            &mat_a,
            space.as_str(),
            "related".into(),
            "ref".into(),
            None,
        )
        .await
        .unwrap();
    }
    set_property_inner(
        &pool_a,
        "device-A",
        &mat_a,
        note.as_str().into(),
        "related".into(),
        None,
        None,
        None,
        Some(page.as_str().to_owned()),
        None,
        None,
    )
    .await
    .unwrap();
    add_attachment_with_bytes_inner(
        &pool_a,
        "device-A",
        &mat_a,
        dir_a.path(),
        first.clone(),
        "photo.png".into(),
        "image/png".into(),
        b"png bytes".to_vec(),
    )
    .await
    .unwrap();
    mat_a.flush_background().await.unwrap();

    let (pool_b, dir_b) = test_pool().await;
    let mat_b = Materializer::new(pool_b.clone());
    super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
        .await
        .unwrap();
    for space in [&old, &new] {
        create_property_def_inner(
            &pool_b,
            "device-B",
            &mat_b,
            space.as_str(),
            "related".into(),
            "ref".into(),
            None,
        )
        .await
        .unwrap();
    }
    let mut fx = MoveFixture {
        pool_a,
        mat_a,
        pool_b,
        mat_b,
        old,
        new,
        page,
        first,
        tag,
        note,
        b_only: BOnlyRows::NONE,
        _dir_a: dir_a,
        _dir_b: dir_b,
    };
    let (old, new) = (fx.old.clone(), fx.new.clone());
    fx.pull(&[&old, &new], SessionEnd::Completed).await;
    assert_eq!(
        shared_rows(&fx.pool_b).await,
        shared_rows(&fx.pool_a).await,
        "precondition: B holds every row A holds"
    );

    agaric_engine::draft::save_draft(&fx.pool_b, "device-B", fx.first.as_str(), "unsaved words")
        .await
        .unwrap();
    record_page_open_inner(&fx.pool_b, fx.page.clone())
        .await
        .unwrap();
    // A Last-edited time B's own op log cannot reproduce: the op that set it
    // came from a peer, or compaction has since taken it.
    let mut conn = fx.pool_b.acquire().await.unwrap();
    agaric_store::cache::raise_pages_last_edited_ms(
        &mut conn,
        &[(fx.page.as_str(), 4_102_444_800_000)],
    )
    .await
    .unwrap();
    drop(conn);
    fx.b_only = b_only_rows(&fx.pool_b, &fx.page).await;
    assert_eq!(
        (
            fx.b_only.drafts.len(),
            fx.b_only.opens.len(),
            fx.b_only.last_edited.clone()
        ),
        (1, 1, vec![(fx.page.as_str().to_owned(), 4_102_444_800_000)]),
        "precondition: B holds a draft, an open and a Last-edited time on the page"
    );
    fx
}

impl MoveFixture {
    /// B pulls `spaces`' docs from A in that order, with the cache fan-out
    /// the session runs after each import, then ends the session.
    async fn pull(&self, spaces: &[&BlockId], end: SessionEnd) {
        use agaric_sync::sync_protocol::loro_sync::{ApplyOutcome, apply_remote};
        for space in spaces {
            let msg = agaric_sync::sync_protocol::loro_sync::prepare_outgoing_for_pool(
                &self.pool_a,
                &self.mat_a.loro_state().registry,
                &agaric_store::space::SpaceId::from_trusted(space.as_str()),
                "device-A",
                None,
            )
            .await
            .unwrap()
            .expect("#1257 freshness gate must not refuse a consistent engine");
            let outcome = apply_remote(
                &self.pool_b,
                &self.mat_b.loro_state().registry,
                "device-B",
                msg,
            )
            .await
            .unwrap();
            let ApplyOutcome::Imported { changed_blocks, .. } = outcome else {
                panic!("a snapshot imports, got {outcome:?}");
            };
            self.mat_b
                .enqueue_inbound_sync_rebuilds(&changed_blocks, &[])
                .await
                .unwrap();
        }
        if end == SessionEnd::Completed {
            let swept = agaric_sync::sync_protocol::loro_sync::sweep_deferred_purges(
                &self.pool_b,
                &self.mat_b.loro_state().registry,
            )
            .await
            .unwrap();
            self.mat_b
                .enqueue_inbound_sync_rebuilds(&[], &swept)
                .await
                .unwrap();
        }
        self.mat_b.flush_inbound_rebuilds().await.unwrap();
    }

    /// A moves `blocks` to `space`.
    async fn move_on_a(&self, blocks: &[&BlockId], space: &BlockId) {
        crate::commands::move_blocks_to_space_inner(
            &self.pool_a,
            "device-A",
            &self.mat_a,
            blocks.iter().map(|id| (*id).clone()).collect(),
            space.as_str().to_owned(),
            &[],
        )
        .await
        .unwrap();
        self.mat_a.flush_background().await.unwrap();
    }

    /// A deletes, then purges, `block`.
    async fn purge_on_a(&self, block: &BlockId) {
        crate::commands::delete_block_inner(&self.pool_a, "device-A", &self.mat_a, block.clone())
            .await
            .unwrap();
        crate::commands::purge_block_inner(&self.pool_a, "device-A", &self.mat_a, block.clone())
            .await
            .unwrap();
        self.mat_a.flush_background().await.unwrap();
    }

    /// The fixture's two spaces, `first` first.
    fn spaces_with_first<'a>(&'a self, first: &'a BlockId) -> [&'a BlockId; 2] {
        if *first == self.old {
            [&self.old, &self.new]
        } else {
            [&self.new, &self.old]
        }
    }

    /// B's rows equal A's, its engines match A's, and nothing waits to be
    /// swept.
    async fn assert_b_matches_a(&self, label: &str) {
        assert_eq!(
            shared_rows(&self.pool_b).await,
            shared_rows(&self.pool_a).await,
            "{label}: B's rows must equal A's"
        );
        for space in [&self.old, &self.new] {
            assert_eq!(
                engine_view(&self.mat_b, "device-B", space),
                engine_view(&self.mat_a, "device-A", space),
                "{label}: B's engine for space {space} must match A's"
            );
        }
        assert_eq!(
            deferred_purges(&self.pool_b).await,
            Vec::<String>::new(),
            "{label}: nothing waits to be swept"
        );
    }

    fn shutdown(&self) {
        self.mat_a.shutdown();
        self.mat_b.shutdown();
    }
}

/// #5712: A moves the page and the tag from `old` to `new`; B pulls both
/// docs in one session, in the given order. Whichever lands first, B ends
/// with A's rows and keeps its own.
async fn a_move_reaches_b_whole(old_space_first: bool) {
    let fx = move_fixture().await;
    fx.move_on_a(&[&fx.page, &fx.tag], &fx.new).await;
    let first = if old_space_first { &fx.old } else { &fx.new };
    fx.pull(&fx.spaces_with_first(first), SessionEnd::Completed)
        .await;
    fx.assert_b_matches_a("move").await;
    assert_eq!(
        b_only_rows(&fx.pool_b, &fx.page).await,
        fx.b_only,
        "B keeps its own rows on the moved page"
    );
    fx.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_moved_page_survives_on_its_peer_when_the_new_space_arrives_first_5712() {
    a_move_reaches_b_whole(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_moved_page_survives_on_its_peer_when_the_old_space_arrives_first_5712() {
    a_move_reaches_b_whole(true).await;
}

/// `(parent_id, space_id, deleted_at)` of `id`'s row, `None` when it is gone.
async fn trash_row(
    pool: &SqlitePool,
    id: &str,
) -> Option<(Option<String>, Option<String>, Option<i64>)> {
    sqlx::query_as("SELECT parent_id, space_id, deleted_at FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .unwrap()
}

/// The `deleted_at` `mat`'s doc for `space` holds on `id`: `None` when the
/// doc has no node for it, `Some(None)` when the node is live.
fn doc_deleted_at(
    mat: &crate::materializer::Materializer,
    device: &str,
    space: &BlockId,
    id: &str,
) -> Option<Option<String>> {
    let space_id = agaric_store::space::SpaceId::from_trusted(space.as_str());
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space_id, device)
        .unwrap();
    let engine = guard.engine_mut();
    engine
        .contains_block(id)
        .then(|| engine.read_deleted_at(id).unwrap())
}

/// #6080: A trashes `first`, which takes `nested` with it, and B pulls; then
/// A moves the page to `new` and B pulls both docs, the old one first or not.
/// Returns `first` and `nested`, and the trash's `deleted_at`.
async fn trash_then_move(fx: &MoveFixture, old_space_first: bool) -> ([String; 2], i64) {
    let deleted_at =
        crate::commands::delete_block_inner(&fx.pool_a, "device-A", &fx.mat_a, fx.first.clone())
            .await
            .unwrap()
            .deleted_at;
    fx.mat_a.flush_background().await.unwrap();
    fx.pull(&[&fx.old, &fx.new], SessionEnd::Completed).await;
    let nested: String = sqlx::query_scalar("SELECT id FROM blocks WHERE parent_id = ?")
        .bind(fx.first.as_str())
        .fetch_one(&fx.pool_a)
        .await
        .unwrap();
    fx.move_on_a(&[&fx.page], &fx.new).await;
    for id in [fx.first.as_str(), nested.as_str()] {
        assert_eq!(
            doc_deleted_at(&fx.mat_a, "device-A", &fx.new, id),
            Some(Some(deleted_at.to_string())),
            "A's new doc holds {id} tombstoned at its delete"
        );
    }
    let first = if old_space_first { &fx.old } else { &fx.new };
    fx.pull(&fx.spaces_with_first(first), SessionEnd::Completed)
        .await;
    ([fx.first.as_str().to_owned(), nested], deleted_at)
}

/// #6080: blocks in the Trash move with their page. On both devices they stay
/// in the Trash at the same `deleted_at`, and the new doc holds them
/// tombstoned, so no sync purges them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_trashed_block_moves_with_its_page_and_stays_in_the_trash_on_both_devices_6080() {
    for old_space_first in [true, false] {
        let fx = move_fixture().await;
        let (trashed, deleted_at) = trash_then_move(&fx, old_space_first).await;
        let devices = [
            (&fx.pool_a, &fx.mat_a, "device-A"),
            (&fx.pool_b, &fx.mat_b, "device-B"),
        ];
        for (pool, _, device) in devices {
            for id in &trashed {
                assert_eq!(
                    trash_row(pool, id).await.map(|row| (row.1, row.2)),
                    Some((Some(fx.new.as_str().to_owned()), Some(deleted_at))),
                    "old space first {old_space_first}, {device}: {id} is in the Trash in `new`"
                );
            }
        }
        for (_, mat, device) in devices {
            for id in &trashed {
                assert_eq!(
                    (
                        doc_deleted_at(mat, device, &fx.new, id),
                        doc_deleted_at(mat, device, &fx.old, id)
                    ),
                    (Some(Some(deleted_at.to_string())), None),
                    "old space first {old_space_first}, {device}: only the new doc holds {id}, \
                     tombstoned"
                );
            }
        }
        fx.assert_b_matches_a(&format!("old space first {old_space_first}"))
            .await;
        fx.shutdown();
    }
}

/// #6080: restoring the block after the move reaches the peer. Both devices
/// hold it and its child live, under the same parents, in the new doc.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restoring_a_block_trashed_before_a_move_reaches_the_peer_6080() {
    let fx = move_fixture().await;
    let ([first, nested], deleted_at) = trash_then_move(&fx, true).await;
    let restored = crate::commands::restore_block_inner(
        &fx.pool_a,
        "device-A",
        &fx.mat_a,
        fx.first.clone(),
        deleted_at,
    )
    .await
    .unwrap();
    assert_eq!(
        restored.restored_count, 2,
        "the restore takes `first` and `nested`"
    );
    fx.mat_a.flush_background().await.unwrap();
    fx.pull(&fx.spaces_with_first(&fx.new), SessionEnd::Completed)
        .await;
    let new = Some(fx.new.as_str().to_owned());
    for (pool, mat, device) in [
        (&fx.pool_a, &fx.mat_a, "device-A"),
        (&fx.pool_b, &fx.mat_b, "device-B"),
    ] {
        for (id, parent) in [(&first, fx.page.as_str()), (&nested, first.as_str())] {
            assert_eq!(
                trash_row(pool, id).await,
                Some((Some(parent.to_owned()), new.clone(), None)),
                "{device}: {id} is live under {parent} in `new`"
            );
            assert_eq!(
                doc_deleted_at(mat, device, &fx.new, id),
                Some(None),
                "{device}: the new doc holds {id} live"
            );
        }
    }
    fx.assert_b_matches_a("restore after the move").await;
    fx.shutdown();
}

/// A device's `block_properties` rows, the text values included.
async fn property_rows(pool: &SqlitePool) -> Vec<(String, String, Option<String>)> {
    sqlx::query_as("SELECT block_id, key, value_text FROM block_properties ORDER BY block_id, key")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// The keys `mat`'s doc for `space` holds on each live block, by id.
fn doc_property_keys(
    mat: &crate::materializer::Materializer,
    device: &str,
    space: &BlockId,
) -> Vec<(String, Vec<String>)> {
    let space_id = agaric_store::space::SpaceId::from_trusted(space.as_str());
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space_id, device)
        .unwrap();
    let engine = guard.engine_mut();
    let mut live = engine.live_block_ids().unwrap();
    live.sort_unstable();
    live.into_iter()
        .map(|id| {
            let mut keys: Vec<String> = engine
                .read_all_properties_typed(&id)
                .unwrap()
                .into_iter()
                .map(|(key, _)| key)
                .collect();
            keys.sort();
            (id, keys)
        })
        .collect()
}

/// #5841 S0.6: `onlyold`, declared in `old` alone, is held by the page and
/// one of its blocks on both devices. A moves the page to `new`, which drops
/// both values once A acknowledges them; B pulls both docs in the given order
/// and ends with A's rows and docs, without the values.
async fn a_lossy_move_reaches_b_without_the_dropped_values(old_space_first: bool) {
    use crate::commands::{
        PropertyLoss, create_property_def_inner, move_blocks_to_space_inner,
        preview_space_move_inner, set_property_inner,
    };
    let fx = move_fixture().await;
    for (pool, device, mat) in [
        (&fx.pool_a, "device-A", &fx.mat_a),
        (&fx.pool_b, "device-B", &fx.mat_b),
    ] {
        create_property_def_inner(
            pool,
            device,
            mat,
            fx.old.as_str(),
            "onlyold".into(),
            "text".into(),
            None,
        )
        .await
        .unwrap();
    }
    for block in [&fx.page, &fx.first] {
        set_property_inner(
            &fx.pool_a,
            "device-A",
            &fx.mat_a,
            block.as_str().into(),
            "onlyold".into(),
            Some("value".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
    }
    fx.mat_a.flush_background().await.unwrap();
    fx.pull(&[&fx.old, &fx.new], SessionEnd::Completed).await;
    let onlyold_values = |rows: Vec<(String, String, Option<String>)>| {
        rows.into_iter().filter(|row| row.1 == "onlyold").count()
    };
    assert_eq!(
        onlyold_values(property_rows(&fx.pool_b).await),
        2,
        "precondition: B holds both values"
    );

    let losses = preview_space_move_inner(
        &fx.pool_a,
        vec![fx.page.clone()],
        fx.new.as_str().to_owned(),
    )
    .await
    .unwrap();
    assert_eq!(
        losses,
        vec![PropertyLoss {
            key: "onlyold".into(),
            count: 2
        }],
        "the move would drop both values"
    );
    move_blocks_to_space_inner(
        &fx.pool_a,
        "device-A",
        &fx.mat_a,
        vec![fx.page.clone()],
        fx.new.as_str().to_owned(),
        &losses,
    )
    .await
    .unwrap();
    fx.mat_a.flush_background().await.unwrap();
    assert_eq!(
        onlyold_values(property_rows(&fx.pool_a).await),
        0,
        "A dropped them"
    );

    let first = if old_space_first { &fx.old } else { &fx.new };
    fx.pull(&fx.spaces_with_first(first), SessionEnd::Completed)
        .await;
    fx.assert_b_matches_a("lossy move").await;
    assert_eq!(
        onlyold_values(property_rows(&fx.pool_b).await),
        0,
        "the dropped values left B too"
    );
    assert_eq!(
        property_rows(&fx.pool_b).await,
        property_rows(&fx.pool_a).await,
        "B's property rows equal A's"
    );
    for space in [&fx.old, &fx.new] {
        assert_eq!(
            doc_property_keys(&fx.mat_b, "device-B", space),
            doc_property_keys(&fx.mat_a, "device-A", space),
            "B's doc for space {space} holds A's properties"
        );
    }
    fx.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lossy_move_reaches_its_peer_without_the_dropped_values_when_the_new_space_arrives_first_5841()
 {
    a_lossy_move_reaches_b_without_the_dropped_values(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lossy_move_reaches_its_peer_without_the_dropped_values_when_the_old_space_arrives_first_5841()
 {
    a_lossy_move_reaches_b_without_the_dropped_values(true).await;
}

/// #5712: A moves the page to `new` and back. B pulls in between or not,
/// and in either order each time; it ends with A's rows and its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_moved_there_and_back_survives_on_its_peer_in_every_order_5712() {
    for between in [None, Some(true), Some(false)] {
        for back_departed_first in [true, false] {
            let label = format!("between {between:?}, back departed-first {back_departed_first}");
            let fx = move_fixture().await;
            fx.move_on_a(&[&fx.page], &fx.new).await;
            if let Some(departed_first) = between {
                let order = if departed_first {
                    fx.spaces_with_first(&fx.old)
                } else {
                    fx.spaces_with_first(&fx.new)
                };
                fx.pull(&order, SessionEnd::Completed).await;
            }
            fx.move_on_a(&[&fx.page], &fx.old).await;
            let order = if back_departed_first {
                fx.spaces_with_first(&fx.new)
            } else {
                fx.spaces_with_first(&fx.old)
            };
            fx.pull(&order, SessionEnd::Completed).await;
            fx.assert_b_matches_a(&label).await;
            assert_eq!(
                b_only_rows(&fx.pool_b, &fx.page).await,
                fx.b_only,
                "{label}: B keeps its own rows on the page"
            );
            fx.shutdown();
        }
    }
}

/// #5712: A moves the page and then purges it, or purges it where it is.
/// Either way the session that brings B the docs purges it there too, with
/// B's own rows on it, in both orders. The tag stays put: A's purge rebuilds
/// A's `block_tag_refs` whole, which drops a tag ref across spaces, while an
/// inbound import never rebuilds that cache whole (#2667).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_purge_reaches_the_peer_after_a_move_or_without_one_5712() {
    for move_first in [true, false] {
        for old_space_first in [true, false] {
            let label = format!("move first {move_first}, old space first {old_space_first}");
            let fx = move_fixture().await;
            if move_first {
                fx.move_on_a(&[&fx.page], &fx.new).await;
            }
            fx.purge_on_a(&fx.page).await;
            let first = if old_space_first { &fx.old } else { &fx.new };
            fx.pull(&fx.spaces_with_first(first), SessionEnd::Completed)
                .await;
            fx.assert_b_matches_a(&label).await;
            assert_eq!(
                b_only_rows(&fx.pool_b, &fx.page).await,
                BOnlyRows::NONE,
                "{label}: B's own rows go with the purged page"
            );
            fx.shutdown();
        }
    }
}

/// #5712: a session that brings only the old space's doc and stops before
/// its end deletes nothing; the next one brings the new doc, which claims
/// every deferred block.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_interrupted_session_keeps_the_rows_for_the_next_one_5712() {
    let fx = move_fixture().await;
    let before = shared_rows(&fx.pool_b).await;
    fx.move_on_a(&[&fx.page, &fx.tag], &fx.new).await;
    fx.pull(&[&fx.old], SessionEnd::Interrupted).await;
    assert_eq!(
        (
            shared_rows(&fx.pool_b).await,
            b_only_rows(&fx.pool_b, &fx.page).await
        ),
        (before, fx.b_only.clone()),
        "the interrupted session deletes nothing"
    );
    assert_eq!(
        deferred_purges(&fx.pool_b).await.len(),
        5,
        "the page, its three blocks and the tag wait for the session's end"
    );
    fx.pull(&[&fx.new, &fx.old], SessionEnd::Completed).await;
    fx.assert_b_matches_a("next session").await;
    assert_eq!(
        b_only_rows(&fx.pool_b, &fx.page).await,
        fx.b_only,
        "B keeps its own rows on the moved page"
    );
    fx.shutdown();
}

/// #5712, the documented gap: a session that completes with the old space's
/// doc but not the new one sweeps the moved blocks, as a purge. The new doc
/// brings the blocks back next time, and with them the ref and the tag on
/// `notes`, which the old doc still holds (#6236). B's own rows stay lost, and
/// so does the link on `notes`: nothing re-projects it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_without_the_new_doc_sweeps_the_moved_page_5712() {
    let fx = move_fixture().await;
    fx.move_on_a(&[&fx.page, &fx.tag], &fx.new).await;
    fx.pull(&[&fx.old], SessionEnd::Completed).await;
    let page_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(fx.page.as_str())
        .fetch_one(&fx.pool_b)
        .await
        .unwrap();
    assert_eq!(page_rows, 0, "the sweep took the page");

    fx.pull(&[&fx.new], SessionEnd::Completed).await;
    let (a, b) = (shared_rows(&fx.pool_a).await, shared_rows(&fx.pool_b).await);
    assert_eq!(b.blocks, a.blocks, "the new doc brings every block back");
    let note = fx.note.as_str().to_owned();
    let (page, tag) = (fx.page.as_str().to_owned(), fx.tag.as_str().to_owned());
    assert_eq!(
        (
            a.value_refs
                .contains(&(note.clone(), "related".into(), page.clone())),
            a.links.contains(&(note.clone(), page.clone())),
            a.tags.contains(&(note.clone(), tag.clone())),
        ),
        (true, true, true),
        "A keeps the rows that point at the page and the tag"
    );
    assert_eq!(
        (
            b.value_refs
                .contains(&(note.clone(), "related".into(), page.clone())),
            b.links.contains(&(note.clone(), page)),
            b.tags.contains(&(note, tag)),
        ),
        (true, false, true),
        "the ref and the tag come back from the doc that holds them (#6236); the link stays lost"
    );
    assert_eq!(
        b_only_rows(&fx.pool_b, &fx.page).await.drafts,
        Vec::<(String, String)>::new(),
        "B lost its draft"
    );
    fx.shutdown();
}

/// One real QUIC session in which B pulls from A, each side running the
/// production session code: `run_sync_session` against `handle_incoming_sync`.
/// Returns B's terminal state.
async fn pull_over_quic(
    pool_a: &SqlitePool,
    mat_a: &crate::materializer::Materializer,
    pool_b: &SqlitePool,
    mat_b: &crate::materializer::Materializer,
) -> agaric_sync::sync_protocol::SyncState {
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use agaric_sync::sync_events::{RecordingEventSink, SyncEventSink};

    let timeout = std::time::Duration::from_secs(30);
    let harness = agaric_sync::transport::test_support::ServiceHarness::new().await;
    // A resolves B from the key the QUIC handshake authenticated.
    agaric_store::peer_refs::upsert_peer_ref(pool_a, "device-B")
        .await
        .unwrap();
    agaric_store::peer_refs::bind_endpoint_id(
        pool_a,
        "device-B",
        &harness.client_endpoint.id().to_string(),
    )
    .await
    .unwrap();
    let service = Arc::clone(&harness.service);
    let (pool_a, mat_a) = (pool_a.clone(), mat_a.clone());
    let responder = tokio::spawn(async move {
        let session = service
            .accept()
            .await
            .expect("the accept loop does not error")
            .expect("B is admitted")
            .establish()
            .await
            .expect("B opens its stream");
        agaric_sync::sync_daemon::handle_incoming_sync(
            session,
            pool_a,
            "device-A".into(),
            Arc::new(mat_a),
            Arc::new(agaric_sync::sync_scheduler::SyncScheduler::new()),
            Arc::new(RecordingEventSink::new()),
            Arc::new(AtomicBool::new(false)),
        )
        .await
    });

    let mut client = harness.dial().await;
    let mut orch = agaric_sync::sync_protocol::SyncOrchestrator::new(
        pool_b.clone(),
        "device-B".into(),
        Arc::new(mat_b.clone()),
    )
    .with_expected_remote_id("device-A".into());
    let host: Arc<dyn agaric_sync::apply_host::ApplyHost> = Arc::new(mat_b.clone());
    let sink: Arc<dyn SyncEventSink> = Arc::new(RecordingEventSink::new());
    tokio::time::timeout(
        timeout,
        agaric_sync::sync_daemon::run_sync_session(
            &mut orch,
            &mut client.send,
            &mut client.recv,
            &client.conn,
            &AtomicBool::new(false),
            pool_b,
            &host,
            &sink,
        ),
    )
    .await
    .expect("B's session timed out")
    .expect("B's session");
    tokio::time::timeout(timeout, responder)
        .await
        .expect("A's session timed out")
        .expect("A's session panicked")
        .expect("A's session");
    orch.session().state.clone()
}

/// #5712 over a real QUIC session: A moves `page` from `old` to `new` and
/// `away` from `new` to `old`, and B pulls both moves in one session. A sends
/// its spaces in `HashMap` order, and whichever comes first is one page's old
/// doc, so each run puts an old-doc-first import under test.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crossing_moves_reach_the_peer_whole_over_quic_5712() {
    use crate::commands::pages::record_page_open_inner;
    use crate::commands::{create_block_inner, create_page_in_space_inner};

    let fx = move_fixture().await;
    let away = create_page_in_space_inner(
        &fx.pool_a,
        "device-A",
        &fx.mat_a,
        None,
        "Away".into(),
        fx.new.as_str().to_owned(),
    )
    .await
    .unwrap();
    let away_child = create_block_inner(
        &fx.pool_a,
        "device-A",
        &fx.mat_a,
        "content".into(),
        "far".into(),
        Some(away.clone()),
        None,
    )
    .await
    .unwrap()
    .id;
    fx.mat_a.flush_background().await.unwrap();
    fx.pull(&[&fx.new], SessionEnd::Completed).await;
    agaric_engine::draft::save_draft(&fx.pool_b, "device-B", away_child.as_str(), "far words")
        .await
        .unwrap();
    record_page_open_inner(&fx.pool_b, away.clone())
        .await
        .unwrap();
    let b_only = b_only_rows(&fx.pool_b, &fx.page).await;
    assert_eq!(
        (b_only.drafts.len(), b_only.opens.len()),
        (2, 2),
        "precondition: B holds a draft and an open on each page"
    );

    fx.move_on_a(&[&fx.page], &fx.new).await;
    fx.move_on_a(&[&away], &fx.old).await;
    assert_eq!(
        pull_over_quic(&fx.pool_a, &fx.mat_a, &fx.pool_b, &fx.mat_b).await,
        agaric_sync::sync_protocol::SyncState::Complete,
        "B's pull completes"
    );
    fx.mat_b.flush_inbound_rebuilds().await.unwrap();

    fx.assert_b_matches_a("crossing moves over QUIC").await;
    assert_eq!(
        b_only_rows(&fx.pool_b, &fx.page).await,
        b_only,
        "B keeps its own rows on both pages"
    );
    fx.shutdown();
}

// ---------------------------------------------------------------------------
// #6048: "Last edited" on the device that receives a block by sync
// ---------------------------------------------------------------------------

/// Two vaults holding the space `space`, which A created and B pulled over
/// QUIC, audit records included.
struct SyncedPair {
    pool_a: SqlitePool,
    mat_a: crate::materializer::Materializer,
    pool_b: SqlitePool,
    mat_b: crate::materializer::Materializer,
    space: BlockId,
    _dir_a: TempDir,
    _dir_b: TempDir,
}

impl SyncedPair {
    async fn new() -> Self {
        use crate::materializer::Materializer;

        let (pool_a, dir_a) = test_pool().await;
        let mat_a = Materializer::new(pool_a.clone());
        super::bootstrap::bootstrap_spaces(&pool_a, "device-A", &mat_a)
            .await
            .unwrap();
        let space =
            crate::commands::create_space_inner(&pool_a, "device-A", &mat_a, "Shared".into(), None)
                .await
                .unwrap();
        let (pool_b, dir_b) = test_pool().await;
        let mat_b = Materializer::new(pool_b.clone());
        super::bootstrap::bootstrap_spaces(&pool_b, "device-B", &mat_b)
            .await
            .unwrap();
        let pair = Self {
            pool_a,
            mat_a,
            pool_b,
            mat_b,
            space,
            _dir_a: dir_a,
            _dir_b: dir_b,
        };
        pair.pull().await;
        pair
    }

    async fn page_on_a(&self, title: &str) -> BlockId {
        crate::commands::create_page_in_space_inner(
            &self.pool_a,
            "device-A",
            &self.mat_a,
            None,
            title.into(),
            self.space.as_str().to_owned(),
        )
        .await
        .unwrap()
    }

    async fn block_on_a(&self, parent: &BlockId, content: &str) -> BlockId {
        crate::commands::create_block_inner(
            &self.pool_a,
            "device-A",
            &self.mat_a,
            "content".into(),
            content.into(),
            Some(parent.clone()),
            None,
        )
        .await
        .unwrap()
        .id
    }

    /// B pulls from A, then drains the rebuild the session armed, as
    /// `SpacePlacementSink` does after every pull that changed something.
    async fn pull(&self) {
        self.mat_a.flush_background().await.unwrap();
        assert_eq!(
            pull_over_quic(&self.pool_a, &self.mat_a, &self.pool_b, &self.mat_b).await,
            agaric_sync::sync_protocol::SyncState::Complete,
            "B's pull completes"
        );
        self.mat_b.flush_inbound_rebuilds().await.unwrap();
    }

    /// The App health check finds no `pages_cache.last_edited_ms` divergence
    /// on B, and B's Last-edited time on each of `pages` is A's.
    async fn assert_b_last_edited_matches_a(&self, pages: &[&BlockId], label: &str) {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 24).unwrap();
        let divergences: Vec<String> = crate::reconciliation_oracle::reconcile_all(
            &self.pool_b,
            self.mat_b.loro_state(),
            None,
            today,
        )
        .await
        .unwrap()
        .into_iter()
        .filter(|d| d.artefact == "pages_cache.last_edited_ms")
        .map(|d| d.to_string())
        .collect();
        assert_eq!(
            (divergences, last_edited_ms(&self.pool_b, pages).await),
            (
                Vec::<String>::new(),
                last_edited_ms(&self.pool_a, pages).await
            ),
            "{label}: B's Last edited must pass the App health check and equal A's"
        );
    }

    fn shutdown(&self) {
        self.mat_a.shutdown();
        self.mat_b.shutdown();
    }
}

/// Each page's `pages_cache.last_edited_ms`, `None` for a page with no row.
async fn last_edited_ms(pool: &SqlitePool, pages: &[&BlockId]) -> Vec<Option<i64>> {
    let mut times = Vec::new();
    for page in pages {
        times.push(
            sqlx::query_scalar("SELECT last_edited_ms FROM pages_cache WHERE page_id = ?")
                .bind(page.as_str())
                .fetch_optional(pool)
                .await
                .unwrap(),
        );
    }
    times
}

/// #6048: A adds a block to a page B holds. B projects the block with
/// `page_id` NULL, so its op raises the page only once the rebuild has
/// filled it in.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peers_new_block_raises_its_pages_last_edited_6048() {
    let fx = SyncedPair::new().await;
    let page = fx.page_on_a("Plan").await;
    fx.pull().await;

    fx.block_on_a(&page, "from the phone").await;
    fx.pull().await;

    fx.assert_b_last_edited_matches_a(&[&page], "a peer's new block")
        .await;
    fx.shutdown();
}

/// #6048: A moves a block to another page. B keeps the block's old
/// `page_id` until the rebuild; the move raises the new page and, as a local
/// move does, leaves the old one alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peers_cross_page_move_raises_the_new_page_6048() {
    let fx = SyncedPair::new().await;
    let from = fx.page_on_a("From").await;
    let to = fx.page_on_a("To").await;
    let block = fx.block_on_a(&from, "moving").await;
    fx.pull().await;

    crate::commands::move_block_inner(
        &fx.pool_a,
        "device-A",
        &fx.mat_a,
        block,
        Some(to.clone()),
        1,
    )
    .await
    .unwrap();
    fx.pull().await;

    fx.assert_b_last_edited_matches_a(&[&from, &to], "a peer's cross-page move")
        .await;
    fx.shutdown();
}

/// #6048: A creates a page with blocks under it. B gives the page its row
/// before the blocks have their `page_id`, so the blocks' ops still have to
/// raise it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_peers_new_page_takes_its_newest_blocks_time_6048() {
    let fx = SyncedPair::new().await;
    let page = fx.page_on_a("Fresh").await;
    // The blocks' ops must be newer than the page's own, or the page's own
    // time is already the newest and a miss shows nothing.
    let page_ms = last_edited_ms(&fx.pool_a, &[&page]).await[0].unwrap();
    while agaric_store::db::now_ms() <= page_ms {
        tokio::task::yield_now().await;
    }
    let first = fx.block_on_a(&page, "first").await;
    fx.block_on_a(&first, "nested").await;
    fx.pull().await;

    fx.assert_b_last_edited_matches_a(&[&page], "a peer's new page")
        .await;
    fx.shutdown();
}
