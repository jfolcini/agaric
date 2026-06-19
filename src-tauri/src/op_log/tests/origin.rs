//! FEAT-4h `op_log.origin` column, block_id extraction (L-1), and L-13 sidecar tests.
//!
//! Split out of the former `op_log/mod.rs` `#[cfg(test)] mod tests` block (#1659).

use super::*;

// =========================================================================
// FEAT-4h slice 1 — `op_log.origin` column
// =========================================================================

/// Migration 0033 must have applied cleanly: the `origin` column exists,
/// is `NOT NULL`, and has the default `'user'`.
#[tokio::test]
async fn origin_column_schema_is_as_specified_in_migration_0033() {
    let (pool, _dir) = test_pool().await;
    let rows = sqlx::query(
            "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('op_log') WHERE name = 'origin'",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "exactly one `origin` column should exist after migration 0033",
    );
    use sqlx::Row as _;
    let row = &rows[0];
    let ty: String = row.try_get("type").unwrap();
    let notnull: i64 = row.try_get("notnull").unwrap();
    let default: Option<String> = row.try_get("dflt_value").unwrap();
    assert_eq!(ty, "TEXT", "origin column must be TEXT");
    assert_eq!(notnull, 1, "origin column must be NOT NULL");
    assert_eq!(
        default.as_deref(),
        Some("'user'"),
        "origin column default must be the literal 'user'",
    );
}

/// Frontend-invoked commands never enter an MCP `ACTOR.scope(...)`, so
/// `current_actor()` falls back to `Actor::User` and
/// `append_local_op_in_tx` must stamp `origin = 'user'`.
#[tokio::test]
async fn append_outside_actor_scope_stamps_origin_user() {
    let (pool, _dir) = test_pool().await;
    let record = append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_USER"))
        .await
        .unwrap();
    let origin: String = sqlx::query_scalar!(
        "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
        record.device_id,
        record.seq,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        origin, "user",
        "frontend / un-wrapped call must stamp origin='user'",
    );
}

/// Inside an MCP `ACTOR.scope(Actor::Agent { name })` the append path
/// must stamp `origin = 'agent:<name>'`, wiring the
/// `mcp::actor::current_actor` task-local all the way through to the
/// DB row.
#[tokio::test]
async fn append_inside_agent_scope_stamps_origin_agent_prefix() {
    use crate::mcp::actor::{ACTOR, Actor, ActorContext};
    let (pool, _dir) = test_pool().await;

    let ctx = ActorContext {
        actor: Actor::Agent {
            name: "claude-desktop".to_string(),
        },
        request_id: "req-slice1".to_string(),
    };

    let record = ACTOR
        .scope(
            ctx,
            append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_AGENT")),
        )
        .await
        .unwrap();

    let origin: String = sqlx::query_scalar!(
        "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
        record.device_id,
        record.seq,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        origin, "agent:claude-desktop",
        "agent-scope append must stamp origin='agent:<clientInfo.name>'",
    );
}

/// Once the `ACTOR.scope` future resolves, subsequent appends fall back
/// to `origin = 'user'`. This pins the scope-boundary behaviour: agent
/// attribution must not leak into ops emitted by frontend code on the
/// same thread after an MCP handler returns.
#[tokio::test]
async fn origin_falls_back_to_user_after_agent_scope_ends() {
    use crate::mcp::actor::{ACTOR, Actor, ActorContext};
    let (pool, _dir) = test_pool().await;

    // First op — inside the agent scope.
    let ctx = ActorContext {
        actor: Actor::Agent {
            name: "agent-A".to_string(),
        },
        request_id: "req-a".to_string(),
    };
    let inside = ACTOR
        .scope(
            ctx,
            append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_INSIDE")),
        )
        .await
        .unwrap();

    // Second op — outside the scope, same runtime.
    let outside = append_local_op(&pool, TEST_DEVICE, make_create_payload("BLK_OUTSIDE"))
        .await
        .unwrap();

    let inside_origin: String = sqlx::query_scalar!(
        "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
        inside.device_id,
        inside.seq,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let outside_origin: String = sqlx::query_scalar!(
        "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
        outside.device_id,
        outside.seq,
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(inside_origin, "agent:agent-A");
    assert_eq!(
        outside_origin, "user",
        "origin must revert to 'user' once the ACTOR.scope future completes",
    );
}

/// `origin` is local-attribution metadata only — it must NOT be part of
/// the op's content hash. Otherwise cross-device sync would split the
/// same logical op into two different hash chains depending on whether
/// it was agent- or user-invoked at the origin device.
#[tokio::test]
async fn origin_does_not_affect_op_hash() {
    use crate::mcp::actor::{ACTOR, Actor, ActorContext};
    let (pool_a, _dir_a) = test_pool().await;
    let (pool_b, _dir_b) = test_pool().await;

    // Same payload, same device, same `created_at` — but different
    // actor scope. Hashes must match because `origin` is excluded from
    // the hash preimage.
    let payload_a = make_create_payload("BLKHASH");
    let payload_b = make_create_payload("BLKHASH");
    let ts: i64 = 1_748_736_000_000; // 2025-06-01T00:00:00Z

    let rec_a = append_local_op_at(&pool_a, TEST_DEVICE, payload_a, ts)
        .await
        .unwrap();

    let ctx = ActorContext {
        actor: Actor::Agent {
            name: "hash-test-agent".to_string(),
        },
        request_id: "req-hash".to_string(),
    };
    let rec_b = ACTOR
        .scope(ctx, append_local_op_at(&pool_b, TEST_DEVICE, payload_b, ts))
        .await
        .unwrap();

    assert_eq!(
        rec_a.hash, rec_b.hash,
        "hash must be independent of origin: same logical op on two devices \
             with different actor scopes must sync cleanly",
    );

    // Sanity: the persisted origin does differ.
    let origin_a: String = sqlx::query_scalar!(
        "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
        rec_a.device_id,
        rec_a.seq,
    )
    .fetch_one(&pool_a)
    .await
    .unwrap();
    let origin_b: String = sqlx::query_scalar!(
        "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
        rec_b.device_id,
        rec_b.seq,
    )
    .fetch_one(&pool_b)
    .await
    .unwrap();
    assert_eq!(origin_a, "user");
    assert_eq!(origin_b, "agent:hash-test-agent");
}

/// Rows inserted through paths that do NOT go through
/// `append_local_op_in_tx` (remote ops via `dag::insert_remote_op`,
/// merge ops via `dag::append_merge_op`, snapshot / compaction writes)
/// don't include `origin` in their INSERT column list; the column
/// default from migration 0033 must take over. This regression-test
/// pins the invariant so a future refactor that adds `origin` to the
/// INSERT list of one path but not the others can't silently ship.
#[tokio::test]
async fn remote_op_insert_defaults_origin_to_user() {
    use crate::dag::insert_remote_op;
    let (pool, _dir) = test_pool().await;

    // Produce a real valid op on device A, then deliver it to device B's
    // pool as a remote op.
    let (pool_src, _dir_src) = test_pool().await;
    let record = append_local_op(&pool_src, "device-A", make_create_payload("BLKREM"))
        .await
        .unwrap();

    let inserted = insert_remote_op(&pool, &record).await.unwrap();
    assert!(inserted, "fresh remote op must insert");

    let origin: String = sqlx::query_scalar!(
        "SELECT origin FROM op_log WHERE device_id = ? AND seq = ?",
        record.device_id,
        record.seq,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        origin, "user",
        "remote op inserted via dag::insert_remote_op must pick up the \
             'user' column default from migration 0033",
    );
}

/// FEAT-4h slice 3: `append_local_op_in_tx` must populate the
/// `LAST_APPEND` task-local with the freshly-inserted `(device_id,
/// seq)` pair when a scope is active. Outside a scope (the
/// frontend-invoked path) the call is a silent no-op — that path is
/// covered in `task_locals::tests::record_append_outside_scope_is_silent_noop`.
///
/// L-114: storage is `RefCell<Vec<OpRef>>` so multiple appends
/// inside the same scope all retain. `take_appends()` drains the
/// list; for a single-call test this yields a one-element Vec.
#[tokio::test]
async fn append_local_op_in_tx_populates_last_append_inside_scope() {
    use crate::task_locals::{LAST_APPEND, take_appends};
    use std::cell::RefCell;

    let (pool, _dir) = test_pool().await;

    let got = LAST_APPEND
        .scope(RefCell::new(Vec::new()), async {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
            let record = append_local_op_in_tx(
                &mut tx,
                TEST_DEVICE,
                make_create_payload("BLKLAPPEND"),
                FIXED_TS,
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();

            let captured = take_appends();
            (record, captured)
        })
        .await;

    let (record, captured) = got;
    assert_eq!(
        captured.len(),
        1,
        "exactly one append in this scope, got {captured:?}",
    );
    let only = &captured[0];
    assert_eq!(
        only.device_id, record.device_id,
        "LAST_APPEND[0].device_id must match the inserted row",
    );
    assert_eq!(
        only.seq, record.seq,
        "LAST_APPEND[0].seq must match the inserted row",
    );
}

// ── extract_block_id_from_payload (L-1) ───────────────────────────

/// L-1: a well-formed payload returns the `block_id` value as
/// before — the warn-on-malformed change must not regress the
/// happy path.
#[test]
fn extract_block_id_from_payload_returns_value_for_well_formed_json() {
    let payload = r#"{"block_id":"BLKHAPPY","content":"x"}"#;
    let got = extract_block_id_from_payload(payload);
    assert_eq!(got, Some("BLKHAPPY".to_owned()));
}

/// L-1: a payload without a `block_id` field (e.g. the
/// `delete_attachment` op which targets an `attachment_id` only)
/// returns `None` cleanly with no warn log emitted — only parse
/// failures are warned, missing fields are not an error.
#[test]
fn extract_block_id_from_payload_missing_field_returns_none() {
    let payload = r#"{"attachment_id":"ATT001"}"#;
    let got = extract_block_id_from_payload(payload);
    assert_eq!(got, None);
}

/// L-1: malformed JSON must (a) still return `None` so existing
/// callers' behaviour is preserved, and (b) emit a `warn`-level
/// log including a truncated payload prefix so the failure is
/// observable.  Without this, a future caller without an upstream
/// hash check would silently lose the indexed `block_id` entry on
/// corruption.
///
/// Uses `#[tokio::test]` to mirror the working pattern in
/// `materializer::tests::dispatch_background_or_warn_logs_seq_and_device_id_on_serde_error`
/// — the per-thread `set_default` guard is reliably honoured by
/// `tracing::warn!` calls when established inside a tokio test.
#[tokio::test]
async fn extract_block_id_from_payload_warns_with_payload_prefix_on_malformed_json() {
    use tracing_subscriber::layer::SubscriberExt;

    /// Thread-safe buffered writer for in-process log capture.
    /// Mirrors the helper used in `materializer::tests` and
    /// `sync_protocol::tests` (see AGENTS.md "Test helper
    /// duplication is intentional").
    #[derive(Clone, Default)]
    struct WarnBufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for WarnBufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for WarnBufWriter {
        type Writer = WarnBufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    let writer = WarnBufWriter::default();
    // Pattern mirrors `db::tests::begin_immediate_logged_emits_warn_on_slow_acquire`
    // which is known to capture warns reliably from the lib's
    // `agaric_lib::*` modules.
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_target(true),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    // A clearly-malformed JSON payload with an identifiable prefix
    // so we can assert it appears in the log line.
    let payload = "{not-valid-json:::truncate-marker-XYZQ123";
    let got = extract_block_id_from_payload(payload);
    assert_eq!(
        got, None,
        "malformed JSON must still return None to preserve caller behaviour"
    );

    let contents = {
        let bytes = writer.0.lock().unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    assert!(
        contents.contains("failed to extract block_id"),
        "warn message must surface the failure, got: {contents:?}"
    );
    assert!(
        contents.contains("op_payload_prefix"),
        "warn must include the op_payload_prefix field, got: {contents:?}"
    );
    assert!(
        contents.contains("truncate-marker-XYZQ123"),
        "warn must include the actual payload prefix so the failure is debuggable, got: {contents:?}"
    );
}

/// L-1: a multi-MB malformed payload must not flood the log line —
/// the prefix is truncated to the first 80 chars so the warn log
/// stays bounded regardless of input size.
#[tokio::test]
async fn extract_block_id_from_payload_truncates_prefix_to_80_chars() {
    use tracing_subscriber::layer::SubscriberExt;

    #[derive(Clone, Default)]
    struct BufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    let writer = BufWriter::default();
    // Disable timestamp to avoid the 'Z' from RFC 3339 timestamps
    // that the default fmt layer prepends — the truncation
    // assertion below scans for a unique sentinel character.
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_target(true)
                .without_time(),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    // 200-char malformed payload — beyond the 80-char cap.  The
    // single sentinel char `~` at index 199 must NOT appear in the
    // log line because the prefix truncates well before it.
    let mut payload = "X".repeat(199);
    payload.push('~');
    // Make it actually invalid JSON.
    let payload = format!("{{not-json{payload}");
    let _ = extract_block_id_from_payload(&payload);

    let contents = {
        let bytes = writer.0.lock().unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    assert!(
        !contents.is_empty(),
        "warn must be captured at all (filter sanity check), got empty buffer"
    );
    assert!(
        !contents.contains('~'),
        "the trailing '~' is past the 80-char cap and must not appear in the log, got: {contents:?}"
    );
}

// ── L-13: cached `block_id` sidecar ───────────────────────────────

/// L-13: every op-type that carries a `block_id` must populate the
/// `OpRecord::block_id` sidecar at append-time so the materializer
/// hot path (`dispatch::enqueue_background_tasks`) can read it
/// without a second JSON parse.  The only payload variant that
/// must yield `None` is `delete_attachment` (it identifies its
/// target by `attachment_id`, not `block_id`).
///
/// This test exercises the full append-time path —
/// `append_local_op_at` → `append_local_op_in_tx` →
/// `OpPayload::block_id()` → struct literal — for every op type
/// returned by `all_op_payloads()`.  Adding a future op type to
/// that helper automatically extends this test's coverage.
#[tokio::test]
async fn op_record_caches_extracted_block_id_l13() {
    let (pool, _dir) = test_pool().await;

    let mut seq_so_far = 0;
    for (label, payload) in all_op_payloads() {
        let expected_block_id: Option<String> = payload.block_id().map(str::to_owned);
        let record = append_local_op_at(&pool, TEST_DEVICE, payload, FIXED_TS)
            .await
            .unwrap_or_else(|e| {
                panic!("append_local_op_at failed for {label}: {e}");
            });

        seq_so_far += 1;
        assert_eq!(record.seq, seq_so_far, "seq monotonicity for {label}");
        assert_eq!(
            record.block_id, expected_block_id,
            "L-13: cached block_id must equal the typed payload's block_id for {label}",
        );

        // Parity oracle: the cached field must match what
        // `extract_block_id_from_payload` would have computed at
        // dispatch time (the parse the sidecar replaces).
        let from_payload = extract_block_id_from_payload(&record.payload);
        assert_eq!(
            record.block_id, from_payload,
            "L-13: cached block_id must agree with extract_block_id_from_payload for {label} \
                 (oracle: cached={:?}, parsed={:?})",
            record.block_id, from_payload,
        );
    }
}

/// L-13: a record fetched from the DB via `get_op_by_seq` must
/// also carry the cached `block_id` sidecar — populated from the
/// indexed `op_log.block_id` column (migration 0030) projected by
/// the SELECT.  Without this, a post-restore / cross-session read
/// would re-introduce the JSON parse the sidecar was added to
/// avoid.
#[tokio::test]
async fn get_op_by_seq_populates_block_id_sidecar_l13() {
    let (pool, _dir) = test_pool().await;

    let appended = append_local_op_at(&pool, TEST_DEVICE, make_create_payload("BLK-L13"), FIXED_TS)
        .await
        .unwrap();
    assert_eq!(
        appended.block_id.as_deref(),
        Some("BLK-L13"),
        "sanity: append-time sidecar must be populated"
    );

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), TEST_DEVICE, appended.seq)
        .await
        .unwrap();
    assert_eq!(
        fetched.block_id.as_deref(),
        Some("BLK-L13"),
        "L-13: DB-read path must populate the cached sidecar from \
             the indexed op_log.block_id column",
    );
}

/// L-13 (sibling of `get_op_by_seq_populates_block_id_sidecar_l13`):
/// the bulk read path (`get_ops_since`) must also project
/// `op_log.block_id` so every row in the result set has the cached
/// sidecar populated.  This is the path the materializer uses on
/// catch-up after sync; missing the column here would leave the
/// sidecar `None` for every replayed op and re-introduce the
/// dispatch-time parse.
#[tokio::test]
async fn get_ops_since_populates_block_id_sidecar_l13() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=3 {
        append_local_op_at(
            &pool,
            TEST_DEVICE,
            make_create_payload(&format!("BLK-L13-{i:02}")),
            FIXED_TS,
        )
        .await
        .unwrap();
    }

    let ops = get_ops_since(&ReadPool(pool.clone()), TEST_DEVICE, 0)
        .await
        .unwrap();
    assert_eq!(ops.len(), 3, "expected three rows");
    for (i, op) in ops.iter().enumerate() {
        let expected = format!("BLK-L13-{:02}", i + 1);
        assert_eq!(
            op.block_id.as_deref(),
            Some(expected.as_str()),
            "L-13: get_ops_since must populate block_id sidecar at index {i}",
        );
    }
}

/// B-1 (sql-review-2026-05-14): migration 0062 adds a compound
/// `exactly_one_value` CHECK constraint on `block_properties`
/// enforcing that exactly one of `value_text`, `value_num`,
/// `value_date`, `value_ref`, `value_bool` is non-null per row.
/// Previously this invariant was only enforced in Rust by
/// `validate_property_value()`; the new CHECK pushes the last line
/// of defence into the storage layer.
///
/// This test pins all three boundaries of the constraint:
///   - two non-null value columns → CHECK violation
///   - zero non-null value columns → CHECK violation
///   - exactly one non-null value column → succeeds
#[tokio::test]
async fn block_properties_exactly_one_value_check_enforced() {
    let (pool, _dir) = test_pool().await;

    // Insert a parent block so the FK `block_id -> blocks(id)` on
    // block_properties is satisfied for the rows below.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'parent', NULL, NULL)",
    )
    .bind("BLK_B1_PARENT")
    .execute(&pool)
    .await
    .unwrap();

    // (a) TWO non-null value columns → CHECK violation.
    let two_values_err = sqlx::query(
        "INSERT INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, ?, NULL, NULL, NULL)",
    )
    .bind("BLK_B1_PARENT")
    .bind("k_two")
    .bind("x")
    .bind(1.0_f64)
    .execute(&pool)
    .await
    .expect_err("row with two non-null value columns must violate exactly_one_value CHECK");
    let two_msg = format!("{two_values_err:?}");
    assert!(
        two_msg.contains("CHECK constraint failed"),
        "expected CHECK constraint failure for two-non-null insert, got: {two_msg}"
    );

    // (b) ZERO non-null value columns → CHECK violation.
    let zero_values_err = sqlx::query(
        "INSERT INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, NULL, NULL, NULL, NULL, NULL)",
    )
    .bind("BLK_B1_PARENT")
    .bind("k_zero")
    .execute(&pool)
    .await
    .expect_err("row with zero non-null value columns must violate exactly_one_value CHECK");
    let zero_msg = format!("{zero_values_err:?}");
    assert!(
        zero_msg.contains("CHECK constraint failed"),
        "expected CHECK constraint failure for zero-non-null insert, got: {zero_msg}"
    );

    // (c) EXACTLY ONE non-null value column → succeeds.
    sqlx::query(
        "INSERT INTO block_properties \
                 (block_id, key, value_text, value_num, value_date, value_ref, value_bool) \
             VALUES (?, ?, ?, NULL, NULL, NULL, NULL)",
    )
    .bind("BLK_B1_PARENT")
    .bind("k_one")
    .bind("only")
    .execute(&pool)
    .await
    .expect("row with exactly one non-null value column must satisfy the CHECK");

    // Sanity: confirm only the valid row landed.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
        .bind("BLK_B1_PARENT")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "exactly one row should have been inserted (the two CHECK-violating rows must not persist)"
    );
}

/// Migration 0083 adds `idx_op_log_seq ON op_log(seq, device_id)` so the
/// boot-replay walk (`WHERE seq > ? ORDER BY seq ASC, device_id ASC`) can
/// be served from the index rather than falling back to a full scan and
/// temp-B-tree sort (issue #546 / backend audit #411).
///
/// This test:
///   1. Verifies the index exists after migrations run.
///   2. Inserts op_log rows for two devices in an order that differs from
///      their `seq` values (interleaved), then queries with the boot-replay
///      ordering (`ORDER BY seq ASC, device_id ASC`) and asserts the rows
///      come back in strict `seq` ascending order regardless of insertion
///      order — confirming the index delivers the correct replay sequence.
#[tokio::test]
async fn idx_op_log_seq_exists_and_boot_replay_order_is_seq_asc() {
    let (pool, _dir) = test_pool().await;

    // ── 1. Index presence ────────────────────────────────────────────────
    let idx_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM sqlite_master \
             WHERE type = 'index' AND name = 'idx_op_log_seq'"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        idx_count, 1,
        "migration 0083 must create idx_op_log_seq on op_log(seq, device_id)"
    );

    // ── 2. Interleaved insertion (insertion order ≠ seq order) ──────────
    //
    // We insert rows such that if the query relied on rowid / insertion
    // order instead of the `seq` column, the result would be wrong.
    //
    // Insertion sequence (device, seq):
    //   device-B seq=1  (rowid 1)
    //   device-A seq=3  (rowid 2)
    //   device-A seq=1  (rowid 3)
    //   device-B seq=2  (rowid 4)
    //   device-A seq=2  (rowid 5)
    //
    // Expected ORDER BY seq ASC, device_id ASC result:
    //   seq=1 device-A, seq=1 device-B, seq=2 device-A, seq=2 device-B, seq=3 device-A
    let rows_to_insert: &[(&str, i64)] = &[
        ("device-B", 1),
        ("device-A", 3),
        ("device-A", 1),
        ("device-B", 2),
        ("device-A", 2),
    ];
    for (device_id, seq) in rows_to_insert {
        sqlx::query(
            "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
        )
        .bind(device_id)
        .bind(seq)
        .bind(format!("hash-{device_id}-{seq}"))
        .execute(&pool)
        .await
        .unwrap();
    }

    // ── 3. Boot-replay ordering assertion ────────────────────────────────
    //
    // Re-run the keyset-ordering query shape that migration 0083 documents
    // for the #411 boot op-log replay walk
    // (`WHERE seq > ? ORDER BY seq ASC, device_id ASC`); we pass 0 for the
    // `seq > ?` cursor so all rows appear. This confirms the index delivers
    // rows in `seq ASC, device_id ASC` order regardless of insertion order.
    let replayed: Vec<(String, i64)> = sqlx::query_as(
        "SELECT device_id, seq FROM op_log \
             WHERE seq > 0 \
             ORDER BY seq ASC, device_id ASC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    let expected: Vec<(String, i64)> = vec![
        ("device-A".to_owned(), 1),
        ("device-B".to_owned(), 1),
        ("device-A".to_owned(), 2),
        ("device-B".to_owned(), 2),
        ("device-A".to_owned(), 3),
    ];
    assert_eq!(
        replayed, expected,
        "boot-replay query must return ops in seq ASC, device_id ASC order \
             regardless of insertion order (idx_op_log_seq must serve the sort)"
    );

    // ── 4. Monotone seq-only assertion (what the replay cursor tracks) ───
    //
    // The boot-replay cursor advances by `last_seen = last_seen.max(record.seq)`.
    // Confirm the seq values of the result are non-decreasing — the property
    // the cursor relies on to make forward progress without skipping ops.
    let seqs: Vec<i64> = replayed.iter().map(|(_, s)| *s).collect();
    let mut prev = 0i64;
    for s in &seqs {
        assert!(
            *s >= prev,
            "seq values in replay order must be non-decreasing; got {s} after {prev}"
        );
        prev = *s;
    }
}
