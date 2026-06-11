//! Tests for materializer queue coordination, dispatch routing, dedup logic, shutdown, flush barriers, and metrics.
use super::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::gcal_push::connector::GcalConnectorHandle;
use crate::op::{
    AddAttachmentPayload, AddTagPayload, CreateBlockPayload, DeleteAttachmentPayload,
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    PurgeBlockPayload, RestoreBlockPayload, SetPropertyPayload,
};
use crate::op_log::append_local_op;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::Ordering as AtomicOrdering;
use std::sync::{Arc as StdArc, OnceLock};
use std::time::Duration;
use tempfile::TempDir;

const DEV: &str = "test-device-mat";
const FIXED_TS: i64 = 1_735_689_600_000;
const FAKE_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Empty GCal handle cell used by every existing materializer test
/// that predates FEAT-5h.  The cell is never populated, so
/// [`crate::gcal_push::dirty_producer::compute_dirty_event`] is never
/// invoked and the test behaves exactly as it did before the handle
/// parameter was added.
pub(super) fn empty_gcal_handle() -> OnceLock<GcalConnectorHandle> {
    OnceLock::new()
}

pub(super) fn empty_gcal_handle_arc() -> StdArc<OnceLock<GcalConnectorHandle>> {
    StdArc::new(OnceLock::new())
}

pub(super) async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}
pub(super) fn fake_op_record(op_type: &str, payload: &str) -> OpRecord {
    // L-13: cache the parsed block_id sidecar so dispatch consults
    // the field without re-parsing the (possibly intentionally
    // malformed) payload of these synthetic records.
    let block_id = crate::op_log::extract_block_id_from_payload(payload);
    OpRecord {
        device_id: DEV.into(),
        seq: 1,
        parent_seqs: None,
        hash: FAKE_HASH.into(),
        op_type: op_type.into(),
        payload: payload.into(),
        created_at: FIXED_TS,
        block_id,
    }
}
pub(super) async fn make_op_record(pool: &SqlitePool, payload: OpPayload) -> OpRecord {
    append_local_op(pool, DEV, payload).await.unwrap()
}
pub(super) async fn insert_block_direct(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
) {
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
        .bind(id)
        .bind(block_type)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
}
pub(super) async fn soft_delete_block_direct(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
        .bind(FIXED_TS)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}
pub(super) async fn insert_block_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}
pub(super) async fn insert_property_date(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
    value_date: &str,
) {
    sqlx::query(
        "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
    )
    .bind(block_id)
    .bind(key)
    .bind(value_date)
    .execute(pool)
    .await
    .unwrap();
}

mod agenda_fts_misc;
mod apply_op;
mod attachments_gc;
mod batch_purge;
mod block_tag_refs;
mod cache_rebuild;
mod dispatch;
mod enqueue_shutdown;
mod fifo_regression;
mod fifo_status;
mod gcal_hook;
mod lifecycle;
mod metrics_dedup;
mod page_link_cache;
mod pages_cache_parity;
mod read_pool_concurrency;
mod retry_metrics;
