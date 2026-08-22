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

// ---------------------------------------------------------------------------
// `block_links` ITSELF — the base table, audited against block CONTENT (#3955)
// ---------------------------------------------------------------------------
//
// Every other artefact in this module folds `block_links` as ground truth, so
// a wrong row in it produced a CONSISTENT wrong answer on both sides of their
// diffs. These tests cover the artefact that gives it an independent expected
// side, and — per the issue's acceptance criterion — the state #3903 was
// about: a same-space link whose target `space_id` is not yet stamped.
//
// Ids are 26-char Crockford base-32 because the link grammar demands it:
// `[[…]]` around anything other than exactly 26 uppercase alphanumerics is not
// a token, so a fixture with short ids would parse to ZERO tokens and every
// assertion below would pass vacuously.

const BL_SPACE: &str = "01SPACE3955000000000000000";
const BL_SRC_PAGE: &str = "01SRCPAGE39550000000000000";
const BL_SRC: &str = "01SRCBLOCK3955000000000000";
const BL_TGT_PAGE: &str = "01TGTPAGE39550000000000000";
/// The #3903 target: on a page in the source's space, but its OWN `space_id`
/// column is still NULL — the window between the block committing and
/// `SetBlockPageId`'s `set_block_space_id_from_parent` stamping it.
const BL_TGT_PENDING: &str = "01TGTPEND39550000000000000";
/// The control: same page, `space_id` already materialised. This one survived
/// the pre-#3894 filter, which is why a fixture containing only this target
/// cannot tell the broken subquery from the fixed one.
const BL_TGT_STAMPED: &str = "01TGTSTMP39550000000000000";
const BL_OTHER_SPACE: &str = "01XSPACE395500000000000000";
const BL_OTHER_PAGE: &str = "01XPAGE3955000000000000000";
const BL_OTHER_BLOCK: &str = "01XBLOCK395500000000000000";

/// A page block. `page_id = id` is forced by the `page_id_self_for_pages`
/// CHECK (migration 0085).
async fn bl_insert_page(pool: &sqlx::SqlitePool, id: &str, space: Option<&str>) {
    // dynamic-sql: test-only fixture seed (not a production query path).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, 'page', ?, NULL, 1, ?, ?)",
    )
    .bind(id)
    .bind(id)
    .bind(id)
    .bind(space)
    .execute(pool)
    .await
    .expect("seed page block");
}

/// Register a space. `blocks.space_id REFERENCES spaces(id)` and
/// `spaces.id REFERENCES blocks(id)` (migration 0089), so the block must
/// already exist and the registry row must exist before anything points at it.
async fn bl_register_space(pool: &sqlx::SqlitePool, id: &str) {
    // dynamic-sql: test-only fixture seed (not a production query path).
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(id)
        .execute(pool)
        .await
        .expect("register space");
}

async fn bl_insert_content(
    pool: &sqlx::SqlitePool,
    id: &str,
    page: &str,
    space: Option<&str>,
    content: &str,
) {
    // dynamic-sql: test-only fixture seed (not a production query path).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
         VALUES (?, 'content', ?, ?, 1, ?, ?)",
    )
    .bind(id)
    .bind(content)
    .bind(page)
    .bind(page)
    .bind(space)
    .execute(pool)
    .await
    .expect("seed content block");
}

/// Overwrite a block's content WITHOUT running any reindex — the state between
/// the apply landing and whichever maintainer the dispatch table enqueued.
async fn bl_set_content(pool: &sqlx::SqlitePool, id: &str, content: &str) {
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
        .bind(content)
        .bind(id)
        .execute(pool)
        .await
        .expect("rewrite block content");
}

/// Read the stored edge set, so a test can assert on the TABLE and not only on
/// the oracle's opinion of it.
async fn bl_stored_targets(pool: &sqlx::SqlitePool, source: &str) -> Vec<String> {
    // dynamic-sql: static SQL, test-only read-back.
    let mut rows: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM block_links WHERE source_id = ?")
            .bind(source)
            .fetch_all(pool)
            .await
            .expect("read block_links");
    rows.sort();
    rows
}

/// The #3903 fixture: one source in a space linking three targets — one whose
/// space resolves only through the owning-page fallback, one already stamped,
/// and one genuinely in another space.
///
/// Nothing is reindexed here: the vault starts in the state a `block_links`
/// oracle must be able to see through, i.e. content that names edges the table
/// does not hold.
async fn bl_fixture() -> (sqlx::SqlitePool, TempDir) {
    let dir = TempDir::new().expect("tempdir");
    let pool = crate::db::init_pool(&dir.path().join("block_links.db"))
        .await
        .expect("init_pool");

    // The space markers are themselves blocks (spaces.id REFERENCES blocks).
    bl_insert_page(&pool, BL_SPACE, None).await;
    bl_register_space(&pool, BL_SPACE).await;
    bl_insert_page(&pool, BL_OTHER_SPACE, None).await;
    bl_register_space(&pool, BL_OTHER_SPACE).await;

    bl_insert_page(&pool, BL_SRC_PAGE, Some(BL_SPACE)).await;
    bl_insert_page(&pool, BL_TGT_PAGE, Some(BL_SPACE)).await;
    bl_insert_page(&pool, BL_OTHER_PAGE, Some(BL_OTHER_SPACE)).await;

    // `space_id` LEFT NULL on purpose — the pre-`SetBlockPageId` window.
    bl_insert_content(&pool, BL_TGT_PENDING, BL_TGT_PAGE, None, "pending").await;
    bl_insert_content(
        &pool,
        BL_TGT_STAMPED,
        BL_TGT_PAGE,
        Some(BL_SPACE),
        "stamped",
    )
    .await;
    bl_insert_content(
        &pool,
        BL_OTHER_BLOCK,
        BL_OTHER_PAGE,
        Some(BL_OTHER_SPACE),
        "elsewhere",
    )
    .await;

    bl_insert_content(
        &pool,
        BL_SRC,
        BL_SRC_PAGE,
        Some(BL_SPACE),
        &format!("see [[{BL_TGT_PENDING}]] and (({BL_TGT_STAMPED})) and [[{BL_OTHER_BLOCK}]]"),
    )
    .await;

    (pool, dir)
}

/// **The acceptance criterion of #3955.** `block_links` is a BASE table to
/// every other artefact here, so the only thing that can make it auditable is
/// an expected side derived from something else — the link tokens in
/// `blocks.content`, resolved the way `reindex_block_links` resolves them.
///
/// Everything this pins:
///
/// * the MISSING arm fires on content that names edges the table does not hold
///   (#3903's shape, and #3296's, and any forgotten `ReindexBlockLinks`
///   enqueue);
/// * production's own writer settles it — the fold agrees with
///   `reindex_block_links` on a vault with a page-fallback target, a stamped
///   target and a cross-space target, so it can be trusted to report a bug
///   rather than hold a different opinion;
/// * the cross-space target is expected to be ABSENT, so an oracle that simply
///   forgot the filter would report a false MISSING here rather than passing;
/// * the coverage counters make the fixture's #3903 relevance an ASSERTION:
///   `page_fallback_space_targets` is the one number that distinguishes the
///   pre-#3894 subquery from the post-#3894 one, and a fixture with zero of
///   them audits nothing about this defect however many edges it checks.
///
/// **Reverting #3894 reddens this test at the final
/// `assert_block_links_reconciled`** — the pre-fix target subquery reads only
/// `blocks.space_id`, resolves `BL_TGT_PENDING` to NULL, `NULL = ?3` is falsy,
/// and the same-space edge is dropped from the table while the from-content
/// rebuild still expects it. That is the whole point: before this artefact
/// existed, that loss was invisible to `reconcile`, because the missing row was
/// missing from the expected AND the actual side of every diff that folded
/// `block_links`.
#[tokio::test]
async fn block_links_oracle_audits_the_base_table_against_content_3955() {
    let (pool, _dir) = bl_fixture().await;

    // NON-VACUITY, by value. Three tokens are parsed; two are derivable edges
    // (the cross-space one is correctly not); exactly one of them can only
    // resolve through the owning-page fallback.
    let before = block_links_coverage(&pool).await.expect("coverage");
    assert_eq!(
        before,
        BlockLinksCoverage {
            block_links_rows: 0,
            content_link_tokens: 3,
            derivable_edges: 2,
            space_filtered_sources: 1,
            page_fallback_space_targets: 1,
        },
        "the fixture must arm the cross-space filter AND contain a target whose space \
         resolves ONLY through the owning-page fallback — without that last one the \
         pre-#3894 subquery and the post-#3894 one are indistinguishable"
    );

    // NON-VACUITY by VALUE, not just by size: a fold that dropped the space
    // filter would still report "2 edges" if it also dropped the page-fallback
    // target, so the identities are pinned.
    assert_eq!(
        rebuild_block_links_from_content(&pool)
            .await
            .expect("from-content rebuild"),
        [
            (BL_SRC.to_owned(), BL_TGT_PENDING.to_owned()),
            (BL_SRC.to_owned(), BL_TGT_STAMPED.to_owned()),
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>(),
        "the expected side must contain BOTH same-space targets — including the one \
         whose space resolves only through its owning page — and NOT the cross-space one"
    );

    // Direction 1 — MISSING. The edges are in the content; no maintainer ran.
    let missing = block_links_reconciliation_failure(&pool, "content written, no reindex ran")
        .await
        .expect("oracle must report the unmaintained edges");
    assert!(
        missing.contains("block_links.row") && missing.contains("no row in block_links"),
        "expected a missing-row divergence, got:\n{missing}"
    );
    assert!(
        missing.contains("in 2 place(s)"),
        "both derivable edges must be reported — and the CROSS-SPACE token must not \
         be, got:\n{missing}"
    );
    // Asserted over the DIVERGENCE SET, not the formatted report: the report
    // renders only `divergences.first()`, and `BL_OTHER_BLOCK` sorts after
    // `BL_TGT_PENDING`, so a fold that dropped the cross-space filter would
    // still produce a string not containing it. Checking the string here would
    // be vacuous with respect to the claim this comment makes.
    let divergences = reconcile_block_links(&pool)
        .await
        .expect("reconcile_block_links");
    assert!(
        !divergences.iter().any(|d| d.key.contains(BL_OTHER_BLOCK)),
        "the cross-space target is correctly absent from block_links; reporting it \
         would mean the oracle dropped the filter it is auditing, got:\n{divergences:#?}"
    );

    // Production's writer settles it. This is the whole claim: a from-CONTENT
    // rebuild and `reindex_block_links` agree.
    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");

    // THE BLIND SPOT ITSELF, asserted rather than described. Settle every
    // roll-up production would settle and the PRE-EXISTING oracle is green —
    // and it stays green with #3894 reverted, because `block_links` is a base
    // table to both of its link artefacts: the dropped row is missing from the
    // expected AND the actual side, so the wrong answer is consistent. That is
    // why the assertion below cannot be replaced by `assert_reconciled`.
    settle_pages_cache(&pool).await;
    settle_page_link_cache_rebuild(&pool)
        .await
        .expect("page_link_cache rebuild");
    assert_reconciled(
        &pool,
        "every roll-up settled — reconcile() sees nothing here",
    )
    .await;

    // #3955 ACCEPTANCE, and FIRST on purpose: this must be the assertion that
    // fires on a tree with #3894 reverted, naming `BL_SRC -> BL_TGT_PENDING`
    // as a row the content demands and the table does not hold. A raw
    // read-back of `block_links` would catch the same regression, but catching
    // it is not the claim — the claim is that the ORACLE can express it, so the
    // oracle has to be what speaks first.
    assert_block_links_reconciled(&pool, "after production's own reindex").await;

    // Corroboration: the same fact read straight off the table, so a green
    // oracle here cannot be a bug in the oracle agreeing with a bug in the
    // writer.
    assert_eq!(
        bl_stored_targets(&pool, BL_SRC).await,
        // `bl_stored_targets` sorts; "…PEND…" sorts before "…STMP…".
        vec![BL_TGT_PENDING.to_owned(), BL_TGT_STAMPED.to_owned()],
        "both same-space targets must land — the unstamped one via the owning-page \
         fallback (#3903) — and the cross-space one must not"
    );

    let after = block_links_coverage(&pool).await.expect("coverage");
    assert_eq!(
        (after.block_links_rows, after.derivable_edges),
        (2, 2),
        "the writer must materialise exactly the folded edges, got {after:?}"
    );
}

/// **The EXTRA arm.** A row the live source's content no longer names.
///
/// Scoped to production's DELETE rule exactly — `old_targets` MINUS the parsed
/// tokens, with no existence and no space predicate — so this is the one
/// direction the writer is unconditionally responsible for. The state is a
/// real one: an `EditBlock` landed and its `ReindexBlockLinks` has not run (or
/// was never enqueued, the #3296 shape one arm over).
#[tokio::test]
async fn block_links_oracle_reports_a_row_the_content_no_longer_names_3955() {
    let (pool, _dir) = bl_fixture().await;
    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");
    assert_block_links_reconciled(&pool, "settled fixture").await;

    // Drop ONE token; keep the other, so the divergence cannot be "the whole
    // source went away" and has to name the individual edge.
    bl_set_content(&pool, BL_SRC, &format!("only (({BL_TGT_STAMPED})) now")).await;

    let extra = block_links_reconciliation_failure(&pool, "token removed, no reindex ran")
        .await
        .expect("oracle must report the stale edge");
    assert!(
        extra.contains("in 1 place(s)"),
        "exactly the de-referenced edge must be reported, got:\n{extra}"
    );
    assert!(
        extra.contains(&format!("{BL_SRC} -> {BL_TGT_PENDING}"))
            && extra.contains("a row in block_links")
            && extra.contains("no block_links row"),
        "expected an EXTRA-row divergence naming the de-referenced pair, got:\n{extra}"
    );

    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");
    assert_block_links_reconciled(&pool, "after the reindex dropped the stale edge").await;
    assert_eq!(
        bl_stored_targets(&pool, BL_SRC).await,
        vec![BL_TGT_STAMPED.to_owned()],
        "the reindex must delete exactly the token that left the content"
    );
}

/// **The two windows the artefact deliberately leaves open**, pinned so they
/// are a decision rather than an accident.
///
/// Production's writer runs on ONE trigger: a change to the source's content.
/// Nothing re-runs it when the world around the source changes, so a
/// soft-deleted TARGET and a soft-deleted SOURCE both leave rows behind that
/// no maintainer will ever remove. Those rows are the SETTLED state — the
/// roll-up is built to carry them (`rebuild_page_link_cache` flags
/// `tgt_deleted` rather than dropping the edge, and excludes deleted sources
/// with its own `WHERE sb.deleted_at IS NULL`) — so an artefact that reported
/// them would fire on every ordinary block deletion and be muted within a week.
///
/// Both halves are independently falsifiable, and by the SPECIFIC mistake each
/// exists to prevent — not by an arbitrary break:
///
/// * scoping the EXTRA arm's token read by liveness (i.e. "faithfully"
///   transcribing production's `SELECT content … WHERE deleted_at IS NULL`,
///   which is the obvious refactor) makes a tombstoned source derive zero
///   tokens and reddens the second half with its whole outbound set;
/// * dropping the target-liveness guard from the from-content fold makes the
///   dead target's edge derivable again — silently repairing the first half —
///   which the `derivable_edges` assertions catch by value.
#[tokio::test]
async fn block_links_oracle_leaves_the_unreindexed_windows_alone_3955() {
    let (pool, _dir) = bl_fixture().await;
    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");
    assert_block_links_reconciled(&pool, "settled fixture").await;

    // Window 1 — the TARGET is soft-deleted. The from-content rebuild stops
    // deriving the edge (the writer's EXISTS guard requires a live target),
    // but the row survives and must NOT be reported.
    soft_delete_block(&pool, BL_TGT_PENDING).await;
    assert_eq!(
        bl_stored_targets(&pool, BL_SRC).await.len(),
        2,
        "a soft delete leaves block_links alone — only a PURGE cascades (0061)"
    );
    let coverage = block_links_coverage(&pool).await.expect("coverage");
    assert_eq!(
        (coverage.block_links_rows, coverage.derivable_edges),
        (2, 1),
        "the rebuild must genuinely stop deriving the dead target's edge, so this is a \
         real asymmetry the arms are choosing not to report, got {coverage:?}"
    );
    assert_block_links_reconciled(&pool, "link target soft-deleted, row retained").await;

    // Window 2 — the SOURCE is soft-deleted. No delete arm enqueues
    // `ReindexBlockLinks`, so both of its rows stay; the EXTRA arm must skip
    // them rather than report the source's whole outbound set.
    soft_delete_block(&pool, BL_SRC).await;
    let coverage = block_links_coverage(&pool).await.expect("coverage");
    assert_eq!(
        (coverage.block_links_rows, coverage.derivable_edges),
        (2, 0),
        "a tombstoned source derives nothing, so its two surviving rows are exactly \
         what an unscoped EXTRA arm would (wrongly) report, got {coverage:?}"
    );
    assert_block_links_reconciled(&pool, "link source soft-deleted, rows retained").await;
}

/// The oracle's link grammar is a TRANSCRIPTION of
/// `agaric_store::cache::ULID_LINK_RE`, not a call to it — that is what stops
/// a production grammar change from moving the expected side with it silently.
///
/// The cost of a transcription is drift, so it is pinned: if the two ever
/// disagree on any of these, the fix is to update the oracle's literal
/// DELIBERATELY, not to discover it as a wave of unexplained divergences on a
/// real vault.
///
/// The corpus is the edge cases, not the happy path: exact length (25 and 27
/// characters must NOT match), lowercase, mixed delimiters, and the `#[ULID]`
/// tag-ref form that is a DIFFERENT artefact's token and must not be captured
/// here.
#[test]
fn oracle_link_grammar_matches_production_3955() {
    const OK: &str = "01ABCDEFGHJKMNPQRSTVWXYZ00";
    const SHORT: &str = "01ABCDEFGHJKMNPQRSTVWXYZ0";
    const LONG: &str = "01ABCDEFGHJKMNPQRSTVWXYZ000";
    let corpus = [
        format!("[[{OK}]]"),
        format!("(({OK}))"),
        format!("[[{OK}))"),
        format!("(({OK}]]"),
        format!("[[{SHORT}]]"),
        format!("[[{LONG}]]"),
        format!("[[{}]]", OK.to_lowercase()),
        format!("#[{OK}]"),
        format!("[{OK}]"),
        format!("prefix [[{OK}]] infix (({OK})) suffix"),
        format!("[[{OK}]][[{OK}]]"),
        String::new(),
    ];
    for text in &corpus {
        let mine: Vec<String> = super::ORACLE_LINK_TOKEN_RE
            .captures_iter(text)
            .map(|c| c[1].to_owned())
            .collect();
        let theirs: Vec<String> = agaric_store::cache::ULID_LINK_RE
            .captures_iter(text)
            .map(|c| c[1].to_owned())
            .collect();
        assert_eq!(
            mine, theirs,
            "the oracle's transcribed link grammar has drifted from \
             agaric_store::cache::ULID_LINK_RE on {text:?} — update the oracle's literal \
             deliberately (see ORACLE_LINK_TOKEN_RE's rustdoc)"
        );
    }
    // The corpus is only worth anything if it distinguishes: assert the two
    // NEGATIVE shapes really are negative, so a regex that matched everything
    // would fail here rather than agreeing with production vacuously.
    assert!(super::ORACLE_LINK_TOKEN_RE.captures(&corpus[4]).is_none());
    assert_eq!(
        super::ORACLE_LINK_TOKEN_RE
            .captures_iter(&corpus[9])
            .count(),
        2
    );
}

/// The measurement behind the LANE decision (#3955), kept `#[ignore]`d so the
/// per-PR suite does not pay for it — `scheduled-deep-checks.yml`'s
/// `--run-ignored=only` sweep runs it, where it is expected to PASS.
///
/// Every other rebuild in this module folds columns; this one runs a regex over
/// every block's full content, which is why the artefact is a separate entry
/// point rather than another arm of `reconcile` (called after EVERY op of
/// EVERY generated chain in the B6 property). This seeds a vault an order of
/// magnitude larger than any directed fixture and prints the cost so the claim
/// is a number rather than an intuition.
///
/// No wall-clock budget is asserted: a weekly lane on shared CI runners is the
/// wrong place for a timing gate (see the existing perf gates, which are sized
/// against measured values on dedicated runs). What IS asserted is that the
/// sweep is non-vacuous and green at scale, which is what would catch a fold
/// that only happens to be right on a seven-block fixture.
#[tokio::test]
#[ignore = "deep-checks lane: seeds a 2000-block vault to measure the content re-parse"]
async fn block_links_oracle_scale_sweep_3955() {
    const PAGES: usize = 20;
    const BLOCKS_PER_PAGE: usize = 100;

    let dir = TempDir::new().expect("tempdir");
    let pool = crate::db::init_pool(&dir.path().join("scale.db"))
        .await
        .expect("init_pool");

    bl_insert_page(&pool, BL_SPACE, None).await;
    bl_register_space(&pool, BL_SPACE).await;

    let mut ids = Vec::new();
    for p in 0..PAGES {
        let page = format!("01PAGE{p:020}");
        bl_insert_page(&pool, &page, Some(BL_SPACE)).await;
        for b in 0..BLOCKS_PER_PAGE {
            let id = format!("01BLK{p:03}{b:018}");
            assert_eq!(id.len(), 26, "seed ids must be token-shaped");
            // Half the blocks leave `space_id` NULL, so the owning-page
            // fallback is on the hot path of the sweep rather than an edge case.
            let space = if b % 2 == 0 { Some(BL_SPACE) } else { None };
            bl_insert_content(&pool, &id, &page, space, "body").await;
            ids.push(id);
        }
    }
    // Chain every block to the next: one token each, so the edge count scales
    // with the vault instead of being a constant handful.
    for (i, id) in ids.iter().enumerate() {
        let target = &ids[(i + 1) % ids.len()];
        bl_set_content(&pool, id, &format!("body [[{target}]]")).await;
        agaric_store::cache::reindex_block_links(&pool, id)
            .await
            .expect("reindex_block_links");
    }

    let started = std::time::Instant::now();
    let divergences = reconcile_block_links(&pool)
        .await
        .expect("block_links reconcile");
    let elapsed = started.elapsed();

    let coverage = block_links_coverage(&pool).await.expect("coverage");
    println!(
        "block_links oracle scale sweep: {} blocks, {} edges, reconcile_block_links took {:?} \
         ({coverage:?})",
        ids.len() + PAGES + 1,
        coverage.derivable_edges,
        elapsed,
    );
    assert_eq!(
        (coverage.derivable_edges, coverage.block_links_rows),
        (
            i64::try_from(ids.len()).unwrap(),
            i64::try_from(ids.len()).unwrap()
        ),
        "every chained block must contribute exactly one audited edge, got {coverage:?}"
    );
    assert!(
        coverage.page_fallback_space_targets > 0,
        "half the targets must resolve only through the owning-page fallback, got {coverage:?}"
    );
    assert!(
        divergences.is_empty(),
        "a vault settled by production's own writer must reconcile; first: {:?}",
        divergences.first()
    );
}

// ===========================================================================
// `block_links_unresolved` — the OBLIGATIONS artefact (#4229)
// ===========================================================================

/// Read the obligation index, so a test can assert on the TABLE and not only
/// on the oracle's opinion of it.
async fn blu_stored(pool: &sqlx::SqlitePool) -> Vec<(String, String)> {
    // dynamic-sql: static SQL, test-only read-back.
    let mut rows: Vec<(String, String)> =
        sqlx::query_as("SELECT source_id, target_id FROM block_links_unresolved")
            .fetch_all(pool)
            .await
            .expect("read block_links_unresolved");
    rows.sort();
    rows
}

/// Plant an obligation row directly — a debt the writers would never have
/// recorded.
async fn blu_insert(pool: &sqlx::SqlitePool, source: &str, target: &str) {
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("INSERT INTO block_links_unresolved (source_id, target_id) VALUES (?, ?)")
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .expect("plant block_links_unresolved row");
}

/// Erase an obligation row directly — the loss the artefact exists to see.
async fn blu_delete(pool: &sqlx::SqlitePool, source: &str, target: &str) {
    // dynamic-sql: test-only fault injection (not a production query path).
    sqlx::query("DELETE FROM block_links_unresolved WHERE source_id = ? AND target_id = ?")
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .expect("erase block_links_unresolved row");
}

/// **The acceptance criterion of #4229.** `block_links_unresolved` was shipped
/// (#4210, for #4118) as derived state with NO auditor: nothing re-derived it,
/// nothing compared it against what block content implies, and nothing would
/// have noticed if it silently went wrong.
///
/// The failure mode is what makes this worth an artefact of its own. A drifted
/// `block_links` is a backlink a user can see is missing. A drifted obligation
/// index is a repair that silently never happens, on a vault whose visible
/// state is identical to the state it already had — and nothing else in the
/// system reads the table, so nothing else can notice.
///
/// Everything this pins:
///
/// * the MISSING arm fires on content that owes edges no row records;
/// * production's OWN writer settles it — `reindex_block_links` and the fold
///   agree on a vault holding a resolvable target, a page-fallback target and
///   a cross-space target, so the artefact can be trusted to report a bug
///   rather than hold a different opinion;
/// * an obligation erased AFTER the writer recorded it — the #4229 loss, and
///   the exact shape #4218 found on the restore path — is reported by name;
/// * production's vault-wide arm (`rebuild_block_links_unresolved`, the
///   snapshot-RESET rebuild) puts it back, which is the ONE place the
///   independently-transcribed fold and the production derivation are pinned
///   against each other;
/// * the coverage counters make the fixture's relevance an ASSERTION:
///   `owed_with_a_live_target` is what distinguishes a fold that understands
///   the space window from one that only handles absent targets.
#[tokio::test]
async fn block_links_unresolved_oracle_audits_the_obligation_index_4229() {
    let (pool, _dir) = bl_fixture().await;

    // NON-VACUITY, by value. Nothing has been reindexed: three tokens are
    // named, none is an edge, so all three are owed — and every one of them
    // has a LIVE target, which is the shape a fold that quietly assumed
    // "unresolved means the target is absent" would get wrong.
    assert_eq!(
        block_links_unresolved_coverage(&pool)
            .await
            .expect("coverage"),
        BlockLinksUnresolvedCoverage {
            unresolved_rows: 0,
            owed_by_content: 3,
            owed_with_a_live_target: 3,
        },
        "the fixture must owe every one of its tokens before any writer runs"
    );

    // NON-VACUITY by VALUE, not just by count: a fold that owed the wrong
    // three pairs would satisfy the counters above.
    assert_eq!(
        rebuild_block_links_unresolved_from_content(&pool)
            .await
            .expect("re-derivation from content"),
        [
            (BL_SRC.to_owned(), BL_OTHER_BLOCK.to_owned()),
            (BL_SRC.to_owned(), BL_TGT_PENDING.to_owned()),
            (BL_SRC.to_owned(), BL_TGT_STAMPED.to_owned()),
        ]
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>(),
        "every token the source names is owed while no edge carries it — including the \
         cross-space one, which is owed precisely because it will never be an edge \
         until something about the TARGET changes"
    );

    // Direction 1 — MISSING. The debts are implied by the content; no
    // maintainer ran.
    let missing = block_links_unresolved_reconciliation_failure(&pool, "no reindex ran")
        .await
        .expect("oracle must report the unrecorded obligations");
    assert!(
        missing.contains("block_links_unresolved.row") && missing.contains("in 3 place(s)"),
        "every owed edge must be reported, got:\n{missing}"
    );
    assert!(
        missing.contains("no row in block_links_unresolved"),
        "expected a missing-row divergence, got:\n{missing}"
    );

    // Production's writer settles it. This is the whole claim: an
    // independently-transcribed re-derivation and `sync_unresolved_links`
    // agree.
    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");
    assert_block_links_unresolved_reconciled(&pool, "after production's own reindex").await;

    // Corroboration, read straight off the table: two tokens became edges, so
    // exactly the CROSS-SPACE one is still owed. A green oracle here cannot be
    // a bug in the oracle agreeing with a bug in the writer.
    assert_eq!(
        blu_stored(&pool).await,
        vec![(BL_SRC.to_owned(), BL_OTHER_BLOCK.to_owned())],
        "the token the cross-space filter declined is the one still owed — and the two \
         that became edges must have stopped being owed"
    );
    assert_eq!(
        block_links_unresolved_coverage(&pool)
            .await
            .expect("coverage"),
        BlockLinksUnresolvedCoverage {
            unresolved_rows: 1,
            owed_by_content: 1,
            owed_with_a_live_target: 1,
        },
        "the surviving obligation's target is present and LIVE — it is owed because of \
         the space filter, not because the target is missing"
    );

    // Direction 2 — the loss the artefact exists for. A row that IS owed and
    // WAS recorded is gone: a repair that will now silently never happen. The
    // vault's visible state — an edge absent from `block_links` — is unchanged,
    // which is exactly why nothing else can see this.
    blu_delete(&pool, BL_SRC, BL_OTHER_BLOCK).await;
    let lost = block_links_unresolved_reconciliation_failure(&pool, "obligation erased")
        .await
        .expect("oracle must report the erased obligation");
    assert!(
        lost.contains(&format!("{BL_SRC} -> {BL_OTHER_BLOCK}")) && lost.contains("in 1 place(s)"),
        "the erased obligation must be named, and nothing else, got:\n{lost}"
    );

    // And PRODUCTION's vault-wide arm puts it back — the same
    // `rebuild_block_links_unresolved` the snapshot RESET runs (#4218). This
    // is the pin between the two derivations: the fold above is a
    // transcription, not a call, so a rebuild that disagreed with it would
    // redden here rather than agree with itself.
    settle_block_links_unresolved(&pool)
        .await
        .expect("vault-wide unresolved rebuild");
    assert_block_links_unresolved_reconciled(&pool, "after the vault-wide rebuild").await;
    assert_eq!(
        blu_stored(&pool).await,
        vec![(BL_SRC.to_owned(), BL_OTHER_BLOCK.to_owned())],
        "the rebuild must restore exactly the obligation the incremental writer had, \
         with no extra rows for the two tokens that are already edges"
    );
}

/// **The EXTRA arm, both of its clauses.** A row nothing owes.
///
/// `sync_unresolved_links`' DELETE removes a source's row for two distinct
/// reasons — the content no longer names the target, or `block_links` now
/// carries the edge — and the arm is scoped to exactly those two. Covering
/// only one would leave the other's divergence invisible, which is the same
/// half-covered-symmetric-pair mistake the artefact exists to prevent.
#[tokio::test]
async fn block_links_unresolved_oracle_reports_a_debt_nothing_owes_4229() {
    let (pool, _dir) = bl_fixture().await;
    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");
    assert_block_links_unresolved_reconciled(&pool, "settled fixture").await;

    // Clause 1 — the content names no such token. (`BL_TGT_PAGE` is a real
    // block, so this is not merely "an id nobody has heard of".)
    blu_insert(&pool, BL_SRC, BL_TGT_PAGE).await;
    let unnamed = block_links_unresolved_reconciliation_failure(&pool, "token never named")
        .await
        .expect("oracle must report the un-named debt");
    assert!(
        unnamed.contains(&format!("{BL_SRC} -> {BL_TGT_PAGE}"))
            && unnamed.contains("names no such")
            && unnamed.contains("in 1 place(s)"),
        "expected the NOT-IN-tokens clause to be named, got:\n{unnamed}"
    );

    // Clause 2 — the edge EXISTS. This is the dangerous one: the obligation is
    // discharged, and a row left behind re-drives a repair on every future
    // reindex of a target that needs none.
    blu_insert(&pool, BL_SRC, BL_TGT_STAMPED).await;
    let already = block_links_unresolved_reconciliation_failure(&pool, "edge already exists")
        .await
        .expect("oracle must report the discharged debt");
    assert!(
        already.contains("in 2 place(s)"),
        "both planted rows must be reported, got:\n{already}"
    );
    let divergences = reconcile_block_links_unresolved(&pool)
        .await
        .expect("reconcile_block_links_unresolved");
    assert!(
        divergences
            .iter()
            .any(|d| d.key == format!("{BL_SRC} -> {BL_TGT_STAMPED}")
                && d.expected.contains("block_links now carries the edge")),
        "the ALREADY-LINKED clause must be reported with its own reason rather than \
         collapsing into the not-named one, got:\n{divergences:#?}"
    );

    // Production's own DELETE arm clears both, and the artefact goes clean —
    // the other half of the pair. An artefact that only ever fires is as
    // useless as one that never does.
    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");
    assert_block_links_unresolved_reconciled(&pool, "after the reindex dropped both rows").await;
    assert_eq!(
        blu_stored(&pool).await,
        vec![(BL_SRC.to_owned(), BL_OTHER_BLOCK.to_owned())],
        "the reindex must delete exactly the two planted rows and keep the real debt"
    );
}

/// **The window this artefact deliberately leaves open**, pinned so it is a
/// decision rather than an accident.
///
/// No delete arm enqueues `ReindexBlockLinks`, so a soft-deleted source keeps
/// both its edges and its obligations — nothing will ever remove them. Those
/// rows are the SETTLED state, so an EXTRA arm that reported them would fire on
/// every ordinary block deletion and be muted within a week.
///
/// Falsifiable by the SPECIFIC mistake it exists to prevent: liveness-scoping
/// the EXTRA arm's token read — i.e. "faithfully" transcribing production's
/// `SELECT content … WHERE deleted_at IS NULL`, which is the obvious refactor —
/// makes a tombstoned source derive zero tokens and reddens this with its whole
/// outstanding debt.
#[tokio::test]
async fn block_links_unresolved_oracle_leaves_a_tombstoned_source_alone_4229() {
    let (pool, _dir) = bl_fixture().await;
    agaric_store::cache::reindex_block_links(&pool, BL_SRC)
        .await
        .expect("reindex_block_links");
    assert_block_links_unresolved_reconciled(&pool, "settled fixture").await;

    soft_delete_block(&pool, BL_SRC).await;

    let coverage = block_links_unresolved_coverage(&pool)
        .await
        .expect("coverage");
    assert_eq!(
        (coverage.unresolved_rows, coverage.owed_by_content),
        (1, 0),
        "a tombstoned source owes nothing, so its surviving row is exactly what a \
         liveness-scoped EXTRA arm would (wrongly) report, got {coverage:?}"
    );
    assert_block_links_unresolved_reconciled(&pool, "source soft-deleted, obligation retained")
        .await;
}
