//! Tests for op-log compaction (`compact_op_log` + `collect_frontier`).
//!
//! #4699 deleted the snapshot blob and, with it, the ~6 300 lines of codec,
//! restore and schema-version tests that covered it. What remains is the
//! purge: its eligibility cutoff, its per-device seq bound, the
//! `compaction_watermark` row it writes, and the apply-cursor clamp (#3310).

use super::*;
use agaric_core::ulid::BlockId;
use agaric_engine::materializer::Materializer;
use agaric_store::op::{CreateBlockPayload, OpPayload};
use agaric_store::op_log::append_local_op_at;
use agaric_store::test_support::init_pool;
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tempfile::TempDir;

/// Read the single-row compaction watermark, if a compaction has run.
async fn read_watermark(pool: &SqlitePool) -> Option<(String, String, i64)> {
    sqlx::query!(
        "SELECT up_to_seqs, up_to_hash, compacted_at_ms FROM compaction_watermark WHERE id = 1"
    )
    .fetch_optional(pool)
    .await
    .unwrap()
    .map(|r| (r.up_to_seqs, r.up_to_hash, r.compacted_at_ms))
}

/// Parse the watermark's persisted frontier.
async fn read_watermark_frontier(pool: &SqlitePool) -> BTreeMap<String, i64> {
    let (json, _, _) = read_watermark(pool)
        .await
        .expect("a compaction must have written the watermark");
    serde_json::from_str(&json).expect("up_to_seqs is the JSON map compaction writes")
}

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Build a `Materializer` for the #3310 tests, which drive the real boot
/// replay path.
fn test_materializer(pool: &SqlitePool) -> Materializer {
    Materializer::new(pool.clone())
}

/// Helper: insert a block directly into the DB (bypasses op log).
async fn insert_block(pool: &SqlitePool, id: &str, content: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'content', ?, 1)",
    )
    .bind(id)
    .bind(content)
    .execute(pool)
    .await
    .unwrap();
}

/// Helper: insert an op via append_local_op_at with an explicit timestamp.
async fn insert_op_at(pool: &SqlitePool, device_id: &str, block_id: &str, ts: i64) {
    let op = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".to_owned(),
        parent_id: None,
        position: Some(0),
        index: None,
        content: "test".to_owned(),
    });
    append_local_op_at(pool, device_id, op, ts).await.unwrap();
}

/// Nothing older than the retention window: the purge is a no-op and leaves
/// no watermark, so `find_lca` keeps reporting a missing op as `NotFound`
/// rather than blaming a compaction that never happened.
#[tokio::test]
async fn compact_noop_when_no_old_ops() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a recent op (now)
    insert_block(&pool, "BLOCK-1", "recent").await;
    let now = agaric_store::db::now_ms();
    insert_op_at(&pool, device_id, "BLOCK-1", now).await;

    // Compact with 90-day retention — all ops are recent
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert!(result.is_none(), "should return None when no old ops");

    assert!(
        read_watermark(&pool).await.is_none(),
        "a no-op compaction must not claim the log was trimmed"
    );
}

/// The purge, and the row that records it. #4699 replaced the snapshot blob
/// this used to assert on with the `compaction_watermark` frontier.
#[tokio::test]
async fn compact_purges_and_records_the_watermark_4699() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a block and an old op (200 days ago)
    insert_block(&pool, "BLOCK-OLD", "old content").await;
    insert_op_at(&pool, device_id, "BLOCK-OLD", 1_704_067_200_000).await;

    // Compact with 90-day retention
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert_eq!(result, Some(1), "the one old op must be reported deleted");

    let (up_to_seqs, up_to_hash, compacted_at_ms) = read_watermark(&pool)
        .await
        .expect("a compaction that ran must record its frontier");
    assert_eq!(
        up_to_seqs, r#"{"dev-1":1}"#,
        "the watermark records the per-device frontier the DELETE was bounded by"
    );
    assert!(
        !up_to_hash.is_empty(),
        "the watermark records the hash of the newest op at that frontier"
    );
    assert!(
        compacted_at_ms > 0,
        "compacted_at_ms is written from db::now_ms(), got {compacted_at_ms}"
    );

    // Old ops should be purged
    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(op_count, 0, "old ops should be purged");
}

#[tokio::test]
async fn compact_preserves_recent_ops() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert a block with an old op
    insert_block(&pool, "BLOCK-OLD", "old").await;
    insert_op_at(&pool, device_id, "BLOCK-OLD", 1_704_067_200_000).await;

    // Insert a block with a recent op
    insert_block(&pool, "BLOCK-NEW", "new").await;
    let now = agaric_store::db::now_ms();
    insert_op_at(&pool, device_id, "BLOCK-NEW", now).await;

    // Compact with 90-day retention
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert!(
        result.is_some(),
        "compaction should occur when old ops exist"
    );

    // Only the recent op should remain
    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(op_count, 1, "recent op should be preserved");

    // Verify it's the recent one by comparing to the captured timestamp.
    let created_at: i64 = sqlx::query_scalar!("SELECT created_at FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        created_at, now,
        "remaining op should have the recent timestamp that was inserted"
    );
}

/// Verify compaction works correctly when multiple devices have ops:
/// old ops from ALL devices should be purged, recent ops preserved.
#[tokio::test]
async fn compact_multi_device_ops() {
    let (pool, _dir) = test_pool().await;

    // Device A: old op
    insert_block(&pool, "BLOCK-A", "from A").await;
    insert_op_at(&pool, "device-A", "BLOCK-A", 1_704_067_200_000).await;

    // Device B: old op + recent op
    insert_block(&pool, "BLOCK-B1", "old from B").await;
    insert_op_at(&pool, "device-B", "BLOCK-B1", 1_705_276_800_000).await;

    insert_block(&pool, "BLOCK-B2", "recent from B").await;
    let now = agaric_store::db::now_ms();
    insert_op_at(&pool, "device-B", "BLOCK-B2", now).await;

    // Compact
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert!(result.is_some(), "should compact when old ops exist");

    // Only device-B's recent op should remain
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1, "only the recent op should survive compaction");

    // Verify it's device-B's recent op
    let dev: String = sqlx::query_scalar!("SELECT device_id FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(dev, "device-B", "remaining op should belong to device-B");

    // The watermark records every device's frontier, not just the one that
    // had eligible ops — the DELETE runs once per device in the map.
    let frontier = read_watermark_frontier(&pool).await;
    assert_eq!(
        frontier,
        BTreeMap::from([("device-A".to_owned(), 1), ("device-B".to_owned(), 2)]),
        "the watermark must carry both devices' MAX(seq) — seq is allocated \
         per device, so device-B's two ops are its seq 1 and 2"
    );
}

/// Calling `compact_op_log` twice: the first call compacts, the second is a
/// no-op because nothing eligible remains — and, crucially, the no-op leaves
/// the first call's watermark untouched rather than rewriting it with the
/// post-purge frontier.
#[tokio::test]
async fn double_compaction() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert an old op (200 days ago)
    insert_block(&pool, "BLOCK-OLD", "old").await;
    insert_op_at(&pool, device_id, "BLOCK-OLD", 1_704_067_200_000).await;

    // First compaction — purges and records the frontier.
    let first = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert_eq!(first, Some(1), "the first compaction deletes the old op");
    let after_first = read_watermark(&pool)
        .await
        .expect("the first compaction records a watermark");

    // Second compaction — no old ops remain, should be no-op
    let second = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert!(
        second.is_none(),
        "second compaction should be no-op (no old ops remain)"
    );

    assert_eq!(
        read_watermark(&pool).await,
        Some(after_first),
        "a second, no-op compaction must not rewrite the watermark — the log \
         was not trimmed again, and the recorded frontier is the record of what \
         was"
    );
}

/// Verify that the cutoff timestamp uses a consistent format for comparison
/// with op_log.created_at. This tests the edge case where the inserted
/// timestamp has zero sub-second precision (`...:00Z`) vs the cutoff's
/// millisecond-precision form (`...:00.000Z`) — both share the
/// `Z`-suffix invariant, so lexicographic comparison must still
/// classify the older op as old.
#[tokio::test]
async fn compact_op_log_timestamp_format_consistency() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    // Insert an old op using a zero-subsecond `Z` timestamp — the edge
    // case is that `now_rfc3339()` always emits 3-digit milliseconds
    // (e.g. `...:00.000Z`) whereas this fixture omits them
    // (`...:00Z`). Lex comparison must still treat the older instant
    // as older despite the precision mismatch.
    insert_block(&pool, "BLOCK-OLD", "old").await;
    insert_op_at(&pool, device_id, "BLOCK-OLD", 1_705_320_000_000).await;

    // Compact with 90-day retention — the old op should be purged
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert!(
        result.is_some(),
        "old op with zero-subsecond Z-suffix timestamp should still be detected as old"
    );

    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "old op should be purged");
}

/// `collect_frontier` gathers the op frontier within a DEFERRED read
/// transaction, matching what `compact_op_log` uses in phase 1.
#[tokio::test]
async fn compact_read_phase_collects_frontier() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-read";

    insert_block(&pool, "BLK-R1", "read phase block").await;
    insert_op_at(&pool, device_id, "BLK-R1", 1_735_689_600_000).await;
    insert_op_at(&pool, device_id, "BLK-R2", 1_735_776_000_000).await;

    // Use a DEFERRED read transaction, same as compact_op_log phase 1
    let mut read_tx = pool.begin().await.unwrap();
    let (frontier, hash): (BTreeMap<String, i64>, String) =
        collect_frontier(&mut read_tx).await.unwrap();
    read_tx.commit().await.unwrap();

    assert!(
        frontier.contains_key(device_id),
        "frontier should include {device_id}"
    );
    assert_eq!(
        frontier[device_id], 2,
        "frontier should record max seq = 2 for {device_id}"
    );
    assert!(!hash.is_empty(), "frontier hash should not be empty");
}

/// Verify stale-read safety: ops written between phase 1 (read) and phase 2
/// (write) are preserved because the DELETE is bounded by the `up_to_seqs`
/// frontier recorded at read time.
#[tokio::test]
async fn compact_stale_read_safety() {
    let (pool, _dir) = test_pool().await;

    // Insert an old op for device A
    insert_block(&pool, "BLK-OLD", "old").await;
    insert_op_at(&pool, "dev-A", "BLK-OLD", 1_704_067_200_000).await;

    // Insert a recent op for a different device (B) — this simulates an
    // op that arrives between Phase 1 read and Phase 3 write in a real
    // concurrent scenario.
    insert_block(&pool, "BLK-NEW", "new").await;
    let now = agaric_store::db::now_ms();
    insert_op_at(&pool, "dev-B", "BLK-NEW", now).await;

    // Run compaction — the frontier will include both devices, but the
    // time cutoff should only remove dev-A's old op.
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert!(result.is_some(), "compaction should occur");

    // dev-B's recent op must survive
    let remaining: Vec<(String, i64)> =
        sqlx::query_as("SELECT device_id, seq FROM op_log ORDER BY device_id, seq")
            .fetch_all(&pool)
            .await
            .unwrap();

    assert_eq!(
        remaining.len(),
        1,
        "only dev-B's recent op should survive compaction"
    );
    assert_eq!(
        remaining[0].0, "dev-B",
        "surviving op should belong to dev-B"
    );

    // The recorded frontier covers both devices — dev-B's entry is what
    // bounded the DELETE that spared its recent op.
    let frontier = read_watermark_frontier(&pool).await;
    assert_eq!(
        frontier,
        BTreeMap::from([("dev-A".to_owned(), 1), ("dev-B".to_owned(), 1)]),
        "the recorded frontier must include both devices — seq is per device, \
         so each device's single op is its seq 1"
    );
}

/// Directly verify the seq-bounded DELETE guard: manually execute the
/// phase-2 DELETE logic with a stale frontier and confirm that ops beyond the
/// frontier are preserved.
#[tokio::test]
async fn compact_stale_read_seq_guard() {
    let (pool, _dir) = test_pool().await;

    // Insert 3 old ops for the same device (seq 1, 2, 3)
    insert_block(&pool, "BLK-S1", "s1").await;
    insert_op_at(&pool, "dev-1", "BLK-S1", 1_704_067_200_000).await;
    insert_block(&pool, "BLK-S2", "s2").await;
    insert_op_at(&pool, "dev-1", "BLK-S2", 1_704_153_600_000).await;
    insert_block(&pool, "BLK-S3", "s3").await;
    insert_op_at(&pool, "dev-1", "BLK-S3", 1_704_240_000_000).await;

    // Simulate a "stale" frontier that only saw up to seq 2
    let stale_frontier: BTreeMap<String, i64> = [("dev-1".to_string(), 2)].into_iter().collect();

    let cutoff_str: i64 = 1_735_689_600_000; // all ops are before this

    // Execute the same per-device DELETE that compact_op_log phase 2 uses.
    // H-13: enable the op_log mutation bypass for the duration of this tx,
    // mirroring the production compaction path.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    agaric_store::op_log::enable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    for (dev_id, max_seq) in &stale_frontier {
        sqlx::query("DELETE FROM op_log WHERE created_at < ?1 AND device_id = ?2 AND seq <= ?3")
            .bind(cutoff_str)
            .bind(dev_id)
            .bind(max_seq)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    agaric_store::op_log::disable_op_log_mutation_bypass(&mut tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    // seq 1 and 2 should be deleted; seq 3 survives because seq > stale max_seq
    let remaining: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 1,
        "op at seq 3 should survive the seq-bounded DELETE"
    );

    let surviving_seq: i64 = sqlx::query_scalar!("SELECT seq FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        surviving_seq, 3,
        "the surviving op should be seq 3 (beyond stale frontier)"
    );
}

/// `compact_op_log`'s write phase is one `BEGIN IMMEDIATE` transaction: the
/// watermark INSERT and the `DELETE FROM op_log` must roll back together.
///
/// Pass-1 source: 08/F36. We exercise that by installing a custom AFTER
/// DELETE trigger on `op_log` that unconditionally `RAISE(ABORT)`s, then run
/// `compact_op_log` and assert the call errors, the `op_log` is intact, and
/// **no watermark row was left behind** — a watermark over an untrimmed log
/// would make `find_lca` blame compaction for a chain break it did not cause.
///
/// This contract inverted at #4699. While the write phase built a snapshot
/// blob it was split across two transactions, so a rolled-back purge
/// deliberately LEFT the snapshot durable rather than re-encoding the same
/// bytes on the next tick. With the blob gone there is nothing expensive to
/// preserve, and one transaction is both simpler and stricter.
#[tokio::test]
async fn compact_op_log_rolls_back_on_injected_delete_failure_l109() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-l109";

    // Insert a block with an old op so compaction has something to delete.
    insert_block(&pool, "BLK-L109", "content").await;
    insert_op_at(&pool, device_id, "BLK-L109", 1_704_067_200_000).await;

    // Pre-compaction state.
    let ops_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ops_before, 1, "should start with 1 op");
    assert!(
        read_watermark(&pool).await.is_none(),
        "should start with no watermark"
    );

    // Install an AFTER DELETE trigger on op_log that unconditionally aborts.
    // The H-13 BEFORE-DELETE bypass mechanism (sentinel row in
    // `_op_log_mutation_allowed`) is checked by the production trigger from
    // migration 0036; this AFTER trigger is independent and will fire even
    // when the bypass is enabled, which is exactly what we want to inject
    // a mid-tx failure.
    sqlx::query(
        "CREATE TRIGGER l109_inject_delete_failure \
         AFTER DELETE ON op_log \
         BEGIN \
             SELECT RAISE(ABORT, ' injected: DELETE FROM op_log not allowed'); \
         END",
    )
    .execute(&pool)
    .await
    .unwrap();

    // Run compaction — must fail.
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await;
    assert!(
        result.is_err(),
        "compaction must fail when DELETE FROM op_log aborts; got {result:?}"
    );

    // The watermark INSERT rode the same transaction as the DELETE, so the
    // abort must have taken it with it.
    assert!(
        read_watermark(&pool).await.is_none(),
        "a rolled-back purge must leave no watermark — a row claiming the log \
         was trimmed to a frontier it still holds would make find_lca report \
         an intact chain as broken by compaction"
    );

    // Op log must be intact — the DELETE was aborted by the injected trigger.
    let ops_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after, ops_before,
        "op_log row count must be unchanged after a rolled-back purge"
    );

    // Drop the injected trigger so any other tests sharing the pool are
    // unaffected. (Each test gets a fresh `test_pool` so this is belt-
    // and-braces, but it documents the cleanup contract for the helper.)
    sqlx::query("DROP TRIGGER IF EXISTS l109_inject_delete_failure")
        .execute(&pool)
        .await
        .unwrap();
}

// ===========================================================================
// #3310 — compaction must clamp the apply cursor
// ===========================================================================
//
// `compact_op_log` used to reset only the log, so a vault whose newest op
// predated the retention window was purged to zero rows while
// the cursor still held the pre-purge frontier — the H-4 impossible state,
// reported by `recovery::replay::read_apply_cursor` at the NEXT boot as
// "impossible-state corruption" on a perfectly healthy vault.
//
// These tests drive the REAL boot path (`replay_unmaterialized_ops`, whose
// first act is `read_apply_cursor`) and assert on the warn line it actually
// emits, captured in-process. The pair is deliberately symmetric: the clamp
// must silence the FALSE report without silencing the TRUE one.

/// Thread-safe buffered writer for in-process log capture. Mirrors the helper
/// in `db::tests` / `op_log::tests::origin` (see AGENTS.md "Test helper
/// duplication is intentional").
#[derive(Clone, Default)]
struct WarnCapture(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for WarnCapture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for WarnCapture {
    type Writer = WarnCapture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl WarnCapture {
    fn contents(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

/// Read the single-row apply cursor.
async fn read_cursor(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar!(
        r#"SELECT materialized_through_seq as "seq!: i64" FROM materializer_apply_cursor WHERE id = 1"#
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Build a healthy, fully-materialised vault whose every op is older than any
/// retention window: three local ops, replayed through the real boot path so
/// the cursor reaches the frontier the way production reaches it.
///
/// Returns the cursor value after replay (which must equal the op frontier).
async fn seed_healthy_ancient_vault(pool: &SqlitePool, device_id: &str) -> i64 {
    use crate::recovery::replay::replay_unmaterialized_ops;

    // 2024-01-01 — older than every retention window the app allows.
    const ANCIENT_TS: i64 = 1_704_067_200_000;
    for (n, block) in ["BLOCK-A1", "BLOCK-A2", "BLOCK-A3"].iter().enumerate() {
        let offset = i64::try_from(n).expect("fixture index fits in i64");
        insert_op_at(pool, device_id, block, ANCIENT_TS + offset).await;
    }

    let mat = test_materializer(pool);
    let report = replay_unmaterialized_ops(pool, &mat).await.unwrap();
    mat.shutdown();
    assert_eq!(
        report.ops_replayed, 3,
        "fixture precondition: all three seeded ops must materialise"
    );
    assert!(
        report.replay_errors.is_empty(),
        "fixture precondition: the vault must be healthy, got {:?}",
        report.replay_errors
    );

    let cursor = read_cursor(pool).await;
    assert_eq!(
        cursor, 3,
        "fixture precondition: a fully-materialised vault's cursor sits at the op frontier"
    );
    cursor
}

/// #3310 (the reported symptom): compact a healthy vault whose whole op_log
/// predates the retention window, then boot. Pre-fix the purge left
/// `cursor = 3` over an EMPTY log and `read_apply_cursor` logged
/// "impossible-state corruption" about a vault that had never been corrupt.
/// Post-fix the purge tx clamps the cursor to the surviving `MAX(seq)` (0),
/// and the boot is silent.
#[tokio::test]
async fn compaction_clamps_apply_cursor_so_boot_reports_no_corruption_3310() {
    use crate::recovery::replay::replay_unmaterialized_ops;
    use tracing_subscriber::layer::SubscriberExt;

    let (pool, _dir) = test_pool().await;
    let device_id = "dev-3310";

    seed_healthy_ancient_vault(&pool, device_id).await;

    // The maintenance tick: every op is older than the retention window.
    let result = compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();
    assert!(result.is_some(), "compaction must have run");

    let op_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        op_count, 0,
        "scenario precondition: the purge empties the log (this is #3310's setup, \
         not the thing under test)"
    );

    // The reported symptom, on the real boot path.
    let writer = WarnCapture::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false),
        );
    let mat = test_materializer(&pool);
    {
        let _guard = tracing::subscriber::set_default(subscriber);
        replay_unmaterialized_ops(&pool, &mat)
            .await
            .expect("boot replay over the compacted vault must succeed");
    }
    mat.shutdown();

    let logs = writer.contents();
    assert!(
        !logs.contains("impossible-state corruption"),
        "#3310: a compacted-to-empty HEALTHY vault must not be reported as \
         impossible-state corruption at boot; captured log output: {logs:?}"
    );

    // ...and the mechanism that removes it, observed directly on the column.
    // Read AFTER the boot: `read_apply_cursor` heals what it warns about, so
    // a post-boot 0 alone would prove nothing — this asserts the compaction
    // tx, not the boot clamp, is what put it there. The boot above was a
    // no-op, which is the whole point.
    assert_eq!(
        read_cursor(&pool).await,
        0,
        "#3310: compaction must clamp materializer_apply_cursor down to the \
         surviving MAX(seq) — 0 over an emptied log — in the purge tx"
    );
}

/// The other half of the pair: the clamp must not blunt the check. Corrupt
/// the cursor by hand AFTER compaction (a value no code path could have
/// produced) and confirm `read_apply_cursor` still names it and still heals
/// it. Without this, the test above would pass just as well if the warn had
/// been deleted outright.
#[tokio::test]
async fn boot_still_reports_genuine_cursor_corruption_after_the_3310_clamp() {
    use crate::recovery::replay::replay_unmaterialized_ops;
    use tracing_subscriber::layer::SubscriberExt;

    let (pool, _dir) = test_pool().await;
    let device_id = "dev-3310";

    seed_healthy_ancient_vault(&pool, device_id).await;
    compact_op_log(&pool, DEFAULT_RETENTION_DAYS).await.unwrap();

    // Genuine corruption: a cursor of 999 over an op_log whose MAX(seq) is 0.
    // Deliberately independent of whether the clamp ran, so this test holds
    // on BOTH sides of the fix — it is the anti-vacuity guard for the test
    // above, not a second regression test.
    sqlx::query("UPDATE materializer_apply_cursor SET materialized_through_seq = 999 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();

    let writer = WarnCapture::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false),
        );
    let mat = test_materializer(&pool);
    {
        let _guard = tracing::subscriber::set_default(subscriber);
        replay_unmaterialized_ops(&pool, &mat).await.unwrap();
    }
    mat.shutdown();

    let logs = writer.contents();
    assert!(
        logs.contains("impossible-state corruption"),
        "the #3310 clamp must not blunt the boot check — a cursor genuinely past \
         the end of the log must still be reported; captured log output: {logs:?}"
    );
    assert_eq!(
        read_cursor(&pool).await,
        0,
        "the boot clamp must still heal the corrupt cursor down to MAX(seq)"
    );
}

/// The clamp may only ever LOWER the cursor. A compaction that purges the old
/// tail but leaves recent ops above the cursor must not touch it — otherwise
/// the "fix" would itself be the data-loss bug (a cursor raised over ops that
/// were never materialised means boot replay skips them).
#[tokio::test]
async fn compaction_never_raises_the_apply_cursor_3310() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-3310";

    // Two ancient ops (purged) and two recent ones (retained).
    insert_op_at(&pool, device_id, "BLOCK-OLD1", 1_704_067_200_000).await;
    insert_op_at(&pool, device_id, "BLOCK-OLD2", 1_704_067_200_001).await;
    let recent = chrono::Utc::now().timestamp_millis();
    insert_op_at(&pool, device_id, "BLOCK-NEW1", recent).await;
    insert_op_at(&pool, device_id, "BLOCK-NEW2", recent).await;

    // Cursor sits mid-log: seqs 1-2 materialised, 3-4 not yet.
    sqlx::query("UPDATE materializer_apply_cursor SET materialized_through_seq = 2 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();

    compact_op_log(&pool, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap()
        .expect("the two ancient ops make compaction run");

    let surviving_max: i64 =
        sqlx::query_scalar!(r#"SELECT COALESCE(MAX(seq), 0) as "m!: i64" FROM op_log"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        surviving_max, 4,
        "scenario precondition: the recent ops survive, so MAX(seq) is still above the cursor"
    );
    assert_eq!(
        read_cursor(&pool).await,
        2,
        "#3310: the clamp is `WHERE materialized_through_seq > <surviving max>` — \
         it must be a strict no-op when the cursor is already below the frontier, \
         never raising it over the two unmaterialised ops"
    );
}

/// #4699: the watermark is a SINGLE row, upserted. Two real compactions must
/// leave one row carrying the SECOND one's frontier — an append would make
/// `find_lca`'s `EXISTS` probe scan a table that grows once a day forever, and
/// a plain INSERT would fail the `CHECK (id = 1)` primary key outright.
#[tokio::test]
async fn compaction_watermark_is_one_upserted_row_4699() {
    let (pool, _dir) = test_pool().await;
    let device_id = "dev-1";

    insert_block(&pool, "BLOCK-OLD1", "old").await;
    insert_op_at(&pool, device_id, "BLOCK-OLD1", 1_704_067_200_000).await;
    compact_op_log(&pool, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap()
        .expect("the first old op makes compaction run");
    assert_eq!(
        read_watermark_frontier(&pool).await,
        BTreeMap::from([("dev-1".to_owned(), 1)]),
        "the first compaction records the frontier it purged to"
    );

    // A second aged op, appended after the first purge: seq keeps climbing
    // from the durable high-water mark, so the new frontier is strictly above
    // the recorded one.
    insert_block(&pool, "BLOCK-OLD2", "older still").await;
    insert_op_at(&pool, device_id, "BLOCK-OLD2", 1_704_153_600_000).await;
    compact_op_log(&pool, DEFAULT_RETENTION_DAYS)
        .await
        .unwrap()
        .expect("the second old op makes compaction run again");

    let rows: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM compaction_watermark")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        rows, 1,
        "the watermark is a single upserted row, never a log"
    );
    assert_eq!(
        read_watermark_frontier(&pool).await,
        BTreeMap::from([("dev-1".to_owned(), 2)]),
        "the second compaction overwrites the frontier with its own"
    );
}
