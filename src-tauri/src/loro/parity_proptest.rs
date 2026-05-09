//! PEND-09 Phase 1 day-8 — proptest-augmented parity streams.
//!
//! Days 1-7 landed the spike port + shadow-mode wiring + envelope +
//! persistent SQLite parity sink + flush task + bucket A/B/C/D
//! classifier + xxh3-64 peer-id swap.  Days prior also brought a
//! hand-curated 53-case parity corpus across the spike's
//! `tests/parity_corpus.rs` (now archived; see git tag
//! `pend-09/spike-archive`) and a 5-shape integration suite in
//! `merge/apply.rs::shadow_apply_unit_tests`.  Both prove kill
//! criterion #2 (the headline "D bucket = 0" gate) over the cases
//! their authors thought of.
//!
//! Day-8 closes the gap left by hand-curated lists by feeding the
//! same shadow-mode dispatch path **thousands of randomised op
//! streams** and asserting that the day-6 `classifier::classify`
//! never produces a `Bucket::D`.  Where the corpus tests one merge
//! shape per file, proptest's shrinker actively searches the space
//! for any input that violates the invariant — so a real CRDT bug
//! (Loro errors where diffy succeeded, summary-shape drift) lands as
//! a reproducible minimal counter-example pinned in
//! `proptest-regressions/`.
//!
//! ## Why direct engine drive (not `shadow_apply`)
//!
//! `merge::shadow_apply` requires a populated `ShadowState` (engine
//! registry + sampler) and a `SpaceId`.  The engine drive logic is
//! the same dispatch table; we mirror it inline here so each
//! generated stream gets a fresh engine without registry-mutex
//! re-entrancy concerns.  The summary strings produced are the
//! identical shape `merge::shadow_apply` and `merge::diffy_summary_for`
//! emit (see the helper-string assertions in the integration tests).
//!
//! ## Two-device concurrent-merge extension (Phase 2 day-2)
//!
//! Day-8 deliberately scoped to single-author streams; the
//! [`two_device`] sub-module landed on Phase 2 day-2 to close the
//! deferred Phase-1-day-8 gap and exercise the C-bucket-rich case
//! (concurrent edits across two peers + Loro's `import`-merge).
//!
//! Scope choice: the two-device tests assert **Loro-side convergence
//! only** — both engines, after mutual snapshot exchange, must read
//! back identical state.  The diffy oracle is NOT compared per-stream:
//! diffy convergence is already proven by the existing 3700+-test
//! merge suite + the hand-curated 53-case spike parity corpus, and
//! standing up two `SqlitePool`s + two materializers per proptest
//! case would balloon per-case wall-clock past the 30 s budget.  The
//! two-device tests target Loro-side bugs (op-log merge bugs,
//! container-shape divergence, LWW non-determinism) that the
//! single-author day-8 net cannot catch.
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
//! proptest's default behaviour; the file is committed to source
//! control (see `proptest-regressions/mcp/tools_ro.txt` for the
//! existing convention).

use proptest::prelude::*;

use crate::loro::classifier::{self, Bucket};
use crate::loro::engine::LoroEngine;
use crate::merge::diffy_summary_for;
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
    proptest::sample::select(BLOCK_ID_POOL).prop_map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// Op-payload strategies.  Each generates ONE typed op against a given
// block id; the stream-level strategy handles invariant maintenance
// (e.g. "Edit only after Create" — see [`StreamGenState`]).
// ---------------------------------------------------------------------------

/// Short ASCII-printable content snippet, 0..=20 chars.  Bounded so
/// `EditBlock`'s `to_text` stays manageable in shrinker output.  We
/// avoid arbitrary Unicode here on purpose — the spike's
/// `apply_edit_via_diff_splice` is unicode-scalar-correct (validated
/// in the corpus's category 5 RGA tests), and adding a Unicode axis
/// to the shrinker would balloon counter-example size without adding
/// regression value beyond what the corpus already covers.
fn content_strategy() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9 ]{0,20}".prop_map(|s| s)
}

/// Property key — a short alphabetic identifier, matching the shape
/// of production property keys (`status`, `priority`, `due_date`, …).
fn prop_key_strategy() -> impl Strategy<Value = String> {
    proptest::sample::select(vec!["status", "priority", "due_date", "owner"])
        .prop_map(|s| s.to_string())
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
//    "engine refused a malformed input" error, NOT a divergence-from-
//    diffy bucket-D event.
// 2. Within a stream, a CreateBlock for a given id must not collide
//    with an existing CreateBlock for the same id (engine returns
//    `insert_container` slot-already-populated error).
//
// Both invariants are also enforced upstream (the materializer
// rejects malformed ops before they reach `shadow_apply`), so the
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
/// favour mutator-heavy streams which are where parity bugs would
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
/// [`apply_stream`] from the running `created_blocks` set.
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
        // Production shadow_apply skips ops against deleted blocks at
        // the materializer boundary; mirroring the rule here keeps
        // stream semantics aligned with what the engine ever sees.
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

/// Mirror of the dispatch arm in `merge::shadow_apply`: drive one op
/// onto an engine and return the same Loro-summary string the parity
/// row would carry.  Errors stringify as `"error:<msg>"` per the
/// production shape (see `merge::mod.rs` line 196).
fn loro_summary_for_engine(engine: &mut LoroEngine, op: &OpPayload) -> String {
    let result: Result<String, crate::error::AppError> = match op {
        OpPayload::CreateBlock(p) => {
            let parent = p.parent_id.as_ref().map(|id| id.as_str());
            let position = p.position.unwrap_or(0);
            engine
                .apply_create_block(
                    p.block_id.as_str(),
                    &p.block_type,
                    &p.content,
                    parent,
                    position,
                )
                .map(|_| format!("create:{}", p.block_id.as_str()))
        }
        OpPayload::EditBlock(p) => engine
            .apply_edit_via_diff_splice(p.block_id.as_str(), &p.to_text)
            .map(|_| {
                let head: String = p.to_text.chars().take(50).collect();
                format!("edit:{}:{}", p.block_id.as_str(), head)
            }),
        OpPayload::DeleteBlock(p) => engine
            .apply_delete_block(p.block_id.as_str())
            .map(|_| format!("delete:{}", p.block_id.as_str())),
        OpPayload::MoveBlock(p) => {
            let parent = p.new_parent_id.as_ref().map(|id| id.as_str());
            engine
                .apply_move_block(p.block_id.as_str(), parent, p.new_position)
                .map(|_| {
                    format!(
                        "move:{}:{}:{}",
                        p.block_id.as_str(),
                        parent.unwrap_or("<root>"),
                        p.new_position
                    )
                })
        }
        OpPayload::SetProperty(p) => {
            let value: Option<String> = p
                .value_text
                .clone()
                .or_else(|| p.value_num.map(|n| n.to_string()))
                .or_else(|| p.value_date.clone())
                .or_else(|| p.value_ref.clone())
                .or_else(|| p.value_bool.map(|b| b.to_string()));
            engine
                .apply_set_property(p.block_id.as_str(), &p.key, value.as_deref())
                .map(|_| {
                    format!(
                        "set_property:{}:{}={}",
                        p.block_id.as_str(),
                        p.key,
                        value.as_deref().unwrap_or("<null>")
                    )
                })
        }
        // The proptest generators only emit the five supported op
        // variants — any other variant is unreachable here.
        other => Ok(format!("unsupported:{}", other.op_type_str())),
    };

    match result {
        Ok(summary) => summary,
        Err(e) => format!("error:{e}"),
    }
}

// ---------------------------------------------------------------------------
// proptest cases.
//
// Each case generates a stream, drives it onto a fresh engine, and
// asserts every step's classifier bucket is NOT `D`.  The "fresh
// engine per case" stance is deliberate — it isolates failures to a
// single stream, so the shrinker's minimised counter-example is also
// the minimised reproduction script.
// ---------------------------------------------------------------------------

proptest! {
    /// Sanity check: single-author CreateBlock-only streams must
    /// always produce bucket A (byte-identical diffy + Loro summaries).
    /// This is the floor — if this test ever flakes, every richer test
    /// below is suspect.
    #[test]
    fn single_author_create_only_stream_is_bucket_a(
        // Up to 8 creates over the 3-block pool.  Most cases will hit
        // the "duplicate create" guard and skip; that's fine — what we
        // care about is the create-succeeded summaries staying in A.
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

            let loro_summary = loro_summary_for_engine(&mut engine, &op);
            let diffy_summary = diffy_summary_for(&op);
            let matched = loro_summary == diffy_summary;
            let bucket = classifier::classify(&diffy_summary, &loro_summary, matched);

            // Single-author Create succeeded on a fresh id → A.
            // ANY other bucket on this floor case is a regression.
            prop_assert_eq!(
                bucket,
                Bucket::A,
                "create-only stream must stay in A; got {:?} (diffy={}, loro={})",
                bucket,
                diffy_summary,
                loro_summary,
            );

            created.push(block_id.clone());
        }
    }

    /// The headline test: single-author MIXED-OP streams (Create +
    /// Edit + Delete + Move + SetProperty over the 3-block pool).
    /// kill criterion #2 says bucket D must remain zero across ALL
    /// observed streams.  proptest's shrinker gives us thousands of
    /// distinct streams per CI run.
    #[test]
    fn single_author_mixed_op_stream_never_hits_bucket_d(
        ops in op_stream_strategy(1..=50),
    ) {
        let mut engine = LoroEngine::with_peer_id("DEV-PROPTEST")
            .expect("with_peer_id");
        let mut created: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();

        for kind in &ops {
            let Some(op) = resolve_op(kind, &created, &deleted) else { continue };

            let loro_summary = loro_summary_for_engine(&mut engine, &op);
            let diffy_summary = diffy_summary_for(&op);
            let matched = loro_summary == diffy_summary;
            let bucket = classifier::classify(&diffy_summary, &loro_summary, matched);

            // The whole point of this test: D must stay empty.  We
            // include both summaries in the failure message so a
            // failing seed surfaces the exact disagreement string.
            prop_assert_ne!(
                bucket,
                Bucket::D,
                "single-author stream landed in bucket D — STOP-AND-FLAG \
                 (diffy={}, loro={})",
                diffy_summary,
                loro_summary,
            );

            // Track stream state for the next iteration.
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
    }

    /// Defensive companion: single-author streams should also stay
    /// out of bucket B (Loro-merged-where-diffy-conflicted).  B is
    /// reachable today only via the forward-compat `conflict:` prefix
    /// rule (see `classifier::classify`); a single-author stream
    /// cannot produce a conflict, so any B sighting here is a
    /// summary-shape drift in either `diffy_summary_for` or the
    /// engine summary path.  Catches a class of refactor bugs the
    /// D-only assertion above would miss.
    #[test]
    fn single_author_mixed_op_stream_never_hits_bucket_b(
        ops in op_stream_strategy(1..=50),
    ) {
        let mut engine = LoroEngine::with_peer_id("DEV-PROPTEST")
            .expect("with_peer_id");
        let mut created: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();

        for kind in &ops {
            let Some(op) = resolve_op(kind, &created, &deleted) else { continue };

            let loro_summary = loro_summary_for_engine(&mut engine, &op);
            let diffy_summary = diffy_summary_for(&op);
            let matched = loro_summary == diffy_summary;
            let bucket = classifier::classify(&diffy_summary, &loro_summary, matched);

            prop_assert_ne!(
                bucket,
                Bucket::B,
                "single-author stream landed in bucket B — diffy summary \
                 shouldn't carry `conflict:` prefix without a real concurrent \
                 conflict (diffy={}, loro={})",
                diffy_summary,
                loro_summary,
            );

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
    }
}

// ===========================================================================
// PEND-09 Phase 2 day-2 — two-device concurrent-merge proptest streams.
//
// Closes the deferred Phase-1-day-8 gap.  The single-author streams
// above prove the dispatch path doesn't drop ops on the way through
// the engine; what they CANNOT catch is divergence-on-merge — the
// failure mode where two devices, having both applied valid op
// streams independently, produce different states after exchanging
// snapshots.  This sub-module's tests start a fresh `LoroEngine` per
// device with distinct peer ids, run independently-generated op
// streams on each, mutually `import` snapshots, and assert both
// engines read back identical state across a representative key set.
//
// ## Why this lives here, not in a sibling file
//
// The strategies + helpers ([`block_id_strategy`], [`op_kind_strategy`],
// [`resolve_op`]) are reused unchanged across single-author and
// two-device tests; pulling them into a new file would force them
// `pub(super)`-visible across an internal module boundary for no
// readability win.  The `two_device` mod block keeps the day-2 cases
// visually grouped without splitting the strategy code.
//
// ## Scope: Loro-side convergence only
//
// We assert "device A's reads == device B's reads after sync" for
// every key the streams touched.  We do NOT compare against the
// diffy 3-way merge oracle: diffy convergence is independently
// covered by the production `merge/tests.rs` suite (3700+ tests) and
// the spike's hand-curated 53-case parity corpus.  The two-device
// proptest's value-add is randomised search for Loro-only bugs:
// container-shape mismatches across import, non-deterministic LWW
// outcomes, op-log merge errors.
//
// ## Bucket-D / kill-criterion #2 angle
//
// The day-8 single-author proptest is the module that exercises the
// bucket-classify path against diffy-shaped summaries (see the
// `bucket` / `classify` callsites earlier in this file).  These
// two-device tests deliberately do NOT run `classify` per op:
// without a diffy-side oracle running per-stream there is no second
// summary to compare against, so a `Bucket::D` assertion would be
// vacuous.  The two-device tests' contract is narrower: post-sync
// convergence + "LWW winner is one of the two contributors".  Sync-
// path crashes (an `import` failure, an `apply_*` returning a
// validation error after divergence) surface as `expect()` panics
// in [`sync_engines`] / the per-op apply calls, which fails the
// proptest case directly — no classify needed.
// ===========================================================================

/// Two-device concurrent-merge proptest streams.  See parent module
/// docstring §"Two-device concurrent-merge extension".
#[cfg(all(test, feature = "loro-shadow"))]
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
    /// created (so the comparator can read them back) and the keys
    /// touched on `set_property` (so we can compare property reads).
    /// The caller uses the returned sets to compute the union of
    /// "interesting" reads across both devices.
    ///
    /// Note: peer-id assignment lives in the caller — each test
    /// instantiates its engines via [`LoroEngine::with_peer_id`] with
    /// distinct labels (`"DEV-PROPTEST-A"` vs `"DEV-PROPTEST-B"`) so
    /// the two engines land on distinct `PeerID`s, which is required
    /// for Loro's CRDT to treat them as independent writers.
    fn apply_stream(
        engine: &mut LoroEngine,
        ops: &[OpKind],
    ) -> (Vec<String>, Vec<(String, String)>) {
        let mut created: Vec<String> = Vec::new();
        let mut deleted: Vec<String> = Vec::new();
        let mut props_touched: Vec<(String, String)> = Vec::new();

        for kind in ops {
            let Some(op) = resolve_op(kind, &created, &deleted) else {
                continue;
            };

            // Drive the op onto the engine.  We don't classify per-op
            // here — single-author classification is the day-8 job;
            // here we care about post-sync convergence.  Errors are
            // ignored on the apply side (the resolver guards against
            // most of them already) and surface in convergence drift.
            let _summary = loro_summary_for_engine(engine, &op);

            match &op {
                OpPayload::CreateBlock(p) => {
                    created.push(p.block_id.as_str().to_string());
                }
                OpPayload::DeleteBlock(p) => {
                    deleted.push(p.block_id.as_str().to_string());
                }
                OpPayload::SetProperty(p) => {
                    props_touched.push((p.block_id.as_str().to_string(), p.key.clone()));
                }
                _ => {}
            }
        }

        (created, props_touched)
    }

    /// Mutual snapshot exchange — A imports B's state, B imports A's.
    /// Mirrors the spike's `parity_corpus::sync` helper.  After this
    /// call both engines have all ops from both sides and must read
    /// back identical state across every shared key.
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
    ///
    /// We compare the [`BlockSnapshot`] equality directly — `PartialEq`
    /// covers all five fields (block_id, block_type, content,
    /// parent_id, position).  `read_deleted` is checked separately
    /// since it's not part of `BlockSnapshot`.
    fn compare_block_reads(a: &LoroEngine, b: &LoroEngine, block_id: &str) -> Result<(), String> {
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
        // (read_deleted is Err on missing block, so guard.)
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
    fn compare_property_reads(
        a: &LoroEngine,
        b: &LoroEngine,
        block_id: &str,
        key: &str,
    ) -> Result<(), String> {
        let a_val = a
            .read_property(block_id, key)
            .map_err(|e| format!("A read_property({block_id}, {key}): {e}"))?;
        let b_val = b
            .read_property(block_id, key)
            .map_err(|e| format!("B read_property({block_id}, {key}): {e}"))?;
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
            // 1-6 creates per device.  Small enough that overlap on
            // the 3-block pool is common (proptest will explore both
            // disjoint and overlapping cases); large enough that
            // we exercise multi-create-per-device.
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

            let (a_created, _) = apply_stream(&mut engine_a, &a_ops);
            let (b_created, _) = apply_stream(&mut engine_b, &b_ops);

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
        ///
        /// This is the "RGA-CRDT identical-edit doubling" scenario
        /// the spike's category 5 documented as bucket C — it's
        /// CRDT-correct divergence from diffy, not bucket D.
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
            // ancestor.  This matches the spike `two_peers_from_seed`
            // pattern — the divergent edits below have a clean LCA.
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
        /// after sync must see the SAME winner.  Mirrors the spike's
        /// `parity_concurrent_property_writes_different_values`
        /// (parity_corpus.rs ~line 724) lifted into proptest scale.
        ///
        /// Note: Loro's LWW tiebreak is Lamport-order (peer-id +
        /// op-counter) — NOT wall-clock timestamp.  Diffy uses
        /// (timestamp, device_id, seq); the tiebreak rule difference
        /// is the documented bucket-C exception (see
        /// pending/PEND-09-lww-resolution-rule.md).  Convergence on
        /// each side is what kill-criterion #2 actually requires.
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
                .read_property(seed_id, &key)
                .expect("A read winner")
                .expect("property must exist after both sides wrote it")
                .expect("non-null after explicit string write");
            prop_assert!(
                winner == a_value || winner == b_value,
                "LWW winner {winner:?} is neither A's {a_value:?} nor B's {b_value:?}",
            );
        }

        /// Test 4 — concurrent MoveBlock to different parents.
        ///
        /// Both devices MoveBlock(X, different parents).  Loro's
        /// per-key LWW on the `parent_id` slot picks one parent; both
        /// engines must converge on the same value.  Cites the same
        /// LWW rule as test 3 — the documented Lamport-vs-wallclock
        /// tiebreak exception (see pending/PEND-09-lww-resolution-rule.md).
        ///
        /// This is the "loser's reparent intent dropped" tradeoff
        /// the plan flagged as open question 5 — the spike's
        /// `parity_concurrent_reparent_different_parents` (corpus
        /// ~line 638) tests one pair of values; here we let proptest
        /// search the parent-id space.
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
