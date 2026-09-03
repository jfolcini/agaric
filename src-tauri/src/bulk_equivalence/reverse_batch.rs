//! #3346 — batch-vs-fold equivalence for the batch REVERSE-EDIT kernel.
//!
//! `reverse::batch::compute_reverse_batch` is the third genuine fork: six
//! hand-copied prior-state SQL kernels (`fetch_prior_text_batch`,
//! `fetch_prior_position_batch`, `fetch_prior_property_batch`,
//! `fetch_prior_attachment_batch`, `fetch_prev_edit_rows_batch`,
//! `fetch_prior_text_fallback_only`) that must mirror
//! `reverse::compute_reverse`'s single-op kernels byte-for-byte. #3280 is what
//! happens when they don't: the batch arm implemented only the TIMESTAMP
//! fallback and never read `payload.prev_edit`, so `revert_ops` /
//! `restore_page_to_op` / `undo_page_group` restored different text than
//! `undo_op` did — for the same op.
//!
//! Five of those six names carry a `batch` segment and so are found by
//! `check-bulk-equivalence.mjs`'s name heuristic. The sixth,
//! `fetch_prior_text_fallback_only`, does not — this test covers it either
//! way, but the RATCHET could not see it, so deleting it would have been
//! invisible to the inventory. It is therefore PINNED by exact key in
//! `scripts/bulk-equivalence-baseline.json` (the `pin` field), which puts it
//! in the live inventory despite its name and makes its deletion a stale-entry
//! failure. Pin the next hand-copied kernel that the heuristic misses the same
//! way rather than renaming production code to satisfy a regex.
//!
//! # Why this test is randomized and the old fixture is KEPT
//!
//! `reverse::tests::compute_reverse_batch_matches_per_op_loop` is the
//! hand-rolled ancestor of this test. It is deliberately NOT deleted:
//!
//! * It pins ABSOLUTE answers (`"B3_BLK1 v0.5"`, `"CORRECT-causal-prev"`,
//!   `"PEER-ORIGIN"`). A parity oracle cannot do that — a regression that
//!   broke BOTH kernels identically satisfies parity and fails those.
//! * This test pins the parity relation over RANDOM op chains, which the
//!   fixture's fixed 22-op list cannot.
//!
//! They cover different failure modes; keeping both is cheap.
//!
//! # The blindness this test had to fix first
//!
//! `proptest_db_harness` mints every `EditBlock` with `prev_edit: None`
//! (`proptest_db_harness.rs`, the `OpKind::Edit` arm). `None` is exactly the
//! shape where the pointer kernel and the timestamp kernel trivially agree, so
//! a parity test driven by the raw harness chain would be GREEN with the #3280
//! bug reinstated. Two things fix that here:
//!
//! 1. [`stamp_prev_edit`] post-processes the resolved chain and stamps a
//!    REALISTIC causal pointer on every other edit, mirroring what production's
//!    `find_prev_edit_in_tx` writes. (Every other, not every: the un-stamped
//!    half keeps the timestamp-fallback arm exercised too.)
//! 2. [`seed_distinguishing_prelude`] adds the two shapes where the pointer and
//!    the timestamp scan give DIFFERENT answers — without them, a single-device
//!    chain with monotonic timestamps has its causal predecessor and its
//!    timestamp-nearest predecessor be the same op, and ignoring `prev_edit`
//!    changes nothing observable.

use std::sync::Arc;

use agaric_core::ulid::BlockId;
use agaric_store::op::{CreateBlockPayload, EditBlockPayload, OpPayload, OpRef};
use agaric_store::op_log::append_local_op_at;
use proptest::prelude::*;
use sqlx::{Row as _, SqlitePool};
use tokio::runtime::Runtime;

use super::{ArmEnv, Normalisation, assert_batch_equals_fold};
use agaric_engine::proptest_db_harness::{
    HARNESS_DEVICE, OpKind, op_chain_strategy, resolve_chain, ts_for,
};
use agaric_engine::reverse::{compute_reverse, compute_reverse_batch, get_op_records_batch};

/// Each case builds two fresh migrated databases, so the budget is kept low
/// deliberately; the value is in running the relation over many SHAPES, not in
/// exhausting the space. Bump locally with `PROPTEST_CASES`.
const REVERSE_CASES: u32 = 12;
const CHAIN_LEN: std::ops::RangeInclusive<usize> = 1..=12;

/// Devices for the clock-skew shape. Two devices are required: a single
/// device's `seq` order and `created_at` order coincide, which is precisely
/// what makes the two kernels indistinguishable.
const DEV_A: &str = "bulk-eq-device-a";
const DEV_B: &str = "bulk-eq-device-b";
const PEER: &str = "bulk-eq-peer-remote";

fn fixed_id(label: &str) -> BlockId {
    BlockId::from_trusted(&format!("{label:0>26}"))
}

// ---------------------------------------------------------------------------
// Chain post-processing
// ---------------------------------------------------------------------------

/// Stamp a realistic `prev_edit` pointer on every OTHER `EditBlock` in a
/// resolved chain.
///
/// Production's `find_prev_edit_in_tx` records the `(device_id, seq)` of the
/// most recent `create_block`/`edit_block` for the target block, regardless of
/// provenance. The chain is appended by a single device in order, so op at
/// index `i` will land at `seq = i + 1` — which is what makes this
/// reconstructable without a round trip.
///
/// Half the eligible edits are left at `prev_edit: None` on purpose: that is
/// the shape production still emits for pre-#1526 ops, and it is the only way
/// the TIMESTAMP-fallback arm of `resolve_prior_text` gets exercised. Stamping
/// all of them would swap the harness's original blindness for its mirror
/// image.
fn stamp_prev_edit(mut payloads: Vec<OpPayload>) -> Vec<OpPayload> {
    let mut last_touch: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut stamped = 0usize;
    for (i, payload) in payloads.iter_mut().enumerate() {
        let seq = i64::try_from(i).expect("chain index fits i64") + 1;
        match payload {
            OpPayload::CreateBlock(c) => {
                last_touch.insert(c.block_id.as_str().to_owned(), seq);
            }
            OpPayload::EditBlock(e) => {
                let block = e.block_id.as_str().to_owned();
                if let Some(prev_seq) = last_touch.get(&block).copied() {
                    if stamped.is_multiple_of(2) {
                        e.prev_edit = Some((HARNESS_DEVICE.to_owned(), prev_seq));
                    }
                    stamped += 1;
                }
                last_touch.insert(block, seq);
            }
            _ => {}
        }
    }
    payloads
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/// Seed a REPLICATED (audit-only, `is_replicated = 1`) op through the real
/// sync-ingest core, so the `block_id` denormalisation and the provenance stamp
/// are byte-faithful to a genuinely synced row.
async fn append_replicated(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    mut payload: OpPayload,
    ts: i64,
) {
    payload.normalize_block_ids();
    let op_type = payload.op_type_str().to_owned();
    let payload_json = agaric_store::op_log::serialize_inner_payload(&payload).unwrap();
    let hash = agaric_core::hash::compute_op_hash(device_id, seq, None, &op_type, &payload_json);
    let transfer = agaric_sync::sync_protocol::types::OpTransfer {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs: None,
        hash,
        op_type,
        payload: payload_json,
        created_at: ts,
        origin: "agent:bulk-equivalence".to_owned(),
    };
    agaric_sync::sync_protocol::insert_replicated_op(pool, &transfer)
        .await
        .expect("replicated audit op must ingest");
}

/// The two shapes where following `payload.prev_edit` and scanning by
/// timestamp give DIFFERENT answers. Without these the oracle cannot see the
/// #3280 class of bug at all.
///
/// **1. Cross-device clock skew (#1526).**
/// ```text
///   dev-a seq1  create  "v0"                    @ T
///   dev-a seq2  edit    "CORRECT-causal-prev"   @ T+5
///   dev-b seq1  edit    "WRONG-intruder"        @ T+8   (no pointer)
///   dev-b seq2  edit    "latest", prev=(a,2)    @ T+10  <- undo target
/// ```
/// The causal pointer names `(a, 2)`; the timestamp-nearest prior edit is
/// dev-b's intruder at T+8. Only the pointer gives the correct undo text.
///
/// **2. Peer-originated block (#3644).**
/// The block's ONLY prior op_log row is a replicated audit row. The timestamp
/// scan is barred from replicated rows (#2549) and finds nothing at all; only
/// the pointer resolves. Ignoring the pointer turns a reversible op into a
/// `NonReversible` error — a divergence in the error class, which this oracle
/// compares because it renders `Err` arms too.
async fn seed_distinguishing_prelude(pool: &SqlitePool, base_ts: i64) {
    let skew = fixed_id("SKEW");
    append_local_op_at(
        pool,
        DEV_A,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: skew.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "v0".into(),
        }),
        base_ts,
    )
    .await
    .expect("skew create");
    append_local_op_at(
        pool,
        DEV_A,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: skew.clone(),
            to_text: "CORRECT-causal-prev".into(),
            prev_edit: Some((DEV_A.to_owned(), 1)),
        }),
        base_ts + 5,
    )
    .await
    .expect("skew causal prev");
    append_local_op_at(
        pool,
        DEV_B,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: skew.clone(),
            to_text: "WRONG-intruder".into(),
            prev_edit: None,
        }),
        base_ts + 8,
    )
    .await
    .expect("skew intruder");
    append_local_op_at(
        pool,
        DEV_B,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: skew,
            to_text: "latest".into(),
            prev_edit: Some((DEV_A.to_owned(), 2)),
        }),
        base_ts + 10,
    )
    .await
    .expect("skew target");

    let peer = fixed_id("PEER");
    append_replicated(
        pool,
        PEER,
        1,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: peer.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            index: None,
            content: "PEER-ORIGIN".into(),
        }),
        base_ts + 20,
    )
    .await;
    append_local_op_at(
        pool,
        HARNESS_DEVICE,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: peer,
            to_text: "my local edit".into(),
            prev_edit: Some((PEER.to_owned(), 1)),
        }),
        base_ts + 25,
    )
    .await
    .expect("peer-origin target");
}

/// Every LOCAL op in the log, in a deterministic order — the undo candidates.
///
/// Replicated audit rows are excluded on purpose: they are never undo targets
/// (`reject_replicated_targets` refuses them at every call site), so feeding
/// them in would compare two paths against an input neither is contracted to
/// accept.
async fn local_op_refs(pool: &SqlitePool) -> Vec<OpRef> {
    // dynamic-sql: test-only oracle readback (not a production query path)
    sqlx::query("SELECT device_id, seq FROM op_log WHERE is_replicated = 0 ORDER BY device_id, seq")
        .fetch_all(pool)
        .await
        .expect("read local op refs")
        .into_iter()
        .map(|r| OpRef {
            device_id: r.get::<String, _>("device_id"),
            seq: r.get::<i64, _>("seq"),
        })
        .collect()
}

fn render(result: &Result<OpPayload, agaric_core::error::AppError>) -> String {
    match result {
        Ok(p) => format!("OK {p:?}"),
        // The error CLASS is part of the contract (#3645 aligned the two
        // kernels' `NonReversible` vs `NotFound` answer); rendering it into the
        // compared surface is what keeps that alignment pinned.
        Err(e) => format!("ERR {e}"),
    }
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

async fn run_reverse_scenario(sketches: Vec<OpKind>) {
    // Resolved ONCE, outside the arms. `resolve_chain` mints a FRESH random
    // ULID pool on every call, so resolving separately per arm would give the
    // two arms different block ids and turn every case into a false divergence.
    let payloads = stamp_prev_edit(resolve_chain(&sketches));
    let prelude_base = ts_for(payloads.len() + 60);

    let seed_payloads = payloads.clone();
    assert_batch_equals_fold(
        "compute_reverse_batch",
        &Normalisation::default(),
        move |env: Arc<ArmEnv>| {
            let payloads = seed_payloads.clone();
            Box::pin(async move {
                for (n, payload) in payloads.into_iter().enumerate() {
                    append_local_op_at(&env.pool, HARNESS_DEVICE, payload, ts_for(n))
                        .await
                        .expect("append harness op");
                }
                seed_distinguishing_prelude(&env.pool, prelude_base).await;
            })
        },
        |env: Arc<ArmEnv>| {
            Box::pin(async move {
                let refs = local_op_refs(&env.pool).await;
                let records = get_op_records_batch(&env.pool, &refs)
                    .await
                    .expect("get_op_records_batch");
                compute_reverse_batch(&env.pool, &records)
                    .await
                    .expect("compute_reverse_batch")
                    .iter()
                    .map(render)
                    .collect()
            })
        },
        |env: Arc<ArmEnv>| {
            Box::pin(async move {
                let refs = local_op_refs(&env.pool).await;
                let mut out = Vec::with_capacity(refs.len());
                for r in &refs {
                    out.push(render(
                        &compute_reverse(&env.pool, &r.device_id, r.seq).await,
                    ));
                }
                out
            })
        },
    )
    .await;
}

/// Directed smoke case — the distinguishing prelude alone, with an empty
/// generated chain. Fast, always runs, and is the case that actually carries
/// the #3280 / #3644 signal; the proptest below adds shape breadth on top.
#[tokio::test]
async fn compute_reverse_batch_matches_fold_on_the_distinguishing_shapes() {
    run_reverse_scenario(Vec::new()).await;
}

proptest! {
    #![proptest_config(ProptestConfig { cases: REVERSE_CASES, .. ProptestConfig::default() })]

    /// The batch reverse kernel must return, op for op, exactly what the
    /// single-op kernel returns — `Ok` payloads AND `Err` classes — over
    /// randomly generated op chains plus the two shapes where the causal
    /// pointer and the timestamp scan disagree.
    #[test]
    fn compute_reverse_batch_matches_per_op_fold(sketches in op_chain_strategy(CHAIN_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(run_reverse_scenario(sketches));
    }
}

#[cfg(test)]
mod stamping_tests {
    use super::*;

    /// The stamper must produce BOTH pointer-carrying and pointerless edits —
    /// if it stamped all of them the timestamp-fallback kernel would go
    /// unexercised, which is the exact mirror of the blindness it was written
    /// to fix.
    #[test]
    fn stamp_prev_edit_leaves_half_the_edits_pointerless() {
        let b = BlockId::from_trusted(&format!("{:0>26}", "SP1"));
        let mut chain = vec![OpPayload::CreateBlock(CreateBlockPayload {
            block_id: b.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "v0".into(),
        })];
        for i in 0..4 {
            chain.push(OpPayload::EditBlock(EditBlockPayload {
                block_id: b.clone(),
                to_text: format!("v{i}"),
                prev_edit: None,
            }));
        }
        let out = stamp_prev_edit(chain);
        let edits: Vec<_> = out
            .iter()
            .filter_map(|p| match p {
                OpPayload::EditBlock(e) => Some(e.prev_edit.is_some()),
                _ => None,
            })
            .collect();
        assert_eq!(edits, vec![true, false, true, false], "alternating stamp");
    }

    /// A stamped pointer must name the op that actually precedes it in the
    /// append order — a wrong `seq` would dangle, `resolve_prev_edit_target`
    /// would return `None`, and both kernels would silently fall back to the
    /// timestamp scan, agreeing for the wrong reason.
    #[test]
    fn stamp_prev_edit_points_at_the_preceding_op_seq() {
        let b = BlockId::from_trusted(&format!("{:0>26}", "SP2"));
        let chain = vec![
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: b.clone(),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                index: None,
                content: "v0".into(),
            }),
            OpPayload::EditBlock(EditBlockPayload {
                block_id: b.clone(),
                to_text: "v1".into(),
                prev_edit: None,
            }),
        ];
        match &stamp_prev_edit(chain)[1] {
            // index 0 -> seq 1 (the create)
            OpPayload::EditBlock(e) => {
                assert_eq!(e.prev_edit, Some((HARNESS_DEVICE.to_owned(), 1)));
            }
            other => panic!("expected EditBlock, got {other:?}"),
        }
    }
}
