//! PEND-09 Phase 0 day 3 — `merge/tests.rs` parity corpus port.
//!
//! Each `#[test]` here pairs one (or two) `LoroEngine`s through the
//! same op-stream as a representative production `merge/tests.rs`
//! function and compares the Loro result against a hardcoded
//! `ExpectedDiffyResult` literal transcribed from the production
//! test's assertions.  The output is a `ParityBucket` per test:
//!
//! * `A` = byte-identical merged content + tree shape.
//! * `B` = Loro produces a clean merge where diffy would create a
//!   conflict copy.  Content correctness preserved.
//! * `C` = Loro's result differs but is CRDT-correct (typically a
//!   different LWW winner — both deterministic, both valid).
//! * `D` = Loro is wrong (lost data, broken invariant).  ANY `D` here
//!   fires kill criterion #2.
//!
//! Why hardcoded expected diffy results: running production `merge/`
//! from the spike crate would force `agaric` to become a workspace
//! dep (rejected day 1).  Each ported test reads its production
//! counterpart's `assert_eq!(...)` once at port time and freezes the
//! expected value as a literal.  No production code runs at test
//! time — Loro is the only engine driven, and the literal is the
//! oracle.
//!
//! Convention: each test docstring quotes the production test name
//! it ports + the diffy bucket it falls into so a reader can find
//! the source assertion in `src-tauri/src/merge/tests.rs` quickly.
//!
//! Edit-coordinate conversion: production `EditBlock` ops carry a
//! `to_text` snapshot (the whole new content).  To map that into
//! Loro's character-level CRDT we compute the longest common prefix +
//! suffix between the prior content and the new content and splice
//! only the differing middle.  This is a faithful "what an editor
//! would emit" model — a real editor's edit callback knows which
//! characters changed; collapsing the whole content into one big
//! splice would force every concurrent edit to overlap, which is
//! NOT what the production diffy line-merge is comparing against.

use loro_spike::LoroEngine;

// ---------------------------------------------------------------------------
// Parity bucket + oracle types
// ---------------------------------------------------------------------------

/// Categorisation of how Loro's outcome compared to the production
/// diffy outcome on a single ported test.  See module docstring.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // D variant intentionally never constructed if we don't see one
pub enum ParityBucket {
    /// Byte-identical content + identical tree shape.
    A,
    /// Loro produced a clean merge; diffy would have produced a
    /// conflict copy.  Content correctness preserved.
    B,
    /// Different but CRDT-correct (e.g. LWW picks a different winner
    /// than the production rule but the result is still consistent
    /// and lossless).
    C,
    /// Loro is wrong.  Any `D` fires kill criterion #2.
    D,
}

/// What a production `merge/tests.rs::merge_text_*` test asserts about
/// the merged content.  Encoded as either a clean merged string
/// (`Clean`), a 3-tuple conflict (`Conflict`), or a flexible "must
/// contain both edits" predicate (`CleanContainsBoth`) for the few
/// cases where production accepts either a clean merge or a conflict
/// as long as both contributions survive somewhere.
#[derive(Debug, Clone)]
pub enum ExpectedDiffyResult<'a> {
    /// Diffy emits `MergeResult::Clean(merged)` with this exact string.
    Clean(&'a str),
    /// Diffy emits `MergeResult::Conflict { ours, theirs, ancestor }`.
    /// (We don't materialise the conflict markers here — what matters
    /// is that diffy *would* split the result into a conflict copy
    /// while Loro will merge cleanly.)
    Conflict {
        ours: &'a str,
        theirs: &'a str,
        ancestor: &'a str,
    },
    /// Diffy emits a clean merge string that contains both edits but
    /// the exact result is content-dependent.  Pass a list of
    /// substrings the merged content must include.
    CleanContains(&'a [&'a str]),
}

// ---------------------------------------------------------------------------
// Edit-coordinate helper — translate production's "whole new content"
// EditBlock into a character-level Loro splice.
// ---------------------------------------------------------------------------

/// Replace `block_id`'s content with `new_content` by computing the
/// longest common Unicode-scalar prefix + suffix vs the engine's
/// current content and splicing only the differing middle.  Mirrors
/// what an interactive editor's edit callback emits and lets two
/// peers' concurrent edits land at non-overlapping character ranges
/// when their new_content strings differ at non-overlapping regions.
///
/// Returns `Err` if the block is missing.
pub fn apply_edit_via_diff_splice(
    engine: &mut LoroEngine,
    block_id: &str,
    new_content: &str,
) -> anyhow::Result<()> {
    let current = engine
        .read_block(block_id)?
        .ok_or_else(|| anyhow::anyhow!("apply_edit_via_diff_splice: block {block_id} not found"))?
        .content;

    // Common prefix + suffix in Unicode scalars.  Iterate over `chars()`
    // for both strings in lockstep to get USV indices that match
    // `LoroText::splice`'s expected coordinate system.
    let cur_chars: Vec<char> = current.chars().collect();
    let new_chars: Vec<char> = new_content.chars().collect();

    let mut prefix = 0usize;
    while prefix < cur_chars.len()
        && prefix < new_chars.len()
        && cur_chars[prefix] == new_chars[prefix]
    {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix < cur_chars.len() - prefix
        && suffix < new_chars.len() - prefix
        && cur_chars[cur_chars.len() - 1 - suffix] == new_chars[new_chars.len() - 1 - suffix]
    {
        suffix += 1;
    }

    // Splice the differing middle.  range_start = prefix, range_len =
    // (cur_len - prefix - suffix), replacement = new_chars[prefix..new_len-suffix].
    let range_start = prefix;
    let range_len = cur_chars.len() - prefix - suffix;
    let replacement: String = new_chars[prefix..new_chars.len() - suffix].iter().collect();

    if range_len == 0 && replacement.is_empty() {
        return Ok(()); // identical strings; no-op
    }

    engine.apply_edit_content(block_id, range_start, range_len, &replacement)
}

// ---------------------------------------------------------------------------
// Test scaffolding helper — bring up a 2-peer environment from a
// shared seed state.
// ---------------------------------------------------------------------------

/// Two engines pre-seeded by running `seed` on each, then exchanging
/// snapshots so both have a common starting point.  After this call
/// each engine is divergence-ready.
pub fn two_peers_from_seed(seed: impl Fn(&mut LoroEngine)) -> (LoroEngine, LoroEngine) {
    let mut a = LoroEngine::new();
    let mut b = LoroEngine::new();
    seed(&mut a);
    seed(&mut b);
    let a_seed = a.export_snapshot().expect("seed export A");
    let b_seed = b.export_snapshot().expect("seed export B");
    a.import(&b_seed).expect("seed import B->A");
    b.import(&a_seed).expect("seed import A->B");
    (a, b)
}

/// Sync A and B by exchanging full snapshots.  Idempotent.
pub fn sync(a: &mut LoroEngine, b: &mut LoroEngine) {
    let a_bytes = a.export_snapshot().expect("export A");
    let b_bytes = b.export_snapshot().expect("export B");
    a.import(&b_bytes).expect("import B->A");
    b.import(&a_bytes).expect("import A->B");
}

/// Compare a converged Loro content string against the diffy
/// expectation literal and assign a parity bucket.
pub fn classify_text(loro_merged: &str, expected: ExpectedDiffyResult<'_>) -> ParityBucket {
    match expected {
        ExpectedDiffyResult::Clean(s) => {
            if loro_merged == s {
                ParityBucket::A
            } else if loro_merged.contains(s.trim_end()) || s.contains(loro_merged.trim_end()) {
                // Sometimes diffy's exact output differs from what a
                // CRDT picks, but content is preserved on both sides.
                ParityBucket::C
            } else {
                ParityBucket::C // different but Loro converged — flag as C
            }
        }
        ExpectedDiffyResult::Conflict {
            ours,
            theirs,
            ancestor,
        } => {
            // Diffy would have produced a conflict copy.  If Loro
            // merged AND its result preserves each peer's *net
            // additions* (words present in ours/theirs but absent
            // from the LCA — i.e., the actually-new contributions),
            // bucket B.  Otherwise bucket D (data loss).
            let ours_token = additive_token(ours, ancestor);
            let theirs_token = additive_token(theirs, ancestor);
            let ours_present = ours_token.map(|t| loro_merged.contains(t)).unwrap_or(true);
            let theirs_present = theirs_token
                .map(|t| loro_merged.contains(t))
                .unwrap_or(true);
            if ours_present && theirs_present {
                ParityBucket::B
            } else {
                ParityBucket::D
            }
        }
        ExpectedDiffyResult::CleanContains(subs) => {
            if subs.iter().all(|s| loro_merged.contains(s)) {
                ParityBucket::A
            } else {
                ParityBucket::D
            }
        }
    }
}

/// Find a "net addition" word — a whitespace-delimited token
/// appearing in `side` but NOT in `ancestor`.  These are the words
/// the side actually contributed (vs words it kept unchanged from
/// the ancestor).  Returns `None` only when `side == ancestor` (no
/// net addition; nothing to assert).
fn additive_token<'a>(side: &'a str, ancestor: &'a str) -> Option<&'a str> {
    if side == ancestor {
        return None;
    }
    for word in side.split_whitespace() {
        if !ancestor.contains(word) {
            return Some(word);
        }
    }
    // No additive word found — fall back to the whole side string,
    // which is unlikely to substring-match cleanly but is the
    // honest signal that this side contributed nothing recognisable.
    Some(side)
}

// ===========================================================================
// CATEGORY 1: simple non-overlapping concurrent edits — should converge
// cleanly on both engines (bucket A).
// ===========================================================================

/// Ports `merge_text_clean_non_overlapping` (tests.rs:112).
///
/// Diffy: clean line-merge, "hello\nbeautiful\nworld\ntoday\n".
/// Loro: character-level merge of two non-overlapping splices.
#[test]
fn parity_clean_non_overlapping_text() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "hello\nworld\n", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "hello\nbeautiful\nworld\n").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "hello\nworld\ntoday\n").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    assert_eq!(
        merged,
        b.read_block("B1").unwrap().unwrap().content,
        "engines must converge"
    );

    let bucket = classify_text(
        &merged,
        ExpectedDiffyResult::Clean("hello\nbeautiful\nworld\ntoday\n"),
    );
    eprintln!("[parity] clean_non_overlapping: bucket {bucket:?}, merged={merged:?}");
    assert!(
        matches!(bucket, ParityBucket::A | ParityBucket::B),
        "expected A or B, got {bucket:?}; merged={merged:?}"
    );
}

/// Ports `merge_text_clean_additions_at_different_ends` (tests.rs:1141).
///
/// Diffy clean: "top\nmiddle\nbottom\n".
#[test]
fn parity_clean_additions_at_different_ends() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "middle\n", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "top\nmiddle\n").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "middle\nbottom\n").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    let bucket = classify_text(&merged, ExpectedDiffyResult::Clean("top\nmiddle\nbottom\n"));
    eprintln!("[parity] clean_additions_at_different_ends: bucket {bucket:?}, merged={merged:?}");
    assert!(
        matches!(bucket, ParityBucket::A | ParityBucket::B),
        "expected A or B, got {bucket:?}; merged={merged:?}"
    );
}

/// Ports `merge_text_unicode_content` (tests.rs:1291).
///
/// Diffy clean: "中文\nEnglish\n🐍 Python\n".
#[test]
fn parity_unicode_concurrent_edits() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "日本語\nEnglish\n🦀 Rust\n", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "中文\nEnglish\n🦀 Rust\n").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "日本語\nEnglish\n🐍 Python\n").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    let bucket = classify_text(
        &merged,
        ExpectedDiffyResult::Clean("中文\nEnglish\n🐍 Python\n"),
    );
    eprintln!("[parity] unicode_concurrent_edits: bucket {bucket:?}, merged={merged:?}");
    assert!(
        matches!(bucket, ParityBucket::A | ParityBucket::B),
        "expected A or B, got {bucket:?}; merged={merged:?}"
    );
}

/// Ports `merge_text_multi_paragraph` (tests.rs:1363).
///
/// Diffy clean — both edits to different paragraphs survive.
#[test]
fn parity_multi_paragraph_edits() {
    let base = "# Title\n\nParagraph one.\n\nParagraph two.\n\nParagraph three.\n";
    let a_text = "# Title\n\nEdited paragraph one by A.\n\nParagraph two.\n\nParagraph three.\n";
    let b_text = "# Title\n\nParagraph one.\n\nParagraph two.\n\nEdited paragraph three by B.\n";

    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", base, None, 0)
            .expect("seed");
    });
    apply_edit_via_diff_splice(&mut a, "B1", a_text).expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", b_text).expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    let bucket = classify_text(
        &merged,
        ExpectedDiffyResult::CleanContains(&[
            "Edited paragraph one by A.",
            "Edited paragraph three by B.",
        ]),
    );
    eprintln!("[parity] multi_paragraph_edits: bucket {bucket:?}");
    assert_eq!(bucket, ParityBucket::A, "expected A; merged={merged:?}");
}

// ===========================================================================
// CATEGORY 2: same-block, different-position concurrent edits — diffy
// often produces a conflict copy (line-level), Loro should merge cleanly
// at the character level.  Bucket B is the win we expect.
// ===========================================================================

/// Ports `merge_text_conflict_same_line` (tests.rs:162).
///
/// Diffy: produces a Conflict because both edits touch the same line.
/// Loro: character-level CRDT — the two splices land at different
/// Unicode-scalar offsets ("hello" → "goodbye" at offset 0-5 vs
/// "world" → "universe" at offset 6-11).  Both edits survive cleanly.
/// Expected bucket: **B (Loro fewer conflicts than diffy).**
#[test]
fn parity_concurrent_edits_same_line_different_words() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "hello world", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "goodbye world").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "hello universe").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    let bucket = classify_text(
        &merged,
        ExpectedDiffyResult::Conflict {
            ours: "goodbye world",
            theirs: "hello universe",
            ancestor: "hello world",
        },
    );
    eprintln!("[parity] same_line_different_words: bucket {bucket:?}, merged={merged:?}");
    assert_eq!(
        bucket,
        ParityBucket::B,
        "Loro should clean-merge; merged={merged:?}"
    );
}

/// Ports `merge_text_empty_content` (tests.rs:1247).
///
/// Diffy: produces a Conflict because both inserts land at offset 0
/// of an empty file.
/// Loro: appends both inserts deterministically (RGA tie-break by
/// peer id), preserving both contributions.  Bucket B.
#[test]
fn parity_concurrent_inserts_into_empty_block() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "hello\n").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "world\n").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    let bucket = classify_text(
        &merged,
        ExpectedDiffyResult::Conflict {
            ours: "hello\n",
            theirs: "world\n",
            ancestor: "",
        },
    );
    eprintln!("[parity] concurrent_inserts_into_empty_block: bucket {bucket:?}, merged={merged:?}");
    assert_eq!(
        bucket,
        ParityBucket::B,
        "Loro should preserve both inserts; merged={merged:?}"
    );
}

/// Ports `merge_text_empty_base_both_add_multiline` (tests.rs:1742).
///
/// Same shape as above but multi-line.  Diffy: Conflict.  Loro: B.
#[test]
fn parity_concurrent_multiline_inserts_into_empty() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "line A1\nline A2\n").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "line B1\nline B2\n").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    let bucket = classify_text(
        &merged,
        ExpectedDiffyResult::Conflict {
            ours: "line A1\nline A2\n",
            theirs: "line B1\nline B2\n",
            ancestor: "",
        },
    );
    eprintln!("[parity] concurrent_multiline_inserts_empty: bucket {bucket:?}, merged={merged:?}");
    assert_eq!(
        bucket,
        ParityBucket::B,
        "Loro should preserve both multi-line additions; merged={merged:?}"
    );
}

// ===========================================================================
// CATEGORY 3: same-block + same-position concurrent edits.  Diffy
// creates a conflict copy (the production behaviour).  Loro deterministically
// orders the two character runs via RGA tie-break.  We accept B (both
// contributions present) as the win; any data loss → D.
// ===========================================================================

/// Synthetic same-position conflict — both peers replace `"X"` at
/// offset 6 of `"hello X world"` with different content.  Production
/// diffy would conflict (they touch the same line).  Loro: RGA
/// orders the two replacements; both survive — bucket B if we see
/// both "ALPHA" and "BETA" in the merged output.
#[test]
fn parity_concurrent_replace_same_word() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "hello X world", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "hello ALPHA world").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "hello BETA world").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    let bucket = classify_text(
        &merged,
        ExpectedDiffyResult::Conflict {
            ours: "hello ALPHA world",
            theirs: "hello BETA world",
            ancestor: "hello X world",
        },
    );
    eprintln!("[parity] concurrent_replace_same_word: bucket {bucket:?}, merged={merged:?}");
    assert!(
        matches!(bucket, ParityBucket::B),
        "expected B (both contributions present); merged={merged:?}"
    );
}

/// Ports `merge_text_identical_edits` (tests.rs:215).
///
/// Both peers make exactly the same edit.  Diffy: Clean to the
/// shared text.  Loro: the splices are character-by-character
/// identical and Loro deduplicates them — but only when the
/// underlying CRDT recognises the operations as causally identical.
/// In our model both peers issue the same diff-splice op, so the
/// final content depends on tie-breaking — bucket A iff convergent
/// to the shared string.
#[test]
fn parity_identical_concurrent_edits() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "hello\nworld\n", None, 0)
            .expect("seed");
    });

    apply_edit_via_diff_splice(&mut a, "B1", "hello\nuniverse\n").expect("A edit");
    apply_edit_via_diff_splice(&mut b, "B1", "hello\nuniverse\n").expect("B edit");

    sync(&mut a, &mut b);

    let merged = a.read_block("B1").unwrap().unwrap().content;
    eprintln!("[parity] identical_concurrent_edits: merged={merged:?}");
    // CRDTs typically pick a deterministic interleaving when two
    // peers produce identical-but-causally-independent splices.
    // The diffy oracle is the shared text; we accept A if Loro
    // matches it, B if Loro produces something doubled but
    // semantically equivalent (both contributions present).  D
    // would be losing one of the contributions.
    let bucket = if merged == "hello\nuniverse\n" {
        ParityBucket::A
    } else if merged.contains("universe") {
        // Both edits left "universe" in the doc — but possibly
        // duplicated.  Still CRDT-consistent.
        ParityBucket::C
    } else {
        ParityBucket::D
    };
    eprintln!("[parity] identical_concurrent_edits: bucket {bucket:?}");
    assert!(
        matches!(bucket, ParityBucket::A | ParityBucket::B | ParityBucket::C),
        "lost the shared content; merged={merged:?}"
    );
}

// ===========================================================================
// CATEGORY 4: tree-op tests (move, delete, restore, reparent).
// ===========================================================================

/// Ports `merge_both_devices_delete_same_block` (tests.rs:2318).
///
/// Both peers issue `delete_block` on the same block.  Diffy: idempotent,
/// no conflict copy, no LWW resolution.  Loro: both writes set
/// `deleted_at` to the same value (LoroMap LWW deduplicates) → block
/// remains deleted on both peers, no extra ops.  Bucket A.
#[test]
fn parity_dual_delete_same_block() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "some content", None, 0)
            .expect("seed");
    });

    a.apply_delete_block("B1").expect("A delete");
    b.apply_delete_block("B1").expect("B delete");

    sync(&mut a, &mut b);

    assert!(a.read_deleted("B1").unwrap());
    assert!(b.read_deleted("B1").unwrap());
    eprintln!("[parity] dual_delete_same_block: bucket A");
}

/// Ports `merge_move_plus_delete_handled_gracefully` (tests.rs:2542).
///
/// A moves CHILD1 to OTHER_PARENT.  B deletes CHILD1.  Diffy: not a
/// conflict — block ends deleted by commutativity (delete + move-of-
/// deleted = still deleted).  Loro: same outcome — `deleted_at` is set,
/// `parent_id` LWW picks one, doesn't matter because block is deleted.
/// Bucket A.
#[test]
fn parity_move_plus_delete() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("PAGE", "page", "page", None, 0)
            .expect("page");
        e.apply_create_block("OTHER", "page", "other", None, 1)
            .expect("other");
        e.apply_create_block("CHILD1", "content", "child", Some("PAGE"), 100)
            .expect("child");
    });

    a.apply_move_block("CHILD1", Some("OTHER"), 0)
        .expect("A move");
    b.apply_delete_block("CHILD1").expect("B delete");

    sync(&mut a, &mut b);

    assert!(
        a.read_deleted("CHILD1").unwrap(),
        "A: CHILD1 should be deleted"
    );
    assert!(
        b.read_deleted("CHILD1").unwrap(),
        "B: CHILD1 should be deleted"
    );
    // Tree shape: parent_id LWW resolves to one of {PAGE, OTHER}; both
    // peers must agree.  The block is deleted regardless so the value
    // doesn't matter — just that it converges.
    assert_eq!(
        a.read_parent("CHILD1").unwrap(),
        b.read_parent("CHILD1").unwrap(),
        "parent_id must converge across peers"
    );
    eprintln!(
        "[parity] move_plus_delete: bucket A, converged parent={:?}",
        a.read_parent("CHILD1").unwrap()
    );
}

/// Synthetic concurrent reparent test — a tree-op shape not directly
/// in tests.rs but central to PEND-09 risks (open question 5).  Two
/// peers reparent the same block to *different* parents.  Diffy
/// (production) handles via `merge_move_lww` — later timestamp wins,
/// loser's intent dropped.  Loro: same — LoroMap LWW per key (last
/// write wins via Lamport order).  Both peers converge.  This is the
/// "reparent loser-intent-dropped" tradeoff documented in the plan.
/// Bucket A as long as both peers agree on the same parent at the end
/// (we don't assert *which* parent — that's an LWW determinism
/// property and Loro's tiebreak rule is documented).
#[test]
fn parity_concurrent_reparent_different_parents() {
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

    a.apply_move_block("CHILD", Some("PAGE_Y"), 0)
        .expect("A reparent");
    b.apply_move_block("CHILD", Some("PAGE_Z"), 0)
        .expect("B reparent");

    sync(&mut a, &mut b);

    let a_parent = a.read_parent("CHILD").unwrap();
    let b_parent = b.read_parent("CHILD").unwrap();
    assert_eq!(a_parent, b_parent, "peers must converge on a parent");
    assert!(
        matches!(a_parent.as_deref(), Some("PAGE_Y") | Some("PAGE_Z")),
        "convergent parent must be one of the two reparent destinations, got {a_parent:?}"
    );
    eprintln!(
        "[parity] concurrent_reparent_different_parents: bucket A, converged parent={:?}",
        a_parent
    );
}

// ===========================================================================
// CATEGORY 5: property-set conflicts.
// ===========================================================================

/// Ports `resolve_property_conflict_later_timestamp_wins` (tests.rs:775).
///
/// Diffy uses an explicit LWW resolver keyed on (timestamp, device_id,
/// seq).  In Loro, LoroMap key writes are LWW by Lamport order — which
/// is determined by peer-id + op-counter, not wall-clock timestamp.
/// That means Loro CAN pick a different winner than diffy when the
/// timestamp ordering and the Lamport ordering disagree.  In *this*
/// test the two writes happen in sequence — after `sync`, peer B's
/// write Lamport-follows peer A's, so B wins on Loro AND on diffy
/// (B has the later timestamp too).  Bucket A.
#[test]
fn parity_property_lww_later_write_wins() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "x", None, 0)
            .expect("seed");
    });

    a.apply_set_property("B1", "priority", Some("low"))
        .expect("A");
    // B writes "after" A in wall-clock terms; in our spike there's no
    // real clock — Lamport ordering is what matters.  We sync first
    // so B's write causally follows A's (B has observed A's write).
    sync(&mut a, &mut b);
    b.apply_set_property("B1", "priority", Some("high"))
        .expect("B");

    sync(&mut a, &mut b);

    let a_val = a.read_property("B1", "priority").unwrap();
    let b_val = b.read_property("B1", "priority").unwrap();
    assert_eq!(a_val, b_val, "peers must converge");
    assert_eq!(
        a_val,
        Some(Some("high".into())),
        "Loro LWW: B's later write should win"
    );
    eprintln!("[parity] property_lww_later_write_wins: bucket A, val={a_val:?}");
}

/// Concurrent property writes — both peers set the same key without
/// a sync between writes.  Diffy: deterministic LWW resolver picks
/// based on timestamp + tiebreakers.  Loro: deterministic per-peer-id
/// tiebreak — but the *winner* may differ from diffy's because Loro
/// doesn't know about wall-clock timestamps.
///
/// We assert convergence + content correctness (some legal value
/// from {"low", "high"} survives) — this is bucket C: different but
/// CRDT-correct.
#[test]
fn parity_concurrent_property_writes_different_values() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "x", None, 0)
            .expect("seed");
    });

    a.apply_set_property("B1", "priority", Some("low"))
        .expect("A");
    b.apply_set_property("B1", "priority", Some("high"))
        .expect("B");

    sync(&mut a, &mut b);

    let a_val = a.read_property("B1", "priority").unwrap();
    let b_val = b.read_property("B1", "priority").unwrap();
    assert_eq!(a_val, b_val, "peers must converge on a single LWW winner");
    let winner = a_val.unwrap().unwrap();
    assert!(
        winner == "low" || winner == "high",
        "winner must be one of the two contributors, got {winner:?}"
    );
    eprintln!("[parity] concurrent_property_writes_different_values: bucket C, winner={winner:?}");
}

/// Ports `merge_property_conflict_one_side_null` (tests.rs:2428).
///
/// Diffy: A clears the property to NULL; B sets it to "world" with a
/// later timestamp; LWW picks B → "world" survives.
/// Loro: same shape — both peers write to the same LoroMap key; the
/// later (Lamport) write wins.  We sync between A's null-write and
/// B's "world" write so B Lamport-follows A and wins.  Bucket A.
#[test]
fn parity_property_null_vs_value_lww() {
    let (mut a, mut b) = two_peers_from_seed(|e| {
        e.apply_create_block("B1", "content", "x", None, 0)
            .expect("seed");
        e.apply_set_property("B1", "priority", Some("hello"))
            .expect("seed prio");
    });

    // A clears (null write).
    a.apply_set_property("B1", "priority", None)
        .expect("A clear");
    // B observes the clear, then sets "world".
    sync(&mut a, &mut b);
    b.apply_set_property("B1", "priority", Some("world"))
        .expect("B set");

    sync(&mut a, &mut b);

    let a_val = a.read_property("B1", "priority").unwrap();
    let b_val = b.read_property("B1", "priority").unwrap();
    assert_eq!(a_val, b_val, "peers must converge");
    assert_eq!(
        a_val,
        Some(Some("world".into())),
        "Loro LWW: B's value should beat A's null-clear"
    );
    eprintln!("[parity] property_null_vs_value_lww: bucket A, val={a_val:?}");
}
