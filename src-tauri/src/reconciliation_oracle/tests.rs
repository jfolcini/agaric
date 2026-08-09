//! Tests for the reconciliation oracle (#3345).
//!
//! Two things are proved here:
//!
//! 1. **The oracle observes something.** Every test asserts
//!    [`oracle_coverage`] is non-empty for the artefact it claims to cover, so
//!    a green run can never be a green vacuum. The directed tests additionally
//!    build the exact many-to-one dedup state (N `attachments` rows → 1 blob
//!    file) that the whole artefact exists for.
//! 2. **Both arms of each symmetric pair are covered.** For the blob store
//!    that is `persist_attachment`'s INSERT and `cleanup_orphaned_attachments`'
//!    prune; the generated sequence drives both, in both orders.
//!
//! The `pages_cache` wiring lives with the op-sequence generator it belongs
//! to — `materializer::handlers::apply_reproject_proptest::b6_*`.

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
        hashed_attachment_rows: 0,
        attachment_blob_rows: 0,
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
        peak.hashed_attachment_rows = peak.hashed_attachment_rows.max(now.hashed_attachment_rows);
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
