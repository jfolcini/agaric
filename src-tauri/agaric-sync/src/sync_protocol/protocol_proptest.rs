//! Property tests for the pure decision functions in `sync_protocol` (#4498).
//!
//! # Why these four
//!
//! `agaric-sync` carries 376 example tests and, before this file, exactly one
//! property test reaching it from the app crate (`snapshot_cbor_roundtrip`).
//! The four surfaces below are the crate's *pure* decision points — no pool, no
//! transport, no engine — and each answers a question an example cannot:
//!
//! * [`check_reset_required`] and [`classify_from_vv_reachability`] are the two
//!   version-vector comparisons the sync layer makes. Both decide, from
//!   peer-supplied bytes, whether the user's graph can take a delta or must be
//!   rebuilt from a snapshot. Getting either wrong in the permissive direction
//!   applies an incoherent delta; getting it wrong in the strict direction
//!   loops the device through snapshot catch-up forever (#602).
//! * [`batch_ops_for_wire`] partitions audit records onto the wire. A partition
//!   that loses, duplicates or reorders a record is silent — the receiver just
//!   sees a different op log.
//! * [`encode_persisted_loro_vvs`] / [`decode_persisted_loro_vvs`] are the
//!   persisted per-peer bookmark. The decoder returns `Vec`, not `Result`, so
//!   "what does it do with garbage" is a question the type does not answer.
//!
//! # A correction to #4498's framing
//!
//! #4498 asks for properties on "version-vector **merge** in `sync_protocol` —
//! commutativity, idempotence, monotonicity". There is no vv merge in this
//! crate: `sync_protocol` only ever *compares* version vectors, and merging is
//! loro's own `VersionVector::merge`, reached through `agaric-engine`. So
//! commutativity and idempotence do not apply here. What the comparisons do
//! have is an order structure — reflexivity, transitivity and monotonicity of
//! the dominance relation — and that is what this file pins instead. (On
//! transitivity specifically, see its own doc comment: it is a restatement of
//! the order law that `reachability_matches_model` already subsumes, kept for
//! legibility rather than for coverage.) The
//! independently-computed reference #4498 asks for is real: every property
//! below scores the implementation against a model built from the *generated*
//! `(peer, counter)` data, which never calls `VersionVector::decode`.
//!
//! # Falsification record
//!
//! Every property below was shown **red** against a mutation of the code it
//! covers, run against a backup and restored byte-identical afterwards. A
//! property whose failure has not been demonstrated has not been shown to
//! cover anything, so the mutation that killed each one is named here — both
//! as evidence and so a later reader can re-run the exercise rather than trust
//! this paragraph.
//!
//! | mutation | properties it killed |
//! | --- | --- |
//! | `check_reset_required`: `>` → `>=` | `matches_model`, `is_reflexive` |
//! | `check_reset_required`: `>` → `!=` | `matches_model`, `is_antitone_in_local` |
//! | `check_reset_required`: comparison inverted | `matches_model`, `is_antitone_in_local`, `is_monotone_in_peer` |
//! | `check_reset_required`: absent local space reads as covered | `matches_model`, `ignores_every_other_peer_id` |
//! | `check_reset_required`: malformed peer vv decodes to empty | `surfaces_malformed_vvs` |
//! | reachability: `>=` → `>` | `matches_model`, `is_reflexive`, `diagnostic_names_a_real_violator`, and `is_transitive` at its PREMISES (a zero lift makes `a == b`, which a strict gate rejects) rather than at its conclusion |
//! | reachability: absent local peer treated as reachable | `matches_model`, `is_monotone_in_local` |
//! | reachability: diagnostic names `peer_id + 1` | `diagnostic_names_a_real_violator` |
//! | batching: final partial batch dropped | `preserves_the_record_sequence`, `emits_no_empty_batch` |
//! | batching: non-empty guard removed | `emits_no_empty_batch` |
//! | batching: record billed after it is added | `respects_the_cap_except_for_unsplittable_records` |
//! | batching: records packed back-to-front | `preserves_the_record_sequence` |
//! | codec: decoder always returns empty | `round_trip` |
//! | codec: decoder panics on an unparseable blob | `decode_is_total`, `decode_is_a_fixed_point` |
//! | codec: decoder appends a marker | `round_trip`, `decode_is_a_fixed_point` |
//!
//! The one property with no entry is `batching_is_monotone_in_the_cap`. It is
//! not unfalsified — `monotonicity_predicate_catches_a_truncating_cap` shows
//! the predicate failing against a deliberately non-monotone control — but no
//! mutation of the *production* pass reaches it, and its doc comment measures
//! exactly why: the window is a truncated cap of 252 through 255, and the
//! record strategy does not reach the 126-byte floor that window needs.
//!
//! # Configuration
//!
//! proptest's default 256 cases. Every case is pure map/byte work — no engine,
//! no I/O — so the whole file is well under a second; there is no reason to
//! tune the count down. Failing seeds auto-save under
//! `proptest-regressions/sync_protocol/`.

use std::collections::BTreeMap;

use proptest::prelude::*;

use agaric_store::space::SpaceId;
use loro::{Counter, PeerID, VersionVector};

use super::loro_sync::classify_from_vv_reachability;
use super::operations::{batch_ops_for_wire, billed_bytes, check_reset_required};
use super::types::{
    OpTransfer, SpaceVersionVector, decode_persisted_loro_vvs, encode_persisted_loro_vvs,
};

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/// A version vector as the *generator* thinks of it: peer id → counter.
///
/// `BTreeMap` rather than `HashMap` so a shrunk counter-example prints in a
/// stable order; the production side is an `FxHashMap` and the ordering is not
/// part of anything asserted here.
type VvModel = BTreeMap<PeerID, Counter>;

/// Encode a model vv into the opaque bytes production passes around.
///
/// `set_last` stores `counter + 1` as the vv "end", and removes the key
/// entirely when that end is `0` — so a model counter of `0` yields an *absent*
/// entry, which is exactly how both functions under test read it (`unwrap_or(0)`
/// on one side, `continue` on the other). The model and the bytes therefore
/// agree on zero without either side special-casing it.
///
/// **A coverage limit that follows from this, and cannot be lifted here.**
/// Because loro removes the key rather than storing an end of `0`, no vv these
/// generators produce carries an *explicit* zero-counter entry — and neither
/// can any vv loro itself produces, since `set_last` is the only way in. So
/// production's two zero guards (`loro_sync.rs`'s `if peer_counter == 0
/// { continue }` and `check_reset_required`'s `if peer_own == 0 { continue }`)
/// are reached in these properties only through an *absent* peer, never a
/// present-but-zero one. That is not a gap the generators can close: those
/// guards are defensive against a shape the encoding cannot express, and no
/// property here distinguishes "absent" from "counter zero" because loro does
/// not either. Worth knowing before reading a surviving mutant on either guard
/// as a missing test.
fn encode_vv(model: &VvModel) -> Vec<u8> {
    let mut vv = VersionVector::new();
    for (&peer, &counter) in model {
        if counter > 0 {
            vv.set_last(loro::ID::new(peer, counter - 1));
        }
    }
    vv.encode()
}

/// The model's counter for `peer`, with absent reading as `0`.
fn model_counter(model: &VvModel, peer: PeerID) -> Counter {
    model.get(&peer).copied().unwrap_or(0)
}

/// A space id built from an index. `SpaceId::from_trusted` skips the parse, but
/// these are still well-formed 26-character Crockford base32 ULIDs (leading `0`
/// keeps them inside the 128-bit range, and every character is in the alphabet)
/// so nothing downstream can tell them from production ids.
fn space(i: usize) -> SpaceId {
    SpaceId::from_trusted(&format!("01HZVV{i:020}"))
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/// Peer ids drawn from a small pool. A wide `u64` range would make collisions —
/// the only interesting case, since a comparison between two vvs that share no
/// peer id is trivially vacuous — vanishingly rare.
fn peer_id() -> impl Strategy<Value = PeerID> {
    (0u64..6).prop_map(|i| 1_000 + i)
}

/// Counters biased small and including `0`, which is the boundary both
/// functions treat specially (absent entry / "carries no ops, skip").
fn counter() -> impl Strategy<Value = Counter> {
    prop_oneof![
        3 => 0i32..4,
        1 => 4i32..1_000,
    ]
}

fn vv_model() -> impl Strategy<Value = VvModel> {
    prop::collection::btree_map(peer_id(), counter(), 0..6)
}

/// A per-space set of model vvs. Space indices are drawn from a small pool and
/// collected into a map, so the space ids are **distinct** — which is what
/// `collect_local_loro_vvs` produces. Duplicate space ids are left out
/// deliberately: `check_reset_required` resolves them through a `HashMap`
/// collect, so "which duplicate wins" is an accident of insertion order rather
/// than a contract, and a property test that pinned it would be freezing an
/// implementation detail as a promise.
fn space_vvs() -> impl Strategy<Value = BTreeMap<usize, VvModel>> {
    prop::collection::btree_map(0usize..4, vv_model(), 0..4)
}

fn to_wire(models: &BTreeMap<usize, VvModel>) -> Vec<SpaceVersionVector> {
    models
        .iter()
        .map(|(&i, m)| SpaceVersionVector {
            space_id: space(i),
            vv: encode_vv(m),
        })
        .collect()
}

/// An `OpTransfer` whose serialized size varies over roughly an order of
/// magnitude, so a `max_bytes` in the low hundreds actually produces multiple
/// batches instead of always one.
fn op_transfer() -> impl Strategy<Value = OpTransfer> {
    (
        "[a-z]{1,12}",
        0i64..1_000,
        prop::option::of("[0-9,]{1,8}"),
        "[a-f0-9]{4,16}",
        prop::sample::select(vec!["create_block", "edit_block", "delete_block"]),
        prop_oneof![
            // Mostly short printable payloads, so a mid-range `max_bytes`
            // actually fits several records per batch — the regime where a
            // wrong cap changes the partition rather than just producing
            // singletons either way.
            3 => "[ -~]{0,40}".prop_map(|s| s.chars().collect::<Vec<char>>()),
            1 => prop::collection::vec(any::<char>(), 0..20),
        ],
        0i64..2_000_000_000_000,
        prop::sample::select(vec!["user", "agent:mcp"]),
    )
        .prop_map(
            |(device_id, seq, parent_seqs, hash, op_type, payload, created_at, origin)| {
                OpTransfer {
                    device_id,
                    seq,
                    parent_seqs,
                    hash,
                    op_type: op_type.to_string(),
                    payload: payload.into_iter().collect(),
                    created_at,
                    origin: origin.to_string(),
                }
            },
        )
}

// ---------------------------------------------------------------------------
// `check_reset_required` — own-lineage loss (#2502, #602)
// ---------------------------------------------------------------------------

/// The independent reference: a reset is required exactly when the peer claims,
/// for **our own** peer id, a positive counter strictly greater than what we
/// hold for that space — with a space we hold no vv for reading as `0`.
///
/// Built from the generated model maps. It never decodes a vv, so it cannot
/// share a decode bug with the implementation.
fn model_reset_required(
    own: PeerID,
    local: &BTreeMap<usize, VvModel>,
    peer: &BTreeMap<usize, VvModel>,
) -> bool {
    peer.iter().any(|(space_idx, peer_model)| {
        let peer_own = model_counter(peer_model, own);
        if peer_own == 0 {
            return false;
        }
        let local_own = local.get(space_idx).map_or(0, |m| model_counter(m, own));
        peer_own > local_own
    })
}

proptest! {
    /// The decision agrees with the model on every shape the generators reach.
    #[test]
    fn check_reset_required_matches_model(
        own in peer_id(),
        local in space_vvs(),
        peer in space_vvs(),
    ) {
        let got = check_reset_required(own, &to_wire(&local), &to_wire(&peer)).unwrap();
        prop_assert_eq!(got, model_reset_required(own, &local, &peer));
    }

    /// A peer advertising exactly our own state never asks us to reset.
    ///
    /// This is the property #602 was: a device whose peer is perfectly in step
    /// with it must be able to sync, and a comparison that mis-handles the
    /// equal case puts it into permanent snapshot catch-up.
    #[test]
    fn check_reset_required_is_reflexive(own in peer_id(), vvs in space_vvs()) {
        let wire = to_wire(&vvs);
        prop_assert!(!check_reset_required(own, &wire, &wire).unwrap());
    }

    /// Holding **more** locally can only ever remove the need for a reset.
    ///
    /// Antitone in the local side: if we gain ops we never newly conclude that
    /// we lost our tail.
    #[test]
    fn check_reset_required_is_antitone_in_local(
        own in peer_id(),
        local in space_vvs(),
        peer in space_vvs(),
        bump in 0i32..50,
    ) {
        let before = check_reset_required(own, &to_wire(&local), &to_wire(&peer)).unwrap();

        let mut raised = local.clone();
        for model in raised.values_mut() {
            let c = model.entry(own).or_insert(0);
            *c = c.saturating_add(bump);
        }
        let after = check_reset_required(own, &to_wire(&raised), &to_wire(&peer)).unwrap();

        prop_assert!(
            before || !after,
            "raising our own local counters turned a no-reset into a reset \
             (before={before}, after={after}, bump={bump})",
        );
    }

    /// The peer holding **more** of our ops can only ever add the need for a
    /// reset — monotone in the peer side, the mirror of the property above.
    #[test]
    fn check_reset_required_is_monotone_in_peer(
        own in peer_id(),
        local in space_vvs(),
        peer in space_vvs(),
        bump in 0i32..50,
    ) {
        let before = check_reset_required(own, &to_wire(&local), &to_wire(&peer)).unwrap();

        let mut raised = peer.clone();
        for model in raised.values_mut() {
            let c = model.entry(own).or_insert(0);
            *c = c.saturating_add(bump);
        }
        let after = check_reset_required(own, &to_wire(&local), &to_wire(&raised)).unwrap();

        prop_assert!(
            !before || after,
            "raising the peer's claim on our own ops turned a reset into a \
             no-reset (before={before}, after={after}, bump={bump})",
        );
    }

    /// #602's actual bug shape, as a property: **nothing** either side holds
    /// for a peer id other than our own can change the answer.
    ///
    /// The peer being ahead for other peer ids is the normal case — they simply
    /// hold more state and we pull it. The retired op-log-seq lookup mis-fired
    /// on exactly this, and no single example pins "for all other-peer edits".
    #[test]
    fn check_reset_required_ignores_every_other_peer_id(
        own in peer_id(),
        local in space_vvs(),
        peer in space_vvs(),
        noise in space_vvs(),
    ) {
        let before = check_reset_required(own, &to_wire(&local), &to_wire(&peer)).unwrap();

        // Overlay `noise` onto both sides for every peer id EXCEPT our own.
        let overlay = |base: &BTreeMap<usize, VvModel>| {
            let mut out = base.clone();
            for (space_idx, noise_model) in &noise {
                let target = out.entry(*space_idx).or_default();
                for (&p, &c) in noise_model {
                    if p != own {
                        target.insert(p, c);
                    }
                }
            }
            out
        };

        let after = check_reset_required(
            own,
            &to_wire(&overlay(&local)),
            &to_wire(&overlay(&peer)),
        )
        .unwrap();

        prop_assert_eq!(before, after);
    }

    /// A malformed vv is a protocol error on **either** side — never a silent
    /// answer.
    ///
    /// The local side is the one worth stating: `check_reset_required` reads a
    /// space it holds no vv for as counter `0`, which is correct for a genuinely
    /// absent space and would be badly wrong for a corrupt one — it would force
    /// a full snapshot rebuild of a space we actually hold. The two cases must
    /// stay distinguishable.
    #[test]
    fn check_reset_required_surfaces_malformed_vvs(
        own in peer_id(),
        garbage in prop::collection::vec(any::<u8>(), 1..40),
        good in vv_model(),
        corrupt_local in any::<bool>(),
    ) {
        // Branch on whether the blob decodes rather than `prop_assume!`-ing it
        // away. Random bytes essentially never form a valid vv today, so the
        // assume would filter almost nothing — but "almost nothing" is a
        // property of loro's framing strictness, not of this test. A future
        // loro that tolerated trailing bytes or short frames would push the
        // reject count into proptest's global cap and this would abort with
        // "Too many global rejects", reporting a harness failure and silently
        // ceasing to cover the error path. Branching covers both arms and
        // cannot be rejected.
        let decodes = VersionVector::decode(&garbage).is_ok();

        // A positive own-counter on the peer side, so the local lookup is
        // actually reached rather than short-circuited by the `peer_own == 0`
        // skip.
        let mut peer_model = good.clone();
        peer_model.insert(own, 7);

        let (local, peer) = if corrupt_local {
            (
                vec![SpaceVersionVector { space_id: space(0), vv: garbage }],
                vec![SpaceVersionVector { space_id: space(0), vv: encode_vv(&peer_model) }],
            )
        } else {
            (
                vec![SpaceVersionVector { space_id: space(0), vv: encode_vv(&good) }],
                vec![SpaceVersionVector { space_id: space(0), vv: garbage }],
            )
        };

        let got = check_reset_required(own, &local, &peer);
        if decodes {
            prop_assert!(
                got.is_ok(),
                "a vv that DOES decode must produce a decision, not an error",
            );
        } else {
            prop_assert!(
                got.is_err(),
                "a vv that does not decode must be a protocol error, not a decision",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// `classify_from_vv_reachability` — the delta-apply gate
// ---------------------------------------------------------------------------

/// The independent reference for reachability: every positive counter the peer
/// holds must be matched by a local counter at least as high.
fn model_reachable(local: &VvModel, peer: &VvModel) -> bool {
    peer.iter()
        .all(|(&p, &c)| c == 0 || model_counter(local, p) >= c)
}

/// Every peer id that witnesses unreachability, for the diagnostic property.
fn model_violators(local: &VvModel, peer: &VvModel) -> Vec<PeerID> {
    peer.iter()
        .filter(|&(&p, &c)| c > 0 && model_counter(local, p) < c)
        .map(|(&p, _)| p)
        .collect()
}

proptest! {
    /// The gate agrees with the model, and `Some`/`None` line up with
    /// unreachable/reachable.
    #[test]
    fn reachability_matches_model(local in vv_model(), peer in vv_model()) {
        let got = classify_from_vv_reachability(&encode_vv(&local), &encode_vv(&peer)).unwrap();
        prop_assert_eq!(got.is_none(), model_reachable(&local, &peer));
    }

    /// Our own state is always reachable from itself — the delta gate never
    /// rejects a peer that is exactly in step with us.
    #[test]
    fn reachability_is_reflexive(vv in vv_model()) {
        let bytes = encode_vv(&vv);
        prop_assert!(classify_from_vv_reachability(&bytes, &bytes).unwrap().is_none());
    }

    /// Dominance is **transitive**: if `b` is reachable from `a` and `c` from
    /// `b`, then `c` is reachable from `a`.
    ///
    /// **This adds no coverage, and the earlier version of this comment
    /// claimed otherwise.** Dominance is pointwise `>=`, so transitivity is a
    /// property of the *relation*, not of its implementation: any gate that
    /// agrees with `model_reachable` is transitive automatically, and
    /// `reachability_matches_model` already pins that agreement. Worse, the
    /// chain below is built by pointwise non-negative lifting, so `a >= b >= c`
    /// holds elementwise by construction and the conclusion re-checks the same
    /// per-peer comparisons the two premises did. No correct-but-non-transitive
    /// gate can be expressed under this construction, so none can be caught.
    ///
    /// Kept anyway, and deliberately: it states the order law in the file that
    /// depends on it, and it is the cheapest place for a reader to see what
    /// "reachable" is supposed to mean. It is documentation that executes, not
    /// a guard — which is worth having, as long as nobody counts it twice.
    ///
    /// The chain is **constructed**, not filtered. Drawing three independent
    /// vvs and `prop_assume!`-ing the two premises rejects roughly 95% of
    /// cases and aborts the run on proptest's global-reject cap — three random
    /// vectors almost never form a chain. Lifting each link by a non-negative
    /// per-peer delta keeps every case useful, and the premises are still
    /// *asserted* against the gate rather than taken on trust, so a gate that
    /// disagreed with the construction would fail here rather than pass
    /// vacuously.
    #[test]
    fn reachability_is_transitive(
        c in vv_model(),
        lift_b in vv_model(),
        lift_a in vv_model(),
    ) {
        // Raise every counter the delta names, adding the peer if it is new.
        // `counter()` never yields a negative, so each lift is monotone.
        let lift = |base: &VvModel, delta: &VvModel| -> VvModel {
            let mut out = base.clone();
            for (&p, &d) in delta {
                let entry = out.entry(p).or_insert(0);
                *entry = entry.saturating_add(d);
            }
            out
        };
        let b = lift(&c, &lift_b);
        let a = lift(&b, &lift_a);

        let (ea, eb, ec) = (encode_vv(&a), encode_vv(&b), encode_vv(&c));
        prop_assert!(
            classify_from_vv_reachability(&ea, &eb).unwrap().is_none(),
            "premise: a was lifted from b, so b must be reachable from a",
        );
        prop_assert!(
            classify_from_vv_reachability(&eb, &ec).unwrap().is_none(),
            "premise: b was lifted from c, so c must be reachable from b",
        );
        prop_assert!(
            classify_from_vv_reachability(&ea, &ec).unwrap().is_none(),
            "a covers b and b covers c, but a does not cover c",
        );
    }

    /// Holding more locally can only ever make a peer's delta acceptable —
    /// monotone in the local side.
    #[test]
    fn reachability_is_monotone_in_local(
        local in vv_model(),
        peer in vv_model(),
        bump in 0i32..50,
    ) {
        let before =
            classify_from_vv_reachability(&encode_vv(&local), &encode_vv(&peer))
                .unwrap()
                .is_none();

        let mut raised = local.clone();
        for c in raised.values_mut() {
            *c = c.saturating_add(bump);
        }
        let after = classify_from_vv_reachability(&encode_vv(&raised), &encode_vv(&peer))
            .unwrap()
            .is_none();

        prop_assert!(
            !before || after,
            "gaining local ops turned a reachable from_vv into an unreachable one",
        );
    }

    /// When the gate rejects, its diagnostic names a peer id that **actually**
    /// witnesses the rejection.
    ///
    /// The reason string is what reaches `SyncMessage::ResetRequired::reason`
    /// and the telemetry, so a message naming the wrong peer sends whoever
    /// debugs a stuck sync to the wrong device. Only *a* violator is asserted,
    /// not a specific one: the gate iterates an `FxHashMap`, so which of
    /// several violators it reports is genuinely unspecified.
    #[test]
    fn reachability_diagnostic_names_a_real_violator(
        local in vv_model(),
        peer in vv_model(),
    ) {
        let got = classify_from_vv_reachability(&encode_vv(&local), &encode_vv(&peer)).unwrap();
        let Some(reason) = got else { return Ok(()) };

        let violators = model_violators(&local, &peer);
        prop_assert!(
            !violators.is_empty(),
            "the gate rejected but the model finds no violating peer: {reason}",
        );
        prop_assert!(
            violators.iter().any(|p| reason.contains(&format!("peer={p} "))),
            "the diagnostic names no genuinely-violating peer \
             (violators={violators:?}): {reason}",
        );
    }
}

// ---------------------------------------------------------------------------
// `batch_ops_for_wire` — the audit-record partition (#2481)
// ---------------------------------------------------------------------------

proptest! {
    /// The partition is exactly that: concatenating the batches reproduces the
    /// input, in order and with the same multiplicity. Nothing is dropped,
    /// duplicated or reordered.
    #[test]
    fn batching_preserves_the_record_sequence(
        records in prop::collection::vec(op_transfer(), 0..40),
        max_bytes in 1usize..1_200,
    ) {
        let batches = batch_ops_for_wire(records.clone(), max_bytes);
        let flattened: Vec<OpTransfer> = batches.into_iter().flatten().collect();
        prop_assert_eq!(flattened, records);
    }

    /// No empty batch is ever emitted, and an empty input sends nothing at all
    /// — the caller's "then send no `OpLogBatch`" branch depends on the latter.
    #[test]
    fn batching_emits_no_empty_batch(
        records in prop::collection::vec(op_transfer(), 0..40),
        max_bytes in 1usize..1_200,
    ) {
        let empty = records.is_empty();
        let batches = batch_ops_for_wire(records, max_bytes);
        prop_assert_eq!(batches.is_empty(), empty);
        prop_assert!(batches.iter().all(|b| !b.is_empty()));
    }

    /// Every batch respects the cap, with the single documented exception: a
    /// lone record that cannot be split ships in a batch of its own rather than
    /// being dropped.
    #[test]
    fn batching_respects_the_cap_except_for_unsplittable_records(
        records in prop::collection::vec(op_transfer(), 0..40),
        max_bytes in 1usize..1_200,
    ) {
        for batch in batch_ops_for_wire(records, max_bytes) {
            // Calling the production `billed_bytes` here does NOT pin it —
            // this property targets the partitioning loop, and would hold for
            // any consistent formula. The pin lives in
            // `monotonicity_predicate_catches_a_truncating_cap` below, which
            // asserts a literal byte count against it (#4525).
            let billed: usize = batch.iter().map(billed_bytes).sum();
            prop_assert!(
                batch.len() == 1 || billed <= max_bytes,
                "a multi-record batch exceeded the cap: {billed} > {max_bytes}",
            );
        }
    }

    /// A larger cap never produces more batches.
    ///
    /// True of this greedy first-fit pass but not of packing in general, and
    /// it is the property that would break first if the loop were ever
    /// rewritten to reorder records to fill batches.
    ///
    /// **On its strength, measured rather than argued.** Every other property
    /// here was shown red against a mutation of the code it covers. This one
    /// was not, and the reason is a fact about the generator rather than about
    /// the pass: see `monotonicity_predicate_catches_a_truncating_cap` below,
    /// which demonstrates that the predicate *does* have power, against a
    /// deliberately non-monotone control.
    ///
    /// The realistic non-monotone bug is a truncating cast on `max_bytes`
    /// (`cast_possible_truncation`, which this repo lints for). It can only
    /// change the partition where a `u8`-truncated cap still fits TWO records,
    /// i.e. at a cap of `2 x` the smallest record or above, with a ceiling of
    /// 255. The smallest `OpTransfer` this strategy can produce bills at 126
    /// bytes, so that window is a truncated cap of 252 through 255 — and over
    /// 20,000 sampled records the strategy never reached the floor (smallest
    /// observed: 142 bytes, whose pair needs 284). So the random search does
    /// not reach the window, which is why no mutation of the pass turned this
    /// red.
    ///
    /// That 126 is the *third* value this floor has been given, and the first
    /// two were each wrong in an instructive way. 106 was the empty-`OpTransfer`
    /// serialization — the TYPE's floor, when the quantity that matters is
    /// twice the STRATEGY's. 127 was the strategy's floor computed with
    /// `parent_seqs: None`, which serializes as `"parent_seqs":null` — but the
    /// strategy can also yield `Some("0")`, and `"parent_seqs":"0"` is one byte
    /// shorter. Derive it, do not estimate it; `tmp`-probe it against
    /// `billed_bytes` if it ever needs re-deriving.
    ///
    /// It is kept as written. Widening the generator to hit a two-in-256 cap
    /// window would trade a reliable property for a flaky one; the control
    /// below covers the same ground deterministically.
    #[test]
    fn batching_is_monotone_in_the_cap(
        records in prop::collection::vec(op_transfer(), 0..40),
        max_bytes in 1usize..1_200,
        extra in 0usize..1_200,
    ) {
        let small = batch_ops_for_wire(records.clone(), max_bytes).len();
        let large = batch_ops_for_wire(records, max_bytes + extra).len();
        prop_assert!(
            large <= small,
            "raising the cap from {max_bytes} to {} produced MORE batches \
             ({small} -> {large})",
            max_bytes + extra,
        );
    }
}

/// `batch_ops_for_wire`'s loop with one deliberate defect: the cap is truncated
/// through a `u8`. Used only by the validation control below.
///
/// A copy of production rather than a call into it, because the point is to
/// have something the monotonicity predicate can *fail* on — which is the only
/// way to show the predicate is not vacuous, since the real function is (as far
/// as this file can establish) correct.
///
/// **Nothing enforces that this stays a copy**, and that is the one way this
/// control can rot: rewrite `batch_ops_for_wire` (`operations.rs`, `pub fn
/// batch_ops_for_wire`) and this keeps exercising the old loop, keeps passing,
/// and silently stops being a control for the property it backs. Re-sync it by
/// hand whenever that loop changes shape. There is no clone-pin guard for Rust
/// the way `scripts/check-mutation-harness-clones.mjs` does it for the JS
/// harnesses, so this comment is the whole mechanism.
fn batch_with_truncated_cap(records: Vec<OpTransfer>, max_bytes: usize) -> Vec<Vec<OpTransfer>> {
    #[allow(clippy::cast_possible_truncation)]
    let max_bytes = max_bytes as u8 as usize;
    let mut batches: Vec<Vec<OpTransfer>> = Vec::new();
    let mut current: Vec<OpTransfer> = Vec::new();
    let mut current_bytes: usize = 0;
    for rec in records {
        let rec_bytes = billed_bytes(&rec);
        if !current.is_empty() && current_bytes + rec_bytes > max_bytes {
            batches.push(std::mem::take(&mut current));
            current_bytes = 0;
        }
        current_bytes += rec_bytes;
        current.push(rec);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

/// Validation control for `batching_is_monotone_in_the_cap` — the same pattern
/// the in-page-find sweep harness uses, and for the same reason: a property
/// that never fails proves nothing until you have seen it fail.
///
/// The predicate is applied to `batch_with_truncated_cap`, which is the real
/// loop plus a truncating cast, over records at the strategy's exact 126-byte
/// floor (`parent_seqs: Some("0")` — one byte shorter than `None`). A cap of
/// 252 pairs them (2 x 126, and the split test is strictly greater-than); 256
/// truncates to 0 and cannot. Twenty batches becomes forty on a *larger* cap,
/// which is precisely what the property forbids.
#[test]
fn monotonicity_predicate_catches_a_truncating_cap() {
    let floor = OpTransfer {
        device_id: "a".to_string(),
        seq: 0,
        // `Some("0")`, not `None`: `"parent_seqs":"0"` is one byte shorter
        // than `"parent_seqs":null`, and this record has to be the strategy's
        // actual minimum for the window arithmetic above to be the real one.
        parent_seqs: Some("0".to_string()),
        hash: "0000".to_string(),
        op_type: "edit_block".to_string(),
        payload: String::new(),
        created_at: 0,
        origin: "user".to_string(),
    };
    assert_eq!(
        billed_bytes(&floor),
        126,
        "the 126-byte floor is load-bearing for the window this control targets \
         and for the doc comment above; if the wire shape changed, both need \
         re-deriving rather than this number nudging"
    );

    let records: Vec<OpTransfer> = std::iter::repeat_n(floor, 40).collect();
    let small = batch_with_truncated_cap(records.clone(), 252).len();
    let large = batch_with_truncated_cap(records, 256).len();

    assert_eq!(small, 20, "a cap of 252 must pair 126-byte records");
    assert_eq!(large, 40, "256 truncates to 0, so nothing pairs");
    assert!(
        large > small,
        "the control is supposed to VIOLATE monotonicity; if it stopped doing \
         so, `batching_is_monotone_in_the_cap` would be unfalsified again"
    );
}

/// Generator coverage: the batching properties above are only meaningful if the
/// generated records and caps actually reach the regime where a batch holds
/// **several** records. With a 126-byte floor per record — the figure derived
/// in `batching_is_monotone_in_the_cap`, which is also where the two earlier
/// wrong values for it are recorded — a cap range that sat below ~300 would
/// make every batch a singleton and quietly turn three properties vacuous —
/// they would all still pass.
///
/// This is a plain `#[test]`, not a property: it asserts a fact about the
/// *strategies*, sampled through proptest's deterministic runner so it cannot
/// flake between runs.
///
/// It CAN move between proptest versions, though, and the failure would point
/// at the wrong thing. `TestRunner::deterministic()` is deterministic given a
/// fixed RNG and fixed per-strategy entropy consumption, both of which are
/// proptest internals; the dev-dependency is a caret range (`"1.11.0"`, matching
/// the four sibling crates), so a semver-compatible bump can change what is
/// sampled with nothing in this repo changing. The margins are wide — the
/// observed floor is ~142 bytes against a 300-byte assertion, and ~6 records
/// per batch against an assertion of 3 — so this is unlikely rather than
/// impossible. If it ever does fail right after a lockfile bump, suspect the
/// bump before suspecting `op_transfer`.
#[test]
fn batching_generators_reach_the_multi_record_regime() {
    use proptest::strategy::{Strategy as _, ValueTree as _};
    use proptest::test_runner::TestRunner;

    let mut runner = TestRunner::deterministic();
    let records: Vec<OpTransfer> = (0..40)
        .map(|_| {
            op_transfer()
                .new_tree(&mut runner)
                .expect("sample an OpTransfer")
                .current()
        })
        .collect();

    let smallest = records.iter().map(billed_bytes).min().expect("non-empty");
    assert!(
        smallest < 300,
        "the record strategy got heavier than the cap range: smallest billed \
         size is {smallest} bytes, so a cap under 300 can never pair records"
    );

    // The top of the `max_bytes` range used by the properties above.
    let widest = batch_ops_for_wire(records, 1_199);
    let fullest = widest.iter().map(Vec::len).max().unwrap_or(0);
    assert!(
        fullest >= 3,
        "at the widest cap the fullest batch held only {fullest} record(s) — \
         the batching properties are running on singletons and prove nothing \
         about packing"
    );
}

// ---------------------------------------------------------------------------
// `peer_refs.loro_vv_bytes` — the persisted per-peer bookmark (#2502)
// ---------------------------------------------------------------------------

proptest! {
    /// Round-trip: what we persist is what we read back.
    #[test]
    fn persisted_vvs_round_trip(vvs in space_vvs()) {
        let wire = to_wire(&vvs);
        prop_assert_eq!(decode_persisted_loro_vvs(&encode_persisted_loro_vvs(&wire)), wire);
    }

    /// The decoder is **total** over arbitrary bytes: it returns, for anything.
    ///
    /// Its signature says so — `Vec`, not `Result` — but the signature is a
    /// claim about the return type, not about termination, and this blob comes
    /// off disk after having come off the wire. The stated contract is that a
    /// malformed or legacy blob reads as "no persisted frontier", so the
    /// fallback is a full snapshot rather than a panic on a peer-supplied byte
    /// string.
    #[test]
    fn persisted_vv_decode_is_total(bytes in prop::collection::vec(any::<u8>(), 0..256)) {
        let _ = decode_persisted_loro_vvs(&bytes);
    }

    /// Decoding is a **fixed point**: whatever arbitrary bytes decode to,
    /// re-encoding and decoding that again yields the same list.
    ///
    /// This is the part totality alone does not give you. It rules out a
    /// decoder that accepts a blob into some shape its own encoder cannot
    /// express — which would persist a bookmark that reads back as a
    /// *different* frontier on the next session, and a wrong frontier ships a
    /// delta against state the peer does not have.
    #[test]
    fn persisted_vv_decode_is_a_fixed_point(
        bytes in prop::collection::vec(any::<u8>(), 0..256),
    ) {
        let once = decode_persisted_loro_vvs(&bytes);
        let twice = decode_persisted_loro_vvs(&encode_persisted_loro_vvs(&once));
        prop_assert_eq!(twice, once);
    }
}
