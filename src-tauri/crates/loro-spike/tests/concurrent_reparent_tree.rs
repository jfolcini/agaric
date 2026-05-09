//! PEND-09 Phase 0 day-5 — open question 5 (concurrent-reparent
//! semantics) measured against `TreeEngine` (LoroTree-shaped).
//!
//! The day-3 `parity_corpus.rs` test
//! `parity_concurrent_reparent_different_parents` runs the same scenario
//! against `LoroEngine` (the LoroMap-shaped engine that keeps
//! `parent_id` as a scalar field).  That engine resolves concurrent
//! reparents via LWW per key — the loser's intent is dropped silently.
//!
//! This test asks: does Loro's *native* movable-tree CRDT do anything
//! different?  Specifically:
//!
//! 1. Both peers start from the same state: `CHILD` under `PAGE_X`.
//! 2. Engine A reparents `CHILD` to `PAGE_Y`.
//! 3. Engine B (concurrently, no sync between A and B) reparents
//!    `CHILD` to `PAGE_Z`.
//! 4. Both engines exchange snapshots.
//! 5. Assertion 1: both engines converge to the SAME final parent.
//! 6. Observation: which parent did the CRDT pick, and is the loser's
//!    move recorded anywhere observable (so a UI could surface "your
//!    move was overridden")?
//!
//! Compare this against `parity_concurrent_reparent_different_parents`
//! in `tests/parity_corpus.rs` — that test also expects convergence on
//! one parent.  Headline question for the SPIKE-NOTES Day 5 section:
//! does `LoroTree` produce a *different / better* answer than
//! `LoroMap`+scalar?

use loro_spike::TreeEngine;

/// Two `TreeEngine`s pre-seeded with `seed`, then snapshot-exchanged so
/// both peers share the same starting state and Loro recognises them as
/// causally related.  Mirrors `two_peers_from_seed` in
/// `tests/parity_corpus.rs`.
fn two_peers_from_seed(seed: impl Fn(&mut TreeEngine)) -> (TreeEngine, TreeEngine) {
    let mut a = TreeEngine::new();
    let mut b = TreeEngine::new();
    seed(&mut a);
    seed(&mut b);
    let a_seed = a.export_snapshot().expect("seed export A");
    let b_seed = b.export_snapshot().expect("seed export B");
    a.import(&b_seed).expect("seed import B->A");
    b.import(&a_seed).expect("seed import A->B");
    (a, b)
}

fn sync(a: &mut TreeEngine, b: &mut TreeEngine) {
    let a_bytes = a.export_snapshot().expect("export A");
    let b_bytes = b.export_snapshot().expect("export B");
    a.import(&b_bytes).expect("import B->A");
    b.import(&a_bytes).expect("import A->B");
}

#[test]
fn tree_concurrent_reparent_different_parents_converges() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("PAGE_X", "page", "X", None, 0)
            .expect("X");
        e.apply_create_block("PAGE_Y", "page", "Y", None, 1)
            .expect("Y");
        e.apply_create_block("PAGE_Z", "page", "Z", None, 2)
            .expect("Z");
        e.apply_create_block("CHILD", "content", "child", Some("PAGE_X"), 100)
            .expect("child");
    });

    // Pre-divergence sanity: both peers see CHILD under PAGE_X.
    assert_eq!(
        a.read_parent("CHILD").unwrap().as_deref(),
        Some("PAGE_X"),
        "A pre-divergence parent"
    );
    assert_eq!(
        b.read_parent("CHILD").unwrap().as_deref(),
        Some("PAGE_X"),
        "B pre-divergence parent"
    );

    // Concurrent reparent — no sync between the two moves.
    a.apply_move_block("CHILD", Some("PAGE_Y"), 0)
        .expect("A reparent to Y");
    b.apply_move_block("CHILD", Some("PAGE_Z"), 0)
        .expect("B reparent to Z");

    // Pre-merge local view: each peer sees its own move.
    let a_pre = a.read_parent("CHILD").unwrap();
    let b_pre = b.read_parent("CHILD").unwrap();
    assert_eq!(a_pre.as_deref(), Some("PAGE_Y"));
    assert_eq!(b_pre.as_deref(), Some("PAGE_Z"));

    // Sync.
    sync(&mut a, &mut b);

    let a_parent = a.read_parent("CHILD").unwrap();
    let b_parent = b.read_parent("CHILD").unwrap();

    // Convergence — primary assertion.
    assert_eq!(
        a_parent, b_parent,
        "TreeEngine peers must converge on a single parent after sync"
    );
    // The convergent parent must be one of the two reparent destinations
    // (we don't assert WHICH — the CRDT's tiebreak rule decides).
    assert!(
        matches!(a_parent.as_deref(), Some("PAGE_Y") | Some("PAGE_Z")),
        "convergent parent must be one of the two reparent destinations, got {a_parent:?}"
    );

    // Loser's intent — observable?  In the LoroMap+scalar shape (see
    // `LoroEngine`), the loser's parent_id write is overwritten by LWW
    // and there's no record of it.  In `LoroTree`, every move is a
    // distinct op in the doc's oplog (TreeOp::Move is a separate entry
    // from TreeOp::Create — see `loro-internal/src/container/tree/tree_op.rs`).
    // So the OPERATION HISTORY records the loser's move; what the
    // current STATE shows is just the winner.  This is the same
    // "convergent on one winner" semantics as LoroMap+scalar — the
    // difference is that the loser's intent lives in the oplog,
    // potentially surfaceable via Loro's checkout / time-travel API
    // for an "audit" view, whereas LoroMap+scalar's loser write is
    // identical-shape to ANY overwritten LWW write and not
    // distinguishable in the oplog.
    //
    // Bottom line for the spike notes: state is LWW-equivalent; the
    // upside of LoroTree is that the move history is structurally
    // distinct (Tree.Move ops vs LoroMap.insert) — but state-level
    // semantics are the same.
    eprintln!(
        "[tree-reparent] converged parent = {a_parent:?} (LoroTree picked one — loser's intent recorded in oplog as a TreeOp::Move, not in current state)"
    );
}

/// Companion test: same scenario but THREE peers concurrently reparent
/// to three different destinations.  Establishes whether the CRDT's
/// tiebreak rule still produces a single winner under more contention,
/// or starts to show non-deterministic behaviour at higher concurrency.
#[test]
fn tree_concurrent_reparent_three_peers_converges() {
    // Three peers from a common seed.  No helper for 3 peers; inline.
    let mut a = TreeEngine::new();
    let mut b = TreeEngine::new();
    let mut c = TreeEngine::new();

    let seed = |e: &mut TreeEngine| {
        e.apply_create_block("PAGE_X", "page", "X", None, 0)
            .expect("X");
        e.apply_create_block("PAGE_Y", "page", "Y", None, 1)
            .expect("Y");
        e.apply_create_block("PAGE_Z", "page", "Z", None, 2)
            .expect("Z");
        e.apply_create_block("PAGE_W", "page", "W", None, 3)
            .expect("W");
        e.apply_create_block("CHILD", "content", "child", Some("PAGE_X"), 100)
            .expect("child");
    };
    seed(&mut a);
    seed(&mut b);
    seed(&mut c);
    let s_a = a.export_snapshot().unwrap();
    let s_b = b.export_snapshot().unwrap();
    let s_c = c.export_snapshot().unwrap();
    // Cross-import so all three share a common starting history.
    a.import(&s_b).unwrap();
    a.import(&s_c).unwrap();
    b.import(&s_a).unwrap();
    b.import(&s_c).unwrap();
    c.import(&s_a).unwrap();
    c.import(&s_b).unwrap();

    // Three concurrent reparents.
    a.apply_move_block("CHILD", Some("PAGE_Y"), 0).unwrap();
    b.apply_move_block("CHILD", Some("PAGE_Z"), 0).unwrap();
    c.apply_move_block("CHILD", Some("PAGE_W"), 0).unwrap();

    // Cross-sync all three.
    let s_a = a.export_snapshot().unwrap();
    let s_b = b.export_snapshot().unwrap();
    let s_c = c.export_snapshot().unwrap();
    a.import(&s_b).unwrap();
    a.import(&s_c).unwrap();
    b.import(&s_a).unwrap();
    b.import(&s_c).unwrap();
    c.import(&s_a).unwrap();
    c.import(&s_b).unwrap();

    let pa = a.read_parent("CHILD").unwrap();
    let pb = b.read_parent("CHILD").unwrap();
    let pc = c.read_parent("CHILD").unwrap();

    assert_eq!(pa, pb, "A == B must converge");
    assert_eq!(pb, pc, "B == C must converge");
    assert!(
        matches!(
            pa.as_deref(),
            Some("PAGE_Y") | Some("PAGE_Z") | Some("PAGE_W")
        ),
        "convergent parent must be one of the three destinations, got {pa:?}"
    );
    eprintln!("[tree-reparent-3] converged parent = {pa:?}");
}
