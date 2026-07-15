//! #2603 — crash-injection convergence test for the engine↔SQL boundary on
//! REMOTE ops.
//!
//! ## What this pins
//!
//! In the materializer apply pipeline the per-space Loro engine is mutated
//! (`apply_*_via_loro` → `engine.apply`) BEFORE the SQL projection + apply-cursor
//! advance are committed in the same transaction. The engine mutation is an
//! in-memory `LoroDoc` write and is NOT part of the SQL transaction, so a crash /
//! COMMIT failure between the engine apply and the SQL COMMIT leaves the engine
//! AHEAD of committed SQL — the SQL projection and cursor advance roll back
//! together, but the engine keeps the mutation. See the atomicity note on
//! `apply_create_block_via_loro` ("The engine's apply is NOT rolled back
//! automatically.") and the rollback comment in `apply_op` ("a tx rollback leaves
//! the engine ahead of SQL until the next op-log replay reconciles it").
//!
//! ## Why this matters MORE for a REMOTE op — the asymmetry
//!
//! The replay reconciliation net is asymmetric:
//! - **LOCAL** ops live in the device op_log and apply with `advance_cursor =
//!   false`, so boot replay (`recovery::replay`) re-applies them idempotently →
//!   self-healing.
//! - **REMOTE** ops never land in the local op_log (#490-M1) and advance the
//!   apply cursor (`advance_cursor = true`), so boot replay cannot see them. The
//!   only net is the #2504 disaster-recovery reprojection
//!   (`reproject_blocks_from_engine`), which rebuilds SQL from the persisted
//!   engine snapshot.
//!
//! This test reproduces the engine-ahead-of-SQL state on a REMOTE op with a
//! simulated COMMIT failure, proves the op-log path cannot heal it, and asserts
//! that `reproject_blocks_from_engine` converges SQL back to the engine — engine
//! state == SQL projection for the remote-authored block.
//!
//! ## Runs under `cargo nextest`
//!
//! Per the Loro-registry per-process isolation note (AGENTS.md) these engine-path
//! tests run under `cargo nextest` in CI / the pre-push hook. The engine state
//! here is the per-instance `LoroState::new()` (no process-global registry) and
//! the test does not read the process-global `sql_only_fallback` counter, so it
//! is also safe under plain `cargo test`.

use crate::db::init_pool;
use crate::op::{CreateBlockPayload, OpPayload};
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use tempfile::TempDir;

const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAGE_ID: &str = "01HZ00000000000000000CRPGE";
const REMOTE_B: &str = "01HZ00000000000000000CRRMT";
// The device applying the crash-op locally (seeds the page); the op_log stays
// single-device so the `advance_cursor` single-device guard holds.
const DEVICE_ID: &str = "device-crash-injection";
// The op we model as REMOTE is authored on a *different* peer and (faithfully)
// never lands in this device's op_log.
const REMOTE_DEVICE_ID: &str = "device-remote-author";
const REMOTE_CONTENT: &str = "authored on a remote peer";

/// Seed the `space` tag block + its `spaces` registry row and a `page` into BOTH
/// SQL and the per-space engine tree. The page must exist in SQL (with its
/// denormalized `space_id`) so `resolve_block_space` resolves a space for the
/// child create, and in the engine tree so the child create resolves its parent
/// there rather than cascading into the #2250 parent-absent SQL-only fallback.
/// Returns the constructed `LoroState`.
async fn seed_space_and_page() -> (SqlitePool, TempDir, crate::loro::shared::LoroState) {
    let dir = TempDir::new().expect("tempdir");
    let pool = init_pool(&dir.path().join("crash_injection.db"))
        .await
        .expect("init_pool");

    // space tag block + `spaces` registry row (blocks.space_id FK target, #708).
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
        .expect("register space");

    // Page row in SQL with its denormalized space_id/page_id set, so the later
    // child create resolves a space via its parent.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, 'page', 'page-content', NULL, 0, ?, ?)",
    )
    .bind(PAGE_ID)
    .bind(PAGE_ID)
    .bind(SPACE_ID)
    .execute(&pool)
    .await
    .expect("seed page block");

    let state = crate::loro::shared::LoroState::new();

    // Seed the page directly into the per-space engine tree (bypassing the
    // create pipeline, which would SQL-only-fallback for a brand-new page with no
    // space at create time, #2250). Now the child create takes the engine path.
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space (seed page)");
    guard
        .engine_mut()
        .apply_create_block(PAGE_ID, "page", "page-content", None, 0)
        .expect("seed page into engine");
    drop(guard);

    (pool, dir, state)
}

/// Build a REMOTE `CreateBlock` op record. Modelled as remote: constructed
/// in-memory from a *different* device with NO local op_log row (remote ops never
/// reach the local op_log, #490-M1), so boot replay cannot re-materialize it.
fn remote_create_record() -> crate::op_log::OpRecord {
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(REMOTE_B),
        block_type: "content".into(),
        parent_id: Some(BlockId::from_trusted(PAGE_ID)),
        position: Some(0),
        index: None,
        content: REMOTE_CONTENT.into(),
    });
    // `apply_op_tx` deserializes the INNER `CreateBlockPayload` from
    // `record.payload` (op_type is the separate discriminator), so serialize the
    // inner payload.
    let OpPayload::CreateBlock(inner) = &payload else {
        unreachable!("constructed a CreateBlock above")
    };
    let payload_json = serde_json::to_string(inner).expect("serialize payload");
    let hash =
        crate::hash::compute_op_hash(REMOTE_DEVICE_ID, 1, None, "create_block", &payload_json);
    crate::op_log::OpRecord {
        device_id: REMOTE_DEVICE_ID.to_string(),
        seq: 1,
        parent_seqs: None,
        hash,
        op_type: "create_block".to_string(),
        payload: payload_json,
        created_at: 1_767_225_600_000,
        block_id: Some(REMOTE_B.to_string()),
    }
}

async fn cursor(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar(
        "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
    )
    .fetch_one(pool)
    .await
    .expect("read apply cursor")
}

async fn sql_block_count(pool: &SqlitePool, id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("count block")
}

/// A COMMIT failure between `engine.apply` and SQL COMMIT on a REMOTE op leaves
/// the in-memory engine ahead of SQL; the op-log path cannot heal it (remote ops
/// are absent from the local op_log); and `reproject_blocks_from_engine` (#2504)
/// converges SQL back to the engine.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_op_commit_failure_leaves_engine_ahead_then_reproject_converges_2603() {
    let (pool, _dir, state) = seed_space_and_page().await;
    let record = remote_create_record();

    let cursor_before = cursor(&pool).await;

    // ── Crash injection ──────────────────────────────────────────────────────
    // Apply the REMOTE op through the real single-op remote path
    // (`apply_op_projected`, `advance_cursor = true`) but ROLL BACK before commit
    // — the crash BETWEEN `engine.apply` and SQL COMMIT. `apply_op_projected`
    // mutates the in-memory engine (via `apply_op_tx` → `apply_create_block_via_loro`)
    // and stages the SQL projection + cursor advance in `tx`; dropping `tx`
    // (never calling `commit`) rolls back the SQL projection AND the cursor
    // advance, but NOT the engine mutation.
    {
        let mut tx = pool.begin().await.expect("begin crash tx");
        super::apply_op_projected(&mut tx, &record, &state, /* advance_cursor */ true)
            .await
            .expect("apply_op_projected (engine apply + staged SQL projection)");
        drop(tx); // ← crash: rollback before commit
    }

    // ── Assert the divergence: engine is AHEAD of SQL ────────────────────────
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let engine_content_after_crash = {
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space (post-crash read)");
        let snap = guard
            .engine_mut()
            .read_block(REMOTE_B)
            .expect("engine read")
            .expect("engine holds the remote block: the apply is not rolled back");
        drop(guard);
        snap.content
    };
    assert_eq!(
        engine_content_after_crash, REMOTE_CONTENT,
        "the in-memory engine keeps the remote op's mutation after the failed commit"
    );
    assert_eq!(
        sql_block_count(&pool, REMOTE_B).await,
        0,
        "the failed COMMIT rolled back the SQL projection: SQL is behind the engine"
    );
    assert_eq!(
        cursor(&pool).await,
        cursor_before,
        "the apply cursor advance rolled back with the failed tx (never points ahead of SQL)"
    );

    // ── The asymmetry: the op-log path cannot heal a REMOTE divergence ───────
    // A remote op never lands in the local op_log, so boot replay
    // (`recovery::replay`, which only walks op_log) has nothing to re-apply — the
    // self-healing that covers LOCAL ops does not apply here.
    let oplog_rows_for_remote: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM op_log WHERE payload LIKE ?")
            .bind(format!("%{REMOTE_B}%"))
            .fetch_one(&pool)
            .await
            .expect("scan op_log");
    assert_eq!(
        oplog_rows_for_remote, 0,
        "a REMOTE op is absent from the local op_log, so boot replay cannot re-materialize it — \
         only the #2504 engine reprojection can"
    );

    // ── Recovery: persist the ahead-of-SQL engine, then reproject ────────────
    // The periodic snapshot save captures the post-apply engine state — the state
    // a real crash leaves on disk (engine snapshot has the block, SQL does not).
    let snapshot = {
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space (export)");
        let snap = guard
            .engine_mut()
            .export_snapshot()
            .expect("export snapshot");
        drop(guard);
        snap
    };
    sqlx::query(
        "INSERT INTO loro_doc_state (space_id, snapshot, updated_at, op_count) VALUES (?, ?, 0, 1)",
    )
    .bind(SPACE_ID)
    .bind(snapshot)
    .execute(&pool)
    .await
    .expect("persist engine snapshot");

    let fired = crate::db::reproject_blocks_from_engine(&pool)
        .await
        .expect("reproject_blocks_from_engine");
    assert!(
        fired,
        "engine reprojection must fire when a persisted snapshot is present"
    );

    // ── Convergence: SQL now matches the engine for the remote block ─────────
    let (sql_content, sql_parent, sql_position): (String, Option<String>, i64) =
        sqlx::query_as("SELECT content, parent_id, position FROM blocks WHERE id = ?")
            .bind(REMOTE_B)
            .fetch_one(&pool)
            .await
            .expect("remote block restored into SQL by reprojection");
    assert_eq!(
        sql_content, REMOTE_CONTENT,
        "reprojection restored the remote op's content into SQL"
    );
    assert_eq!(
        sql_parent.as_deref(),
        Some(PAGE_ID),
        "reprojection restored the remote block's parent"
    );

    // Three-way agreement on the post-recovery state: engine == SQL projection.
    let engine_final = {
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space (final read)");
        let snap = guard
            .engine_mut()
            .read_block(REMOTE_B)
            .expect("engine read")
            .expect("engine still holds the remote block");
        drop(guard);
        snap
    };
    assert_eq!(
        engine_final.content, sql_content,
        "engine and SQL converge on content after recovery"
    );
    assert_eq!(
        engine_final.position, sql_position,
        "engine and SQL converge on the dense position after recovery"
    );

    // Visibility: the reprojection backfills page_id, so the restored remote
    // block is page-scoped-visible rather than recovered-but-invisible.
    let page_id: Option<String> = sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = ?")
        .bind(REMOTE_B)
        .fetch_one(&pool)
        .await
        .expect("fetch page_id");
    assert_eq!(
        page_id.as_deref(),
        Some(PAGE_ID),
        "reprojected remote block gets its page_id backfilled (page-scoped-visible)"
    );
}

/// #2604 — the SAME REMOTE-op commit-failure as above, but WITH the rollback
/// wiring armed: a [`RevertScope`](crate::loro::revert::RevertScope) rewinds the
/// engine on abort so it never gets ahead of committed SQL. This is the
/// transactional-by-construction counterpart to the divergence the #2603 test
/// pins — no `reproject_blocks_from_engine` recovery is needed because the
/// engine and SQL roll back together.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_op_abort_under_revert_scope_rewinds_engine_no_divergence_2604() {
    let (pool, _dir, state) = seed_space_and_page().await;
    let record = remote_create_record();
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let cursor_before = cursor(&pool).await;

    // ── Crash injection UNDER an armed #2604 revert scope ────────────────────
    // Same shape as the #2603 injection (apply in place, then roll back before
    // commit), except an armed `RevertScope` is held across it. The mutation
    // handler's `for_space_recording` captured the space's pre-op checkpoint
    // into the armed log; dropping the scope on the abort path rewinds the
    // engine to it — mirroring exactly what production `apply_op` does when its
    // `commit()` fails.
    {
        let revert = crate::loro::revert::RevertScope::arm(&state);
        let mut tx = pool.begin().await.expect("begin crash tx");
        super::apply_op_projected(&mut tx, &record, &state, /* advance_cursor */ true)
            .await
            .expect("apply_op_projected (engine apply + staged SQL projection)");
        drop(tx); // ← crash: roll back the SQL projection + cursor advance
        drop(revert); // ← #2604: abort → rewind the engine to its checkpoint
    }

    // ── Assert NO divergence: the engine rewound in lock-step with SQL ───────
    let engine_has_block = {
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space (post-abort read)");
        let present = guard
            .engine_mut()
            .read_block(REMOTE_B)
            .expect("engine read")
            .is_some();
        drop(guard);
        present
    };
    assert!(
        !engine_has_block,
        "the aborted remote op must be rewound OUT of the engine — no engine-ahead-of-SQL divergence"
    );
    assert_eq!(
        sql_block_count(&pool, REMOTE_B).await,
        0,
        "SQL rolled back too: engine and SQL agree the op never landed"
    );
    assert_eq!(
        cursor(&pool).await,
        cursor_before,
        "the apply cursor never advanced"
    );

    // ── The rewound engine is fully usable — re-apply and COMMIT this time ────
    // Proves the rewind left an attached, usable engine (not stuck detached at
    // the checkpoint) and that the op converges into BOTH stores without any
    // recovery reprojection — the whole point of the transactional apply.
    {
        let mut tx = pool.begin().await.expect("begin commit tx");
        super::apply_op_projected(&mut tx, &record, &state, /* advance_cursor */ true)
            .await
            .expect("re-apply after rewind");
        tx.commit().await.expect("commit the re-applied op");
    }
    let engine_final = {
        let mut guard = state
            .registry
            .for_space(&space, DEVICE_ID)
            .expect("for_space (final read)");
        let snap = guard
            .engine_mut()
            .read_block(REMOTE_B)
            .expect("engine read")
            .expect("engine holds the re-applied block");
        drop(guard);
        snap
    };
    assert_eq!(
        engine_final.content, REMOTE_CONTENT,
        "the re-applied op is present in the engine after a clean commit"
    );
    assert_eq!(
        sql_block_count(&pool, REMOTE_B).await,
        1,
        "engine and SQL converge on the committed op — no reprojection needed"
    );
    assert_eq!(
        engine_final.parent_id.as_deref(),
        Some(PAGE_ID),
        "the re-applied block keeps its parent linkage"
    );
}
