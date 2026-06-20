//! Seeded-DB proptest fixture harness (TEST-PROPTEST-B, issue #150).
//!
//! A reusable [`proptest`] generator + driver for **random valid block
//! trees + op chains** over a real (TempDir-backed) SQLite pool. Built
//! for the Tier-B property tests that exercise DB-bound logic — code
//! that reads the `op_log` (and, for B2-B4, the materialised tables)
//! rather than pure in-memory functions.
//!
//! Tier A proptests (`word_diff`, `space_filter_canonical`,
//! `loro::engine_proptest`) drive pure functions / a bare `LoroEngine`.
//! Tier B is different: the function under test (`reverse::compute_reverse`,
//! and later the materializer / sync apply paths) needs a *seeded op_log
//! in a real pool*. This harness produces exactly that.
//!
//! # What the harness guarantees
//!
//! Every generated chain is **structurally valid**:
//!
//! * **Valid ULIDs** — block ids come from a fixed pool of real
//!   `BlockId::new()` ULIDs (26-char Crockford base32, uppercase). They
//!   pass `BlockId::from_string` validation and the AGENTS.md invariant #8
//!   uppercase-canonical contract.
//! * **Valid parent/page relationships** — a block is only ever created
//!   under a parent that already exists in the chain (or as a root,
//!   `parent_id = None`). No forward references, no cycles (a block is
//!   created once, and only earlier-created blocks are eligible parents).
//! * **Valid positions** — positions are 1-based (never 0, never
//!   negative), per the `block_positions` invariant and
//!   `move_block_inner`'s validation.
//! * **Valid op chains** — the generator maintains a running model of
//!   which blocks exist / are deleted, and only emits ops whose
//!   pre-conditions hold (no Edit/Move/SetProperty/Delete against a
//!   block that was never created or is currently deleted; no duplicate
//!   Create for a live id; RestoreBlock only against a currently-deleted
//!   block; DeleteProperty only against a key that was Set).
//!
//! The chain is appended to the pool via [`append_local_op_at`] with
//! **strictly increasing, deterministic timestamps** (`FIXED_BASE_TS` +
//! step seconds), so the `(created_at, seq)` ordering the reverse-op
//! prior-state lookups depend on is stable across runs.
//!
//! # What is reusable for B2-B4
//!
//! * [`AppliedChain`] + [`OpKind`] + [`ChainModel`] — the typed op-chain
//!   IR and the running validity model. B2 (materializer apply
//!   round-trip) and B3/B4 (sync convergence) reuse the *same* generated
//!   chains; they differ only in what they assert after seeding.
//! * [`op_chain_strategy`] / [`seed_chain`] — generate + append. B2 will
//!   additionally call `Materializer::apply_op` over the seeded ops and
//!   compare materialised state; B3/B4 will replay the chain on a second
//!   pool / engine and assert convergence.
//! * [`observe_prior_text`] / [`observe_prior_position`] /
//!   [`observe_prior_property`] — op-log-derived observable-state oracles.
//!   These deliberately re-derive prior state *independently* of the
//!   `reverse::*` helpers (a hand-rolled `BTreeMap` replay of the chain),
//!   so the B1 inverse-law test is not tautological (oracle ≠ code under
//!   test). B2-B4 can reuse them as a cheap state oracle that needs no
//!   materializer.
//!
//! # Scope discipline
//!
//! Kept focused on B1's needs: the generator emits the op variants whose
//! reverse is observable through the op log alone (Create / Edit / Delete
//! / Move / Restore / AddTag / RemoveTag / SetProperty / DeleteProperty).
//! Attachment ops (Add/Delete) and PurgeBlock are covered by the B1
//! mapping test directly (they need no chain), so the generator does not
//! emit them — B2 can add them when it wires the attachment FS side.

#![cfg(test)]

use proptest::prelude::*;
use sqlx::SqlitePool;
use std::collections::BTreeMap;

use crate::op::{
    CreateBlockPayload, DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload,
    MoveBlockPayload, OpPayload, RestoreBlockPayload, SetPropertyPayload,
};
use crate::op_log::{OpRecord, append_local_op_at};
use crate::ulid::BlockId;

/// Device id used for every seeded op. A single device keeps the
/// `(device_id, seq)` space simple — the reverse-op lookups key on
/// `block_id` + `(created_at, seq)`, not device, so one device exercises
/// the full surface.
pub const HARNESS_DEVICE: &str = "proptest-harness-device";

/// Base timestamp for the op chain. Each op gets `base + step` seconds so
/// the `created_at` column is strictly lex-increasing (the invariant the
/// reverse-op "strictly before (created_at, seq)" lookups depend on).
const FIXED_BASE_HHMM: (u32, u32) = (12, 0);

/// Fixed pool of real ULIDs (generated once at chain-build time). A small
/// pool (default 4) is intentional — it exercises the realistic
/// "long-lived block re-edited / re-moved many times" shape and keeps the
/// shrinker's counter-examples small, mirroring `loro::engine_proptest`'s
/// 3-block-pool rationale.
const DEFAULT_POOL_SIZE: usize = 4;

/// Property keys the generator draws from — short identifiers matching
/// production property shapes (`status`, `priority`, …).
const PROP_KEYS: &[&str] = &["status", "priority", "due_date", "owner"];

// ---------------------------------------------------------------------------
// Op-kind IR.
//
// An `OpKind` is a *sketch* of an op resolved against the running chain
// model at build time. Indices into the live/deleted/created sets are
// generated as raw `usize` and reduced modulo the relevant set size in
// `ChainModel::resolve`, so the generator never has to know the set size
// up-front (the same trick `loro::engine_proptest` uses).
// ---------------------------------------------------------------------------

/// One step in a generated op chain. Reusable IR for B1-B4.
#[derive(Debug, Clone)]
pub enum OpKind {
    /// Create a new block. `parent_choice` selects a parent from the
    /// already-created set (or root if `None`/empty).
    Create {
        pool_index: usize,
        parent_choice: Option<usize>,
        position: i64,
        content: String,
    },
    Edit {
        live_index: usize,
        new_content: String,
    },
    Delete {
        live_index: usize,
    },
    Restore {
        deleted_index: usize,
    },
    Move {
        live_index: usize,
        parent_choice: Option<usize>,
        position: i64,
    },
    SetProperty {
        live_index: usize,
        key_index: usize,
        value: String,
    },
    DeleteProperty {
        live_index: usize,
        key_index: usize,
    },
    AddTag {
        live_index: usize,
        tag_pool_index: usize,
    },
    RemoveTag {
        live_index: usize,
        tag_pool_index: usize,
    },
}

// ---------------------------------------------------------------------------
// proptest strategies.
// ---------------------------------------------------------------------------

fn content_strategy() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9 ]{0,16}".prop_map(|s| s)
}

/// Property values must be non-empty and not whitespace-only — `op.rs`'s
/// `validate_set_property` rejects `value_text.trim().is_empty()`. The
/// regex guarantees at least one non-whitespace char.
fn prop_value_strategy() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9]{1,12}".prop_map(|s| s)
}

fn position_strategy() -> impl Strategy<Value = i64> {
    // 1-based positions only. `block_positions` / `move_block_inner`
    // reject 0 and negatives, so the generator never emits them.
    1i64..32
}

fn op_kind_strategy() -> impl Strategy<Value = OpKind> {
    prop_oneof![
        // Create-heavy at the start so the live set warms up; the model
        // skips Creates that would collide with a live id.
        4 => (any::<usize>(), proptest::option::of(any::<usize>()), position_strategy(), content_strategy())
            .prop_map(|(pool_index, parent_choice, position, content)| OpKind::Create {
                pool_index, parent_choice, position, content,
            }),
        3 => (any::<usize>(), content_strategy())
            .prop_map(|(live_index, new_content)| OpKind::Edit { live_index, new_content }),
        1 => any::<usize>().prop_map(|live_index| OpKind::Delete { live_index }),
        1 => any::<usize>().prop_map(|deleted_index| OpKind::Restore { deleted_index }),
        2 => (any::<usize>(), proptest::option::of(any::<usize>()), position_strategy())
            .prop_map(|(live_index, parent_choice, position)| OpKind::Move {
                live_index, parent_choice, position,
            }),
        3 => (any::<usize>(), any::<usize>(), prop_value_strategy())
            .prop_map(|(live_index, key_index, value)| OpKind::SetProperty { live_index, key_index, value }),
        // #181: `DeleteProperty` is emitted by the random generator now
        // that `reverse::reverse_set_property` honours an intervening
        // `delete_property` when computing the prior value of a later
        // `set_property` (the prior state of a set-after-delete is ABSENT,
        // so its reverse is `DeleteProperty`). The inverse-law test stays
        // green with this arm enabled; see
        // `reverse::proptest_b1::regression_reverse_set_property_after_delete_should_be_delete`.
        1 => (any::<usize>(), any::<usize>())
            .prop_map(|(live_index, key_index)| OpKind::DeleteProperty { live_index, key_index }),
        1 => (any::<usize>(), any::<usize>())
            .prop_map(|(live_index, tag_pool_index)| OpKind::AddTag { live_index, tag_pool_index }),
        1 => (any::<usize>(), any::<usize>())
            .prop_map(|(live_index, tag_pool_index)| OpKind::RemoveTag { live_index, tag_pool_index }),
    ]
}

/// A chain of [`OpKind`] sketches of the given length range. The realised
/// (resolved, well-formed) chain is computed at seed time by
/// [`ChainModel`].
pub fn op_chain_strategy(
    len_range: std::ops::RangeInclusive<usize>,
) -> impl Strategy<Value = Vec<OpKind>> {
    proptest::collection::vec(op_kind_strategy(), len_range)
}

// ---------------------------------------------------------------------------
// Chain model — resolves sketches into well-formed typed payloads while
// maintaining the structural invariants (create-before-use, no dup
// create, positions 1-based, no op on a deleted block, restore only a
// deleted block, etc.).
// ---------------------------------------------------------------------------

/// Running validity model used to resolve [`OpKind`] sketches into typed
/// [`OpPayload`]s. Reusable across B1-B4 — it is the single source of
/// "what is a structurally valid next op given the chain so far".
pub struct ChainModel {
    /// Fixed pool of valid ULIDs to draw block ids from.
    pool: Vec<BlockId>,
    /// Blocks that have been created (and not purged). Maps id -> live?.
    state: BTreeMap<String, bool>, // true = live, false = soft-deleted
    /// Properties set per (block_id, key) — used to gate DeleteProperty.
    props: BTreeMap<(String, String), ()>,
}

impl ChainModel {
    fn new(pool_size: usize) -> Self {
        let pool = (0..pool_size).map(|_| BlockId::new()).collect();
        Self {
            pool,
            state: BTreeMap::new(),
            props: BTreeMap::new(),
        }
    }

    fn live_ids(&self) -> Vec<String> {
        self.state
            .iter()
            .filter(|&(_, &live)| live)
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn deleted_ids(&self) -> Vec<String> {
        self.state
            .iter()
            .filter(|&(_, &live)| !live)
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Resolve one sketch to a typed payload, or `None` if no valid
    /// target exists (caller skips — keeps the chain well-formed without
    /// rejecting the whole proptest case). Mutates the model to reflect
    /// the op that will be appended.
    fn resolve(&mut self, kind: &OpKind) -> Option<OpPayload> {
        match kind {
            OpKind::Create {
                pool_index,
                parent_choice,
                position,
                content,
            } => {
                let id = self.pool[pool_index % self.pool.len()].clone();
                // No duplicate create for a currently-known id.
                if self.state.contains_key(id.as_str()) {
                    return None;
                }
                // Parent must be an already-created live block (or root).
                let live = self.live_ids();
                let parent_id = parent_choice.and_then(|c| {
                    if live.is_empty() {
                        None
                    } else {
                        Some(BlockId::from_trusted(&live[c % live.len()]))
                    }
                });
                self.state.insert(id.as_str().to_string(), true);
                Some(OpPayload::CreateBlock(CreateBlockPayload {
                    block_id: id,
                    block_type: "content".into(),
                    parent_id,
                    position: Some(*position),
                    index: None,
                    content: content.clone(),
                }))
            }
            OpKind::Edit {
                live_index,
                new_content,
            } => {
                let live = self.live_ids();
                if live.is_empty() {
                    return None;
                }
                let target = &live[live_index % live.len()];
                Some(OpPayload::EditBlock(EditBlockPayload {
                    block_id: BlockId::from_trusted(target),
                    to_text: new_content.clone(),
                    prev_edit: None,
                }))
            }
            OpKind::Delete { live_index } => {
                let live = self.live_ids();
                if live.is_empty() {
                    return None;
                }
                let target = live[live_index % live.len()].clone();
                self.state.insert(target.clone(), false);
                Some(OpPayload::DeleteBlock(DeleteBlockPayload {
                    block_id: BlockId::from_trusted(&target),
                }))
            }
            OpKind::Restore { deleted_index } => {
                let deleted = self.deleted_ids();
                if deleted.is_empty() {
                    return None;
                }
                let target = deleted[deleted_index % deleted.len()].clone();
                self.state.insert(target.clone(), true);
                // Reverse-of-restore discards the original
                // deleted_at_ref; we still need a non-empty ref to build a
                // structurally valid RestoreBlock payload. Use a marker —
                // the actual value is irrelevant to the chain model.
                Some(OpPayload::RestoreBlock(RestoreBlockPayload {
                    block_id: BlockId::from_trusted(&target),
                    deleted_at_ref: 0,
                }))
            }
            OpKind::Move {
                live_index,
                parent_choice,
                position,
            } => {
                let live = self.live_ids();
                if live.is_empty() {
                    return None;
                }
                let target = live[live_index % live.len()].clone();
                // Parent must be a different live block (or root). Avoid
                // self-parenting, which `move_block_inner` rejects.
                let candidates: Vec<&String> = live.iter().filter(|id| **id != target).collect();
                let new_parent_id = parent_choice.and_then(|c| {
                    if candidates.is_empty() {
                        None
                    } else {
                        Some(BlockId::from_trusted(candidates[c % candidates.len()]))
                    }
                });
                Some(OpPayload::MoveBlock(MoveBlockPayload {
                    block_id: BlockId::from_trusted(&target),
                    new_parent_id,
                    new_position: *position,
                    new_index: None,
                }))
            }
            OpKind::SetProperty {
                live_index,
                key_index,
                value,
            } => {
                let live = self.live_ids();
                if live.is_empty() {
                    return None;
                }
                let target = live[live_index % live.len()].clone();
                let key = PROP_KEYS[key_index % PROP_KEYS.len()].to_string();
                self.props.insert((target.clone(), key.clone()), ());
                Some(OpPayload::SetProperty(SetPropertyPayload {
                    block_id: BlockId::from_trusted(&target),
                    key,
                    value_text: Some(value.clone()),
                    value_num: None,
                    value_date: None,
                    value_ref: None,
                    value_bool: None,
                }))
            }
            OpKind::DeleteProperty {
                live_index,
                key_index,
            } => {
                let live = self.live_ids();
                if live.is_empty() {
                    return None;
                }
                let target = live[live_index % live.len()].clone();
                let key = PROP_KEYS[key_index % PROP_KEYS.len()].to_string();
                // Only delete a property that was previously set (a
                // reversible DeleteProperty requires a prior SetProperty).
                if !self.props.contains_key(&(target.clone(), key.clone())) {
                    return None;
                }
                self.props.remove(&(target.clone(), key.clone()));
                Some(OpPayload::DeleteProperty(DeletePropertyPayload {
                    block_id: BlockId::from_trusted(&target),
                    key,
                }))
            }
            OpKind::AddTag {
                live_index,
                tag_pool_index,
            } => {
                let live = self.live_ids();
                if live.is_empty() {
                    return None;
                }
                let target = live[live_index % live.len()].clone();
                let tag = self.pool[tag_pool_index % self.pool.len()].clone();
                Some(OpPayload::AddTag(crate::op::AddTagPayload {
                    block_id: BlockId::from_trusted(&target),
                    tag_id: tag,
                }))
            }
            OpKind::RemoveTag {
                live_index,
                tag_pool_index,
            } => {
                let live = self.live_ids();
                if live.is_empty() {
                    return None;
                }
                let target = live[live_index % live.len()].clone();
                let tag = self.pool[tag_pool_index % self.pool.len()].clone();
                Some(OpPayload::RemoveTag(crate::op::RemoveTagPayload {
                    block_id: BlockId::from_trusted(&target),
                    tag_id: tag,
                }))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Seeding.
// ---------------------------------------------------------------------------

/// The result of seeding an op chain into a pool: the appended op records
/// (in chain order) alongside the typed payloads that produced them.
/// Reusable by B2-B4 — e.g. B2 can iterate `records` and apply each op to
/// a `Materializer`, B3/B4 can replay `payloads` onto a second pool.
pub struct AppliedChain {
    pub records: Vec<OpRecord>,
    pub payloads: Vec<OpPayload>,
}

impl AppliedChain {
    /// All (record, payload) pairs whose `op_type` is reversible — i.e.
    /// everything except `purge_block` and `delete_attachment`-without-add.
    /// Convenience for the B1 inverse-law test, which only iterates ops
    /// `compute_reverse` will not reject.
    pub fn iter(&self) -> impl Iterator<Item = (&OpRecord, &OpPayload)> {
        self.records.iter().zip(self.payloads.iter())
    }
}

/// Deterministic strictly-increasing timestamp for the `n`-th op in a
/// chain. Spaced one minute apart, rolling into hours, so `created_at`
/// lex-ordering tracks chain order exactly (the invariant the reverse
/// prior-state lookups depend on).
fn ts_for(n: usize) -> i64 {
    let (base_h, base_m) = FIXED_BASE_HHMM;
    let total_minutes = base_h as usize * 60 + base_m as usize + n;
    let h = total_minutes / 60;
    // h stays < 24 for the chain lengths we generate (max ~64 ops); guard
    // anyway so a future longer chain doesn't silently wrap.
    assert!(h < 24, "harness chain too long for single-day timestamps");
    // #109 Phase 2: op_log.created_at is INTEGER epoch-ms.
    // 2025-01-15T00:00:00Z = 1_736_899_200_000; one minute = 60_000 ms.
    1_736_899_200_000 + i64::try_from(total_minutes).unwrap() * 60_000
}

/// Resolve a sketch chain into a well-formed sequence of typed
/// [`OpPayload`]s **without touching any pool** (no `op_log` append, no
/// materialization). Skips sketches with no valid target — exactly the
/// same model-driven validity discipline [`seed_chain`] applies, minus the
/// side effects.
///
/// B2-B4 (the materializer apply/reproject proptests, issue #1683) need the
/// resolved payloads *before* they are appended so they can re-anchor every
/// root `CreateBlock` under a pre-seeded page (so `resolve_block_space`
/// succeeds and every op routes through the production engine path rather
/// than the SQL-only fallback). Generating the payloads here and driving
/// them through `append_local_op` + the foreground apply pipeline themselves
/// gives those tests full control over the apply path while reusing the
/// harness's single source of "what is a structurally valid op chain".
pub fn resolve_chain(sketches: &[OpKind]) -> Vec<OpPayload> {
    resolve_chain_with_pool_size(sketches, DEFAULT_POOL_SIZE)
}

/// As [`resolve_chain`] but with a caller-chosen ULID pool size.
pub fn resolve_chain_with_pool_size(sketches: &[OpKind], pool_size: usize) -> Vec<OpPayload> {
    let mut model = ChainModel::new(pool_size.max(1));
    let mut payloads = Vec::new();
    for sketch in sketches {
        if let Some(payload) = model.resolve(sketch) {
            payloads.push(payload);
        }
    }
    payloads
}

/// Generate a fresh ULID pool, resolve the sketch chain into well-formed
/// typed ops, and append them to `pool` with deterministic timestamps.
/// Skips sketches with no valid target. Returns the appended chain.
pub async fn seed_chain(pool: &SqlitePool, sketches: &[OpKind]) -> AppliedChain {
    seed_chain_with_pool_size(pool, sketches, DEFAULT_POOL_SIZE).await
}

/// As [`seed_chain`] but with a caller-chosen ULID pool size.
pub async fn seed_chain_with_pool_size(
    pool: &SqlitePool,
    sketches: &[OpKind],
    pool_size: usize,
) -> AppliedChain {
    let mut model = ChainModel::new(pool_size.max(1));
    let mut records = Vec::new();
    let mut payloads = Vec::new();
    let mut n = 0usize;
    for sketch in sketches {
        let Some(payload) = model.resolve(sketch) else {
            continue;
        };
        let rec = append_local_op_at(pool, HARNESS_DEVICE, payload.clone(), ts_for(n))
            .await
            .expect("append_local_op_at must succeed for a well-formed harness op");
        records.push(rec);
        payloads.push(payload);
        n += 1;
    }
    AppliedChain { records, payloads }
}

// ---------------------------------------------------------------------------
// Observable-state oracles.
//
// These re-derive observable prior state by an INDEPENDENT replay of the
// op log (a hand-rolled BTreeMap fold), deliberately NOT calling the
// `reverse::*` helpers — so the B1 inverse-law assertion is a genuine
// oracle comparison, not a tautology against the code under test.
//
// "Observable state" here is the op-log projection the reverse functions
// are contractually defined against (per reverse/tests.rs AGENTS note:
// "Prior-state lookups use the op log exclusively, not the materialised
// blocks table"). For B2-B4 these double as a cheap materializer-free
// state oracle.
// ---------------------------------------------------------------------------

/// The latest content of `block_id` as of strictly before `(created_at,
/// seq)`, by independent replay of the chain's create/edit ops. `None` if
/// the block has no create/edit before that point.
pub fn observe_prior_text(chain: &AppliedChain, block_id: &str, before_seq: i64) -> Option<String> {
    let mut text: Option<String> = None;
    for (rec, payload) in chain.iter() {
        if rec.seq >= before_seq {
            break;
        }
        match payload {
            OpPayload::CreateBlock(p) if p.block_id == block_id => text = Some(p.content.clone()),
            OpPayload::EditBlock(p) if p.block_id == block_id => text = Some(p.to_text.clone()),
            _ => {}
        }
    }
    text
}

/// The latest (parent, position) of `block_id` strictly before
/// `(created_at, seq)`, by independent replay of create/move ops.
pub fn observe_prior_position(
    chain: &AppliedChain,
    block_id: &str,
    before_seq: i64,
) -> Option<(Option<String>, i64)> {
    let mut pos: Option<(Option<String>, i64)> = None;
    for (rec, payload) in chain.iter() {
        if rec.seq >= before_seq {
            break;
        }
        match payload {
            OpPayload::CreateBlock(p) if p.block_id == block_id => {
                pos = p
                    .position
                    .map(|n| (p.parent_id.as_ref().map(|id| id.as_str().to_string()), n));
            }
            OpPayload::MoveBlock(p) if p.block_id == block_id => {
                pos = Some((
                    p.new_parent_id.as_ref().map(|id| id.as_str().to_string()),
                    p.new_position,
                ));
            }
            _ => {}
        }
    }
    pos
}

/// The latest text-value of property `key` on `block_id` strictly before
/// `(created_at, seq)`, by independent replay of set/delete property ops.
/// Outer `None` = property never set / was deleted; inner is the
/// `value_text`.
pub fn observe_prior_property(
    chain: &AppliedChain,
    block_id: &str,
    key: &str,
    before_seq: i64,
) -> Option<Option<String>> {
    let mut val: Option<Option<String>> = None;
    for (rec, payload) in chain.iter() {
        if rec.seq >= before_seq {
            break;
        }
        match payload {
            OpPayload::SetProperty(p) if p.block_id == block_id && p.key == key => {
                val = Some(p.value_text.clone());
            }
            OpPayload::DeleteProperty(p) if p.block_id == block_id && p.key == key => {
                val = None;
            }
            _ => {}
        }
    }
    val
}
