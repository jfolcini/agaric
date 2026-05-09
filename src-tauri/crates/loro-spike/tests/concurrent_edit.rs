//! Day-2 integration test for `LoroEngine` — the headline CRDT
//! property: two devices apply *different* edits to the same block's
//! content, exchange exports, and converge on the same merged string.
//!
//! No coordinator is involved — Loro's underlying RGA-derived text
//! algorithm picks the deterministic merged ordering.  All we assert is
//! eventual consistency: after both engines have observed both edits,
//! their `read_block(...).content` is byte-identical.
//!
//! This test exists because day 1's round-trip alone could be satisfied
//! by `LoroValue::String` (which we shipped on day 1) — that shape
//! could *not* survive divergent edits.  Day 2 swapped `content` to a
//! `LoroText` container, and this test is the proof that the swap
//! actually buys us character-level CRDT semantics rather than just
//! changing the storage shape.

use loro_spike::LoroEngine;

const PAGE_ID: &str = "page-01";
const BLOCK_ID: &str = "block-01";
const INITIAL: &str = "The quick brown fox";

/// Helper: bring a fresh engine up to the shared starting state both
/// peers diverge from.  We create a parent page + the block under
/// edit; in production this is what would already be in both devices'
/// local Loro doc before the user starts typing.
fn make_engine_with_initial() -> LoroEngine {
    let mut engine = LoroEngine::new();
    engine
        .apply_create_block(PAGE_ID, "page", "Spike Page", None, 0)
        .expect("seed page");
    engine
        .apply_create_block(BLOCK_ID, "text", INITIAL, Some(PAGE_ID), 1_000)
        .expect("seed block");
    engine
}

#[test]
fn divergent_edits_converge_after_export_swap() {
    // Seed both engines to the same starting state via the same op
    // sequence.  In a real deployment they'd have arrived at this
    // state by importing each other's prior exports; for the spike,
    // running identical ops on each is equivalent for the purposes of
    // testing post-divergence merge.
    let mut a = make_engine_with_initial();
    let mut b = make_engine_with_initial();

    // First exchange: bring A and B to a common version.  After this
    // both have observed the initial state from each other and Loro's
    // internal version vector reflects both peer ids.
    let a_seed = a.export_snapshot().expect("export A seed");
    let b_seed = b.export_snapshot().expect("export B seed");
    a.import(&b_seed).expect("A import B seed");
    b.import(&a_seed).expect("B import A seed");

    // Both engines should now agree on the initial content.  Sanity-
    // check before we diverge.
    let a_initial = a
        .read_block(BLOCK_ID)
        .expect("A read initial")
        .expect("A has block");
    let b_initial = b
        .read_block(BLOCK_ID)
        .expect("B read initial")
        .expect("B has block");
    assert_eq!(
        a_initial.content, INITIAL,
        "A should see initial content before divergence"
    );
    assert_eq!(
        b_initial.content, INITIAL,
        "B should see initial content before divergence"
    );

    // Divergent edits.  "The quick brown fox" — Unicode-scalar offsets:
    //  index 0 = 'T'
    //  index 4 = 'q' (start of "quick", len 5)
    //  index 16 = 'f' (start of "fox", len 3)
    //
    // Engine A: "quick" -> "slow"  (offset 4, len 5)
    a.apply_edit_content(BLOCK_ID, 4, 5, "slow")
        .expect("A edit quick->slow");
    let a_after_local = a
        .read_block(BLOCK_ID)
        .expect("A read post-local")
        .expect("A has block")
        .content;
    assert_eq!(
        a_after_local, "The slow brown fox",
        "A's local view should reflect its own edit"
    );

    // Engine B: "fox" -> "dog"  (offset 16, len 3)
    b.apply_edit_content(BLOCK_ID, 16, 3, "dog")
        .expect("B edit fox->dog");
    let b_after_local = b
        .read_block(BLOCK_ID)
        .expect("B read post-local")
        .expect("B has block")
        .content;
    assert_eq!(
        b_after_local, "The quick brown dog",
        "B's local view should reflect its own edit"
    );

    // Each peer exports its full state and imports the other's.  In
    // production this'd be `ExportMode::updates_since(remote_vv)`, but
    // snapshot is fine for the spike: Loro's import is idempotent and
    // ignores ops it has already seen.
    let a_post = a.export_snapshot().expect("export A post-edit");
    let b_post = b.export_snapshot().expect("export B post-edit");

    // Doc-byte sizes pre-merge — useful for SPIKE-NOTES baseline.
    eprintln!("pre-merge: A export = {} bytes", a_post.len());
    eprintln!("pre-merge: B export = {} bytes", b_post.len());

    a.import(&b_post).expect("A import B post-edit");
    b.import(&a_post).expect("B import A post-edit");

    let a_merged = a
        .read_block(BLOCK_ID)
        .expect("A read merged")
        .expect("A has block")
        .content;
    let b_merged = b
        .read_block(BLOCK_ID)
        .expect("B read merged")
        .expect("B has block")
        .content;

    // Doc-byte sizes post-merge.
    let a_final_export = a.export_snapshot().expect("export A final");
    let b_final_export = b.export_snapshot().expect("export B final");
    eprintln!("post-merge: A export = {} bytes", a_final_export.len());
    eprintln!("post-merge: B export = {} bytes", b_final_export.len());
    eprintln!("merged content = {a_merged:?}");

    // CRITICAL ASSERTION: convergence.  Whatever string Loro picks,
    // both engines must agree.  This is the headline CRDT property.
    assert_eq!(
        a_merged, b_merged,
        "engines must converge to byte-identical content after exchanging exports"
    );

    // Both edits are non-overlapping (quick vs fox), so an RGA-style
    // text CRDT preserves both.  Pin the expected merged string so we
    // notice if Loro's tie-breaking ever changes shape.
    assert_eq!(
        a_merged, "The slow brown dog",
        "non-overlapping edits should preserve both edits cleanly"
    );
}
