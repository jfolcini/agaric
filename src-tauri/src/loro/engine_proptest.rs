//! Randomised `LoroEngine` regression streams.
//!
//! Asserts:
//!
//! * Single-author streams: every well-formed op succeeds against a
//!   fresh engine, and the post-apply read-back matches the typed
//!   input. Catches engine-side regressions where an op's effect is
//!   lost / corrupted in `LoroEngine::apply_*`.
//! * Two-device streams: two engines that imported each other's
//!   exported snapshots converge to the same read-back state across
//!   every block_id touched + every property key written. Catches
//!   `loro` upstream regressions in `import` / `export_snapshot` /
//!   per-key LWW behaviour. Load-bearing surface for the sync trust
//!   assumption: if two `LoroEngine` instances diverge after mutual
//!   snapshot exchange, the sync apply path is wrong.
//!
//! ## Configuration choices
//!
//! - **256 cases** (proptest default) — empirically <1 s wall-clock on
//!   the test box for the mixed-op stream, comfortably under the
//!   30 s budget.  Tuning down only if a future engine change pushes
//!   per-case work into the millisecond range.
//! - **Stream length 1..=50** — long enough to interleave
//!   create/edit/delete/move/set_property over a small block pool;
//!   short enough that proptest's shrinker can produce a
//!   human-readable counter-example.
//! - **3-block pool** — exercises the repeat-block-id path (multiple
//!   ops landing on the same id) without ballooning the search space.
//!   Production sees long-lived block ids re-edited many times, so
//!   the small pool is more realistic than a fresh-id-per-op model.
//!
//! Failing seeds auto-save under `proptest-regressions/loro/` per
//! proptest's default behaviour.

use proptest::prelude::*;

use crate::loro::engine::{LoroEngine, PropertyValue};
use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    SetPropertyPayload,
};
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Block-id pool.
//
// Three fixed 26-char Crockford-base32 ULIDs.  A small pool exercises
// the repeat-block-id path (the realistic production shape — a block
// is created once and edited many times).  All literals pass
// `BlockId::from_string` validation.
// ---------------------------------------------------------------------------

const BLOCK_ID_POOL: &[&str] = &[
    "01HZ00000000000000000000AB",
    "01HZ00000000000000000000CD",
    "01HZ00000000000000000000EF",
];

/// One of [`BLOCK_ID_POOL`] uniformly at random.  Keeping the pool
/// tiny is intentional — see module docstring "3-block pool".
fn block_id_strategy() -> impl Strategy<Value = String> {
    proptest::sample::select(BLOCK_ID_POOL).prop_map(std::string::ToString::to_string)
}

// ---------------------------------------------------------------------------
// Op-payload strategies.  Each generates ONE typed op against a given
// block id; the stream-level strategy handles invariant maintenance
// (e.g. "Edit only after Create").
// ---------------------------------------------------------------------------

/// Short ASCII-printable content snippet, 0..=20 chars.  Bounded so
/// `EditBlock`'s `to_text` stays manageable in shrinker output.  We
/// avoid arbitrary Unicode here on purpose — the engine's
/// `apply_edit_via_diff_splice` is unicode-scalar-correct (validated
/// in `loro::tests`), and adding a Unicode axis to the shrinker would
/// balloon counter-example size without adding regression value.
fn content_strategy() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9 ]{0,20}".prop_map(|s| s)
}

/// Property key — a short alphabetic identifier, matching the shape
/// of production property keys (`status`, `priority`, `due_date`, …).
fn prop_key_strategy() -> impl Strategy<Value = String> {
    proptest::sample::select(vec!["status", "priority", "due_date", "owner"])
        .prop_map(std::string::ToString::to_string)
}

/// Short property value text.  Bounded as `content_strategy` — see
/// rationale there.
fn prop_value_strategy() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9]{0,10}".prop_map(|s| s)
}

/// Position scalar.  Deliberately bounded — production positions are
/// typically small int reorder anchors, and unbounded i64 would
/// shrink to extremal values that don't add coverage.
fn position_strategy() -> impl Strategy<Value = i64> {
    -16i64..16
}

// ---------------------------------------------------------------------------
// Stream-level generation.
//
// Maintains the basic CRDT op-stream invariants required by
// `LoroEngine`'s validation layer:
//
// 1. A block must be created (CreateBlock) before any Edit / Delete /
//    Move / SetProperty against it.  The engine returns
//    `AppError::Validation("not found")` otherwise — a legitimate
//    "engine refused a malformed input" error, NOT an engine-side
//    correctness failure.
// 2. Within a stream, a CreateBlock for a given id must not collide
//    with an existing CreateBlock for the same id (engine returns
//    `insert_container` slot-already-populated error).
//
// Both invariants are also enforced upstream (the materializer
// rejects malformed ops before they reach the engine), so the
// generator is modelling the production invariant — not papering
// over an engine bug.
// ---------------------------------------------------------------------------

/// What kind of op the stream generator will emit at each step.
/// Used as an intermediate representation so the generator can
/// resolve the actual block_id + content based on the running
/// `created_blocks` set at apply time.
#[derive(Debug, Clone)]
enum OpKind {
    Create {
        block_id: String,
        content: String,
    },
    Edit {
        index: usize, // index into the created_blocks vector at apply time
        new_content: String,
    },
    Delete {
        index: usize,
    },
    Move {
        index: usize,
        position: i64,
    },
    SetProperty {
        index: usize,
        key: String,
        value: String,
    },
}

/// Generator for a single [`OpKind`] step.  The probability mix
/// (40 % create, 60 % spread across the four mutators) keeps streams
/// from being all-create — once the pool warms up the shrinker can
/// favour mutator-heavy streams which are where engine bugs would
/// first surface.
fn op_kind_strategy() -> impl Strategy<Value = OpKind> {
    prop_oneof![
        4 => (block_id_strategy(), content_strategy())
            .prop_map(|(block_id, content)| OpKind::Create { block_id, content }),
        2 => (any::<usize>(), content_strategy())
            .prop_map(|(index, new_content)| OpKind::Edit { index, new_content }),
        1 => any::<usize>().prop_map(|index| OpKind::Delete { index }),
        1 => (any::<usize>(), position_strategy())
            .prop_map(|(index, position)| OpKind::Move { index, position }),
        2 => (any::<usize>(), prop_key_strategy(), prop_value_strategy())
            .prop_map(|(index, key, value)| OpKind::SetProperty { index, key, value }),
    ]
}

/// A stream of op-kind sketches.  The realised stream (with concrete
/// block_ids, no-Edit-before-Create) is computed at apply time by
/// the test bodies from the running `created_blocks` set.
fn op_stream_strategy(
    len_range: std::ops::RangeInclusive<usize>,
) -> impl Strategy<Value = Vec<OpKind>> {
    proptest::collection::vec(op_kind_strategy(), len_range)
}

/// Build a typed `OpPayload` for an `OpKind` resolved against the
/// current created-blocks set.  Returns `None` if the op has no valid
/// target (e.g. an Edit when no blocks exist yet); the caller skips
/// these so the stream stays well-formed without rejecting whole
/// proptest cases.
fn resolve_op(kind: &OpKind, created: &[String], deleted: &[String]) -> Option<OpPayload> {
    let pick_alive = |index: usize| -> Option<&String> {
        // Only consider blocks that exist AND have not been deleted.
        // Mirrors the materializer boundary's "skip ops against
        // deleted blocks" rule so stream semantics align with what
        // the engine ever sees in production.
        let alive: Vec<&String> = created.iter().filter(|id| !deleted.contains(id)).collect();
        if alive.is_empty() {
            return None;
        }
        Some(alive[index % alive.len()])
    };

    match kind {
        OpKind::Create { block_id, content } => {
            // CreateBlock must not collide with an existing block.
            if created.contains(block_id) {
                return None;
            }
            Some(OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                index: None,
                content: content.clone(),
            }))
        }
        OpKind::Edit { index, new_content } => {
            let target = pick_alive(*index)?;
            Some(OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::from_trusted(target),
                to_text: new_content.clone(),
                prev_edit: None,
            }))
        }
        OpKind::Delete { index } => {
            let target = pick_alive(*index)?;
            Some(OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::from_trusted(target),
            }))
        }
        OpKind::Move { index, position } => {
            let target = pick_alive(*index)?;
            Some(OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::from_trusted(target),
                new_parent_id: None,
                new_position: *position,
                new_index: None,
            }))
        }
        OpKind::SetProperty { index, key, value } => {
            let target = pick_alive(*index)?;
            Some(OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::from_trusted(target),
                key: key.clone(),
                value_text: Some(value.clone()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
            }))
        }
    }
}

/// Drive one op onto the engine. Mirrors the per-op-type dispatch arm
/// in `merge::engine_apply`. Returns `Ok(())` on success; the proptest
/// body asserts no errors fire (well-formed streams must always
/// succeed against a fresh engine).
fn apply_to_engine(engine: &mut LoroEngine, op: &OpPayload) -> Result<(), crate::error::AppError> {
    match op {
        OpPayload::CreateBlock(p) => {
            let parent = p.parent_id.as_ref().map(BlockId::as_str);
            let position = p.position.unwrap_or(0);
            engine.apply_create_block(
                p.block_id.as_str(),
                &p.block_type,
                &p.content,
                parent,
                position,
            )?;
        }
        OpPayload::EditBlock(p) => {
            engine.apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)?;
        }
        OpPayload::DeleteBlock(p) => {
            engine.apply_delete_block(p.block_id.as_str(), "2025-01-15T12:00:00Z")?;
        }
        OpPayload::MoveBlock(p) => {
            let parent = p.new_parent_id.as_ref().map(BlockId::as_str);
            engine.apply_move_block(p.block_id.as_str(), parent, p.new_position)?;
        }
        OpPayload::SetProperty(p) => {
            let value: Option<String> = p
                .value_text
                .clone()
                .or_else(|| p.value_num.map(|n| n.to_string()))
                .or_else(|| p.value_date.clone())
                .or_else(|| p.value_ref.as_ref().map(|b| b.as_str().to_owned()))
                .or_else(|| p.value_bool.map(|b| b.to_string()));
            engine.apply_set_property(p.block_id.as_str(), &p.key, value.as_deref())?;
        }
        // The proptest generators only emit the five supported op
        // variants — any other variant is unreachable here.
        _ => {}
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// proptest cases.
//
// Each case generates a stream, drives it onto a fresh engine, and
// asserts every applied op succeeds.  The "fresh engine per case"
// stance is deliberate — it isolates failures to a single stream, so
// the shrinker's minimised counter-example is also the minimised
// reproduction script.
// ---------------------------------------------------------------------------

proptest! {
    /// Sanity check: single-author CreateBlock-only streams must apply
    /// cleanly and read back with the content the stream supplied.
    /// This is the floor — if this test ever flakes, every richer test
    /// below is suspect.
    #[test]
    fn single_author_create_only_stream_apply_succeeds(
        // Up to 8 creates over the 3-block pool.  Most cases will hit
        // the "duplicate create" guard in `resolve_op` and skip; that's
        // fine — what we care about is the create-succeeded path.
        block_ids in proptest::collection::vec(block_id_strategy(), 1..=8),
    ) {
        let mut engine = LoroEngine::with_peer_id("DEV-PROPTEST")
            .expect("with_peer_id");
        let mut created: Vec<String> = Vec::new();

        for block_id in &block_ids {
            let kind = OpKind::Create {
                block_id: block_id.clone(),
                content: "hello".into(),
            };
            let Some(op) = resolve_op(&kind, &created, &[]) else { continue };

            apply_to_engine(&mut engine, &op).expect("apply create on fresh id");

            // Read-back equality: the engine must hold the just-created
            // block with the typed content.
            let snap = engine
                .read_block(block_id)
                .expect("read")
                .expect("block must exist post-create");
            prop_assert_eq!(snap.content, "hello");

            created.push(block_id.clone());
        }
    }

    /// #400: random NEW-SCHEME (0-based slot) create/move streams must keep the
    /// engine's projected dense `position` a contiguous `1..=N` permutation per
    /// parent. The mixed-op stream above only emits legacy position-based ops
    /// (`index`/`new_index = None`), so this is the only property coverage of
    /// `apply_create_block_at` / `apply_move_block_to` and their live-slot math.
    #[test]
    fn new_scheme_slot_stream_keeps_dense_positions_contiguous(
        actions in proptest::collection::vec((proptest::bool::ANY, 0usize..6usize), 1..=40),
    ) {
        let mut engine = LoroEngine::with_peer_id("DEV-PROP-SLOT").expect("peer");
        engine
            .apply_create_block_at("P", "page", "P", None, 0)
            .expect("root");
        let mut ids: Vec<String> = Vec::new();
        let mut counter = 0u32;

        for (is_create, slot) in &actions {
            if *is_create || ids.is_empty() {
                let id = format!("B{counter:04}");
                counter += 1;
                let s = (*slot).min(ids.len()); // clamp into a valid insert slot
                engine
                    .apply_create_block_at(&id, "content", "", Some("P"), s)
                    .expect("create_at");
                ids.push(id);
            } else {
                let s = *slot % ids.len();
                let target = ids[s].clone();
                engine
                    .apply_move_block_to(&target, Some("P"), s)
                    .expect("move_to");
            }

            // Invariant: the live children's dense ranks are exactly {1..=N}.
            let order = engine.list_children_walk("P").expect("walk");
            let mut positions: Vec<i64> = order
                .iter()
                .map(|id| {
                    engine
                        .read_block(id)
                        .expect("read")
                        .expect("alive")
                        .position
                })
                .collect();
            positions.sort_unstable();
            let expected: Vec<i64> = (1..=i64::try_from(order.len()).unwrap()).collect();
            prop_assert_eq!(positions, expected);
        }
    }

    /// Single-author MIXED-OP streams (Create + Edit + Delete + Move +
    /// SetProperty over the 3-block pool).  Every well-formed op must
    /// apply without error against a fresh engine — the resolver's
    /// invariants (Create-before-mutate, no duplicate Create, no
    /// Edit-on-deleted) make every emitted op well-formed.
    ///
    /// proptest's shrinker gives us thousands of distinct streams per
    /// CI run; any apply-side failure here surfaces an engine
    /// regression as a minimal reproducer.
    #[test]
    fn single_author_mixed_op_stream_apply_succeeds(
        ops in op_stream_strategy(1..=50),
    ) {
        let mut engine = LoroEngine::with_peer_id("DEV-PROPTEST")
            .expect("with_peer_id");
        let mut created: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();

        for kind in &ops {
            let Some(op) = resolve_op(kind, &created, &deleted) else { continue };

            // Headline assertion: well-formed ops must apply cleanly.
            // A failure here is an engine bug (or a resolver bug if
            // the op turned out to be ill-formed).
            apply_to_engine(&mut engine, &op)
                .map_err(|e| TestCaseError::fail(format!("apply failed: {e}")))?;

            // Read-back assertions: verify the engine reflects the op's
            // effect immediately after apply.  Mirrors the pattern from
            // `single_author_create_only_stream_apply_succeeds`.
            match &op {
                OpPayload::CreateBlock(p) => {
                    created.push(p.block_id.as_str().to_string());
                }
                OpPayload::EditBlock(p) => {
                    // The engine must hold the text just written by the edit.
                    let snap = engine
                        .read_block(p.block_id.as_str())
                        .map_err(|e| TestCaseError::fail(format!("read_block after edit failed: {e}")))?
                        .ok_or_else(|| TestCaseError::fail(
                            format!("block {} absent after EditBlock", p.block_id.as_str())
                        ))?;
                    prop_assert_eq!(
                        snap.content, p.to_text.clone(),
                        "EditBlock must update block content in the engine"
                    );
                }
                OpPayload::SetProperty(p) => {
                    // The engine must hold the value just written.
                    let stored = engine
                        .read_property_typed(p.block_id.as_str(), &p.key)
                        .map_err(|e| TestCaseError::fail(format!("read_property_typed after set failed: {e}")))?;
                    // The generators only ever emit `value_text` (a string),
                    // which `apply_set_property` stores as `PropertyValue::Str`.
                    let expected: Option<String> = p
                        .value_text
                        .clone()
                        .or_else(|| p.value_num.map(|n| n.to_string()))
                        .or_else(|| p.value_date.clone())
                        .or_else(|| p.value_ref.as_ref().map(|b| b.as_str().to_owned()))
                        .or_else(|| p.value_bool.map(|b| b.to_string()));
                    prop_assert_eq!(
                        stored,
                        expected.map(PropertyValue::Str),
                        "SetProperty must persist the value in the engine"
                    );
                }
                OpPayload::MoveBlock(p) => {
                    // After a move the block must still be present (not deleted).
                    let snap = engine
                        .read_block(p.block_id.as_str())
                        .map_err(|e| TestCaseError::fail(format!("read_block after move failed: {e}")))?;
                    prop_assert!(
                        snap.is_some(),
                        "MoveBlock: block {} must still exist in engine after move",
                        p.block_id.as_str()
                    );
                }
                OpPayload::DeleteBlock(p) => {
                    deleted.push(p.block_id.as_str().to_string());
                    // The engine must mark the block as deleted.
                    let is_deleted = engine
                        .read_deleted(p.block_id.as_str())
                        .map_err(|e| TestCaseError::fail(format!("read_deleted after delete failed: {e}")))?;
                    prop_assert!(
                        is_deleted,
                        "DeleteBlock: block {} must be marked deleted in engine",
                        p.block_id.as_str()
                    );
                }
                _ => {}
            }
        }
    }
}

// ===========================================================================
// Two-device concurrent-merge proptest streams.
//
// The single-author streams above prove the engine's apply path
// doesn't drop or corrupt ops. What they CANNOT catch is
// divergence-on-merge — the failure mode where two devices, having
// both applied valid op streams independently, produce different
// states after exchanging snapshots. This sub-module starts a fresh
// `LoroEngine` per device with distinct peer ids, runs
// independently-generated op streams on each, mutually `import`
// snapshots, and asserts both engines read back identical state
// across a representative key set. Load-bearing CRDT correctness
// check for the sync apply path.
//
// ## Scope: Loro-side convergence only
//
// We assert "device A's reads == device B's reads after sync" for
// every key the streams touched.  We do NOT compare against any
// external oracle.  The two-device proptest's value-add is randomised
// search for Loro-only bugs: container-shape mismatches across
// import, non-deterministic LWW outcomes, op-log merge errors.
// ===========================================================================

#[cfg(test)]
mod two_device {
    use super::*;

    /// Per-case proptest budget.  Matches the single-author default.
    /// Empirically each two-device test runs in <2 s wall-clock at 256
    /// cases on the dev box (4 tests × ~1.7 s each), comfortably under
    /// the 30 s budget.
    const TWO_DEVICE_CASES: u32 = 256;

    /// Apply a stream of [`OpKind`] sketches to `engine`, maintaining
    /// the same well-formedness invariants as the single-author
    /// dispatch (Create-before-mutate, no duplicate Create, no
    /// Edit/Delete/Move/SetProperty on a deleted block — see
    /// [`resolve_op`]).  Returns the set of block_ids that ended up
    /// created (so the comparator can read them back).
    pub(super) fn apply_stream(engine: &mut LoroEngine, ops: &[OpKind]) -> Vec<String> {
        let mut created: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();

        for kind in ops {
            let Some(op) = resolve_op(kind, &created, &deleted) else {
                continue;
            };

            // Errors are ignored on the apply side (the resolver guards
            // against most of them already) and surface as convergence
            // drift in the post-sync compare.
            let _ = apply_to_engine(engine, &op);

            match &op {
                OpPayload::CreateBlock(p) => {
                    created.push(p.block_id.as_str().to_string());
                }
                OpPayload::DeleteBlock(p) => {
                    deleted.push(p.block_id.as_str().to_string());
                }
                _ => {}
            }
        }

        created
    }

    /// Mutual snapshot exchange — A imports B's state, B imports A's.
    /// After this call both engines have all ops from both sides and
    /// must read back identical state across every shared key.
    fn sync_engines(a: &mut LoroEngine, b: &mut LoroEngine) {
        let a_bytes = a.export_snapshot().expect("export A");
        let b_bytes = b.export_snapshot().expect("export B");
        a.import(&b_bytes).expect("import B->A");
        b.import(&a_bytes).expect("import A->B");
    }

    /// Compare reads of `block_id` across both engines.  Returns Ok if
    /// both engines agree (either both see the block with identical
    /// fields, or both see no block); returns the divergence detail in
    /// `Err` for the prop_assert message.
    pub(super) fn compare_block_reads(
        a: &LoroEngine,
        b: &LoroEngine,
        block_id: &str,
    ) -> Result<(), String> {
        let a_block = a
            .read_block(block_id)
            .map_err(|e| format!("A read_block({block_id}): {e}"))?;
        let b_block = b
            .read_block(block_id)
            .map_err(|e| format!("B read_block({block_id}): {e}"))?;
        if a_block != b_block {
            return Err(format!(
                "block {block_id} diverged: A={a_block:?}, B={b_block:?}"
            ));
        }
        // If both saw the block, also check the deleted-flag read.
        if a_block.is_some() {
            let a_del = a
                .read_deleted(block_id)
                .map_err(|e| format!("A read_deleted({block_id}): {e}"))?;
            let b_del = b
                .read_deleted(block_id)
                .map_err(|e| format!("B read_deleted({block_id}): {e}"))?;
            if a_del != b_del {
                return Err(format!(
                    "block {block_id} deleted flag diverged: A={a_del}, B={b_del}"
                ));
            }
        }
        Ok(())
    }

    /// Compare a property read across both engines.  `Ok(None)` and
    /// `Ok(Some(_))` shapes must match exactly.
    pub(super) fn compare_property_reads(
        a: &LoroEngine,
        b: &LoroEngine,
        block_id: &str,
        key: &str,
    ) -> Result<(), String> {
        let a_val = a
            .read_property_typed(block_id, key)
            .map_err(|e| format!("A read_property_typed({block_id}, {key}): {e}"))?;
        let b_val = b
            .read_property_typed(block_id, key)
            .map_err(|e| format!("B read_property_typed({block_id}, {key}): {e}"))?;
        if a_val != b_val {
            return Err(format!(
                "property {block_id}.{key} diverged: A={a_val:?}, B={b_val:?}"
            ));
        }
        Ok(())
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: TWO_DEVICE_CASES,
            .. ProptestConfig::default()
        })]

        /// Test 1 — concurrent CreateBlock streams.
        ///
        /// Device A creates some subset of the 3-block pool, device B
        /// creates an independently-chosen subset (overlap is allowed
        /// and exercises the "both devices created the same id"
        /// CRDT path).  After mutual sync both engines must agree on
        /// every block in the union of their created sets.
        ///
        /// Loro semantics for "both devices `insert_container(K, ...)`
        /// against the same key with no prior sync": the LoroMap LWW
        /// tiebreak picks one container as the survivor, the other's
        /// nested writes (the inserts into the loser's `content`
        /// LoroText, the parent_id/position scalars) are dropped on
        /// the loser side.  Both engines, after sync, see the
        /// SAME survivor — which is convergence.  We assert
        /// convergence; we do NOT assert which side wins.
        #[test]
        fn two_device_concurrent_create_only_stream_loro_converges(
            a_block_ids in proptest::collection::vec(block_id_strategy(), 1..=6),
            b_block_ids in proptest::collection::vec(block_id_strategy(), 1..=6),
        ) {
            let mut engine_a = LoroEngine::with_peer_id("DEV-PROPTEST-A")
                .expect("with_peer_id A");
            let mut engine_b = LoroEngine::with_peer_id("DEV-PROPTEST-B")
                .expect("with_peer_id B");

            let a_ops: Vec<OpKind> = a_block_ids
                .iter()
                .map(|id| OpKind::Create {
                    block_id: id.clone(),
                    content: "from-A".into(),
                })
                .collect();
            let b_ops: Vec<OpKind> = b_block_ids
                .iter()
                .map(|id| OpKind::Create {
                    block_id: id.clone(),
                    content: "from-B".into(),
                })
                .collect();

            let a_created = apply_stream(&mut engine_a, &a_ops);
            let b_created = apply_stream(&mut engine_b, &b_ops);

            sync_engines(&mut engine_a, &mut engine_b);

            // Assert convergence on every block in the union.  Concurrent
            // create-on-same-id is a real CRDT case — Loro's LWW picks
            // one container (typically the higher-PeerID writer); both
            // engines must see the SAME winner.  We don't assert which.
            let mut all_ids: Vec<String> = a_created;
            all_ids.extend(b_created);
            all_ids.sort();
            all_ids.dedup();

            for id in &all_ids {
                if let Err(msg) = compare_block_reads(&engine_a, &engine_b, id) {
                    prop_assert!(false, "two-device create-only divergence: {msg}");
                }
            }
        }

        /// Test 2 — concurrent edit streams against the same block.
        ///
        /// Both devices first sync on a common seed (the block exists
        /// on both before the divergent edits start).  Then each
        /// device runs an independent stream of EditBlocks against
        /// that block.  Loro's `apply_edit_via_diff_splice` lowers
        /// each whole-content edit into a character-level RGA splice;
        /// concurrent splices interleave deterministically per Loro's
        /// CRDT rules.  After sync both engines must read back the
        /// same content.
        #[test]
        fn two_device_concurrent_edit_same_block_loro_converges(
            a_edits in proptest::collection::vec(content_strategy(), 1..=8),
            b_edits in proptest::collection::vec(content_strategy(), 1..=8),
        ) {
            let mut engine_a = LoroEngine::with_peer_id("DEV-PROPTEST-A")
                .expect("with_peer_id A");
            let mut engine_b = LoroEngine::with_peer_id("DEV-PROPTEST-B")
                .expect("with_peer_id B");

            // Common seed: both devices create the same block, then
            // exchange snapshots so the create lands on a shared
            // ancestor.  The divergent edits below have a clean LCA.
            let seed_id = BLOCK_ID_POOL[0];
            engine_a
                .apply_create_block(seed_id, "content", "seed", None, 0)
                .expect("A seed create");
            engine_b
                .apply_create_block(seed_id, "content", "seed", None, 0)
                .expect("B seed create");
            sync_engines(&mut engine_a, &mut engine_b);

            for edit in &a_edits {
                let _ = engine_a.apply_edit_via_diff_splice(seed_id, edit);
            }
            for edit in &b_edits {
                let _ = engine_b.apply_edit_via_diff_splice(seed_id, edit);
            }

            sync_engines(&mut engine_a, &mut engine_b);

            // Convergence assertion: after sync, both engines must
            // produce identical reads.  The exact merged string is
            // CRDT-determined (RGA tiebreak picks a deterministic
            // interleaving); we only assert determinism — both sides
            // must agree.
            if let Err(msg) = compare_block_reads(&engine_a, &engine_b, seed_id) {
                prop_assert!(false, "two-device edit divergence: {msg}");
            }
        }

        /// Test 3 — concurrent SetProperty against the same key.
        ///
        /// Both devices SetProperty(X, "todo_state", different values).
        /// Loro's LoroMap LWW key-write picks one value; both engines
        /// after sync must see the SAME winner.
        ///
        /// Note: Loro's LWW tiebreak is Lamport-order (peer-id +
        /// op-counter) — NOT wall-clock timestamp.  The tiebreak rule
        /// is documented in `docs/ARCHITECTURE.md` §12 "LWW resolution
        /// rule".  Convergence on each side is what kill-criterion #2
        /// actually requires.
        #[test]
        fn two_device_concurrent_set_property_loro_lww_wins(
            a_value in prop_value_strategy(),
            b_value in prop_value_strategy(),
            key in prop_key_strategy(),
        ) {
            let mut engine_a = LoroEngine::with_peer_id("DEV-PROPTEST-A")
                .expect("with_peer_id A");
            let mut engine_b = LoroEngine::with_peer_id("DEV-PROPTEST-B")
                .expect("with_peer_id B");

            let seed_id = BLOCK_ID_POOL[0];
            engine_a
                .apply_create_block(seed_id, "content", "seed", None, 0)
                .expect("A seed create");
            engine_b
                .apply_create_block(seed_id, "content", "seed", None, 0)
                .expect("B seed create");
            sync_engines(&mut engine_a, &mut engine_b);

            engine_a
                .apply_set_property(seed_id, &key, Some(&a_value))
                .expect("A set_property");
            engine_b
                .apply_set_property(seed_id, &key, Some(&b_value))
                .expect("B set_property");

            sync_engines(&mut engine_a, &mut engine_b);

            // Both engines must agree on the LWW winner.  Don't assert
            // which value won — that's a Lamport-order property of the
            // peer ids.  Just assert determinism.
            if let Err(msg) = compare_property_reads(&engine_a, &engine_b, seed_id, &key) {
                prop_assert!(false, "two-device set_property divergence: {msg}");
            }

            // Additionally, the winner must be one of the two
            // contributors (Loro never invents a third value).  This
            // catches an entire class of "LWW resolved to garbage"
            // bugs that pure equality-of-reads would miss.
            let winner = engine_a
                .read_property_typed(seed_id, &key)
                .expect("A read winner")
                .expect("property must exist after both sides wrote it");
            // Both sides write strings via `apply_set_property`, so the
            // stored winner is always a `PropertyValue::Str`.
            prop_assert!(
                winner == PropertyValue::Str(a_value.clone())
                    || winner == PropertyValue::Str(b_value.clone()),
                "LWW winner {winner:?} is neither A's {a_value:?} nor B's {b_value:?}",
            );
        }

        /// Test 4 — concurrent MoveBlock to different parents.
        ///
        /// Both devices MoveBlock(X, different parents).  Loro's
        /// per-key LWW on the `parent_id` slot picks one parent; both
        /// engines must converge on the same value.
        #[test]
        fn two_device_concurrent_move_loro_lww_wins(
            a_pos in position_strategy(),
            b_pos in position_strategy(),
        ) {
            let mut engine_a = LoroEngine::with_peer_id("DEV-PROPTEST-A")
                .expect("with_peer_id A");
            let mut engine_b = LoroEngine::with_peer_id("DEV-PROPTEST-B")
                .expect("with_peer_id B");

            // Seed: all three pool blocks exist on both peers.  A and
            // B will reparent BLOCK_ID_POOL[2] to different parents
            // (BLOCK_ID_POOL[0] vs BLOCK_ID_POOL[1]).
            for seed_id in BLOCK_ID_POOL {
                engine_a
                    .apply_create_block(seed_id, "content", "seed", None, 0)
                    .expect("A seed");
                engine_b
                    .apply_create_block(seed_id, "content", "seed", None, 0)
                    .expect("B seed");
            }
            sync_engines(&mut engine_a, &mut engine_b);

            let target = BLOCK_ID_POOL[2];
            let parent_a = BLOCK_ID_POOL[0];
            let parent_b = BLOCK_ID_POOL[1];

            engine_a
                .apply_move_block(target, Some(parent_a), a_pos)
                .expect("A move");
            engine_b
                .apply_move_block(target, Some(parent_b), b_pos)
                .expect("B move");

            sync_engines(&mut engine_a, &mut engine_b);

            // Convergence: both engines must see the same parent +
            // position after sync.
            if let Err(msg) = compare_block_reads(&engine_a, &engine_b, target) {
                prop_assert!(false, "two-device move divergence: {msg}");
            }

            // Winner must be one of the two reparent destinations
            // (Loro's LWW tiebreak per-key resolves parent_id and
            // position INDEPENDENTLY — the position can come from one
            // peer while the parent_id comes from the other, since
            // they're separate map keys.  We assert the parent is one
            // of the two contenders; we don't constrain position
            // relative to parent because cross-key independence is
            // documented Loro behaviour, not a bug).
            let parent = engine_a
                .read_parent(target)
                .expect("read parent")
                .expect("parent must be set after both moves");
            prop_assert!(
                parent == parent_a || parent == parent_b,
                "move winner {parent:?} is neither A's {parent_a:?} nor B's {parent_b:?}",
            );
        }
    }
}

// ===========================================================================
// N-way (3+ device) concurrent-merge proptest streams.
//
// The `two_device` module above proves PAIRWISE convergence: two
// engines that exchange snapshots agree. What it CANNOT prove is that
// merge is ASSOCIATIVE and COMMUTATIVE across an arbitrary device
// topology — that K>=3 engines, each with their own independent op
// stream, all reach the SAME state regardless of the order in which
// deltas are exchanged (ring vs star vs all-to-all). Production sync
// is N-way (a journal syncs across phone + laptop + desktop), so the
// 2-device assumption is not enough; this module closes that gap.
//
// ## Why full-snapshot import is sound for order-independence
//
// Each device exports a complete state snapshot (`export_snapshot`),
// and Loro's `import` is idempotent + commutative over the op-log:
// importing the same snapshot twice, or in any order, contributes the
// same set of ops to the merged DAG. So "import everyone's snapshot"
// in ANY topology is the join of all op-logs, and Loro's deterministic
// CRDT replay over that join is what we assert is identical across all
// peers AND across topologies. A failure here is a genuine
// associativity/commutativity bug in the sync apply path.
//
// We REUSE the two-device harness wholesale: `apply_stream` (drives an
// `OpKind` stream onto one engine), `compare_block_reads` /
// `compare_property_reads` (the convergence comparators), the
// `op_stream_strategy` / `block_id_strategy` / `prop_key_strategy`
// generators, and `export_snapshot` / `import`. No new harness, no new
// assertion.
// ===========================================================================

#[cfg(test)]
mod n_way {
    use super::two_device::{apply_stream, compare_block_reads, compare_property_reads};
    use super::*;

    /// Per-case budget for the single-topology all-to-all test. Matched
    /// to `TWO_DEVICE_CASES` (256): one all-to-all sweep per case is a
    /// small multiple of a two-device case, so CI runtime stays in line
    /// with the surrounding two-device suite (~2 s/test at 256 cases).
    const N_WAY_CASES: u32 = 256;

    /// Per-case budget for the topology-independence test. Lower than
    /// `N_WAY_CASES` because each case builds the K peers THREE times and
    /// merges them three ways (all-to-all + an O(K^2) ring loop + star),
    /// then runs cross-topology compares — ~3-4x the per-case work of the
    /// single-topology test. 96 cases keeps it well under the 30 s budget
    /// while still exercising hundreds of distinct K-peer interleavings.
    const N_WAY_TOPOLOGY_CASES: u32 = 96;

    /// Drive `imports` (one snapshot per peer, including this peer's own
    /// already-folded-in state, which is a harmless no-op re-import)
    /// into `engine` in the supplied order. The order is varied per
    /// topology to prove order-independence.
    fn import_all(engine: &mut LoroEngine, snapshots: &[Vec<u8>]) {
        for snap in snapshots {
            engine.import(snap).expect("import peer snapshot");
        }
    }

    /// Build K engines with distinct peer ids and run one independent
    /// `OpKind` stream on each. Returns the engines plus the union of
    /// every created block id (so the comparators know what to read
    /// back). REUSES `apply_stream` per device.
    fn build_peers(streams: &[Vec<OpKind>]) -> (Vec<LoroEngine>, Vec<String>) {
        let mut engines: Vec<LoroEngine> = Vec::with_capacity(streams.len());
        let mut all_ids: Vec<String> = Vec::new();

        for (i, stream) in streams.iter().enumerate() {
            // Distinct, deterministic peer ids: "DEV-PROP-NWAY-00", etc.
            let mut engine = LoroEngine::with_peer_id(&format!("DEV-PROP-NWAY-{i:02}"))
                .expect("with_peer_id N-way");
            let created = apply_stream(&mut engine, stream);
            all_ids.extend(created);
            engines.push(engine);
        }

        all_ids.sort();
        all_ids.dedup();
        (engines, all_ids)
    }

    /// Assert every engine in `engines` reads back identically for every
    /// id in `ids` and every property key in `prop_key_strategy`'s set.
    /// REUSES `compare_block_reads` / `compare_property_reads` against
    /// `engines[0]` as the reference peer (transitive equality: if all
    /// agree with peer 0, all agree with each other).
    fn assert_converged(engines: &[LoroEngine], ids: &[String]) -> Result<(), String> {
        // The 4 keys the SetProperty generator can emit (see
        // `prop_key_strategy`). Reading a never-set key returns
        // `Ok(None)` on every peer, so checking the whole set is safe
        // and catches property-LWW divergence across peers.
        const PROP_KEYS: &[&str] = &["status", "priority", "due_date", "owner"];

        let reference = &engines[0];
        for peer in &engines[1..] {
            for id in ids {
                compare_block_reads(reference, peer, id)?;
                for key in PROP_KEYS {
                    compare_property_reads(reference, peer, id, key)?;
                }
            }
        }
        Ok(())
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: N_WAY_CASES,
            .. ProptestConfig::default()
        })]

        /// Test 1 — N-way merge convergence (all-to-all topology).
        ///
        /// Generate K devices (K in 3..=5), each running its OWN
        /// independently-generated mixed-op stream (the same
        /// `op_stream_strategy` the two-device tests use). Then every
        /// peer imports every other peer's snapshot (all-to-all). After
        /// the sweep all K engines must read back identical state across
        /// every touched block id + property key.
        ///
        /// This is the headline N-way property: independent concurrent
        /// authoring on 3..=5 peers converges to one agreed state. A
        /// failure is a real CRDT merge bug invisible to the 2-device
        /// matrix (which can't exhibit 3-way interleavings).
        #[test]
        fn n_way_concurrent_mixed_streams_all_to_all_converges(
            streams in proptest::collection::vec(op_stream_strategy(1..=30), 3..=5),
        ) {
            let (mut engines, all_ids) = build_peers(&streams);

            // All-to-all: snapshot every peer ONCE (pre-merge state),
            // then have every peer import every snapshot. Because each
            // snapshot is the peer's INDEPENDENT pre-merge state, this
            // is the full join of all op-logs on every engine.
            let snapshots: Vec<Vec<u8>> = engines
                .iter_mut()
                .map(|e| e.export_snapshot().expect("export peer"))
                .collect();
            for engine in &mut engines {
                import_all(engine, &snapshots);
            }

            if let Err(msg) = assert_converged(&engines, &all_ids) {
                prop_assert!(false, "N-way all-to-all divergence: {msg}");
            }
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: N_WAY_TOPOLOGY_CASES,
            .. ProptestConfig::default()
        })]

        /// Test 2 — topology-independence (ring vs star vs all-to-all).
        ///
        /// The SAME K independent streams are merged three different
        /// ways:
        ///   * ring   — peer i imports peer (i-1)'s snapshot, looped
        ///              enough times to propagate fully around the ring;
        ///   * star   — a hub peer collects all leaves, then every leaf
        ///              imports the hub;
        ///   * all-to-all — every peer imports every pre-merge snapshot.
        ///
        /// All three topologies must reach the SAME converged state on
        /// EVERY peer. This is the associativity + commutativity proof:
        /// the merge result is independent of the exchange order/route.
        /// We assert (a) each topology self-converges, and (b) the three
        /// converged states are equal to each other.
        #[test]
        fn n_way_merge_is_topology_independent(
            streams in proptest::collection::vec(op_stream_strategy(1..=20), 3..=5),
        ) {
            let k = streams.len();

            // --- All-to-all (reference topology) ---
            let (mut ata, all_ids) = build_peers(&streams);
            let ata_snaps: Vec<Vec<u8>> = ata
                .iter_mut()
                .map(|e| e.export_snapshot().expect("export ata"))
                .collect();
            for engine in &mut ata {
                import_all(engine, &ata_snaps);
            }
            if let Err(msg) = assert_converged(&ata, &all_ids) {
                prop_assert!(false, "N-way all-to-all self-divergence: {msg}");
            }

            // --- Ring: peer i pulls peer (i-1), looped K-1 times so a
            // delta originating anywhere reaches every peer. After full
            // propagation the ring must converge to the same join. ---
            let (mut ring, _) = build_peers(&streams);
            for _ in 0..k {
                for i in 0..k {
                    let prev = (i + k - 1) % k;
                    let snap = ring[prev].export_snapshot().expect("export ring prev");
                    ring[i].import(&snap).expect("ring import");
                }
            }
            if let Err(msg) = assert_converged(&ring, &all_ids) {
                prop_assert!(false, "N-way ring self-divergence: {msg}");
            }

            // --- Star: hub (peer 0) imports every leaf, then every leaf
            // imports the now-complete hub. Two-phase gather/scatter. ---
            let (mut star, _) = build_peers(&streams);
            let leaf_snaps: Vec<Vec<u8>> = (1..k)
                .map(|i| star[i].export_snapshot().expect("export star leaf"))
                .collect();
            import_all(&mut star[0], &leaf_snaps);
            let hub_snap = star[0].export_snapshot().expect("export star hub");
            for leaf in star.iter_mut().skip(1) {
                leaf.import(&hub_snap).expect("star leaf import hub");
            }
            if let Err(msg) = assert_converged(&star, &all_ids) {
                prop_assert!(false, "N-way star self-divergence: {msg}");
            }

            // --- Cross-topology equality: every peer of every topology
            // must agree with the all-to-all reference. REUSES the same
            // comparators across topology boundaries — this is the core
            // associativity+commutativity assertion. ---
            let reference = &ata[0];
            for (label, engines) in [("ring", &ring), ("star", &star)] {
                for peer in engines {
                    for id in &all_ids {
                        if let Err(msg) = compare_block_reads(reference, peer, id) {
                            prop_assert!(false, "{label} vs all-to-all block divergence: {msg}");
                        }
                        for key in ["status", "priority", "due_date", "owner"] {
                            if let Err(msg) =
                                compare_property_reads(reference, peer, id, key)
                            {
                                prop_assert!(
                                    false,
                                    "{label} vs all-to-all property divergence: {msg}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
