//! #2894: recovery↔kernel differential parity net.
//!
//! ## Why this file exists
//!
//! The meaning of an op-log record is re-implemented across several
//! interpreters that today are aligned only by comments plus isolated
//! per-interpreter tests. Two of them are the *disaster-recovery* interpreters
//! that reconstruct a corrupted DB straight from `op_log`:
//!
//!   * **interpreter 3** — [`super::recover_blocks_from_op_log`]: replays
//!     block-level ops (create/edit/move/delete/restore/purge) into a temporary
//!     constraint-free `blocks` table PRE-migration, and
//!   * **interpreter 4** — [`super::recover_derived_state_from_op_log`]: replays
//!     property/tag/attachment ops POST-migration onto the real schema.
//!
//! The canonical semantics live in **interpreter 1** — the kernel
//! ([`agaric_engine::apply::kernel::apply_op_tx`]) — which every LOCAL command
//! and REMOTE sync op flows through. Until this file there was NO test driving
//! the same op corpus through a recovery interpreter AND the kernel and
//! asserting they converge (for the arms that are *supposed* to converge) or
//! diverge in exactly the DOCUMENTED way (for the arms #2043 intentionally
//! keeps divergent). This is that safety net.
//!
//! ## What is pinned here
//!
//! 1. **Structural parity (interpreter 3 vs kernel 1).** A create + edit + move
//!    corpus — the three NON-divergent block arms — driven through both, then
//!    asserted equal on the restricted `{id, block_type, content, parent_id}`
//!    shape over the active rows. `position` / `page_id` are DELIBERATELY
//!    excluded from the cross-arm compare: recovery reconstructs them
//!    differently (#1252 provisional ranks; its own `page_id` fixed-point loop),
//!    exactly as the sibling create/edit convergence net (#1323 Step 3) excludes
//!    `position` as the documented #1245/#1257 reproject-gap.
//!
//! 2. **Divergence pins (delete_block + restore_block).** #2043 keeps the
//!    recovery restore arm INTENTIONALLY divergent from the kernel: recovery
//!    un-deletes only the flat `(seed, deleted_at_ref)` descendant cohort, while
//!    the kernel (`project_restore_block_to_sql`) ALSO restores the contiguous
//!    soft-deleted ANCESTOR chain (#1884 live-orphan fix / #2017). The pin
//!    reconstructs the exact orphan scenario and asserts the kernel restores the
//!    tombstoned ancestor while recovery leaves it deleted. The pin is
//!    non-vacuous: it fails if either interpreter is changed to match the other.
//!
//! ## How the two arms stay byte-aligned on op ordering / timestamps
//!
//! The kernel arm is built FIRST — every op is appended via
//! [`crate::op_log::append_local_op`] (which assigns `seq` + `created_at`) and
//! applied through `apply_op_tx`. The recovery arm then CLONES that arm's
//! `op_log` verbatim (same `payload` / `created_at` / `seq` / `device_id`) into
//! a fresh pool before replaying it. That matters for the delete/restore pin:
//! recovery stamps `deleted_at` from each delete op's OWN `created_at` and the
//! restore's `deleted_at_ref` must match it — cloning the log makes the cohort
//! timestamps line up across arms with zero hand-synchronisation.
//!
//! ## Proving the kernel arm really ran the ENGINE path (#891)
//!
//! #891's lesson: a fixture that never seeds the engine silently runs the
//! sql_only FALLBACK, not the production kernel path. The structural arm
//! therefore seeds the page into the engine (mirroring the #1323/#2250
//! convergence nets) and, after the ops, reads the block back OUT of the
//! per-space engine and asserts the edit + move landed there — proving
//! `apply_op_tx` drove interpreter 1, not the sql_only shim.
//!
//! Process isolation: nextest runs each test in its own process, so these tests
//! must run under `cargo nextest run` (as CI / the pre-push hook do).

use super::recover_blocks_from_op_log;
use crate::db::init_pool;
use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    PurgeBlockPayload, RestoreBlockPayload, SetPropertyPayload,
};
use crate::ulid::BlockId;
use sqlx::{Row, SqlitePool};
use tempfile::TempDir;

/// The registered space every block resolves to (a `tag`/`space` block + its
/// `spaces(id)` registry row, #708). Seeded via direct SQL, so it is NOT an op
/// and never appears in the recovery arm — the compares filter to the created
/// blocks only.
const SPACE_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DEVICE_ID: &str = "device-recovery-kernel-parity";

/// The at-head (post-0080, INTEGER `deleted_at`) constraint-free temp `blocks`
/// table [`recover_blocks_from_op_log`] rebuilds into — copied verbatim from the
/// existing recovery tests' fixture so the replay runs against the same shape it
/// does in production's migration-73 rebuild path.
const TEMP_BLOCKS_DDL: &str = "CREATE TABLE blocks (
     id TEXT NOT NULL PRIMARY KEY, block_type TEXT NOT NULL DEFAULT 'content',
     content TEXT, parent_id TEXT, position INTEGER, deleted_at INTEGER,
     todo_state TEXT, priority TEXT, due_date TEXT, scheduled_date TEXT, page_id TEXT
 )";

/// The restricted cross-arm shape: `(id, block_type, content, parent_id)`.
/// `position` and `page_id` are excluded on purpose (recovery reconstructs them
/// by its own rules — see the module doc).
type ShapeRow = (String, String, String, Option<String>);

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/// Seed the `space` block + its `spaces` registry row (#708) so any block's
/// `blocks.space_id` (FK → spaces(id)) can be stamped.
async fn seed_space(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'space', NULL, 0)",
    )
    .bind(SPACE_ID)
    .execute(pool)
    .await
    .expect("seed space block");
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(SPACE_ID)
        .execute(pool)
        .await
        .expect("register space");
}

/// #2250: seed a block directly into the per-space engine tree, bypassing the
/// op/create pipeline. Used to place a page that legitimately cannot engine-
/// apply through its create op (a brand-new page has no resolvable space at
/// create time, so its create falls back to sql_only and never enters the
/// engine) — so its descendants' creates/moves genuinely take the engine path
/// rather than cascading into the parent-absent fallback.
fn seed_block_into_engine(
    state: &crate::loro::shared::LoroState,
    space_id: &str,
    block_id: &str,
    block_type: &str,
    parent: Option<&str>,
    position: i64,
) {
    let space = crate::space::SpaceId::from_trusted(space_id);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space (seed into engine)");
    guard
        .engine_mut()
        .apply_create_block(block_id, block_type, "", parent, position)
        .expect("seed apply_create_block into engine");
    drop(guard);
}

/// Drive a CreateBlock op through the real `apply_op_tx` kernel pipeline.
async fn create_via_kernel(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    block_id: &str,
    block_type: &str,
    parent: Option<&str>,
    content: &str,
) {
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: block_type.into(),
        parent_id: parent.map(BlockId::from_trusted),
        position: Some(0),
        index: None,
        content: content.into(),
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append create");
    let mut tx = pool.begin().await.expect("begin create");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply create");
    tx.commit().await.expect("commit create");
}

/// Stamp `parent_id` / `page_id` / `space_id` on a freshly-created block. In
/// production these are reconciled post-commit (deferred `SetBlockPageId` /
/// space-propagation tasks). This op-log-only fixture skips that fan-out, so we
/// stamp inline: without a resolvable `space_id` the NEXT child's create — and
/// any later move/delete — would resolve `None` and silently route through the
/// sql_only fallback, leaving the block ABSENT from the engine tree.
async fn stamp_owner(pool: &SqlitePool, id: &str, parent: Option<&str>, page: &str) {
    sqlx::query("UPDATE blocks SET parent_id = ?, page_id = ?, space_id = ? WHERE id = ?")
        .bind(parent)
        .bind(page)
        .bind(SPACE_ID)
        .bind(id)
        .execute(pool)
        .await
        .expect("stamp owner");
}

/// Clone `op_log` verbatim from the kernel-arm pool into the recovery-arm pool
/// so both interpreters replay a byte-identical op corpus with identical
/// `created_at` / `seq` (the cohort-timestamp alignment the restore pin needs).
async fn clone_op_log(from: &SqlitePool, to: &SqlitePool) {
    let rows = sqlx::query(
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at \
         FROM op_log ORDER BY created_at, device_id, seq",
    )
    .fetch_all(from)
    .await
    .expect("read source op_log");
    for row in rows {
        let device_id: String = row.get("device_id");
        let seq: i64 = row.get("seq");
        let parent_seqs: Option<String> = row.get("parent_seqs");
        let hash: String = row.get("hash");
        let op_type: String = row.get("op_type");
        let payload: String = row.get("payload");
        let created_at: i64 = row.get("created_at");
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(seq)
        .bind(parent_seqs)
        .bind(hash)
        .bind(op_type)
        .bind(payload)
        .bind(created_at)
        .execute(to)
        .await
        .expect("insert cloned op");
    }
}

/// Build the recovery arm: a fresh migrated pool whose `op_log` is cloned from
/// `source_pool`, whose `blocks` table is replaced with the constraint-free temp
/// table, into which [`recover_blocks_from_op_log`] replays the block ops
/// (at-head ms era ⇒ `deleted_at_is_ms = true`).
async fn run_recovery_arm(source_pool: &SqlitePool, dir: &TempDir) -> SqlitePool {
    let pool = init_pool(&dir.path().join("recovery_arm.db"))
        .await
        .expect("init_pool");
    clone_op_log(source_pool, &pool).await;

    // Replace the migrated `blocks` table with the constraint-free temp table
    // the recovery replay rebuilds into (mirrors the migration-73 rebuild path).
    sqlx::query("DROP TABLE IF EXISTS blocks")
        .execute(&pool)
        .await
        .expect("drop blocks");
    sqlx::query(TEMP_BLOCKS_DDL)
        .execute(&pool)
        .await
        .expect("create temp blocks");

    let mut conn = pool.acquire().await.expect("acquire");
    recover_blocks_from_op_log(&mut conn, /* deleted_at_is_ms */ true)
        .await
        .expect("recover blocks");
    drop(conn);
    pool
}

/// `(id, block_type, content, parent_id)` for the four created blocks, ACTIVE
/// rows only (`deleted_at IS NULL`), ordered by id — the restricted cross-arm
/// shape. A fixed 4-id literal query (no dynamic SQL).
async fn active_shape(pool: &SqlitePool, ids: [&str; 4]) -> Vec<ShapeRow> {
    sqlx::query_as::<_, ShapeRow>(
        "SELECT id, block_type, content, parent_id FROM blocks \
         WHERE deleted_at IS NULL AND id IN (?, ?, ?, ?) ORDER BY id",
    )
    .bind(ids[0])
    .bind(ids[1])
    .bind(ids[2])
    .bind(ids[3])
    .fetch_all(pool)
    .await
    .expect("active shape")
}

/// Whether `id`'s row is soft-deleted (`deleted_at IS NOT NULL`). A missing row
/// returns `None`.
async fn is_deleted(pool: &SqlitePool, id: &str) -> Option<bool> {
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .expect("fetch deleted_at")
        .map(|deleted_at| deleted_at.is_some())
}

/// Read a block back OUT of the per-space engine (proves the kernel/engine path
/// #1 actually ran, not the sql_only shim — #891).
fn engine_read(
    state: &crate::loro::shared::LoroState,
    id: &str,
) -> Option<crate::loro::engine::BlockSnapshot> {
    let space = crate::space::SpaceId::from_trusted(SPACE_ID);
    let mut guard = state
        .registry
        .for_space(&space, DEVICE_ID)
        .expect("for_space");
    let snap = guard
        .engine_mut()
        .read_block(id)
        .expect("engine read_block");
    drop(guard);
    snap
}

// ---------------------------------------------------------------------------
// Generic single-op kernel drivers (Parts 3-6). Each appends the op via
// `append_local_op` (assigns seq + created_at) and applies it through the real
// `apply_op_tx` kernel — the SAME pipeline as the Part 1/2 arms — so the
// widened corpus never writes expected state via direct SQL.
// ---------------------------------------------------------------------------

/// Drive an `EditBlock` op through the kernel; returns nothing.
async fn edit_via_kernel(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    id: &str,
    to_text: &str,
) {
    let payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(id),
        to_text: to_text.into(),
        prev_edit: None,
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append edit");
    let mut tx = pool.begin().await.expect("begin edit");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply edit");
    tx.commit().await.expect("commit edit");
}

/// Drive a `MoveBlock` op (reparent to `new_parent` at 0-based `new_index`).
async fn move_via_kernel(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    id: &str,
    new_parent: Option<&str>,
    new_index: i64,
) {
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(id),
        new_parent_id: new_parent.map(BlockId::from_trusted),
        new_position: new_index + 1,
        new_index: Some(new_index),
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append move");
    let mut tx = pool.begin().await.expect("begin move");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply move");
    tx.commit().await.expect("commit move");
}

/// Drive a `DeleteBlock` op; returns the op's `created_at` (the cohort token a
/// later `RestoreBlock`'s `deleted_at_ref` must carry — see the Part 2 doc).
async fn delete_via_kernel(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    id: &str,
) -> i64 {
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(id),
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append delete");
    let created_at = record.created_at;
    let mut tx = pool.begin().await.expect("begin delete");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply delete");
    tx.commit().await.expect("commit delete");
    created_at
}

/// Drive a `RestoreBlock` op with the originating delete's cohort token.
async fn restore_via_kernel(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    id: &str,
    deleted_at_ref: i64,
) {
    let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(id),
        deleted_at_ref,
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append restore");
    let mut tx = pool.begin().await.expect("begin restore");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply restore");
    tx.commit().await.expect("commit restore");
}

/// Drive a `PurgeBlock` op (hard-delete the soft-deleted subtree).
async fn purge_via_kernel(pool: &SqlitePool, state: &crate::loro::shared::LoroState, id: &str) {
    let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
        block_id: BlockId::from_trusted(id),
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append purge");
    let mut tx = pool.begin().await.expect("begin purge");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply purge");
    tx.commit().await.expect("commit purge");
}

/// Drive a `SetProperty` op (a satellite op the block-table recovery replay is
/// expected to IGNORE — see `interleaved_property_op_is_inert_to_block_parity`).
async fn set_property_via_kernel(
    pool: &SqlitePool,
    state: &crate::loro::shared::LoroState,
    id: &str,
    key: &str,
    value_text: &str,
) {
    let payload = OpPayload::SetProperty(SetPropertyPayload {
        block_id: BlockId::from_trusted(id),
        key: key.into(),
        value_text: Some(value_text.into()),
        value_num: None,
        value_date: None,
        value_ref: None,
        value_bool: None,
    });
    let record = crate::op_log::append_local_op(pool, DEVICE_ID, payload)
        .await
        .expect("append set_property");
    let mut tx = pool.begin().await.expect("begin set_property");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &record, None, state)
        .await
        .expect("apply set_property");
    tx.commit().await.expect("commit set_property");
}

/// `page_id` of an ACTIVE block (`deleted_at IS NULL`); `None` if the row is
/// missing or soft-deleted. Single fixed-shape query (no dynamic SQL).
async fn page_id_of(pool: &SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT page_id FROM blocks WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .expect("fetch page_id")
    .flatten()
}

/// `position` of an ACTIVE block (`deleted_at IS NULL`); `None` if the row is
/// missing/soft-deleted or the column is NULL. Single fixed-shape query.
async fn position_of(pool: &SqlitePool, id: &str) -> Option<i64> {
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT position FROM blocks WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .expect("fetch position")
    .flatten()
}

// ===========================================================================
// Part 1 — Structural parity (interpreter 3 vs kernel 1): create + edit + move
// ===========================================================================

// Tail-distinct ULIDs; lexical id order is A < B < PAGE < PARENT.
const S_PAGE: &str = "01HZ0000000000000000STPG01";
const S_PARENT: &str = "01HZ0000000000000000STPR01";
const S_A: &str = "01HZ0000000000000000STCA01";
const S_B: &str = "01HZ0000000000000000STCB01";

/// Build the kernel arm for the structural corpus. Returns the pool + the
/// `LoroState` so the caller can prove the engine path ran.
///
/// Corpus (all through `apply_op_tx`):
///   1. create PAGE (page)         — falls back to sql_only (fresh page has no
///      resolvable space at create time), then seeded into the engine so the
///      children below take the ENGINE path.
///   2. create PARENT (child PAGE)
///   3. create A, B (children PARENT)
///   4. edit A                     — content UPDATE
///   5. move B under A             — reparent (the parent_id differential)
async fn run_structural_kernel_arm(dir: &TempDir) -> (SqlitePool, crate::loro::shared::LoroState) {
    let pool = init_pool(&dir.path().join("kernel_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;

    let state = crate::loro::shared::LoroState::new();

    // (1) Page create — legitimately falls back to sql_only (no space yet), so
    // seed it into the engine to give the descendant creates a resolvable
    // parent in the tree (#2250).
    create_via_kernel(&pool, &state, S_PAGE, "page", None, "structural-page").await;
    // A page's own page_id is itself (#1324); a page has no parent.
    stamp_owner(&pool, S_PAGE, None, S_PAGE).await;
    seed_block_into_engine(&state, SPACE_ID, S_PAGE, "page", None, 0);

    // (2) Parent under the page — engine path (page is now in the tree + has a
    // stamped space_id).
    create_via_kernel(
        &pool,
        &state,
        S_PARENT,
        "content",
        Some(S_PAGE),
        "structural-parent",
    )
    .await;
    stamp_owner(&pool, S_PARENT, Some(S_PAGE), S_PAGE).await;

    // (3) Two content children of the parent — engine path.
    create_via_kernel(
        &pool,
        &state,
        S_A,
        "content",
        Some(S_PARENT),
        "structural-a",
    )
    .await;
    stamp_owner(&pool, S_A, Some(S_PARENT), S_PAGE).await;
    create_via_kernel(
        &pool,
        &state,
        S_B,
        "content",
        Some(S_PARENT),
        "structural-b",
    )
    .await;
    stamp_owner(&pool, S_B, Some(S_PARENT), S_PAGE).await;

    // (4) EditBlock on A — content UPDATE through the kernel.
    let edit = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(S_A),
        to_text: "structural-a-edited".into(),
        prev_edit: None,
    });
    let edit_record = crate::op_log::append_local_op(&pool, DEVICE_ID, edit)
        .await
        .expect("append edit");
    let mut tx = pool.begin().await.expect("begin edit");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &edit_record, None, &state)
        .await
        .expect("apply edit");
    tx.commit().await.expect("commit edit");

    // (5) MoveBlock B → under A (reparent; index 0). The parent_id differential.
    let mv = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(S_B),
        new_parent_id: Some(BlockId::from_trusted(S_A)),
        new_position: 1,
        new_index: Some(0),
    });
    let mv_record = crate::op_log::append_local_op(&pool, DEVICE_ID, mv)
        .await
        .expect("append move");
    let mut tx = pool.begin().await.expect("begin move");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &mv_record, None, &state)
        .await
        .expect("apply move");
    tx.commit().await.expect("commit move");

    (pool, state)
}

/// The load-bearing #2894 structural assertion: the recovery interpreter
/// (`recover_blocks_from_op_log`) and the kernel (`apply_op_tx`) project
/// IDENTICAL `blocks` rows — on the `{id, block_type, content, parent_id}`
/// shape the create/edit/move projections govern — for the same op corpus, AND
/// match the absolute expected rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structural_recovery_converges_with_kernel() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let (kernel_pool, state) = run_structural_kernel_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    let ids = [S_A, S_B, S_PAGE, S_PARENT];
    let kernel_shape = active_shape(&kernel_pool, ids).await;
    let recovery_shape = active_shape(&recovery_pool, ids).await;

    // --- Cross-arm shape equality (the differential) ---
    assert_eq!(
        kernel_shape, recovery_shape,
        "recovery interpreter (#3) and kernel (#1) must project identical \
         {{id, block_type, content, parent_id}} for create+edit+move; \
         kernel={kernel_shape:?} recovery={recovery_shape:?}"
    );

    // --- Absolute expected rows (pin the shape down, not just cross-arm equal) ---
    // ids sort: STCA01(A) < STCB01(B) < STPG01(PAGE) < STPR01(PARENT).
    let expected: Vec<ShapeRow> = vec![
        // A: content EDITED (#edit arm), still a child of PARENT.
        (
            S_A.to_string(),
            "content".to_string(),
            "structural-a-edited".to_string(),
            Some(S_PARENT.to_string()),
        ),
        // B: REPARENTED under A by the move (the parent_id differential).
        (
            S_B.to_string(),
            "content".to_string(),
            "structural-b".to_string(),
            Some(S_A.to_string()),
        ),
        // PAGE: a page block, no parent.
        (
            S_PAGE.to_string(),
            "page".to_string(),
            "structural-page".to_string(),
            None,
        ),
        // PARENT: child of PAGE.
        (
            S_PARENT.to_string(),
            "content".to_string(),
            "structural-parent".to_string(),
            Some(S_PAGE.to_string()),
        ),
    ];
    assert_eq!(
        kernel_shape, expected,
        "structural rows must match absolute expected; got {kernel_shape:?}"
    );

    // --- #891: prove the kernel arm drove the ENGINE path (interpreter 1), not
    // the sql_only shim — read the block back OUT of the per-space engine. ---
    let a_snap = engine_read(&state, S_A).expect("A present in engine");
    assert_eq!(
        a_snap.content, "structural-a-edited",
        "the EditBlock must have landed in the engine (engine path ran, #891)"
    );
    let b_snap = engine_read(&state, S_B).expect("B present in engine");
    assert_eq!(
        b_snap.parent_id.as_deref(),
        Some(S_A),
        "the MoveBlock must have reparented B under A in the engine tree \
         (engine path ran, #891)"
    );
}

// ===========================================================================
// Part 2 — Divergence pins (delete_block + restore_block): #2043 / #1884 / #2017
// ===========================================================================

const D_PAGE: &str = "01HZ0000000000000000DVPG01";
// The middle block that becomes a TOMBSTONED ANCESTOR (deleted after its child).
const D_PARENT: &str = "01HZ0000000000000000DVPR01";
// The leaf that is deleted first, then restored — its restore is the divergence.
const D_CHILD: &str = "01HZ0000000000000000DVCH01";

/// Build the kernel arm for the divergence corpus. Returns the pool.
///
/// Corpus (all through `apply_op_tx`):
///   1. create PAGE > PARENT > CHILD (nested).
///   2. DeleteBlock(CHILD)  — CHILD alone gets cohort `ts_child`.
///   3. DeleteBlock(PARENT) — PARENT gets cohort `ts_parent`; the already-
///      deleted CHILD is SKIPPED by the active-descendants filter, so it keeps
///      `ts_child`. PARENT is now a tombstoned ancestor above CHILD.
///   4. RestoreBlock(CHILD, deleted_at_ref = ts_child).
///
/// After step 4 the kernel restores CHILD *and* the contiguous soft-deleted
/// ancestor PARENT (#1884/#2017), so both are active. Recovery, replaying the
/// SAME op_log, restores only the flat CHILD cohort and leaves PARENT deleted.
async fn run_divergence_kernel_arm(dir: &TempDir) -> SqlitePool {
    let pool = init_pool(&dir.path().join("kernel_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;

    let state = crate::loro::shared::LoroState::new();

    create_via_kernel(&pool, &state, D_PAGE, "page", None, "divergence-page").await;
    stamp_owner(&pool, D_PAGE, None, D_PAGE).await;
    seed_block_into_engine(&state, SPACE_ID, D_PAGE, "page", None, 0);

    create_via_kernel(
        &pool,
        &state,
        D_PARENT,
        "content",
        Some(D_PAGE),
        "divergence-parent",
    )
    .await;
    stamp_owner(&pool, D_PARENT, Some(D_PAGE), D_PAGE).await;

    create_via_kernel(
        &pool,
        &state,
        D_CHILD,
        "content",
        Some(D_PARENT),
        "divergence-child",
    )
    .await;
    stamp_owner(&pool, D_CHILD, Some(D_PARENT), D_PAGE).await;

    // (2) DeleteBlock(CHILD) — capture the op's created_at: it is BOTH the
    // deleted_at the delete arm stamps AND the deleted_at_ref the restore below
    // must carry (production wiring). Cloning the op_log keeps this aligned in
    // the recovery arm too.
    let del_child = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(D_CHILD),
    });
    let del_child_record = crate::op_log::append_local_op(&pool, DEVICE_ID, del_child)
        .await
        .expect("append delete child");
    let mut tx = pool.begin().await.expect("begin delete child");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &del_child_record, None, &state)
        .await
        .expect("apply delete child");
    tx.commit().await.expect("commit delete child");

    // (3) DeleteBlock(PARENT) — PARENT becomes the tombstoned ancestor.
    let del_parent = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(D_PARENT),
    });
    let del_parent_record = crate::op_log::append_local_op(&pool, DEVICE_ID, del_parent)
        .await
        .expect("append delete parent");
    let mut tx = pool.begin().await.expect("begin delete parent");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &del_parent_record, None, &state)
        .await
        .expect("apply delete parent");
    tx.commit().await.expect("commit delete parent");

    // (4) RestoreBlock(CHILD) with the CHILD-cohort token. Its parent is still
    // tombstoned, so `apply_restore_block_via_loro` resolves off the soft-
    // deleted parent, misses a space, and routes to the sql_only restore — which
    // STILL runs `project_restore_block_to_sql` (the ancestor-restoring kernel
    // projection). This is the production orphan-restore path.
    let restore = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(D_CHILD),
        deleted_at_ref: del_child_record.created_at,
    });
    let restore_record = crate::op_log::append_local_op(&pool, DEVICE_ID, restore)
        .await
        .expect("append restore");
    let mut tx = pool.begin().await.expect("begin restore");
    agaric_engine::apply::kernel::apply_op_tx(&mut tx, &restore_record, None, &state)
        .await
        .expect("apply restore");
    tx.commit().await.expect("commit restore");

    pool
}

/// The load-bearing #2894 divergence pin: for an orphan restore (delete child,
/// then delete its parent, then restore the child), the kernel restores the
/// tombstoned ANCESTOR (#1884/#2017) while the recovery interpreter deliberately
/// does NOT (#2043 — it un-deletes only the flat `(seed, deleted_at_ref)`
/// cohort). This pin is NON-VACUOUS: it fails if recovery is changed to restore
/// ancestors, or if the kernel is changed to stop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_ancestor_divergence_is_pinned() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let kernel_pool = run_divergence_kernel_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    // --- Agreement on the restored SEED (both un-delete the child cohort). ---
    // #2043: the recovery restore arm shares the delete-arm's descendant-cohort
    // shape keyed on `deleted_at = deleted_at_ref`, so the seed itself is
    // restored in BOTH interpreters.
    assert_eq!(
        is_deleted(&kernel_pool, D_CHILD).await,
        Some(false),
        "kernel: the restored child (seed) must be active"
    );
    assert_eq!(
        is_deleted(&recovery_pool, D_CHILD).await,
        Some(false),
        "recovery: the restored child (seed) must be active"
    );

    // --- THE DIVERGENCE: the tombstoned ANCESTOR. ---
    // #1884/#2017: the kernel's `project_restore_block_to_sql` restores the
    // contiguous soft-deleted ancestor chain above the seed, so PARENT is
    // un-deleted (no live-orphan under a tombstone).
    assert_eq!(
        is_deleted(&kernel_pool, D_PARENT).await,
        Some(false),
        "kernel MUST restore the tombstoned ancestor PARENT (#1884/#2017 \
         live-orphan fix); if this fails the kernel stopped restoring ancestors"
    );
    // #2043: recovery INTENTIONALLY keeps the flat `(seed, deleted_at_ref)`
    // cohort with NO ancestor restore, so PARENT stays deleted. If a future
    // change routes recovery through the connected-cohort/ancestor projection,
    // this assertion fires — the pin's whole purpose.
    assert_eq!(
        is_deleted(&recovery_pool, D_PARENT).await,
        Some(true),
        "recovery MUST leave the ancestor PARENT tombstoned (#2043 flat-cohort, \
         NO ancestor restore); if this fails recovery started restoring ancestors"
    );

    // The pin is non-vacuous by construction: the two arms replay a BYTE-
    // IDENTICAL op_log (cloned), so the ONLY reason PARENT's state differs is
    // the interpreter-level ancestor-restore divergence asserted above.
    assert_ne!(
        is_deleted(&kernel_pool, D_PARENT).await,
        is_deleted(&recovery_pool, D_PARENT).await,
        "the documented #2043 ancestor-restore divergence must be OBSERVABLE: \
         kernel restores PARENT, recovery leaves it deleted"
    );
}

// ===========================================================================
// Part 3 — Derived-state parity (interpreter 3 vs kernel 1): page_id + position
//
// Part 1 pins the `{id, block_type, content, parent_id}` shape. This part
// extends the differential to the two DERIVED columns Part 1 deliberately
// excluded, establishing an HONEST contract for each: `page_id` is asserted
// EQUAL (both interpreters converge on page ownership), `position` is PINNED
// DIVERGENT (they reconstruct sibling rank by different rules). Both reuse the
// Part 1 create+edit+move corpus (`run_structural_kernel_arm`).
// ===========================================================================

/// **`page_id` converges.** Recovery has NO page_id op arm — it computes the
/// column AFTER the replay loop: pages self-reference (`page_id = id WHERE
/// block_type = 'page'`) and content blocks inherit the nearest page ancestor
/// via a fixed-point UPDATE loop over `parent_id` (see the tail of
/// `recover_blocks_from_op_log`). The kernel arm stamps the same ownership
/// inline (`stamp_owner`, standing in for the deferred `SetBlockPageId`
/// fan-out). For this corpus BOTH resolve every block to `S_PAGE` — including
/// the MOVED block B, whose page ownership recovery must re-derive through the
/// restructured chain B→A→PARENT→PAGE. This is the derived-state equality half
/// of the #2894 contract: assert equality where equality is the spec.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structural_page_id_converges_with_kernel() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let (kernel_pool, _state) = run_structural_kernel_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    for id in [S_PAGE, S_PARENT, S_A, S_B] {
        let kernel_page = page_id_of(&kernel_pool, id).await;
        let recovery_page = page_id_of(&recovery_pool, id).await;
        assert_eq!(
            kernel_page, recovery_page,
            "recovery (#3) and kernel (#1) must agree on page_id for {id}; \
             kernel={kernel_page:?} recovery={recovery_page:?}"
        );
        assert_eq!(
            recovery_page.as_deref(),
            Some(S_PAGE),
            "every block in the structural corpus is owned by the page S_PAGE; \
             recovery's page_id fixed-point loop must resolve {id} to it \
             (the MOVED block B proves the loop follows the restructured chain)"
        );
    }
}

/// **`position` diverges (pinned).** The two interpreters reconstruct sibling
/// rank by DIFFERENT rules, so the column cannot be cross-asserted equal:
///
///   * **kernel (#1)** projects the engine's DENSE 1-based rank among a
///     parent's children (`LoroEngine::read_block` → `child_rank_position`,
///     projected by `project_create_block_to_sql` / `project_move_block_to_sql`).
///   * **recovery (#3)** replays the RAW op payload: `create_block` writes the
///     payload's `position` verbatim (here `Some(0)` for every create — the
///     fixture builds ops with `position: Some(0)`), and `move_block` maps
///     `new_index` through `index_to_provisional_position` (0-based → 1-based).
///
/// So the two agree only where the raw payload happens to coincide with the
/// dense rank (the moved block B, index 0 → position 1, matches its dense rank
/// of 1 as A's sole child) and diverge on the create-only blocks (recovery 0 vs
/// kernel's 1-based rank). This mirrors the Part 1 module-doc rationale and the
/// sibling create/edit convergence net (#1323 Step 3), which likewise exclude
/// `position` as the #1245/#1257/#1252 reproject-gap. The pin is the honest
/// divergence half of the #2894 contract: pin divergence where divergence is
/// the reality. It is NON-VACUOUS — the two arms replay a byte-identical
/// op_log, so any change that made recovery reproject the dense rank (or the
/// kernel stop) would flip these asserts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn structural_position_divergence_is_pinned() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let (kernel_pool, _state) = run_structural_kernel_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    // Recovery replays the raw payloads: every create carried `position: 0`, and
    // the move of B carried `new_index: 0` → provisional position 1.
    assert_eq!(position_of(&recovery_pool, S_PAGE).await, Some(0));
    assert_eq!(position_of(&recovery_pool, S_PARENT).await, Some(0));
    assert_eq!(position_of(&recovery_pool, S_A).await, Some(0));
    assert_eq!(position_of(&recovery_pool, S_B).await, Some(1));

    // Kernel projects the engine's dense 1-based child rank. PARENT (sole child
    // of PAGE), A (sole child of PARENT after B moved away) and B (sole child of
    // A) are all rank 1. PAGE's create legitimately fell back to sql_only (no
    // resolvable space at create time, see `run_structural_kernel_arm`), so its
    // row carries the sql-only create rank rather than an engine reprojection.
    assert_eq!(position_of(&kernel_pool, S_PARENT).await, Some(1));
    assert_eq!(position_of(&kernel_pool, S_A).await, Some(1));
    assert_eq!(position_of(&kernel_pool, S_B).await, Some(1));

    // THE DIVERGENCE: the create-only blocks differ (recovery 0 vs kernel 1).
    assert_ne!(
        position_of(&kernel_pool, S_PARENT).await,
        position_of(&recovery_pool, S_PARENT).await,
        "position MUST diverge for a create-only block: kernel projects the \
         dense 1-based rank, recovery replays the raw payload position (0). If \
         this fails, recovery started reprojecting the dense rank (or the kernel \
         stopped) — the #1245/#1257 reproject-gap the Part 1 doc cites closed."
    );
    assert_ne!(
        position_of(&kernel_pool, S_A).await,
        position_of(&recovery_pool, S_A).await,
        "position MUST diverge for A as well (kernel 1 vs recovery 0)"
    );
}

// ===========================================================================
// Part 4 — Widened op corpus (interleavings beyond Part 1/2)
//
// Each arm drives ops through the SAME `apply_op_tx` pipeline (via the generic
// drivers above), then replays the cloned op_log through
// `recover_blocks_from_op_log`, asserting the two converge on the restricted
// `{id, block_type, content, parent_id}` shape for the arms that SHOULD agree.
// ===========================================================================

// --- 4a: delete → restore → edit → move (a non-orphan restore converges) ---

const W_PAGE: &str = "01HZ0000000000000000W4PG01";
const W_P: &str = "01HZ0000000000000000W4PR01";
const W_X: &str = "01HZ0000000000000000W4CX01";
const W_Y: &str = "01HZ0000000000000000W4CY01";

/// Build the 4a kernel arm. Corpus (all through `apply_op_tx`):
///   1. create PAGE > P > {X, Y}
///   2. delete X          — X is a LEAF whose parent P stays ALIVE, so the
///      restore below is a plain cohort restore (NOT the Part 2 orphan case:
///      no tombstoned ancestor, hence no #2043 divergence).
///   3. restore X         — cohort token = the delete op's created_at.
///   4. edit X            — content UPDATE lands on the now-active row.
///   5. move X under Y    — reparent (index 0).
async fn run_delete_restore_edit_move_arm(
    dir: &TempDir,
) -> (SqlitePool, crate::loro::shared::LoroState) {
    let pool = init_pool(&dir.path().join("kernel_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    let state = crate::loro::shared::LoroState::new();

    create_via_kernel(&pool, &state, W_PAGE, "page", None, "w-page").await;
    stamp_owner(&pool, W_PAGE, None, W_PAGE).await;
    seed_block_into_engine(&state, SPACE_ID, W_PAGE, "page", None, 0);

    create_via_kernel(&pool, &state, W_P, "content", Some(W_PAGE), "w-p").await;
    stamp_owner(&pool, W_P, Some(W_PAGE), W_PAGE).await;
    create_via_kernel(&pool, &state, W_X, "content", Some(W_P), "w-x").await;
    stamp_owner(&pool, W_X, Some(W_P), W_PAGE).await;
    create_via_kernel(&pool, &state, W_Y, "content", Some(W_P), "w-y").await;
    stamp_owner(&pool, W_Y, Some(W_P), W_PAGE).await;

    let ts_x = delete_via_kernel(&pool, &state, W_X).await;
    restore_via_kernel(&pool, &state, W_X, ts_x).await;
    edit_via_kernel(&pool, &state, W_X, "w-x-edited").await;
    move_via_kernel(&pool, &state, W_X, Some(W_Y), 0).await;

    (pool, state)
}

/// #2894 widened corpus: a delete→restore→edit→move interleaving on a leaf
/// (parent never tombstoned) converges between recovery (#3) and the kernel
/// (#1) on the structural shape. Proves the recovery restore arm re-activates
/// the row so the subsequent edit/move land identically to the kernel.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_restore_edit_move_converges_with_kernel() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let (kernel_pool, state) = run_delete_restore_edit_move_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    let ids = [W_PAGE, W_P, W_X, W_Y];
    let kernel_shape = active_shape(&kernel_pool, ids).await;
    let recovery_shape = active_shape(&recovery_pool, ids).await;
    assert_eq!(
        kernel_shape, recovery_shape,
        "delete→restore→edit→move must converge; kernel={kernel_shape:?} \
         recovery={recovery_shape:?}"
    );

    // ids sort: W4CX01(X) < W4CY01(Y) < W4PG01(PAGE) < W4PR01(P).
    let expected: Vec<ShapeRow> = vec![
        (
            W_X.to_string(),
            "content".to_string(),
            "w-x-edited".to_string(), // edited AFTER restore
            Some(W_Y.to_string()),    // reparented under Y by the move
        ),
        (
            W_Y.to_string(),
            "content".to_string(),
            "w-y".to_string(),
            Some(W_P.to_string()),
        ),
        (
            W_PAGE.to_string(),
            "page".to_string(),
            "w-page".to_string(),
            None,
        ),
        (
            W_P.to_string(),
            "content".to_string(),
            "w-p".to_string(),
            Some(W_PAGE.to_string()),
        ),
    ];
    assert_eq!(kernel_shape, expected, "got {kernel_shape:?}");

    // #891: prove the kernel arm drove the engine path — the edit + move on the
    // RESTORED block must be visible in the per-space engine.
    let x = engine_read(&state, W_X).expect("X present in engine");
    assert_eq!(x.content, "w-x-edited");
    assert_eq!(x.parent_id.as_deref(), Some(W_Y));
}

// --- 4b: purge in the middle of a lineage (absent from BOTH systems) ---

const PG_PAGE: &str = "01HZ0000000000000000P4PG01";
const PG_P: &str = "01HZ0000000000000000P4PR01";
const PG_X: &str = "01HZ0000000000000000P4CX01";
const PG_GX: &str = "01HZ0000000000000000P4GX01";

/// Build the 4b kernel arm. Corpus: create PAGE > P > X > GX, then soft-delete
/// P (production purges a TRASHED block, #2868) and purge P. The purge
/// hard-deletes the whole P/X/GX subtree; PAGE survives.
async fn run_purge_mid_lineage_arm(dir: &TempDir) -> SqlitePool {
    let pool = init_pool(&dir.path().join("kernel_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    let state = crate::loro::shared::LoroState::new();

    create_via_kernel(&pool, &state, PG_PAGE, "page", None, "pg-page").await;
    stamp_owner(&pool, PG_PAGE, None, PG_PAGE).await;
    seed_block_into_engine(&state, SPACE_ID, PG_PAGE, "page", None, 0);

    create_via_kernel(&pool, &state, PG_P, "content", Some(PG_PAGE), "pg-p").await;
    stamp_owner(&pool, PG_P, Some(PG_PAGE), PG_PAGE).await;
    create_via_kernel(&pool, &state, PG_X, "content", Some(PG_P), "pg-x").await;
    stamp_owner(&pool, PG_X, Some(PG_P), PG_PAGE).await;
    create_via_kernel(&pool, &state, PG_GX, "content", Some(PG_X), "pg-gx").await;
    stamp_owner(&pool, PG_GX, Some(PG_X), PG_PAGE).await;

    // Trash then purge P (mid-lineage): both the kernel cascade and recovery's
    // `purge_block` arm remove the whole subtree.
    delete_via_kernel(&pool, &state, PG_P).await;
    purge_via_kernel(&pool, &state, PG_P).await;

    pool
}

/// #2894 widened corpus: a purge in the middle of a lineage removes the purged
/// subtree from BOTH interpreters (no resurrection). Recovery's `purge_block`
/// arm cascades the same subtree the kernel's `purge_block_sql_cascade` does, so
/// P/X/GX are absent from both rebuilt tables while the surviving PAGE remains.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_mid_lineage_absent_from_both() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let kernel_pool = run_purge_mid_lineage_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    // The purged subtree must be GONE (row absent → `is_deleted` returns None,
    // NOT merely soft-deleted) in BOTH arms. A root-only purge that left
    // descendants behind would surface here (the #615 orphan-resurrection class).
    for id in [PG_P, PG_X, PG_GX] {
        assert_eq!(
            is_deleted(&kernel_pool, id).await,
            None,
            "kernel: purged block {id} must be physically absent"
        );
        assert_eq!(
            is_deleted(&recovery_pool, id).await,
            None,
            "recovery: purged block {id} must be physically absent"
        );
    }

    // The surviving page is present + active in BOTH.
    assert_eq!(is_deleted(&kernel_pool, PG_PAGE).await, Some(false));
    assert_eq!(is_deleted(&recovery_pool, PG_PAGE).await, Some(false));
}

// --- 4c: re-parenting under a restored ANCESTOR (a subtree-root restore) ---

const R_PAGE: &str = "01HZ0000000000000000R4PG01";
const R_A: &str = "01HZ0000000000000000R4AA01";
const R_B: &str = "01HZ0000000000000000R4BB01";
const R_C: &str = "01HZ0000000000000000R4CC01";

/// Build the 4c kernel arm. Corpus:
///   1. create PAGE > A > B, and PAGE > (later) C
///   2. delete A          — cascades {A, B} into one cohort. A is the SUBTREE
///      ROOT (its own parent PAGE stays alive), so restoring A is a connected-
///      cohort restore with NO tombstoned ancestor above it — this converges,
///      UNLIKE the Part 2 orphan case (restore a CHILD under a dead parent).
///   3. restore A         — both interpreters re-activate {A, B}.
///   4. create C under PAGE
///   5. move C under the restored ancestor A.
async fn run_reparent_under_restored_ancestor_arm(
    dir: &TempDir,
) -> (SqlitePool, crate::loro::shared::LoroState) {
    let pool = init_pool(&dir.path().join("kernel_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    let state = crate::loro::shared::LoroState::new();

    create_via_kernel(&pool, &state, R_PAGE, "page", None, "r-page").await;
    stamp_owner(&pool, R_PAGE, None, R_PAGE).await;
    seed_block_into_engine(&state, SPACE_ID, R_PAGE, "page", None, 0);

    create_via_kernel(&pool, &state, R_A, "content", Some(R_PAGE), "r-a").await;
    stamp_owner(&pool, R_A, Some(R_PAGE), R_PAGE).await;
    create_via_kernel(&pool, &state, R_B, "content", Some(R_A), "r-b").await;
    stamp_owner(&pool, R_B, Some(R_A), R_PAGE).await;

    // Delete the subtree root A (cascades A + B into one cohort), then restore.
    let ts_a = delete_via_kernel(&pool, &state, R_A).await;
    restore_via_kernel(&pool, &state, R_A, ts_a).await;

    // New sibling C, then reparent it UNDER the restored ancestor A.
    create_via_kernel(&pool, &state, R_C, "content", Some(R_PAGE), "r-c").await;
    stamp_owner(&pool, R_C, Some(R_PAGE), R_PAGE).await;
    move_via_kernel(&pool, &state, R_C, Some(R_A), 1).await;

    (pool, state)
}

/// #2894 widened corpus: restoring a subtree ROOT (whose ancestor never died)
/// converges between recovery and the kernel — {A, B} come back active in both
/// — and a subsequent reparent of a fresh block C UNDER the restored ancestor A
/// lands identically. This is the CONVERGENT restore counterpart to the Part 2
/// orphan-restore divergence pin: here there is no tombstoned ancestor, so the
/// #2043 flat-cohort recovery and the kernel's connected-cohort restore agree.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reparent_under_restored_ancestor_converges() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let (kernel_pool, state) = run_reparent_under_restored_ancestor_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    let ids = [R_PAGE, R_A, R_B, R_C];
    let kernel_shape = active_shape(&kernel_pool, ids).await;
    let recovery_shape = active_shape(&recovery_pool, ids).await;
    assert_eq!(
        kernel_shape, recovery_shape,
        "reparent-under-restored-ancestor must converge; kernel={kernel_shape:?} \
         recovery={recovery_shape:?}"
    );

    // ids sort: R4AA01(A) < R4BB01(B) < R4CC01(C) < R4PG01(PAGE).
    let expected: Vec<ShapeRow> = vec![
        (
            R_A.to_string(),
            "content".to_string(),
            "r-a".to_string(),
            Some(R_PAGE.to_string()),
        ),
        (
            R_B.to_string(),
            "content".to_string(),
            "r-b".to_string(),
            Some(R_A.to_string()), // restored under A
        ),
        (
            R_C.to_string(),
            "content".to_string(),
            "r-c".to_string(),
            Some(R_A.to_string()), // reparented under the RESTORED ancestor A
        ),
        (
            R_PAGE.to_string(),
            "page".to_string(),
            "r-page".to_string(),
            None,
        ),
    ];
    assert_eq!(kernel_shape, expected, "got {kernel_shape:?}");

    // #891: the reparent under the restored ancestor took the engine path.
    let c = engine_read(&state, R_C).expect("C present in engine");
    assert_eq!(c.parent_id.as_deref(), Some(R_A));
    // The restored descendant B is active in the engine too.
    let b = engine_read(&state, R_B).expect("B present in engine");
    assert_eq!(b.parent_id.as_deref(), Some(R_A));
}

// --- 4d: an interleaved SATELLITE op (set_property) is INERT to block parity ---

const SP_PAGE: &str = "01HZ0000000000000000S4PG01";
const SP_P: &str = "01HZ0000000000000000S4PR01";
const SP_X: &str = "01HZ0000000000000000S4CX01";
const SP_Y: &str = "01HZ0000000000000000S4CY01";

/// Build the 4d kernel arm: create PAGE > P > {X, Y}, set a PROPERTY on X in the
/// middle of the block ops, then edit X. The `set_property` op is interleaved to
/// prove it does not perturb block-table parity.
async fn run_property_interleave_arm(dir: &TempDir) -> SqlitePool {
    let pool = init_pool(&dir.path().join("kernel_arm.db"))
        .await
        .expect("init_pool");
    seed_space(&pool).await;
    let state = crate::loro::shared::LoroState::new();

    create_via_kernel(&pool, &state, SP_PAGE, "page", None, "sp-page").await;
    stamp_owner(&pool, SP_PAGE, None, SP_PAGE).await;
    seed_block_into_engine(&state, SPACE_ID, SP_PAGE, "page", None, 0);

    create_via_kernel(&pool, &state, SP_P, "content", Some(SP_PAGE), "sp-p").await;
    stamp_owner(&pool, SP_P, Some(SP_PAGE), SP_PAGE).await;
    create_via_kernel(&pool, &state, SP_X, "content", Some(SP_P), "sp-x").await;
    stamp_owner(&pool, SP_X, Some(SP_P), SP_PAGE).await;
    create_via_kernel(&pool, &state, SP_Y, "content", Some(SP_P), "sp-y").await;
    stamp_owner(&pool, SP_Y, Some(SP_P), SP_PAGE).await;

    // The satellite op, interleaved between block ops.
    set_property_via_kernel(&pool, &state, SP_X, "status", "done").await;
    edit_via_kernel(&pool, &state, SP_X, "sp-x-edited").await;

    pool
}

/// #2894 widened corpus (satellite-op boundary). `recover_blocks_from_op_log`
/// rebuilds ONLY the `blocks` table: its `match op_type` falls through
/// `set_property` / `delete_property` / `add_tag` via the `_ => {}` arm ("handled
/// post-migration so they survive migration 73's DROP TABLE"). So a property op
/// is INERT to this net — it neither appears in nor perturbs the block-table
/// parity. This test pins that boundary: block structural parity holds across an
/// interleaved `set_property`, and we DO NOT assert the property/tag satellites
/// (those are the separate interpreter `recover_derived_state_from_op_log`'s
/// domain, out of this net's scope).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interleaved_property_op_is_inert_to_block_parity() {
    let kernel_dir = TempDir::new().expect("tempdir");
    let recovery_dir = TempDir::new().expect("tempdir");

    let kernel_pool = run_property_interleave_arm(&kernel_dir).await;
    let recovery_pool = run_recovery_arm(&kernel_pool, &recovery_dir).await;

    let ids = [SP_PAGE, SP_P, SP_X, SP_Y];
    let kernel_shape = active_shape(&kernel_pool, ids).await;
    let recovery_shape = active_shape(&recovery_pool, ids).await;
    assert_eq!(
        kernel_shape, recovery_shape,
        "an interleaved set_property must not perturb block-table parity; \
         kernel={kernel_shape:?} recovery={recovery_shape:?}"
    );

    // ids sort: S4CX01(X) < S4CY01(Y) < S4PG01(PAGE) < S4PR01(P).
    let expected: Vec<ShapeRow> = vec![
        (
            SP_X.to_string(),
            "content".to_string(),
            "sp-x-edited".to_string(),
            Some(SP_P.to_string()),
        ),
        (
            SP_Y.to_string(),
            "content".to_string(),
            "sp-y".to_string(),
            Some(SP_P.to_string()),
        ),
        (
            SP_PAGE.to_string(),
            "page".to_string(),
            "sp-page".to_string(),
            None,
        ),
        (
            SP_P.to_string(),
            "content".to_string(),
            "sp-p".to_string(),
            Some(SP_PAGE.to_string()),
        ),
    ];
    assert_eq!(kernel_shape, expected, "got {kernel_shape:?}");

    // The satellite op left NO trace in the recovery blocks table: the property
    // key is not a block id (recovery only ever inserts block ids), and X's row
    // is a plain content block. (We assert absence of a stray row, not the
    // property itself — properties live outside this interpreter's output.)
    assert_eq!(
        is_deleted(&recovery_pool, "status").await,
        None,
        "the property key must never materialize as a block row in recovery"
    );
}
