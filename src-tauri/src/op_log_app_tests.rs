//! App-crate home for the op_log tests that couple to app-only modules.
//!
//! `op_log` moved into `agaric-store` (#2621, wave S3b-ii), but five of its
//! tests exercise machinery that stays in the app crate and therefore cannot
//! compile down in the store:
//!
//!   * three `origin` tests drive the MCP actor scope
//!     (`agaric_store::task_locals::{ACTOR, Actor, ActorContext}`),
//!   * one `origin` test drives remote-op ingest (`agaric_engine::dag::insert_remote_op`),
//!   * one immutability test reads the app crate's `src/dag.rs` from disk.
//!
//! They are relocated here verbatim (modulo path repointing): the op_log entry
//! points come from `agaric_store::op_log` (re-exported as `agaric_store::op_log`), the
//! pool from `crate::db::init_pool`, and the coupled modules from `crate::mcp` /
//! `crate::dag`. The store-resident op_log tests keep everything that only needs
//! the migrated schema.

use agaric_core::ulid::BlockId;
use agaric_store::op::{CreateBlockPayload, OpPayload};
use agaric_store::op_log::{append_local_op, append_local_op_at};
use sqlx::SqlitePool;
use tempfile::TempDir;

// 2025-01-15T12:00:00Z in epoch-ms (op_log.created_at INTEGER, #109).
const TEST_DEVICE: &str = "test-device";

/// Create a temp-file-backed SQLite pool with migrations applied (the app's
/// `init_pool`, which carries the recovery wiring the store test pool omits).
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let pool = crate::db::init_pool(&dir.path().join("test.db"))
        .await
        .unwrap();
    (pool, dir)
}

/// Build a minimal `CreateBlock` payload with the given block ID.
fn make_create_payload(block_id: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        index: None,
        content: "test".into(),
    })
}

/// Inside an MCP `ACTOR.scope(Actor::Agent { name })` the append path
/// must stamp `origin = 'agent:<name>'`, wiring the
/// `agaric_store::task_locals::current_actor` task-local all the way through to the
/// DB row.
#[tokio::test]
async fn append_inside_agent_scope_stamps_origin_agent_prefix() {
    use agaric_store::task_locals::{ACTOR, Actor, ActorContext};
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
    use agaric_store::task_locals::{ACTOR, Actor, ActorContext};
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
    use agaric_store::task_locals::{ACTOR, Actor, ActorContext};
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
    use agaric_engine::dag::insert_remote_op;
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
