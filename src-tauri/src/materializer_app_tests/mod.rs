//! The materializer tests that need the app crate (#4502): the command layer
//! (`attachments_gc`, `page_link_cache`), `CommandTx` and the boot
//! reprojection (`crash_injection_convergence_tests`), and the reconciliation
//! oracle (`apply_reproject_proptest`). Everything else moved down with the
//! materializer into `agaric_engine::materializer::tests`; the helpers below
//! mirror that module's for the same fixtures.

use crate::db::init_pool;
use crate::materializer::{MaterializeTask, Materializer};
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::op::{AddAttachmentPayload, OpPayload, RestoreBlockPayload};
use agaric_store::op_log::{OpRecord, append_local_op};
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc as StdArc;
use tempfile::TempDir;

const DEV: &str = "test-device-mat";
const FIXED_TS: i64 = 1_735_689_600_000;

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}
async fn make_op_record(pool: &SqlitePool, payload: OpPayload) -> OpRecord {
    append_local_op(pool, DEV, payload).await.unwrap()
}
async fn soft_delete_block_direct(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
        .bind(FIXED_TS)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

mod apply_reproject_proptest;
mod attachments_gc;
mod crash_injection_convergence_tests;
mod page_link_cache;
