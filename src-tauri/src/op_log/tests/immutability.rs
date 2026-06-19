//! Immutability-trigger (H-13) and compaction-bypass tests.
//!
//! Split out of the former `op_log/mod.rs` `#[cfg(test)] mod tests` block (#1659).

use super::*;

// ── Immutability triggers (H-13) ────────────────────────────────────

/// Migration 0036 installs BEFORE UPDATE / BEFORE DELETE triggers on
/// `op_log` that ABORT with the documented message unless the
/// compaction bypass sentinel is present. This test asserts the
/// trigger now fires for bare UPDATE/DELETE statements issued
/// outside the compaction code path.
///
/// Was previously `op_log_update_not_blocked_by_schema` — documented
/// the gap (no enforcement). H-13 closed that gap; the assertion is
/// inverted accordingly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn op_log_update_blocked_by_trigger() {
    let (pool, _dir) = test_pool().await;

    // Append an op so there is a row to attempt to mutate.
    append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-IMMUT"),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Attempt UPDATE — must ABORT with the H-13 trigger message.
    let update_result =
        sqlx::query("UPDATE op_log SET payload = '{}' WHERE device_id = ? AND seq = 1")
            .bind(TEST_DEVICE)
            .execute(&pool)
            .await;

    let update_err = update_result.expect_err("bare UPDATE on op_log must ABORT (H-13)");
    let update_msg = format!("{update_err:?}");
    assert!(
        update_msg.contains("op_log is append-only"),
        "UPDATE should abort with H-13 trigger message, got: {update_msg}"
    );
    assert!(
        update_msg.contains("UPDATE forbidden outside compaction"),
        "UPDATE abort message must name the operation, got: {update_msg}"
    );

    // Confirm the row is unchanged (trigger fired BEFORE the UPDATE
    // touched the row).
    let payload: String = sqlx::query_scalar!(
        "SELECT payload FROM op_log WHERE device_id = ? AND seq = 1",
        TEST_DEVICE
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(
        payload, "{}",
        "row payload must be untouched after aborted UPDATE"
    );

    // Attempt DELETE — must ABORT with the H-13 trigger message.
    let delete_result = sqlx::query("DELETE FROM op_log WHERE device_id = ? AND seq = 1")
        .bind(TEST_DEVICE)
        .execute(&pool)
        .await;

    let delete_err = delete_result.expect_err("bare DELETE on op_log must ABORT (H-13)");
    let delete_msg = format!("{delete_err:?}");
    assert!(
        delete_msg.contains("op_log is append-only"),
        "DELETE should abort with H-13 trigger message, got: {delete_msg}"
    );
    assert!(
        delete_msg.contains("DELETE forbidden outside compaction"),
        "DELETE abort message must name the operation, got: {delete_msg}"
    );

    // Confirm the row is still present (trigger fired BEFORE the DELETE
    // removed the row).
    let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "op_log row must survive aborted DELETE");
}

/// The compaction bypass helper pair must let UPDATE/DELETE proceed
/// when invoked through the documented enable → mutate → disable →
/// commit dance. Mirrors the production compaction code path.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_path_with_bypass_succeeds() {
    let (pool, _dir) = test_pool().await;

    append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-COMPACT"),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Run the canonical compaction dance: BEGIN IMMEDIATE → enable →
    // UPDATE / DELETE → disable → commit.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    super::enable_op_log_mutation_bypass(&mut tx).await.unwrap();

    let update_res = sqlx::query(
        "UPDATE op_log SET payload = '{\"compacted\":true}' WHERE device_id = ? AND seq = 1",
    )
    .bind(TEST_DEVICE)
    .execute(&mut *tx)
    .await
    .expect("UPDATE inside bypass must succeed");
    assert_eq!(
        update_res.rows_affected(),
        1,
        "exactly one row should be updated under bypass"
    );

    let delete_res = sqlx::query("DELETE FROM op_log WHERE device_id = ? AND seq = 1")
        .bind(TEST_DEVICE)
        .execute(&mut *tx)
        .await
        .expect("DELETE inside bypass must succeed");
    assert_eq!(
        delete_res.rows_affected(),
        1,
        "exactly one row should be deleted under bypass"
    );

    super::disable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // After commit the op_log is empty (DELETE took effect) and the
    // sentinel is gone (so subsequent connections still see the
    // immutability invariant).
    let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "DELETE under bypass must have taken effect");

    let sentinel: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM _op_log_mutation_allowed")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sentinel, 0, "bypass sentinel must be cleared after commit");
}

/// Verify that enabling the bypass on connection A does not leak the
/// sentinel to a sibling connection B: while A holds an open tx with
/// the sentinel inserted (uncommitted), B must (a) not see the
/// sentinel via a SELECT, and (b) once A commits with the sentinel
/// cleared, observe a bare UPDATE still aborting.
///
/// This is the H-13 connection-isolation guarantee: WAL semantics
/// ensure the sentinel is invisible across connections while it lives
/// only as a pending write inside A's tx.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compaction_bypass_does_not_leak_to_sibling_connection() {
    let (pool, _dir) = test_pool().await;

    // Append an op so there is a row B can attempt to mutate.
    append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-LEAK"),
        FIXED_TS,
    )
    .await
    .unwrap();

    // Connection A: open a write tx and enable the bypass. Hold the
    // tx open without committing.
    let mut tx_a = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    super::enable_op_log_mutation_bypass(&mut tx_a)
        .await
        .unwrap();

    // Connection B (separate read from the pool): must not observe
    // A's uncommitted sentinel insert. WAL gives B a snapshot from
    // before A's BEGIN IMMEDIATE.
    let sentinel_seen_by_b: i64 =
        sqlx::query_scalar!("SELECT COUNT(*) FROM _op_log_mutation_allowed")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        sentinel_seen_by_b, 0,
        "sibling connection must not observe A's uncommitted bypass sentinel"
    );

    // Tear down A cleanly: clear the sentinel and commit.
    super::disable_op_log_mutation_bypass(&mut tx_a)
        .await
        .unwrap();
    tx_a.commit().await.unwrap();

    // Connection B (post-A-commit): a bare UPDATE on op_log must
    // still ABORT with the H-13 trigger message — proving the
    // bypass A briefly held did not leak past A's tx boundary.
    let result = sqlx::query("UPDATE op_log SET payload = '{}' WHERE device_id = ? AND seq = 1")
        .bind(TEST_DEVICE)
        .execute(&pool)
        .await;
    let err = result.expect_err("sibling connection's UPDATE must ABORT after A's commit");
    let msg = format!("{err:?}");
    assert!(
        msg.contains("op_log is append-only"),
        "sibling UPDATE should abort with H-13 trigger message, got: {msg}"
    );
}

/// PEND-35 Tier 3.1: migration 0048 retires the expression index
/// `idx_op_log_payload_block_id` from migration 0003 because the four
/// remaining query sites in `pagination/history.rs` and
/// `commands/history.rs` now read the native `op_log.block_id` column
/// (added by migration 0030 and covered by `idx_op_log_block_id`).
/// This test guards both halves: the legacy expression index is gone,
/// and the native column index is in place.
#[tokio::test]
async fn op_log_block_id_indexes_post_migration_0048() {
    let (pool, _dir) = test_pool().await;

    let legacy = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_op_log_payload_block_id'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        legacy, 0,
        "migration 0048 must drop idx_op_log_payload_block_id (the json_extract expression index)"
    );

    let native = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_op_log_block_id'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        native, 1,
        "idx_op_log_block_id (native column index from migration 0030) must remain"
    );
}

/// SQL-review H-2 / migration 0065: the `page_link_cache` table and
/// its companion `idx_page_link_cache_target` secondary index must
/// exist after migrations run. This pins the schema contract that
/// `commands::pages::list_page_links_inner` and
/// `cache::page_links::{reindex_page_link_cache_for_block,
/// rebuild_page_link_cache}` rely on. Mirrors the
/// `op_log_block_id_indexes_post_migration_0048` shape.
#[tokio::test]
async fn page_link_cache_table_post_migration_0065() {
    let (pool, _dir) = test_pool().await;

    let table_count = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'table' AND name = 'page_link_cache'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        table_count, 1,
        "migration 0065 must create the `page_link_cache` table"
    );

    // The PK is the implicit covering index on
    // `(source_page_id, target_page_id)` — SQLite emits the autoindex
    // under a `sqlite_autoindex_page_link_cache_*` name, so we
    // assert via `pragma_index_list` rather than a literal name.
    let pk_indexes = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM pragma_index_list('page_link_cache') \
             WHERE origin = 'pk' AND \"unique\" = 1"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        pk_indexes, 1,
        "page_link_cache must have a unique PK covering index on (source_page_id, target_page_id)"
    );

    let target_idx_count = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'index' AND name = 'idx_page_link_cache_target'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        target_idx_count, 1,
        "migration 0065 must create `idx_page_link_cache_target` for reverse-edge lookups"
    );
}

/// PEND-56b / migration 0069 (inbound shape refined by PEND-58d D2 /
/// migration 0070): `pages_cache` must carry the materialised
/// `inbound_link_count` + `child_block_count` INTEGER columns with
/// `NOT NULL DEFAULT 0`. The CURRENT inbound backfill (migration 0070)
/// uses the **exact SQL shape** of the live IPC aggregate maintained by
/// `recompute_pages_cache_counts_for_pages` and mirrored in
/// `backlink/grouped.rs` — JOINing the source block and excluding
/// same-page / self / deleted-source / orphan edges. This test seeds a
/// fixture and asserts that the same SQL applied to fresh rows produces
/// the expected counts, locking in the backfill contract that the
/// materializer hooks must thereafter maintain at O(1) per op.
#[tokio::test]
async fn pages_cache_link_and_content_counts_post_migration_0069() {
    let (pool, _dir) = test_pool().await;

    // (a) Schema guards: both columns exist, both are INTEGER, both
    // NOT NULL with DEFAULT 0.
    let inbound: (String, i64, Option<String>) = sqlx::query_as(
        "SELECT \"type\", \"notnull\", dflt_value \
             FROM pragma_table_info('pages_cache') WHERE name = 'inbound_link_count'",
    )
    .fetch_one(&pool)
    .await
    .expect("migration 0069 must add `inbound_link_count` to pages_cache");
    assert_eq!(inbound.0, "INTEGER");
    assert_eq!(inbound.1, 1);
    assert_eq!(inbound.2.as_deref(), Some("0"));

    let child: (String, i64, Option<String>) = sqlx::query_as(
        "SELECT \"type\", \"notnull\", dflt_value \
             FROM pragma_table_info('pages_cache') WHERE name = 'child_block_count'",
    )
    .fetch_one(&pool)
    .await
    .expect("migration 0069 must add `child_block_count` to pages_cache");
    assert_eq!(child.0, "INTEGER");
    assert_eq!(child.1, 1);
    assert_eq!(child.2.as_deref(), Some("0"));

    // (b) Backfill contract: seed two pages with descendants + a
    // soft-deleted descendant + cross-page links + a soft-deleted
    // source, then re-run the **same UPDATE SQL** the current migration
    // (0070) uses and assert the result matches what the live IPC /
    // materializer aggregate would compute.
    //
    // Topology:
    //   PAGE_A (page) — children: A_C1 (live), A_C2 (live), A_C3 (deleted)
    //   PAGE_B (page) — children: B_C1 (live)
    //   Links (source -> target):
    //     A_C1 -> PAGE_B      (inbound to PAGE_B)
    //     A_C2 -> PAGE_B      (inbound to PAGE_B, dedup'd by DISTINCT — but
    //                          source is distinct so it does count)
    //     A_C3 -> PAGE_B      (A_C3 is a soft-deleted SOURCE — excluded
    //                          by `src.deleted_at IS NULL` per PEND-58d
    //                          D2 / migration 0070, so it does NOT count)
    //     B_C1 -> PAGE_A      (inbound to PAGE_A)
    //     B_C1 -> A_C1        (inbound, but A_C1.page_id = PAGE_A so this
    //                          contributes one DISTINCT source to PAGE_A)
    //
    // Expected (matching the live IPC `COUNT(DISTINCT bl.source_id)`
    // with the PEND-58d D2 source-side exclusions):
    //   PAGE_A.inbound_link_count = 1  (only B_C1 across both edges)
    //   PAGE_B.inbound_link_count = 2  (A_C1, A_C2; A_C3 is a deleted source)
    //   PAGE_A.child_block_count  = 2  (A_C1, A_C2 — A_C3 is deleted)
    //   PAGE_B.child_block_count  = 1  (B_C1)
    for (id, page_id, deleted) in [
        ("PAGE_A", "PAGE_A", false),
        ("PAGE_B", "PAGE_B", false),
        ("A_C1", "PAGE_A", false),
        ("A_C2", "PAGE_A", false),
        ("A_C3", "PAGE_A", true),
        ("B_C1", "PAGE_B", false),
    ] {
        let deleted_at = if deleted {
            Some(1_736_942_400_000_i64) // 2025-01-15T12:00:00Z
        } else {
            None
        };
        sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at, page_id) \
                 VALUES (?, 'content', '', NULL, 1, ?, ?)",
            )
            .bind(id)
            .bind(deleted_at)
            .bind(page_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    // pages_cache rows for the two pages (matches the materializer's
    // post-CreateBlock writes).
    for page_id in ["PAGE_A", "PAGE_B"] {
        sqlx::query(
            "INSERT INTO pages_cache (page_id, title, updated_at) \
                 VALUES (?, ?, 1736942400000)",
        )
        .bind(page_id)
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
    }

    for (source, target) in [
        ("A_C1", "PAGE_B"),
        ("A_C2", "PAGE_B"),
        ("A_C3", "PAGE_B"),
        ("B_C1", "PAGE_A"),
        ("B_C1", "A_C1"),
    ] {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(source)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap();
    }

    // Re-run the corrected backfill (migration 0070 shape — the new
    // rows were inserted after migrations applied, so their counts are
    // still the DEFAULT 0). PEND-58d D2: the inbound side now JOINs the
    // source block and excludes same-page / self / deleted-source /
    // orphan edges, matching `recompute_pages_cache_counts_for_pages`
    // and `backlink/grouped.rs`.
    sqlx::query(
        "UPDATE pages_cache SET inbound_link_count = ( \
                 SELECT COUNT(DISTINCT bl.source_id) FROM block_links AS bl \
                 INNER JOIN blocks AS descendant ON bl.target_id = descendant.id \
                 INNER JOIN blocks AS src ON src.id = bl.source_id \
                 WHERE descendant.page_id = pages_cache.page_id \
                   AND descendant.deleted_at IS NULL \
                   AND src.deleted_at IS NULL \
                   AND src.page_id IS NOT NULL \
                   AND src.page_id != pages_cache.page_id)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE pages_cache SET child_block_count = ( \
                 SELECT COUNT(*) FROM blocks AS descendant \
                 WHERE descendant.page_id = pages_cache.page_id \
                   AND descendant.deleted_at IS NULL \
                   AND descendant.id != pages_cache.page_id)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let row_a = sqlx::query!(
        "SELECT inbound_link_count AS \"i!: i64\", child_block_count AS \"c!: i64\" \
             FROM pages_cache WHERE page_id = 'PAGE_A'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row_a.i, 1,
        "PAGE_A inbound count should be 1 (B_C1 distinct across both edges into PAGE_A's subtree)"
    );
    assert_eq!(
        row_a.c, 2,
        "PAGE_A child count should be 2 (A_C1, A_C2; A_C3 deleted)"
    );

    let row_b = sqlx::query!(
        "SELECT inbound_link_count AS \"i!: i64\", child_block_count AS \"c!: i64\" \
             FROM pages_cache WHERE page_id = 'PAGE_B'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row_b.i, 2,
        "PAGE_B inbound count should be 2 (A_C1, A_C2 distinct sources; \
             A_C3 is a soft-deleted source, excluded by `src.deleted_at IS NULL` \
             per PEND-58d D2)"
    );
    assert_eq!(row_b.c, 1, "PAGE_B child count should be 1 (B_C1)");

    // (c) `materialised == computed` parity: assert the live IPC
    // SELECT shape produces identical numbers when applied as a
    // sibling subquery — this is the contract the materializer's
    // O(1) hooks must uphold.
    let parity = sqlx::query!(
        "SELECT \
                pc.page_id AS \"page_id!\", \
                pc.inbound_link_count AS \"mat_in!: i64\", \
                pc.child_block_count AS \"mat_ch!: i64\", \
                (SELECT COUNT(DISTINCT bl.source_id) FROM block_links AS bl \
                     INNER JOIN blocks AS descendant ON bl.target_id = descendant.id \
                     INNER JOIN blocks AS src ON src.id = bl.source_id \
                     WHERE descendant.page_id = pc.page_id \
                       AND descendant.deleted_at IS NULL \
                       AND src.deleted_at IS NULL \
                       AND src.page_id IS NOT NULL \
                       AND src.page_id != pc.page_id) AS \"calc_in!: i64\", \
                (SELECT COUNT(*) FROM blocks AS descendant \
                     WHERE descendant.page_id = pc.page_id \
                       AND descendant.deleted_at IS NULL \
                       AND descendant.id != pc.page_id) AS \"calc_ch!: i64\" \
             FROM pages_cache AS pc"
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for r in parity {
        assert_eq!(
            r.mat_in, r.calc_in,
            "page {}: materialised inbound_link_count must match live IPC aggregate",
            r.page_id
        );
        assert_eq!(
            r.mat_ch, r.calc_ch,
            "page {}: materialised child_block_count must match live IPC aggregate",
            r.page_id
        );
    }
}

/// SQL-review B-4 / migration 0064: the native `attachment_id`
/// column and its partial index `idx_op_log_attachment_id` must
/// exist after migrations run. This pins the schema contract that
/// `reverse::attachment_ops::reverse_delete_attachment` relies on
/// (O(log N) lookup instead of a full `op_log` scan filtered by
/// `json_extract(payload, '$.attachment_id')`). Mirrors the
/// `op_log_block_id_indexes_post_migration_0048` guard immediately
/// above.
#[tokio::test]
async fn op_log_attachment_id_column_and_index_exist() {
    let (pool, _dir) = test_pool().await;

    let col_count = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM pragma_table_info('op_log') WHERE name = 'attachment_id'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        col_count, 1,
        "migration 0064 must add the `attachment_id` column to op_log"
    );

    let idx_count = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_op_log_attachment_id'"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        idx_count, 1,
        "migration 0064 must create the `idx_op_log_attachment_id` partial index"
    );
}

/// SQL-review B-2: `dag.rs` must read the native indexed `block_id`
/// column, not the legacy `json_extract(payload, '$.block_id')`
/// expression. Migration 0030 added the native column (with the
/// covering `idx_op_log_block_id` index) and every INSERT path
/// populates it; migration 0048 dropped the legacy expression index,
/// so any surviving `json_extract` lookup would degrade to a full
/// `op_log` scan. This regression guard reads `src/dag.rs` from disk
/// and asserts the expression has not been re-introduced.
#[test]
fn dag_queries_no_longer_use_json_extract_block_id() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/dag.rs");
    let contents =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"));
    assert!(
        !contents.contains("json_extract(payload, '$.block_id')"),
        "src/dag.rs must not contain `json_extract(payload, '$.block_id')` — \
             use the native indexed `block_id` column instead (see migration 0030 \
             and SQL-review B-2)."
    );
}
