//! Tests for the reconciliation oracle (#3345, extended by #3654).
//!
//! Three things are proved here:
//!
//! 1. **The oracle observes something.** Every test asserts
//!    [`oracle_coverage`] is non-empty for the artefact it claims to cover, so
//!    a green run can never be a green vacuum. The directed tests additionally
//!    build the exact state each artefact exists for: the many-to-one dedup
//!    state (N `attachments` rows → 1 blob file), a page tree in which the
//!    ownership walk actually has to climb, and a `pages_cache` whose key set
//!    is genuinely non-empty.
//! 2. **Both arms of each symmetric pair are covered.** For the blob store
//!    that is `persist_attachment`'s INSERT and `cleanup_orphaned_attachments`'
//!    prune; the generated sequence drives both, in both orders. For row
//!    membership it is the missing row and the extra row; for ownership, a
//!    drifted owner and a lost one.
//! 3. **Each artefact FIRES.** Every artefact here is shown reporting a
//!    divergence with a report that names the row, both values and the owning
//!    arm — an oracle never seen to fail is not yet an oracle.
//!
//! The `pages_cache` COUNT wiring lives with the op-sequence generator it
//! belongs to — `materializer::handlers::apply_reproject_proptest::b6_*`;
//! that harness also carries the non-vacuity assertions for row membership and
//! ownership over generated chains.

use super::*;

use crate::commands::attachments::{add_attachment_with_bytes_inner, delete_attachment_inner};
use crate::materializer::Materializer;
use agaric_core::ulid::{AttachmentId, BlockId};
use proptest::prelude::*;
use tempfile::TempDir;
use tokio::runtime::Runtime;

const DEV: &str = "reconciliation-oracle-device";

/// Distinct byte payloads the generator draws from. A *small* pool is the
/// point: drawing the same index twice makes the second add DEDUP onto the
/// first add's canonical blob file, which is the many-to-one state
/// (`attachment_blobs` refcount > 1) the artefact exists to manage. A large
/// pool would make every add a fresh blob and the oracle would never see a
/// shared file.
const BYTE_POOL: &[&[u8]] = &[b"alpha-bytes", b"beta-bytes", b"gamma-bytes"];

/// Blocks attachments are attached to. Two are enough to exercise "the same
/// bytes attached to two different blocks", the shape #3259 was about.
const BLOCK_COUNT: usize = 2;

/// A fresh pool plus the TempDir that owns its app-data directory.
async fn test_env() -> (sqlx::SqlitePool, TempDir, Materializer, Vec<BlockId>) {
    let dir = TempDir::new().expect("tempdir");
    let pool = crate::db::init_pool(&dir.path().join("oracle.db"))
        .await
        .expect("init_pool");
    let mat = Materializer::new(pool.clone());
    mat.set_app_data_dir(dir.path().to_path_buf());

    let mut blocks = Vec::new();
    for i in 0..BLOCK_COUNT {
        let id = BlockId::new();
        let position = i64::try_from(i).unwrap_or(0) + 1;
        // dynamic-sql: test-only fixture seed (not a production query path).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'holder', NULL, ?)",
        )
        .bind(id.as_str())
        .bind(position)
        .execute(&pool)
        .await
        .expect("seed holder block");
        blocks.push(id);
    }
    (pool, dir, mat, blocks)
}

/// Run production's DEFERRED byte/blob reclamation pass — the background
/// `MaterializeTask::CleanupOrphanedAttachments` handler.
///
/// `delete_attachment_inner` and every purge path deliberately leave both the
/// bytes and the `attachment_blobs` row behind (#1993/#3259): unlinking under
/// a shared blob is only race-free inside the GC, where the reference test and
/// the unlink are colocated. So the settled state is the post-GC state, and a
/// driver asserts reconciliation after this call, not before it.
///
/// This is production code. Breaking its prune turns the oracle red — that is
/// what keeps the DECREMENT arm of the blob store covered rather than assumed.
async fn settle_attachment_gc(pool: &sqlx::SqlitePool, app_data_dir: &std::path::Path) {
    crate::materializer::cleanup_orphaned_attachments(pool, None, app_data_dir)
        .await
        .expect("cleanup_orphaned_attachments never propagates errors");
}

/// Tombstone an `attachments` row.
///
/// Written directly because production has NO writer for
/// `attachments.deleted_at` (`delete_attachment_inner` and the
/// `DeleteAttachment` op handler both hard-delete). That is precisely why the
/// semantics of the column had to be settled deliberately (#3654) instead of
/// being discovered by whoever adds the first writer. `deleted_at` is still
/// TEXT here — out of #109 Phase 2's scope, per migration 0081.
async fn soft_delete_attachment(pool: &sqlx::SqlitePool, id: &str) {
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("UPDATE attachments SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .expect("soft-delete attachment row");
}

// ---------------------------------------------------------------------------
// Directed coverage: the many-to-one dedup state the artefact exists for
// ---------------------------------------------------------------------------

/// Two blocks, one set of bytes: the second add must dedup onto the first
/// add's canonical file, so ONE `attachment_blobs` row is referenced by TWO
/// live `attachments` rows. Then drop them one at a time and settle.
///
/// This pins the whole lifecycle of the artefact — refcount 2 → 1 → 0 — and
/// asserts reconciliation at each step, so both the INSERT arm
/// (`persist_attachment`) and the prune arm (`cleanup_orphaned_attachments`)
/// are exercised, and the intermediate refcount-1 state (where an over-eager
/// prune would destroy bytes a survivor still references) is a state the
/// oracle actually visits rather than one it merely could.
#[tokio::test]
async fn blob_refcount_reconciles_across_shared_blob_lifecycle() {
    let (pool, dir, mat, blocks) = test_env().await;
    let app_data_dir = dir.path();

    let first = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        blocks[0].clone(),
        "shared.png".into(),
        "image/png".into(),
        BYTE_POOL[0].to_vec(),
    )
    .await
    .expect("first add");
    let second = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        blocks[1].clone(),
        "shared.png".into(),
        "image/png".into(),
        BYTE_POOL[0].to_vec(),
    )
    .await
    .expect("second add");

    // Precondition, not decoration: without dedup there is no many-to-one
    // state and every assertion below is about a degenerate 1:1 store.
    assert_eq!(
        second.fs_path, first.fs_path,
        "#1993 dedup precondition: the second add of identical bytes must point \
         at the FIRST add's canonical blob file, otherwise this test proves nothing"
    );

    let coverage = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        coverage.attachment_blob_rows, 1,
        "two live rows must share exactly ONE blob row, got {coverage:?}"
    );
    assert_eq!(
        coverage.hashed_attachment_rows, 2,
        "both rows must carry a content_hash, got {coverage:?}"
    );

    assert_reconciled(&pool, "after two adds sharing one blob").await;

    // Refcount 2 -> 1. The blob and its bytes must survive; a prune here is
    // the #3259 data-loss shape.
    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, first.id.clone())
        .await
        .expect("delete first");
    settle_attachment_gc(&pool, app_data_dir).await;
    assert_reconciled(&pool, "after dropping one of two referrers, GC settled").await;
    let after_one = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        after_one.attachment_blob_rows, 1,
        "the surviving referrer must keep its blob row alive, got {after_one:?}"
    );
    assert!(
        app_data_dir.join(&second.fs_path).exists(),
        "the surviving row's bytes must still be on disk"
    );

    // Refcount 1 -> 0. Now the blob row MUST be pruned; leaving it is a leak
    // and a stale dedup target pointing at bytes the GC is about to unlink.
    delete_attachment_inner(&pool, DEV, &mat, app_data_dir, second.id.clone())
        .await
        .expect("delete second");
    settle_attachment_gc(&pool, app_data_dir).await;
    assert_reconciled(&pool, "after dropping the last referrer, GC settled").await;
    let after_all = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        after_all.attachment_blob_rows, 0,
        "the last referrer is gone, so the blob row must be pruned, got {after_all:?}"
    );
}

/// The oracle must actually FAIL on a broken blob store, not merely pass on a
/// healthy one. Injecting the divergence directly (rather than by editing a
/// production arm) pins the detector itself: if `reconcile` stopped reading
/// `attachment_blobs`, this test goes green-and-silent and would be caught.
///
/// Both divergence directions are asserted — an orphan blob (a decrement that
/// never happened) and a missing blob (an increment that never happened) — so
/// neither half of the pair can rot into a no-op.
#[tokio::test]
async fn oracle_reports_both_blob_divergence_directions() {
    let (pool, dir, mat, blocks) = test_env().await;
    let app_data_dir = dir.path();

    let row = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        blocks[0].clone(),
        "solo.png".into(),
        "image/png".into(),
        BYTE_POOL[1].to_vec(),
    )
    .await
    .expect("add");
    assert_reconciled(&pool, "healthy single attachment").await;

    // Direction 1 — MISSING blob: a live row carries a hash with no blob row.
    // This is what a `persist_attachment` that forgot its INSERT produces.
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("DELETE FROM attachment_blobs")
        .execute(&pool)
        .await
        .expect("drop blob row");
    let missing = reconciliation_failure(&pool, "missing-blob injection")
        .await
        .expect("oracle must report a missing blob row");
    assert!(
        missing.contains("attachment_blobs.refcount") && missing.contains("no blob row"),
        "expected a missing-blob divergence, got:\n{missing}"
    );

    // Direction 2 — ORPHAN blob: a blob row no live row references. This is
    // what a delete/purge arm that dropped the last referrer without the GC
    // ever running produces.
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query(
        "INSERT INTO attachment_blobs (content_hash, on_disk_path, size_bytes, created_at) \
         VALUES ('deadbeef', 'attachments/ORPHANED', 1, 1)",
    )
    .execute(&pool)
    .await
    .expect("inject orphan blob");
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("DELETE FROM attachments WHERE id = ?")
        .bind(row.id.as_str())
        .execute(&pool)
        .await
        .expect("drop the only referrer");
    let orphan = reconciliation_failure(&pool, "orphan-blob injection")
        .await
        .expect("oracle must report an orphan blob row");
    assert!(
        orphan.contains("attachment_blobs.refcount") && orphan.contains("refcount 0"),
        "expected an orphan-blob divergence, got:\n{orphan}"
    );
}

/// A soft-deleted `attachments` row is still a reference (#3654 part 3).
///
/// `attachments.deleted_at` has no production writer, so the tombstone arm of
/// [`rebuild_attachment_blobs_from_base`] is unreachable through the command
/// path and the row is written directly here. That is the point of the test:
/// the two production writers of `attachment_blobs` used to disagree about
/// this row, and the disagreement could only ever be discovered by whoever
/// shipped the first writer of the column.
///
/// The settled semantic — the GC's, which the backfill was moved to match — is
/// asserted end to end against BOTH production writers:
///
/// * `cleanup_orphaned_attachments` must keep a tombstone's bytes and its blob
///   row, even when NO live row is left;
/// * `backfill_attachment_blobs` must be able to rebuild that blob row from a
///   tombstone alone. Before #3654 it scoped its candidates with
///   `WHERE deleted_at IS NULL` and this half is red.
#[tokio::test]
async fn soft_deleted_attachment_row_still_holds_its_blob_and_bytes() {
    let (pool, dir, mat, blocks) = test_env().await;
    let app_data_dir = dir.path();

    let first = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        blocks[0].clone(),
        "tomb.png".into(),
        "image/png".into(),
        BYTE_POOL[2].to_vec(),
    )
    .await
    .expect("first add");
    let second = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        blocks[1].clone(),
        "tomb.png".into(),
        "image/png".into(),
        BYTE_POOL[2].to_vec(),
    )
    .await
    .expect("second add");
    assert_eq!(
        second.fs_path, first.fs_path,
        "#1993 dedup precondition: both rows must share one canonical blob file"
    );
    let canonical = app_data_dir.join(&first.fs_path);

    // Tombstone BOTH rows: the state in which "is a tombstone a reference?"
    // is the only thing keeping the bytes alive. One tombstone plus one live
    // row would be kept alive by the live row regardless and would prove
    // nothing about the tombstone.
    soft_delete_attachment(&pool, first.id.as_str()).await;
    soft_delete_attachment(&pool, second.id.as_str()).await;
    let coverage = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        coverage.soft_deleted_attachment_rows, 2,
        "both rows must be tombstoned or the tombstone arm never runs, got {coverage:?}"
    );
    assert_eq!(
        coverage.hashed_attachment_rows, 2,
        "tombstones still carry their content_hash, got {coverage:?}"
    );

    settle_attachment_gc(&pool, app_data_dir).await;
    assert_reconciled(&pool, "GC settled with only tombstone referrers").await;
    assert!(
        canonical.exists(),
        "the GC must NOT unlink bytes a tombstone still names — a restore \
         (history.rs' add_attachment reversal) re-inserts the row with this exact \
         fs_path and nothing re-fetches the bytes"
    );
    let after_gc = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        after_gc.attachment_blob_rows, 1,
        "the blob row must survive alongside the bytes it maps, got {after_gc:?}"
    );

    // The other production writer must agree. Wipe the blob store and let the
    // boot-time backfill rebuild it from tombstones alone.
    // dynamic-sql: test-only fixture reset (not a production query path).
    sqlx::query("DELETE FROM attachment_blobs")
        .execute(&pool)
        .await
        .expect("wipe blob store");
    let report = crate::recovery::backfill_attachment_blobs(&pool, app_data_dir)
        .await
        .expect("backfill");
    assert_eq!(
        report.blobs_created, 1,
        "backfill_attachment_blobs must index a hash whose only referrers are \
         tombstones — otherwise the GC keeps bytes the blob store cannot name, \
         got {report:?}"
    );
    assert_reconciled(
        &pool,
        "after backfill rebuilt the blob store from tombstones",
    )
    .await;

    // Hard-delete both rows and the obligation genuinely ends: no referrer of
    // any kind, so the blob row and the bytes must both go.
    // dynamic-sql: test-only fixture teardown (not a production query path).
    sqlx::query("DELETE FROM attachments")
        .execute(&pool)
        .await
        .expect("hard-delete both rows");
    settle_attachment_gc(&pool, app_data_dir).await;
    assert_reconciled(&pool, "GC settled after hard-deleting every referrer").await;
    assert!(
        !canonical.exists(),
        "with no attachments row of any kind left, the bytes must be reclaimed"
    );
}

/// The oracle must FIRE on the tombstone arm, not merely pass on it.
///
/// Drops the blob row while a tombstone still carries the hash — the exact
/// state the pre-#3654 backfill produced on any vault with a soft-deleted row.
/// The report must name the tombstone as the referrer, so a reader is not left
/// wondering why a "deleted" attachment imposes an obligation.
#[tokio::test]
async fn oracle_reports_a_blob_row_missing_for_a_tombstoned_referrer() {
    let (pool, dir, mat, blocks) = test_env().await;
    let app_data_dir = dir.path();

    let row = add_attachment_with_bytes_inner(
        &pool,
        DEV,
        &mat,
        app_data_dir,
        blocks[0].clone(),
        "tomb-solo.png".into(),
        "image/png".into(),
        BYTE_POOL[1].to_vec(),
    )
    .await
    .expect("add");
    soft_delete_attachment(&pool, row.id.as_str()).await;
    assert_reconciled(&pool, "tombstoned row with its blob row intact").await;

    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("DELETE FROM attachment_blobs")
        .execute(&pool)
        .await
        .expect("drop blob row");
    let report = reconciliation_failure(&pool, "tombstone-only missing-blob injection")
        .await
        .expect("oracle must report the missing blob row");
    assert!(
        report.contains("attachment_blobs.refcount") && report.contains("no blob row"),
        "expected a missing-blob divergence, got:\n{report}"
    );
    assert!(
        report.contains("soft-deleted") && report.contains(row.id.as_str()),
        "the report must name the tombstoned referrer, got:\n{report}"
    );
}

// ---------------------------------------------------------------------------
// Generated action sequences over the production attachment path
// ---------------------------------------------------------------------------

/// One step of a generated attachment-lifecycle sequence. Indices are raw
/// `usize` reduced modulo the live set at drive time — the same trick
/// `proptest_db_harness::OpKind` uses, so the generator never needs to know
/// the set size up front.
#[derive(Debug, Clone)]
enum BlobAction {
    /// Attach `BYTE_POOL[bytes_index]` to `blocks[block_index]` through the
    /// production ingest command (hash + dedup + blob INSERT).
    Add {
        block_index: usize,
        bytes_index: usize,
    },
    /// Drop a still-present attachment row through the production delete
    /// command (which deliberately touches neither disk nor `attachment_blobs`).
    Delete { attachment_index: usize },
    /// Run production's deferred reclamation pass.
    Gc,
}

fn blob_action_strategy() -> impl Strategy<Value = BlobAction> {
    prop_oneof![
        // Add-heavy so the live set warms up and dedup collisions happen.
        3 => (any::<usize>(), any::<usize>()).prop_map(|(block_index, bytes_index)| {
            BlobAction::Add { block_index, bytes_index }
        }),
        2 => any::<usize>().prop_map(|attachment_index| BlobAction::Delete { attachment_index }),
        2 => Just(BlobAction::Gc),
    ]
}

/// Drive one generated sequence, asserting reconciliation after every step.
///
/// Asserting per-step (rather than once at the end) is what makes the report
/// name the arm: the `context` carries the step index and the action that just
/// ran, so the first divergence identifies the operation that caused it.
///
/// Every step runs the GC before asserting, because production defers byte and
/// blob reclamation to it. A `Gc` action is therefore not "the only place the
/// GC runs" — it is an explicitly generated *extra* pass, which is what
/// exercises the GC's own idempotence (a second pass over an already-clean
/// tree takes the empty-directory early return).
async fn drive_blob_sequence(actions: &[BlobAction]) -> Result<OracleCoverage, String> {
    let (pool, dir, mat, blocks) = test_env().await;
    let app_data_dir = dir.path();
    let mut live: Vec<AttachmentId> = Vec::new();
    // PEAK coverage, not final coverage: a sequence that ends in
    // Add/Delete/Gc legitimately leaves the store empty, so the question the
    // caller must be able to answer is "did the audited artefact ever hold a
    // row at all", not "does it hold one now".
    let mut peak = OracleCoverage {
        pages_cache_rows: 0,
        live_page_blocks: 0,
        blocks_owned_by_another_page: 0,
        hashed_attachment_rows: 0,
        soft_deleted_attachment_rows: 0,
        attachment_blob_rows: 0,
        page_link_cache_rows: 0,
        page_link_edges: 0,
    };

    for (step, action) in actions.iter().enumerate() {
        let label = match action {
            BlobAction::Add {
                block_index,
                bytes_index,
            } => {
                let block = &blocks[block_index % blocks.len()];
                let bytes = BYTE_POOL[bytes_index % BYTE_POOL.len()];
                let row = add_attachment_with_bytes_inner(
                    &pool,
                    DEV,
                    &mat,
                    app_data_dir,
                    block.clone(),
                    "gen.png".into(),
                    "image/png".into(),
                    bytes.to_vec(),
                )
                .await
                .map_err(|e| format!("step {step}: add_attachment failed: {e}"))?;
                live.push(row.id);
                format!("step {step}: Add(bytes#{})", bytes_index % BYTE_POOL.len())
            }
            BlobAction::Delete { attachment_index } => {
                if live.is_empty() {
                    continue;
                }
                let idx = attachment_index % live.len();
                let id = live.remove(idx);
                delete_attachment_inner(&pool, DEV, &mat, app_data_dir, id)
                    .await
                    .map_err(|e| format!("step {step}: delete_attachment failed: {e}"))?;
                format!("step {step}: Delete")
            }
            BlobAction::Gc => format!("step {step}: Gc"),
        };

        // Settle production's deferred reclamation, then diff.
        settle_attachment_gc(&pool, app_data_dir).await;
        if let Some(report) = reconciliation_failure(&pool, &label).await {
            return Err(report);
        }
        let now = oracle_coverage(&pool)
            .await
            .map_err(|e| format!("step {step}: oracle_coverage failed: {e}"))?;
        peak.pages_cache_rows = peak.pages_cache_rows.max(now.pages_cache_rows);
        peak.live_page_blocks = peak.live_page_blocks.max(now.live_page_blocks);
        peak.blocks_owned_by_another_page = peak
            .blocks_owned_by_another_page
            .max(now.blocks_owned_by_another_page);
        peak.hashed_attachment_rows = peak.hashed_attachment_rows.max(now.hashed_attachment_rows);
        peak.soft_deleted_attachment_rows = peak
            .soft_deleted_attachment_rows
            .max(now.soft_deleted_attachment_rows);
        peak.attachment_blob_rows = peak.attachment_blob_rows.max(now.attachment_blob_rows);
    }
    Ok(peak)
}

/// Low case count keeps the suite fast (each case builds a pool, writes real
/// files and runs a real directory-walking GC per step). Bump locally with
/// `PROPTEST_CASES` for a deeper search.
const BLOB_CASES: u32 = 12;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(BLOB_CASES))]

    /// A generated sequence of production attachment operations must leave the
    /// blob store reconciled with a from-base rebuild after every step.
    ///
    /// The sequence covers BOTH arms of the store's only symmetric pair:
    /// `persist_attachment`'s blob INSERT and `cleanup_orphaned_attachments`'
    /// prune. Interleaving them under a 3-payload pool means the same bytes are
    /// repeatedly re-added, deduped, and dropped. The refcount-2 state itself is
    /// pinned deterministically by
    /// [`blob_refcount_reconciles_across_shared_blob_lifecycle`] rather than
    /// left to the generator, which can only make it *likely*.
    ///
    /// The closing assertion is on the PEAK
    /// [`OracleCoverage`] the sequence reached, not on the number of actions
    /// the driver performed: "the driver did the add I prepended" restates a
    /// precondition this test itself established and would stay true if
    /// `persist_attachment` stopped writing a hash or a blob row entirely,
    /// leaving the oracle diffing an empty map against an empty map.
    #[test]
    fn blob_refcount_reconciles_after_every_generated_action(
        seed_block in any::<usize>(),
        seed_bytes in any::<usize>(),
        rest in proptest::collection::vec(blob_action_strategy(), 0..=9),
    ) {
        // The sequence ALWAYS starts with an add: a generated chain with no
        // add would leave the blob store empty and every assertion in it
        // vacuous. Prepending (rather than filtering after the fact) makes
        // non-vacuity structural instead of probabilistic.
        let mut actions = vec![BlobAction::Add {
            block_index: seed_block,
            bytes_index: seed_bytes,
        }];
        actions.extend(rest);

        let rt = Runtime::new().expect("tokio runtime");
        match rt.block_on(drive_blob_sequence(&actions)) {
            Ok(peak) => {
                prop_assert!(
                    peak.hashed_attachment_rows > 0,
                    "no step ever left a live attachments row carrying a content_hash, \
                     so the blob rebuild folded an empty input: {peak:?}"
                );
                prop_assert!(
                    peak.attachment_blob_rows > 0,
                    "attachment_blobs was empty at every step, so the oracle diffed \
                     an empty map against an empty map: {peak:?}"
                );
            }
            Err(report) => prop_assert!(false, "{}", report),
        }
    }
}

// ---------------------------------------------------------------------------
// `pages_cache` row membership and page ownership (#3654)
// ---------------------------------------------------------------------------

/// A page tree shaped so that every branch of the ownership walk is exercised
/// by SOME block: self-ownership, a one-step climb, a two-step climb, a nested
/// page boundary the walk must stop at, and a block with no page ancestor at
/// all.
///
/// ```text
/// PAGE_A  (page, "Alpha")            owns itself
///  └─ A_CHILD    (content)           climbs 1 → PAGE_A
///      ├─ A_GRAND (content)          climbs 2 → PAGE_A
///      └─ NESTED_PAGE (page, "Nest") owns itself — the walk STOPS here
///          └─ N_CHILD (content)      climbs 1 → NESTED_PAGE, not PAGE_A
/// PAGE_B  (page, "Beta")             owns itself
/// ORPHAN  (content, no parent)       no page ancestor → NULL
/// ```
const PAGE_A: &str = "PAGE_A";
const PAGE_B: &str = "PAGE_B";
const NESTED_PAGE: &str = "NESTED_PAGE";
const A_CHILD: &str = "A_CHILD";
const A_GRAND: &str = "A_GRAND";
const N_CHILD: &str = "N_CHILD";
const ORPHAN: &str = "ORPHAN";

/// Blocks whose structurally-derived owner is some OTHER block: `A_CHILD`,
/// `A_GRAND` (both → `PAGE_A`) and `N_CHILD` (→ `NESTED_PAGE`). Pinning the
/// exact number is what makes the nested-page boundary and the orphan part of
/// the assertion rather than incidental fixture decoration.
const OWNED_BY_ANOTHER_PAGE: i64 = 3;

async fn insert_page_block(pool: &sqlx::SqlitePool, id: &str, title: &str, parent: Option<&str>) {
    // `page_id = id` is not a choice: the `page_id_self_for_pages` CHECK
    // (migration 0085) rejects any other value for a page block.
    // dynamic-sql: test-only fixture seed (not a production query path).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, ?, 1, ?)",
    )
    .bind(id)
    .bind(title)
    .bind(parent)
    .bind(id)
    .execute(pool)
    .await
    .expect("seed page block");
}

async fn insert_content_block(
    pool: &sqlx::SqlitePool,
    id: &str,
    parent: Option<&str>,
    page_id: Option<&str>,
) {
    // dynamic-sql: test-only fixture seed (not a production query path).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'content', 'body', ?, 1, ?)",
    )
    .bind(id)
    .bind(parent)
    .bind(page_id)
    .execute(pool)
    .await
    .expect("seed content block");
}

/// Seed the fixture above into a fresh pool. `blocks` only — `pages_cache` is
/// left EMPTY on purpose so the first thing the membership artefact sees is a
/// vault whose `RebuildPagesCache` has never run.
async fn page_fixture() -> (sqlx::SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let pool = crate::db::init_pool(&dir.path().join("pages.db"))
        .await
        .expect("init_pool");

    insert_page_block(&pool, PAGE_A, "Alpha", None).await;
    insert_page_block(&pool, PAGE_B, "Beta", None).await;
    insert_content_block(&pool, A_CHILD, Some(PAGE_A), Some(PAGE_A)).await;
    insert_content_block(&pool, A_GRAND, Some(A_CHILD), Some(PAGE_A)).await;
    insert_page_block(&pool, NESTED_PAGE, "Nest", Some(A_CHILD)).await;
    insert_content_block(&pool, N_CHILD, Some(NESTED_PAGE), Some(NESTED_PAGE)).await;
    insert_content_block(&pool, ORPHAN, None, None).await;

    (pool, dir)
}

/// Run both deferred `pages_cache` passes, in production's order: the row
/// rebuild first (it inserts the rows), the count recompute second (it only
/// touches rows that already exist). `materializer::dispatch` orders its task
/// list the same way, and says so.
async fn settle_pages_cache(pool: &sqlx::SqlitePool) {
    settle_pages_cache_rows(pool).await.expect("row rebuild");
    settle_deferred_pages_cache_counts(pool)
        .await
        .expect("count rebuild");
}

/// **Row membership.** The key set of `pages_cache` must equal the set of live
/// page blocks carrying a title — both directions.
///
/// Every state below is a real one production reaches, not an injected
/// corruption: a vault whose `RebuildPagesCache` has not run yet, a page
/// soft-deleted before its rebuild lands, and a page whose title was cleared.
/// Each is asserted to make the oracle FIRE before the settle repairs it, so
/// the artefact is observed working in both directions rather than merely
/// observed green.
#[tokio::test]
async fn pages_cache_row_membership_reconciles_in_both_directions() {
    let (pool, _dir) = page_fixture().await;

    // NON-VACUITY: the rebuild must fold a non-empty set, or the key-set diff
    // is `{} == {}` and passes whatever broke.
    let coverage = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        coverage.live_page_blocks, 3,
        "the fixture must contain PAGE_A, PAGE_B and NESTED_PAGE, got {coverage:?}"
    );
    assert_eq!(
        coverage.pages_cache_rows, 0,
        "pages_cache must start empty so the MISSING-row direction is reachable, got {coverage:?}"
    );
    // The set itself, not just its size: a rebuild that admitted content
    // blocks (or the orphan) would still report "3" against a fixture with
    // three of anything.
    let expected_rows = rebuild_pages_cache_rows_from_base(&pool)
        .await
        .expect("row rebuild");
    assert_eq!(
        expected_rows,
        [PAGE_A, PAGE_B, NESTED_PAGE]
            .into_iter()
            .map(str::to_owned)
            .collect::<std::collections::BTreeSet<_>>(),
        "the membership rebuild must fold exactly the live titled page blocks"
    );

    // Direction 1 — MISSING row: three live titled pages, no cache rows.
    let missing = reconciliation_failure(&pool, "pages_cache never rebuilt")
        .await
        .expect("oracle must report the missing cache rows");
    assert!(
        missing.contains("pages_cache.row") && missing.contains("no row in pages_cache"),
        "expected a missing-row divergence, got:\n{missing}"
    );
    assert!(
        missing.contains("in 3 place(s)"),
        "all three live pages must be reported, got:\n{missing}"
    );

    settle_pages_cache(&pool).await;
    assert_reconciled(&pool, "after the production row rebuild").await;
    let settled = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        settled.pages_cache_rows, 3,
        "the row rebuild must insert one row per live titled page, got {settled:?}"
    );

    // Direction 2 — EXTRA row: a soft-deleted page keeps its cache row until
    // the orphan sweep runs. Its counts stay reconciled (it has no children),
    // so the row itself is the only thing the oracle can be reporting.
    soft_delete_block(&pool, PAGE_B).await;
    let extra = reconciliation_failure(&pool, "page soft-deleted before the sweep")
        .await
        .expect("oracle must report the stale cache row");
    assert!(
        extra.contains("pages_cache.row") && extra.contains(PAGE_B),
        "expected an extra-row divergence naming the soft-deleted page, got:\n{extra}"
    );
    assert!(
        extra.contains("a row in pages_cache"),
        "expected the EXTRA-row direction, got:\n{extra}"
    );
    settle_pages_cache(&pool).await;
    assert_reconciled(&pool, "after the orphan sweep dropped the deleted page").await;

    // Direction 2 again, via the other exit from the set: a page whose title
    // was cleared is no longer a cache row's subject even though it is live.
    // dynamic-sql: test-only state transition (not a production query path).
    sqlx::query("UPDATE blocks SET content = NULL WHERE id = ?")
        .bind(NESTED_PAGE)
        .execute(&pool)
        .await
        .expect("clear the nested page's title");
    let cleared = reconciliation_failure(&pool, "page title cleared before the sweep")
        .await
        .expect("oracle must report the title-cleared page's stale row");
    assert!(
        cleared.contains("pages_cache.row") && cleared.contains(NESTED_PAGE),
        "expected an extra-row divergence naming the title-cleared page, got:\n{cleared}"
    );
    settle_pages_cache(&pool).await;
    assert_reconciled(&pool, "after the sweep dropped the title-cleared page").await;
    let end = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        (end.live_page_blocks, end.pages_cache_rows),
        (1, 1),
        "only PAGE_A should remain a live titled page, got {end:?}"
    );
}

/// Soft-delete a block the way a cohort delete does — `deleted_at` in epoch ms
/// (migration 0080), no row removal.
async fn soft_delete_block(pool: &sqlx::SqlitePool, id: &str) {
    // dynamic-sql: test-only state transition (not a production query path).
    sqlx::query("UPDATE blocks SET deleted_at = 1735689600000 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .expect("soft-delete block");
}

/// **Page ownership.** `blocks.page_id` must equal the page the `parent_id`
/// tree says owns the block.
///
/// This is the artefact the count rules used to have to ASSUME: both they and
/// the incremental UPDATE they audit read `page_id`, so a drifted column made
/// them agree with each other and with nothing else.
///
/// The injected divergence is the real shape, not a scribble: a block is
/// reparented onto another page and its `page_id` is left behind, which is
/// exactly what a cross-page move whose re-derivation was missed leaves in the
/// table (a MOVE deliberately does not enqueue the vault-wide `RebuildPageIds`
/// — #2200 — so the in-tx `rederive_page_and_space_ids` is the only thing
/// standing between that op and this state).
///
/// Production's own re-derivation then repairs it, which is the other half of
/// the claim: the oracle's structural walk agrees with `rebuild_page_ids` on a
/// tree with self-owned pages, multi-level climbs, a nested page boundary and
/// an orphan — so it can be trusted to be reporting a bug rather than a
/// different opinion.
#[tokio::test]
async fn page_ownership_reconciles_and_reports_a_missed_rederivation() {
    let (pool, _dir) = page_fixture().await;
    settle_pages_cache(&pool).await;
    assert_reconciled(&pool, "fixture as seeded").await;

    // NON-VACUITY: every page owns itself by DB CHECK, so a fixture in which
    // nothing is owned by another page makes the walk a no-op. Pinning the
    // exact count also pins the two edges the walk could get wrong — it must
    // NOT climb past NESTED_PAGE to PAGE_A, and it must NOT invent an owner
    // for ORPHAN.
    let coverage = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        coverage.blocks_owned_by_another_page, OWNED_BY_ANOTHER_PAGE,
        "expected A_CHILD + A_GRAND (→ PAGE_A) and N_CHILD (→ NESTED_PAGE), got {coverage:?}"
    );
    // The derived owners themselves, so the walk's every branch is pinned by
    // value rather than by a count that several wrong walks would also hit.
    let derived = rebuild_page_ownership_from_base(&pool)
        .await
        .expect("ownership rebuild");
    let owner = |id: &str| derived.get(id).cloned().flatten();
    assert_eq!(owner(PAGE_A).as_deref(), Some(PAGE_A), "a page owns itself");
    assert_eq!(
        owner(A_CHILD).as_deref(),
        Some(PAGE_A),
        "one climb reaches the page"
    );
    assert_eq!(
        owner(A_GRAND).as_deref(),
        Some(PAGE_A),
        "two climbs reach the same page"
    );
    assert_eq!(
        owner(NESTED_PAGE).as_deref(),
        Some(NESTED_PAGE),
        "a nested page owns itself, it does not belong to its host page"
    );
    assert_eq!(
        owner(N_CHILD).as_deref(),
        Some(NESTED_PAGE),
        "the walk must STOP at the nearest page, not climb through to PAGE_A"
    );
    assert_eq!(
        owner(ORPHAN),
        None,
        "a block with no page ancestor is owned by nothing"
    );

    // Injection — a cross-page reparent whose page_id re-derivation never ran.
    reparent_block(&pool, A_GRAND, Some(PAGE_B)).await;
    let drift = reconciliation_failure(&pool, "cross-page move without re-derivation")
        .await
        .expect("oracle must report the ownership drift");
    assert!(
        drift.contains("blocks.page_id") && drift.contains(A_GRAND),
        "expected an ownership divergence naming the moved block, got:\n{drift}"
    );
    assert!(
        drift.contains(&format!("rebuilt-from-base: {PAGE_B}"))
            && drift.contains(&format!("incremental state: {PAGE_A}")),
        "the report must name both pages so the reader knows which way it drifted, got:\n{drift}"
    );

    // Production's re-derivation repairs it — the oracle agrees with
    // `rebuild_page_ids`, it does not merely disagree with the column.
    settle_derived_page_ids(&pool)
        .await
        .expect("page_id re-derivation");
    settle_pages_cache(&pool).await;
    assert_reconciled(&pool, "after the production page_id rebuild").await;

    // The other direction: a block that loses its page ancestor entirely must
    // fall back to NULL, not keep its stale owner.
    reparent_block(&pool, A_CHILD, None).await;
    let orphaned = reconciliation_failure(&pool, "block reparented out of every page")
        .await
        .expect("oracle must report the orphaned block");
    assert!(
        orphaned.contains("blocks.page_id") && orphaned.contains(A_CHILD),
        "expected an ownership divergence naming the orphaned block, got:\n{orphaned}"
    );
    assert!(
        orphaned.contains("NULL (no page ancestor via parent_id)"),
        "expected the NULL-owner direction, got:\n{orphaned}"
    );

    settle_derived_page_ids(&pool)
        .await
        .expect("page_id re-derivation");
    settle_pages_cache(&pool).await;
    assert_reconciled(&pool, "after re-deriving the orphaned subtree").await;
    let end = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        end.blocks_owned_by_another_page, 2,
        "A_GRAND now sits under PAGE_B and A_CHILD under no page, leaving A_GRAND \
         and N_CHILD as the climbing blocks, got {end:?}"
    );
}

/// Reparent a block WITHOUT touching its `page_id` — the residue of a move
/// whose ownership re-derivation was missed.
async fn reparent_block(pool: &sqlx::SqlitePool, id: &str, new_parent: Option<&str>) {
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("UPDATE blocks SET parent_id = ? WHERE id = ?")
        .bind(new_parent)
        .bind(id)
        .execute(pool)
        .await
        .expect("reparent block");
}

// ---------------------------------------------------------------------------
// `page_link_cache` — the page-level `block_links` roll-up (#3296)
// ---------------------------------------------------------------------------

/// Record one outbound edge the way the in-tx `reindex_block_links_conn` arm
/// does — a `block_links` row, and nothing else. `page_link_cache` is
/// deliberately left alone: NOTHING inside `apply_op_tx` maintains it, so this
/// is exactly the state a vault is in between the edge landing and whichever
/// background task the dispatch table decided to enqueue.
async fn insert_block_link(pool: &sqlx::SqlitePool, source: &str, target: &str) {
    // dynamic-sql: test-only fixture seed (not a production query path).
    sqlx::query("INSERT OR IGNORE INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .expect("seed block_links edge");
}

/// **`page_link_cache`.** The roll-up must equal a from-base fold of
/// `block_links` — in both key-set directions AND by value, flags included.
///
/// Every state below is one production reaches. The starting state is the
/// #3296 bug itself: edges written by an op whose arm enqueued no link
/// maintainer, so the roll-up the Graph view reads never learns about them.
/// The later ones are a source block soft-deleted before its page's rebuild
/// lands, and a link TARGET soft-deleted — which must flip a denormalised flag
/// the read path filters on, not merely leave `edge_count` alone.
///
/// Production's own rebuild repairs each one, which is the other half of the
/// claim: this fold agrees with `rebuild_page_link_cache` on a tree with a
/// two-block roll-up, a nested-page boundary and a tombstone, so it can be
/// trusted to be reporting a bug rather than holding a different opinion.
#[tokio::test]
async fn page_link_cache_reconciles_and_reports_an_unmaintained_rollup() {
    let (pool, _dir) = page_fixture().await;
    settle_pages_cache(&pool).await;
    assert_reconciled(&pool, "fixture as seeded, before any link exists").await;

    // Two blocks on PAGE_A link to PAGE_B (so the roll-up must AGGREGATE), and
    // one block behind the nested-page boundary links there too (so the
    // roll-up must attribute it to NESTED_PAGE, not to the host page).
    insert_block_link(&pool, A_CHILD, PAGE_B).await;
    insert_block_link(&pool, A_GRAND, PAGE_B).await;
    insert_block_link(&pool, N_CHILD, PAGE_B).await;
    // The counts artefact reads the same `block_links` rows; settle it so the
    // page-link divergence below is the FIRST one and cannot be a side effect.
    settle_pages_cache(&pool).await;

    // NON-VACUITY, by value not just by size: a fold that ignored the nested
    // page boundary would report ONE row of edge_count 3 and still be
    // "non-empty".
    let expected = rebuild_page_link_cache_from_base(&pool)
        .await
        .expect("page-link rebuild");
    assert_eq!(
        expected,
        [
            (
                (PAGE_A.to_owned(), PAGE_B.to_owned()),
                PageLinkEdge {
                    edge_count: 2,
                    src_deleted: false,
                    tgt_deleted: false,
                    tgt_is_page: true,
                },
            ),
            (
                (NESTED_PAGE.to_owned(), PAGE_B.to_owned()),
                PageLinkEdge {
                    edge_count: 1,
                    src_deleted: false,
                    tgt_deleted: false,
                    tgt_is_page: true,
                },
            ),
        ]
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>(),
        "the roll-up must aggregate the two PAGE_A blocks into ONE row and stop at \
         the nested page boundary"
    );
    let coverage = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        (coverage.page_link_edges, coverage.page_link_cache_rows),
        (2, 0),
        "the fold must see 2 edges while the cache is still empty, so the \
         MISSING-row direction is reachable, got {coverage:?}"
    );

    // Direction 1 — MISSING row: this is #3296. The edges are in `block_links`
    // (the in-tx arm wrote them) but no background link maintainer ever ran.
    let missing = reconciliation_failure(&pool, "edges written, no link maintainer enqueued")
        .await
        .expect("oracle must report the unmaintained roll-up");
    assert!(
        missing.contains("page_link_cache.row") && missing.contains("no row in page_link_cache"),
        "expected a missing-row divergence, got:\n{missing}"
    );
    assert!(
        missing.contains("in 2 place(s)"),
        "both source pages must be reported, got:\n{missing}"
    );

    settle_page_link_cache_rebuild(&pool)
        .await
        .expect("page_link_cache rebuild");
    assert_reconciled(&pool, "after the production roll-up rebuild").await;
    let settled = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        (settled.page_link_edges, settled.page_link_cache_rows),
        (2, 2),
        "the rebuild must materialise exactly the folded edges, got {settled:?}"
    );

    // Direction 2 — WRONG VALUE: a soft-deleted SOURCE block stops holding its
    // edge up, so PAGE_A's row must drop to 1 while the cache still says 2.
    soft_delete_block(&pool, A_GRAND).await;
    settle_pages_cache(&pool).await;
    let stale_count = reconciliation_failure(&pool, "source block deleted before the rebuild")
        .await
        .expect("oracle must report the stale edge_count");
    assert!(
        stale_count.contains("page_link_cache.edge") && stale_count.contains(PAGE_A),
        "expected an edge divergence naming the source page, got:\n{stale_count}"
    );
    assert!(
        stale_count.contains("edge_count: 1") && stale_count.contains("edge_count: 2"),
        "the report must name both counts so the reader knows which way it drifted, \
         got:\n{stale_count}"
    );
    settle_page_link_cache_rebuild(&pool)
        .await
        .expect("page_link_cache rebuild");
    assert_reconciled(&pool, "after the rebuild dropped the deleted source's edge").await;

    // Direction 3 — EXTRA row: delete the LAST live source on PAGE_A and its
    // row must go entirely, not merely drop to zero.
    soft_delete_block(&pool, A_CHILD).await;
    settle_pages_cache(&pool).await;
    let extra = reconciliation_failure(&pool, "last source on the page deleted")
        .await
        .expect("oracle must report the orphaned roll-up row");
    assert!(
        extra.contains("page_link_cache.row") && extra.contains("a row in page_link_cache"),
        "expected the EXTRA-row direction, got:\n{extra}"
    );
    settle_page_link_cache_rebuild(&pool)
        .await
        .expect("page_link_cache rebuild");
    assert_reconciled(&pool, "after the rebuild dropped the emptied page's row").await;

    // Direction 4 — a stale FLAG. `tgt_deleted` is not decoration: the hot
    // unscoped read filters on it with a partial index and ZERO `blocks`
    // joins, so a flag left at 0 is a link to a tombstone the Graph view keeps
    // drawing. `edge_count` is unchanged here, so the flag is the only thing
    // this divergence can be about.
    soft_delete_block(&pool, PAGE_B).await;
    settle_pages_cache(&pool).await;
    let stale_flag = reconciliation_failure(&pool, "link target soft-deleted")
        .await
        .expect("oracle must report the stale tgt_deleted flag");
    assert!(
        stale_flag.contains("page_link_cache.edge")
            && stale_flag.contains("tgt_deleted: true")
            && stale_flag.contains("tgt_deleted: false"),
        "expected a flag divergence naming both states of tgt_deleted, got:\n{stale_flag}"
    );
    settle_page_link_cache_rebuild(&pool)
        .await
        .expect("page_link_cache rebuild");
    assert_reconciled(&pool, "after the rebuild refreshed the denormalised flags").await;
    let end = oracle_coverage(&pool).await.expect("coverage");
    assert_eq!(
        (end.page_link_edges, end.page_link_cache_rows),
        (1, 1),
        "only NESTED_PAGE -> PAGE_B should survive, flagged tgt_deleted, got {end:?}"
    );
}
