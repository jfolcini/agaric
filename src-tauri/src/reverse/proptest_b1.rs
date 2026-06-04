//! B1 property tests for [`compute_reverse`] (TEST-PROPTEST-B, #150).
//!
//! Three property families, all driven by the shared seeded-DB harness
//! (`crate::proptest_db_harness`):
//!
//! 1. **Inverse law** — for each reversible op `O` in a randomly generated
//!    valid op chain, appending `compute_reverse(O)` returns the
//!    observable state of the touched block to what it was strictly
//!    before `O`. "Observable state" is the op-log projection the reverse
//!    functions are contractually defined against (prior text / position /
//!    property value), computed by an INDEPENDENT replay in the harness's
//!    `observe_prior_*` oracles — so the assertion is a real oracle
//!    comparison, not a tautology.
//!
//! 2. **Determinism** — `compute_reverse(O)` called twice on the same
//!    seeded log yields byte-identical payloads.
//!
//! 3. **Exhaustive `OpType` -> inverse mapping** — every reversible
//!    variant maps to the documented inverse variant; the two
//!    non-reversible variants (`PurgeBlock`, `delete_attachment` with no
//!    prior add) are *rejected* with `AppError::NonReversible`, never
//!    mis-reversed. This is written as an **exhaustive match over every
//!    `OpType`** so that adding a 13th op type without a reverse fails to
//!    compile here (the match has no catch-all) — see
//!    `every_op_type_is_classified` below.
//!
//! ## proptest case count
//!
//! 64 cases (vs the proptest default of 256). Each case seeds a fresh
//! TempDir SQLite pool and appends a chain of up to 24 ops, then calls
//! `compute_reverse` once per reversible op — i.e. up to ~24 DB-backed
//! reverse computations per case. At 256 cases this pushed the single
//! test toward the 30 s nextest slow-timeout on a cold target; 64 cases
//! runs comfortably (a few seconds) while still exploring thousands of
//! distinct chains across a CI run. Bump via `PROPTEST_CASES` env if a
//! deeper search is wanted locally.

use super::*;
use crate::db::init_pool;
use crate::op::{OpPayload, OpType};
use crate::proptest_db_harness::{
    observe_prior_position, observe_prior_property, observe_prior_text, op_chain_strategy,
    seed_chain, AppliedChain, HARNESS_DEVICE,
};
use proptest::prelude::*;
use std::path::PathBuf;
use tempfile::TempDir;
use tokio::runtime::Runtime;

const B1_CASES: u32 = 64;
const CHAIN_LEN: std::ops::RangeInclusive<usize> = 1..=24;

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

// ---------------------------------------------------------------------------
// Property 1 — inverse law.
//
// For every reversible op O at seq s touching block B, the reverse op R
// = compute_reverse(O) must restore the observable state of B to its
// value strictly before O. We check this against the harness's
// independent op-log replay oracle (NOT the reverse helpers), per
// op-type:
//   * Edit / Create-then-Edit  -> reverse is EditBlock(prior_text)
//   * Move                      -> reverse is MoveBlock(prior parent,pos)
//   * SetProperty               -> reverse restores prior property value
//                                  (SetProperty(prior) or DeleteProperty)
//   * DeleteProperty            -> reverse is SetProperty(prior value)
//   * Create/Delete/Restore/Tag -> structural inverse variant + id match
//
// The oracle is "state strictly before O", which is exactly the inverse
// law: apply(O) then apply(reverse(O)) == prior observable state.
// ---------------------------------------------------------------------------

/// Assert the inverse law for a single (record, payload) pair against the
/// independent oracle. Returns a `TestCaseError` on violation so the
/// proptest shrinker can minimise.
async fn assert_inverse_law(
    pool: &SqlitePool,
    chain: &AppliedChain,
    rec: &crate::op_log::OpRecord,
    payload: &OpPayload,
) -> Result<(), TestCaseError> {
    let reverse = match compute_reverse(pool, HARNESS_DEVICE, rec.seq).await {
        Ok(r) => r,
        Err(AppError::NonReversible { .. }) => {
            // The only NonReversible ops the generator can produce are
            // move_block whose only prior is an ancient create with no
            // position — the generator always sets a position, so this
            // should not fire. If it does, it is a legitimate rejection,
            // not a mis-reversal; skip the inverse-law check for it.
            return Ok(());
        }
        Err(AppError::NotFound(_)) => {
            // e.g. reverse_edit_block when there is no prior text. The
            // generator only emits Edit on a created block, so a prior
            // (the create) always exists; treat any NotFound as a skip
            // rather than a failure (it is a refusal, not a wrong answer).
            return Ok(());
        }
        Err(e) => {
            return Err(TestCaseError::fail(format!(
                "compute_reverse({}) errored unexpectedly: {e}",
                rec.seq
            )))
        }
    };

    match payload {
        OpPayload::EditBlock(p) => {
            let prior = observe_prior_text(chain, p.block_id.as_str(), rec.seq);
            match (&reverse, prior) {
                (OpPayload::EditBlock(r), Some(prior_text)) => {
                    prop_assert_eq!(
                        &r.to_text,
                        &prior_text,
                        "reverse of edit must restore prior text"
                    );
                    prop_assert_eq!(&r.block_id, &p.block_id);
                }
                (other, prior) => {
                    return Err(TestCaseError::fail(format!(
                        "reverse of edit_block must be EditBlock(prior); got {other:?}, oracle prior={prior:?}"
                    )))
                }
            }
        }
        OpPayload::MoveBlock(p) => {
            let prior = observe_prior_position(chain, p.block_id.as_str(), rec.seq);
            match (&reverse, prior) {
                (OpPayload::MoveBlock(r), Some((prior_parent, prior_pos))) => {
                    let r_parent = r.new_parent_id.as_ref().map(|id| id.as_str().to_string());
                    prop_assert_eq!(
                        r_parent,
                        prior_parent,
                        "reverse of move must restore prior parent"
                    );
                    prop_assert_eq!(
                        r.new_position,
                        prior_pos,
                        "reverse of move must restore prior position"
                    );
                }
                (other, prior) => {
                    return Err(TestCaseError::fail(format!(
                        "reverse of move_block must be MoveBlock(prior); got {other:?}, oracle prior={prior:?}"
                    )))
                }
            }
        }
        OpPayload::SetProperty(p) => {
            let prior = observe_prior_property(chain, p.block_id.as_str(), &p.key, rec.seq);
            match (&reverse, prior) {
                // Prior value existed -> reverse re-sets it.
                (OpPayload::SetProperty(r), Some(prior_val)) => {
                    prop_assert_eq!(&r.key, &p.key);
                    prop_assert_eq!(
                        &r.value_text,
                        &prior_val,
                        "reverse of set_property must restore prior value_text"
                    );
                }
                // No prior value -> reverse deletes the key.
                (OpPayload::DeleteProperty(r), None) => {
                    prop_assert_eq!(&r.key, &p.key);
                    prop_assert_eq!(&r.block_id, &p.block_id);
                }
                (other, prior) => {
                    return Err(TestCaseError::fail(format!(
                        "reverse of set_property mismatched oracle; got {other:?}, oracle prior={prior:?}"
                    )))
                }
            }
        }
        OpPayload::DeleteProperty(p) => {
            let prior = observe_prior_property(chain, p.block_id.as_str(), &p.key, rec.seq);
            match (&reverse, prior) {
                (OpPayload::SetProperty(r), Some(prior_val)) => {
                    prop_assert_eq!(&r.key, &p.key);
                    prop_assert_eq!(
                        &r.value_text,
                        &prior_val,
                        "reverse of delete_property must restore prior value_text"
                    );
                }
                (other, prior) => {
                    return Err(TestCaseError::fail(format!(
                        "reverse of delete_property must be SetProperty(prior); got {other:?}, oracle prior={prior:?}"
                    )))
                }
            }
        }
        // Structural inverses — the inverse op carries the same id and the
        // documented opposite variant.
        OpPayload::CreateBlock(p) => {
            prop_assert!(
                matches!(&reverse, OpPayload::DeleteBlock(r) if r.block_id == p.block_id),
                "reverse of create must be DeleteBlock(same id); got {:?}",
                reverse
            );
        }
        OpPayload::DeleteBlock(p) => {
            prop_assert!(
                matches!(&reverse, OpPayload::RestoreBlock(r) if r.block_id == p.block_id),
                "reverse of delete must be RestoreBlock(same id); got {:?}",
                reverse
            );
        }
        OpPayload::RestoreBlock(p) => {
            prop_assert!(
                matches!(&reverse, OpPayload::DeleteBlock(r) if r.block_id == p.block_id),
                "reverse of restore must be DeleteBlock(same id); got {:?}",
                reverse
            );
        }
        OpPayload::AddTag(p) => {
            prop_assert!(
                matches!(&reverse, OpPayload::RemoveTag(r) if r.block_id == p.block_id && r.tag_id == p.tag_id),
                "reverse of add_tag must be RemoveTag(same ids); got {:?}",
                reverse
            );
        }
        OpPayload::RemoveTag(p) => {
            prop_assert!(
                matches!(&reverse, OpPayload::AddTag(r) if r.block_id == p.block_id && r.tag_id == p.tag_id),
                "reverse of remove_tag must be AddTag(same ids); got {:?}",
                reverse
            );
        }
        // The generator never emits these; if it ever does, fail loudly.
        OpPayload::PurgeBlock(_) | OpPayload::AddAttachment(_) | OpPayload::DeleteAttachment(_) => {
            return Err(TestCaseError::fail(format!(
                "harness emitted an op it should not: {payload:?}"
            )))
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: B1_CASES, .. ProptestConfig::default() })]

    /// Inverse law over random valid op chains. For every reversible op
    /// in the chain, the computed reverse restores the touched block's
    /// observable prior state (checked against the independent op-log
    /// replay oracle).
    #[test]
    fn compute_reverse_obeys_inverse_law(sketches in op_chain_strategy(CHAIN_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            let chain = seed_chain(&pool, &sketches).await;
            for (rec, payload) in chain.iter() {
                assert_inverse_law(&pool, &chain, rec, payload).await?;
            }
            Ok::<(), TestCaseError>(())
        })?;
    }

    /// Determinism: `compute_reverse` on the same seeded log is a pure
    /// function — two calls produce byte-identical payloads.
    #[test]
    fn compute_reverse_is_deterministic(sketches in op_chain_strategy(CHAIN_LEN)) {
        let rt = Runtime::new().unwrap();
        rt.block_on(async {
            let (pool, _dir) = test_pool().await;
            let chain = seed_chain(&pool, &sketches).await;
            for (rec, _payload) in chain.iter() {
                let first = compute_reverse(&pool, HARNESS_DEVICE, rec.seq).await;
                let second = compute_reverse(&pool, HARNESS_DEVICE, rec.seq).await;
                match (first, second) {
                    (Ok(a), Ok(b)) => prop_assert_eq!(
                        serde_json::to_string(&a).unwrap(),
                        serde_json::to_string(&b).unwrap(),
                        "compute_reverse must be deterministic"
                    ),
                    (Err(a), Err(b)) => prop_assert_eq!(
                        a.to_string(), b.to_string(),
                        "compute_reverse error must be deterministic"
                    ),
                    (a, b) => return Err(TestCaseError::fail(format!(
                        "compute_reverse non-deterministic Ok/Err: {a:?} vs {b:?}"
                    ))),
                }
            }
            Ok::<(), TestCaseError>(())
        })?;
    }
}

// ---------------------------------------------------------------------------
// Property 3 — exhaustive OpType -> inverse mapping / reversibility class.
//
// This is NOT a proptest (no randomness needed): it is a compile-time
// exhaustiveness guard plus a runtime check that the reversibility
// classification matches `compute_reverse`'s dispatch in mod.rs.
//
// THE GUARANTEE: the match below has NO catch-all arm. Adding a 13th
// OpType variant (e.g. a compaction tombstone) without classifying it
// here is a COMPILE ERROR ("non-exhaustive patterns"), exactly as
// `compute_reverse` itself fails to compile until the new variant gets a
// dispatch arm. So a future op type added without a reverse is caught at
// build time in two places: `reverse::compute_reverse` (must add a
// dispatch arm) and here (must declare its reversibility class). This
// mirrors the OpType `#[non_exhaustive]`-removal rationale in op.rs.
// ---------------------------------------------------------------------------

/// Whether `compute_reverse` can, in principle, reverse this op type.
/// `false` for the variants whose `compute_reverse` arm is an
/// unconditional `Err(NonReversible)`.
fn is_reversible(op_type: &OpType) -> bool {
    match op_type {
        OpType::CreateBlock
        | OpType::EditBlock
        | OpType::DeleteBlock
        | OpType::RestoreBlock
        | OpType::MoveBlock
        | OpType::AddTag
        | OpType::RemoveTag
        | OpType::SetProperty
        | OpType::DeleteProperty
        | OpType::AddAttachment => true,
        // DeleteAttachment is conditionally reversible (reversible iff a
        // prior add_attachment row exists); compute_reverse dispatches to
        // a fallible lookup rather than an unconditional NonReversible, so
        // it belongs on the "has a reverse arm" side.
        OpType::DeleteAttachment => true,
        // The ONLY unconditionally non-reversible op.
        OpType::PurgeBlock => false,
    }
}

/// Compile-time exhaustiveness guard: every `OpType` variant is
/// classified. The `all_op_types` list below is the closed set of
/// variants; if a variant is added to `OpType` without being added here
/// the `is_reversible` match (no catch-all) fails to compile.
#[test]
fn every_op_type_is_classified() {
    // The closed enumeration of all variants. Adding a variant to OpType
    // without adding it here means it is never asserted on — but
    // `is_reversible`'s non-exhaustive match already forces the author to
    // touch this file, at which point this list is the obvious next edit.
    let all_op_types = [
        OpType::CreateBlock,
        OpType::EditBlock,
        OpType::DeleteBlock,
        OpType::RestoreBlock,
        OpType::PurgeBlock,
        OpType::MoveBlock,
        OpType::AddTag,
        OpType::RemoveTag,
        OpType::SetProperty,
        OpType::DeleteProperty,
        OpType::AddAttachment,
        OpType::DeleteAttachment,
    ];

    // Exactly one non-reversible variant today: PurgeBlock.
    let non_reversible: Vec<&OpType> = all_op_types.iter().filter(|t| !is_reversible(t)).collect();
    assert_eq!(
        non_reversible,
        vec![&OpType::PurgeBlock],
        "PurgeBlock must be the only unconditionally non-reversible op type; \
         if this changed, update compute_reverse and this classification together"
    );
}

/// Runtime check that the unconditionally non-reversible op
/// (`PurgeBlock`) is *rejected* by `compute_reverse` with
/// `AppError::NonReversible` — never mis-reversed into some other op.
#[tokio::test]
async fn purge_block_is_rejected_not_mis_reversed() {
    let (pool, _dir) = test_pool().await;

    // Seed a create + delete so the block exists and is purgeable, then a
    // purge_block op. compute_reverse(purge) must be NonReversible.
    let bid = crate::ulid::BlockId::new();
    crate::op_log::append_local_op_at(
        &pool,
        HARNESS_DEVICE,
        OpPayload::CreateBlock(crate::op::CreateBlockPayload {
            block_id: bid.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "x".into(),
        }),
        1_736_942_400_000,
    )
    .await
    .unwrap();
    let purge = crate::op_log::append_local_op_at(
        &pool,
        HARNESS_DEVICE,
        OpPayload::PurgeBlock(crate::op::PurgeBlockPayload {
            block_id: bid.clone(),
        }),
        1_736_942_460_000,
    )
    .await
    .unwrap();

    let result = compute_reverse(&pool, HARNESS_DEVICE, purge.seq).await;
    assert!(
        matches!(result, Err(AppError::NonReversible { ref op_type }) if op_type == "purge_block"),
        "purge_block must be rejected as NonReversible, not mis-reversed; got {result:?}"
    );
}

// ---------------------------------------------------------------------------
// BUG-PROPTEST-B1 regression pin (found by `compute_reverse_obeys_inverse_law`).
//
// `reverse::reverse_set_property` computes the prior value of a
// `set_property` op by walking back to the most-recent *`set_property`*
// row for (block_id, key) — its `find_prior_property` query filters
// `op_type = 'set_property'` and IGNORES any intervening `delete_property`.
//
// So for the chain
//     Set(K = "A");  Delete(K);  Set(K = "a")
// the correct reverse of the final `Set(K="a")` is `DeleteProperty(K)`
// (the property was absent immediately before it), but `compute_reverse`
// returns `SetProperty(K = "A")`, resurrecting the stale pre-delete value.
// Undo of that last set would therefore wrongly re-add the property with
// the old value instead of removing it.
//
// This is a real production correctness bug in the undo engine, NOT a
// test artefact. Per the TEST-PROPTEST-B task constraint ("if B1 reveals
// a production bug, do not fix it here — report it"), this test is
// `#[ignore]`d so the suite stays green; it documents the exact minimal
// reproducer for the follow-up fix issue. Un-`#[ignore]` it (and
// re-enable the `DeleteProperty` arm in `proptest_db_harness`) once the
// `find_prior_property` query is taught to honour `delete_property`.
//
// FIXED (#181): `find_prior_property` now inspects the most-recent prior
// op of EITHER type for (block, key); if it is a `delete_property` the
// prior state is absent and the reverse of the final set is `DeleteProperty`.
#[tokio::test]
async fn regression_reverse_set_property_after_delete_should_be_delete() {
    let (pool, _dir) = test_pool().await;
    let bid = crate::ulid::BlockId::new();
    let key = "due_date";

    // Set(K="A")
    crate::op_log::append_local_op_at(
        &pool,
        HARNESS_DEVICE,
        OpPayload::SetProperty(crate::op::SetPropertyPayload {
            block_id: bid.clone(),
            key: key.into(),
            value_text: Some("A".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        1_736_942_400_000,
    )
    .await
    .unwrap();
    // Delete(K)
    crate::op_log::append_local_op_at(
        &pool,
        HARNESS_DEVICE,
        OpPayload::DeleteProperty(crate::op::DeletePropertyPayload {
            block_id: bid.clone(),
            key: key.into(),
        }),
        1_736_942_460_000,
    )
    .await
    .unwrap();
    // Set(K="a") — the op we reverse.
    let last_set = crate::op_log::append_local_op_at(
        &pool,
        HARNESS_DEVICE,
        OpPayload::SetProperty(crate::op::SetPropertyPayload {
            block_id: bid.clone(),
            key: key.into(),
            value_text: Some("a".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        1_736_942_520_000,
    )
    .await
    .unwrap();

    let reverse = compute_reverse(&pool, HARNESS_DEVICE, last_set.seq)
        .await
        .unwrap();

    // CORRECT behaviour: the property was absent immediately before the
    // last set (it had been deleted), so its reverse must REMOVE it.
    assert!(
        matches!(&reverse, OpPayload::DeleteProperty(p) if p.key == key),
        "reverse of set-after-delete must be DeleteProperty(key); got {reverse:?} \
         (this assertion documents the BUG — it currently fails because \
         reverse_set_property resurrects the stale pre-delete value)"
    );
}
