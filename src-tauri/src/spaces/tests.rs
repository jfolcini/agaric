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
    SPACE_PERSONAL_DEFAULT_ACCENT, SPACE_PERSONAL_ULID, SPACE_WORK_DEFAULT_ACCENT, SPACE_WORK_ULID,
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
// FEAT-3p10 — Default accent_color seeding for Personal + Work.
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
    let pattern = format!("%\"key\":\"{}\"%", key);
    sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM op_log
           WHERE op_type = 'set_property'
             AND block_id = ?
             AND payload LIKE ?"#,
    )
    .bind(block_id)
    .bind(pattern)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// FEAT-3p10 — fresh bootstrap seeds the two default accent tokens
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
        "Personal must seed accent_color = '{}'",
        SPACE_PERSONAL_DEFAULT_ACCENT
    );
    assert_eq!(
        accent_color_property(&pool, SPACE_WORK_ULID)
            .await
            .as_deref(),
        Some(SPACE_WORK_DEFAULT_ACCENT),
        "Work must seed accent_color = '{}'",
        SPACE_WORK_DEFAULT_ACCENT
    );

    // Sanity check that bootstrap is operating in a valid steady state
    // — the seeded tokens must differ so the visual identity is
    // distinguishable at a glance (the spec rationale for FEAT-3p10).
    assert_ne!(
        SPACE_PERSONAL_DEFAULT_ACCENT, SPACE_WORK_DEFAULT_ACCENT,
        "seeded defaults must differ to give the two spaces distinct identity"
    );
}

/// FEAT-3p10 — running bootstrap twice on a vanilla install must not
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
// BUG-1 / L-133 — bootstrap re-runs `pages_without_space` every boot.
// ---------------------------------------------------------------------
//
// Pages that arrive without a `space` property — via a misbehaving
// frontend, a sync replay from a peer that bypassed the invariant, or
// any other path — are captured by the every-boot backfill and
// assigned to the seeded Personal space. The seeded-block fast-path
// (which avoids re-emitting `is_space` / `accent_color` ops) is
// preserved.

/// FEAT-3p10 keeps `is_space` ops fast-pathed to "emit once". This
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

/// BUG-1 / L-133 regression — after the bootstrap-complete marker
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
    // a `space` property — exactly the bypass-path scenario BUG-1
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

/// BUG-1 / L-133 — the seeded-block fast path is intentionally
/// preserved. `is_space = "true"` SetProperty ops must fire ONLY on
/// the first boot (FEAT-3p10 invariant). This test pins the fact
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

/// M-92 regression: the batched migrator must correctly span multiple
/// chunks. The chunk size is `MAX_SQL_PARAMS / 6 = 166` rows; seeding
/// 200 unscoped pages exercises the two-chunk path (chunk #1 = 166 rows,
/// chunk #2 = 34 rows). Confirms:
///
/// - Every page ends up with `space = SPACE_PERSONAL_ULID`.
/// - Exactly N `SetProperty(key='space')` ops are appended (one per
///   page, mirroring the pre-batch behaviour — the op_log invariant
///   was preserved across the perf change).
/// - A second `bootstrap_spaces` call appends zero new ops
///   (idempotent — `pages_without_space` short-circuits because every
///   page now carries `space`).
#[tokio::test]
async fn bootstrap_batched_migrator_handles_more_than_one_chunk() {
    let (pool, _dir) = test_pool().await;

    // 200 > 166 (= MAX_SQL_PARAMS / 6), so the multi-chunk path is exercised.
    const N: usize = 200;
    for i in 0..N {
        // 26-char Crockford-base32 ULID: `01JABCDE` (8) +
        // `0000000000000` (13) + `{:05}` (5) — all chars are valid
        // Crockford (no I/L/O/U). Indices 00000..00199.
        let id = format!("01JABCDE0000000000000{:05}", i);
        debug_assert_eq!(id.len(), 26, "test fixture must produce a 26-char ULID");
        insert_page(&pool, &id, "page").await;
    }

    bootstrap_spaces(&pool, DEV).await.unwrap();

    // Every page gets the Personal-space ref — confirms both chunks
    // landed (a regression where the second chunk's binding loop was
    // wrong would leave pages 167..200 unscoped).
    for i in 0..N {
        let id = format!("01JABCDE0000000000000{:05}", i);
        assert_eq!(
            space_property(&pool, &id).await.as_deref(),
            Some(SPACE_PERSONAL_ULID),
            "page {id} must be migrated to Personal"
        );
    }

    // Op-log invariant — one SetProperty(space=…) op per migrated page.
    let space_ops = count_set_property_ops_for_key(&pool, "space").await;
    assert_eq!(
        space_ops, N as i64,
        "exactly {N} SetProperty(key='space') ops in op_log; got {space_ops}"
    );

    // Idempotency — a second bootstrap call sees zero candidates and
    // appends zero new ops (pages_without_space's NOT EXISTS filter
    // short-circuits). This is the steady-state guarantee that gates
    // the batched migrator behind a no-op check on every subsequent boot.
    let ops_before = count_rows(&pool, "op_log").await;
    bootstrap_spaces(&pool, DEV).await.unwrap();
    let ops_after = count_rows(&pool, "op_log").await;
    assert_eq!(
        ops_before, ops_after,
        "second bootstrap call must append zero new ops (idempotent)"
    );
}

// ---------------------------------------------------------------------
// BUG-1 / H-3c — Property-test-style invariant: every page block has a
// `space` property.
// ---------------------------------------------------------------------
//
// Rust uses neither `proptest` nor `quickcheck` in this repo, so we
// ship a deterministic regression-style scenario test instead. The
// scenarios cover the three documented bypass paths:
//
//   1. Legacy `create_block(page)` direct IPC call — refused at the
//      IPC boundary by the H-3a tightening (see `block_cmd_tests.rs`).
//   2. `create_page_in_space` — emits the page WITH its `space`
//      property atomically.
//   3. Sync replay of legacy ops (or any path that lands a page row
//      without `space` post-bootstrap) — caught by the L-133
//      every-boot backfill.
//
// The invariant: AFTER `bootstrap_spaces` has run, EVERY live,
// non-conflict page block in the materialized state has either a
// `space` property pointing at a valid space block, OR carries
// `is_space = "true"` (i.e. is itself a space block).

/// Helper: assert the BUG-1 invariant holds for the entire pool.
async fn assert_every_page_has_space_or_is_space(pool: &SqlitePool) {
    let leaks: Vec<String> = sqlx::query_scalar!(
        r#"SELECT id as "id!: String" FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id AND p.key = 'space'
             )
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
        "BUG-1 invariant violated: pages missing `space` AND `is_space`: {leaks:?}"
    );
}

/// Property-style regression: scenario sequence covering every BUG-1
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
        r#"SELECT block_id as "id!: String" FROM block_properties
           WHERE key = 'space' AND value_ref = ?"#,
        SPACE_PERSONAL_ULID,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let work_pages: Vec<String> = sqlx::query_scalar!(
        r#"SELECT block_id as "id!: String" FROM block_properties
           WHERE key = 'space' AND value_ref = ?"#,
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
