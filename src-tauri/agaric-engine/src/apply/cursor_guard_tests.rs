//! #4661 — the release-build guard on the single global apply cursor.
//!
//! `apply_op_projected(.., advance_cursor = true)` moves ONE global scalar
//! cursor to `record.seq`, which is sound only while every applied op comes
//! from one device. These tests pin both arms of that guard: a replicated
//! foreign record is refused and leaves the cursor where it was, and a
//! locally-authored record still advances it.

use agaric_core::ulid::BlockId;
use agaric_store::op::{CreateBlockPayload, OpPayload};
use agaric_store::op_log::OpRecord;
use agaric_store::test_support::init_pool;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ00000000000000000000P7";
const LOCAL_BLOCK_ID: &str = "01HZ00000000000000000000B7";
const FOREIGN_BLOCK_ID: &str = "01HZ00000000000000000000B8";
const LOCAL_DEVICE: &str = "device-cursor-guard-local";
const FOREIGN_DEVICE: &str = "device-cursor-guard-peer";

async fn fresh_pool_with_page() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("cursor_guard.db"))
        .await
        .expect("init_pool");
    // `spaces.id` REFERENCES `blocks(id)` (migration 0089), so the space's own
    // tag block goes in first.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .expect("seed space block");
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(&pool)
        .await
        .expect("seed space");
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, 'page', 'page-content', NULL, 0, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .expect("seed page");
    (pool, dir)
}

fn create_block_payload(block_id: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(1),
        index: None,
        content: "cursor guard content".into(),
    })
}

async fn read_cursor(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    .expect("read cursor")
}

/// Land a foreign device's op the way production does: hash-verified audit
/// metadata stamped `is_replicated = 1` (migration 0099), never applied.
async fn ingest_foreign_audit_record(pool: &SqlitePool, seq: i64) -> OpRecord {
    let payload = create_block_payload(FOREIGN_BLOCK_ID);
    let payload_json =
        agaric_store::op_log::serialize_inner_payload(&payload).expect("serialize payload");
    let op_type = payload.op_type_str().to_string();
    let created_at = agaric_store::db::now_ms();
    let record = OpRecord {
        device_id: FOREIGN_DEVICE.to_string(),
        seq,
        parent_seqs: None,
        hash: agaric_core::hash::compute_op_hash(
            FOREIGN_DEVICE,
            seq,
            None,
            &op_type,
            &payload_json,
        ),
        op_type,
        payload: payload_json,
        created_at,
        block_id: Some(FOREIGN_BLOCK_ID.to_string()),
    };
    let mut tx = pool.begin().await.expect("begin");
    let inserted = agaric_store::op_log::ingest_remote_op_in_tx(&mut tx, &record, "peer", true)
        .await
        .expect("ingest replicated op");
    tx.commit().await.expect("commit");
    assert!(inserted, "the audit row should be new");
    record
}

/// A replicated foreign record is refused before it can move the cursor, with
/// the batch path's error class, and the cursor is still where it was.
#[tokio::test]
async fn replicated_record_is_refused_and_leaves_the_cursor_put() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let state = crate::loro::shared::LoroState::new();

    // Advance the cursor to a known non-zero value first, so "did not move" is
    // a real assertion rather than "still at the seed default".
    let local = agaric_store::op_log::append_local_op(
        &pool,
        LOCAL_DEVICE,
        create_block_payload(LOCAL_BLOCK_ID),
    )
    .await
    .expect("append local op");
    let mut conn = pool.acquire().await.expect("acquire");
    crate::apply::kernel::apply_op_projected(&mut conn, &local, &state, true)
        .await
        .expect("local apply");
    let cursor_before = read_cursor(&pool).await;
    assert_eq!(cursor_before, local.seq);

    // The peer's op carries a seq from ITS OWN counter; applying it would drag
    // the one global cursor to that number.
    let foreign = ingest_foreign_audit_record(&pool, local.seq + 500).await;
    let err = crate::apply::kernel::apply_op_projected(&mut conn, &foreign, &state, true)
        .await
        .expect_err("a replicated record must not advance the cursor");
    let agaric_core::error::AppError::InvalidOperation(message) = &err else {
        panic!("expected AppError::InvalidOperation, got {err:?}");
    };
    assert!(
        message.contains("a replicated op_log row")
            && message.contains(FOREIGN_DEVICE)
            && message.contains("#412"),
        "error names the record and the deferred fix: {message}"
    );

    let cursor_after: i64 = sqlx::query_scalar(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(&mut *conn)
    .await
    .expect("read cursor on the applying connection");
    assert_eq!(cursor_after, cursor_before);
}

/// The other arm: a locally-authored record still advances the cursor. Without
/// this a guard that refused everything would look identical to a correct one.
#[tokio::test]
async fn locally_authored_record_still_advances_the_cursor() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let state = crate::loro::shared::LoroState::new();
    assert_eq!(read_cursor(&pool).await, 0);

    let record = agaric_store::op_log::append_local_op(
        &pool,
        LOCAL_DEVICE,
        create_block_payload(LOCAL_BLOCK_ID),
    )
    .await
    .expect("append local op");
    let mut conn = pool.acquire().await.expect("acquire");
    crate::apply::kernel::apply_op_projected(&mut conn, &record, &state, true)
        .await
        .expect("local apply");

    assert_eq!(read_cursor(&pool).await, record.seq);
}

/// `advance_cursor = false` — the LOCAL command sites (#1257) — is untouched by
/// the guard: it never reaches the check, and never moves the cursor.
#[tokio::test]
async fn command_path_without_cursor_advance_skips_the_guard() {
    let (pool, _dir) = fresh_pool_with_page().await;
    let state = crate::loro::shared::LoroState::new();

    let foreign = ingest_foreign_audit_record(&pool, 42).await;
    let mut conn = pool.acquire().await.expect("acquire");
    crate::apply::kernel::apply_op_projected(&mut conn, &foreign, &state, false)
        .await
        .expect("projection without a cursor advance is not gated");

    assert_eq!(read_cursor(&pool).await, 0);
}
