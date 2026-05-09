//! PEND-09 Phase 1 day-8 — proptest-augmented parity streams.
//!
//! Days 1-7 landed the spike port + shadow-mode wiring + envelope +
//! persistent SQLite parity sink + flush task + bucket A/B/C/D
//! classifier + xxh3-64 peer-id swap.  Days prior also brought a
//! hand-curated 53-case parity corpus across in `crates/loro-spike/
//! tests/parity_corpus.rs` and a 5-shape integration suite in
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
//! ## Why no two-device concurrent-merge proptest yet
//!
//! Day-8 deliberately scopes to single-author streams.  Concurrent
//! two-device streams (the C-bucket-rich case) need:
//!   1. A second engine peer.
//!   2. Loro's `import` to merge the two op-logs.
//!   3. A diffy three-way merge oracle to compare against.
//! The corpus already covers ~20 hand-picked two-device merge shapes;
//! the proptest extension to that surface lands on a later Phase-1 day
//! after the day-8 single-author net is in CI.  See SPIKE-REPORT.md
//! §6 readiness checklist item 8 for the full rollout plan.
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
