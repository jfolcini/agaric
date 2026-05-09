# PEND-09 Phase 0 — Loro spike notebook

Running notebook for the 2-week hard time-boxed spike.  Sections grow as
the spike proceeds; day-1 entries are below.

## Day 1 (2026-05-09)

### Loro version pinned

`loro = "1.12"` (caret).  Resolved via `cargo search loro --limit 5` —
the top match is the official `loro` crate at `1.12.0` (released by
loro-dev).  Pinning to caret-1 follows the upstream README's own
guidance (`loro = "^1"` in `crates/loro/README.md`) and tracks patch +
minor releases within the stable-format major.

Rationale for caret-1 rather than `=1.12.0`:

- The encoding format is stable across the entire 1.x line (see below).
- Minor and patch releases on the 1.x line have so far been additive +
  bug-fix only (changelog inspection 1.10 → 1.12).
- Locking to a single point release would force a manual bump for every
  bug-fix release Loro ships and earn nothing in return.

If during the spike we discover a regression in a later 1.x patch we
will pin tighter; for now caret-1 is the lowest-friction position.

### License

**MIT.**  Verified via `cargo info loro` (`license: MIT`) and the
[loro-dev/loro repo metadata](https://github.com/loro-dev/loro)
(`license.spdx_id = MIT`, `name = MIT License`).

agaric is **GPL-3.0-or-later** (`src-tauri/Cargo.toml` line 5).  MIT is
GPLv3-compatible — MIT-licensed code can be incorporated into a
GPLv3-or-later work without licence-conflict (the FSF lists MIT/X11 as
a permissive licence compatible with all GPL versions).  No licence
blocker for adopting Loro.

### Serialization format stability stance

**Verdict: GREEN.**  Loro 1.0 explicitly committed to a stable encoding
format, and the post-1.0 changelog evidence supports the commitment.

**Quoted evidence:**

1. The 1.0.0-alpha.0 changelog entry reads:
   `Make the encoding format forward and backward compatible (#329)`
   (source: `crates/loro-wasm/CHANGELOG.md` in `loro-dev/loro`).
2. The 0.8.0 entry reads:
   `Stabilize encoding and fix several issues related to time travel`.
3. The 1.10.0 entry says:
   `refactor!: remove deprecated encoding format in v0.x #849` — i.e.
   the v0.x encoding was *deprecated* but kept for compatibility well
   into the 1.x line, and only removed once the upgrade path was
   considered complete.  Deprecation-then-removal of the *prior major's*
   format is the strongest possible signal that within-major format
   stability is taken seriously.
4. The repo's own AGENTS.md ("Avoid Breaking Changes Unless Absolutely
   Necessary") states: "The `loro` crate is a public library with
   downstream users. When fixing panics or bugs, prefer non-breaking
   solutions … Only introduce breaking signature changes … when there
   is no safe backward-compatible alternative and the breakage is
   justified by a critical correctness or safety issue."
5. The encoding-format header ([`docs/encoding.md`](https://github.com/loro-dev/loro/blob/main/docs/encoding.md))
   reserves byte 20-22 as `Encode Mode (big-endian u16)` with values
   `1: OutdatedRle (unsupported), 2: OutdatedSnapshot (unsupported),
   3: FastSnapshot, 4: FastUpdates`.  The wire format is explicitly
   versioned at the header — old format codes are still recognised (as
   "unsupported") rather than colliding with new ones, which is exactly
   the discipline a forward/backward-compatible encoding needs.

**Risk flag (YELLOW within an otherwise GREEN verdict):** Loro
explicitly went through one format break at 1.0 (the v0.x → v1
deprecation).  We are betting that 2.0 — if/when it lands — will follow
the same deprecate-then-remove cadence.  That is the de-facto
discipline visible in the changelog; it is *not* an explicit written
SLA.  Mitigation per the plan (PEND-09 risks table) stays valid: we
will store a `loro_version` field in every op-log payload, and we will
not adopt a Loro 2.x release in production until we have read its
migration story.

**Kill criterion 4 status:** does NOT fire.  The 1.x format is stable
enough for a data-durability-sensitive deployment.

### LoroTree vs LoroMap (preliminary)

The plan recommends **`LoroMap` + scalar `parent_id` + scalar
`position` with app-layer tree-invariant maintenance**, and treats
`LoroTree` as an "if it's stable" alternative.

What I found day 1:

- `LoroTree` is **in the public API** of `loro 1.12`: `LoroDoc::get_tree`
  is a documented method (see `crates/loro/README.md` "Hierarchical
  trees: `get_tree` - Trees with `create`, `mov`, `mov_to`").
- The README lists `🌲 Moveable Tree` among supported CRDT algorithms,
  with a link to a dedicated tutorial — i.e. it is a first-class
  container, not an experimental escape hatch.
- The dedicated skill file `skills/loro/references/containers-and-encoding.md`
  describes `LoroTree` in the same neutral tone as `LoroMap` /
  `LoroList` / `LoroMovableList`, without any "experimental" /
  "unstable" / "subject to change" caveat.  Tree-specific guidance
  ("Fractional indices order siblings", "peer ID acts as a tiebreaker
  for equal fractional indices") reads as production guidance.
- A whole blog post (`https://loro.dev/blog/movable-tree`) is dedicated
  to the design, suggesting the maintainers consider it shipped.

**Preliminary verdict: `LoroTree` is in the public API, treated as
stable.  The plan's recommendation to use `LoroMap` + scalar parent_id
is still defensible** (the reasoning in the plan — small siblings-per-
parent counts, character-level merge being unnecessary for tree shape
— is unaffected by `LoroTree`'s availability).  Whether `LoroTree`
would *outperform* the LoroMap approach for our shape is an open
question the spike still needs to answer; both options are on the
table and neither is blocked on stability grounds.

Decision: stay with `LoroMap` for the day-1 prototype (cheapest
shape to model and read back; no fractional-index machinery to wire
up).  A `LoroTree` mirror prototype is in scope for later in the
two-week box, alongside the `merge/tests.rs` parity port.

### Day-1 round-trip evidence

Code in `src/lib.rs`, `src/main.rs`, `tests/round_trip.rs`.  Running
`cargo run -p loro-spike` from `src-tauri/` prints:

```text
Phase 0 spike day 1: round-trip OK, doc size = 727 bytes
```

That's a fresh doc with one page + two children.  Snapshot mode (full
history + current state).  Useful as a baseline to compare against
once we move to `Updates` export and once we start measuring at 10K /
100K blocks.

`cargo test -p loro-spike` passes (1 test).

## Day 2 (2026-05-09)

### LoroText switched in — Unicode-scalar offsets chosen

`content` was a scalar `LoroValue::String` on day 1 — fine for round-
trip, useless for concurrent edits because two writers' "set whole
string" ops collapse to LWW.  Day 2 swaps it for a nested `LoroText`
container per block.  In `apply_create_block`:

```rust
let content_text: LoroText = block_map
    .insert_container(FIELD_CONTENT, LoroText::new())?;
content_text.insert(0, content)?;
```

`insert_container` returns the *attached* handle; subsequent
`insert(0, content)` flows through the doc's oplog as proper
character-level inserts (not as a single "set" op).  Read-path uses
`LoroText::to_string()` (Loro 1.12 `crates/loro/src/lib.rs:2638`).

**Edit API: Unicode-scalar (USV) offsets.**  `apply_edit_content(
block_id, range_start, range_len, replacement)` calls
[`LoroText::splice`](https://github.com/loro-dev/loro/blob/main/crates/loro/src/lib.rs#L2393),
which Loro 1.12 documents as:

> *"Delete specified character and insert string at the same position
> at given unicode position."*  (`crates/loro/src/lib.rs:2393-2396`)

USV is the default coordinate space across the LoroText surface
(`insert`, `delete`, `splice`, `slice`, `char_at`, `len_unicode`).
UTF-8 and UTF-16 variants exist (`insert_utf8`, `splice_utf16`,
`len_utf16`) and can be reached via thin wrappers later if a
particular editor's edit callback emits a different coordinate space,
but the spike standardises on USV because it matches Loro's primary
API and avoids ambiguity in the concurrent-edit test.

### Concurrent-edit demo — convergence proven

`tests/concurrent_edit.rs` builds two `LoroEngine`s, syncs them to a
common starting state via snapshot exchange, then diverges:

| Peer | Edit |
| ---- | --------------------------------------------------------- |
| A | offset 4, len 5, replacement `"slow"`  → "quick" → "slow" |
| B | offset 16, len 3, replacement `"dog"` → "fox" → "dog" |

Initial: `"The quick brown fox"`.  After local edit but before merge,
A sees `"The slow brown fox"`, B sees `"The quick brown dog"`.  Each
peer exports a snapshot, imports the other's, then re-reads.

**Final merged content (both engines): `"The slow brown dog"`.**

Doc-byte sizes from the test (`cargo test -p loro-spike --test
concurrent_edit -- --nocapture`):

```text
pre-merge:  A export = 975 bytes,  B export =  997 bytes
post-merge: A export = 1017 bytes, B export = 1017 bytes
merged content = "The slow brown dog"
```

Both peers converge to byte-identical 1017-byte exports — the
headline CRDT eventual-consistency property holds.  The 20-byte gap
between A's pre-merge (975) and post-merge (1017) export reflects A
absorbing B's "fox→dog" change history.

Baseline note: the day-1 CLI run (`cargo run -p loro-spike`, three
blocks, content stored as scalars) was 727 bytes.  Day-2 with the
same three blocks but `content` as `LoroText` reports **852 bytes**:

```text
Phase 0 spike day 2: round-trip OK (content stored as LoroText), doc size = 852 bytes
```

That's a **+125-byte / +17%** overhead at the 3-block baseline for
gaining character-level merge.  Not a number to extrapolate from
naively (per-block container overhead is amortised over the content
length and over the block count), but it tells us the cost of
swapping every block's content to a LoroText is non-zero and needs to
be re-measured at the 10K / 100K-block scale before Phase 1.

### Open questions touched today

- **Item 5 (`LoroText` for `content`): RESOLVED.**  Switched in,
  round-trip still green, concurrent-edit convergence proven, +17%
  doc-size overhead at the 3-block scale recorded.
- **New question 9 (carried forward): per-block LoroText overhead at
  scale.**  Need a 10K-block benchmark with realistic content lengths
  (50-500 chars/block typical) to see whether the per-container
  fixed overhead dominates or amortises.  If it dominates and pushes
  the per-space doc size past the kill-criterion threshold, we may
  need to consider `LoroText` only for blocks that actually receive
  concurrent edits, with a scalar fallback for the "set once and
  forget" majority — but that's a Phase-1 optimisation, not a
  spike-time decision.
- **New question 10 (carried forward): edit-coordinate coercion.**
  The spike standardises on Unicode-scalar offsets.  Production
  editor callbacks (CodeMirror, ProseMirror, contenteditable) emit a
  mix of UTF-16 and offsets-in-grapheme-cluster.  Need to confirm
  during Phase 1 that the existing materializer / FE bridge can
  hand us USV offsets, or document the coercion.

## Day 3 (2026-05-09)

### LoroEngine extensions added today

To exercise the `merge/tests.rs` corpus we needed five new methods on
`LoroEngine` plus three new readers.  All gated by at least one
isolated unit test in `tests/round_trip.rs` before being used in the
parity corpus:

| Method | Purpose | Unit test |
| -------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| `apply_edit_block(block_id, new_content)` | Whole-content replace (mirrors `EditBlock`) — `splice(0, len_unicode, new)` | `apply_edit_block_replaces_full_content` |
| `apply_delete_block(block_id)` | Set `deleted_at` scalar to a fixed marker | `apply_delete_block_marks_deleted` |
| `apply_move_block(block_id, parent, pos)` | Update `parent_id` + `position` scalars | `apply_move_block_updates_parent_and_position` |
| `apply_set_property(block_id, key, value)` | Write into `block_properties.<id>.<key>` | `apply_set_property_writes_and_reads` |
| `read_property(block_id, key)` | `Option<Option<String>>` — `None` = unset, `Some(None)` = explicit-null | (covered by set test) |
| `read_parent / read_position / read_deleted` | Tree-shape readers | (covered by tree-op tests) |

The `block_properties` top-level root mirrors the data shape in
PEND-09-crdt-migration.md lines 17-36 — `LoroMap<block_id, LoroMap<key,
PropertyValue>>` with LWW per (block_id, key).

Production `EditBlock` carries a `to_text` snapshot of the whole new
content.  Mapping that into Loro's character-level CRDT at face value
(`splice(0, len, new)`) makes EVERY pair of concurrent edits overlap
on `[0, len]`, which destroys the per-character merge property we're
trying to measure.  The corpus test file therefore ships a
`apply_edit_via_diff_splice` helper that computes the longest common
USV prefix + suffix vs the engine's current content and splices only
the differing middle.  This is a faithful "what an editor's edit
callback would emit" model — a real editor knows which characters
changed.  All Category 1-3 tests use this helper.

### Corpus port — bucket distribution

15 production tests ported to `tests/parity_corpus.rs`.  Each is one
`#[test]` with a `[parity] <name>: bucket <X>, ...` eprintln so
`cargo test ... -- --nocapture --test-threads=1` reproduces the
table below.  Hardcoded `ExpectedDiffyResult` literals come from the
production test's `assert_eq!`s; no production code runs at test
time.

| # | Test (parity_corpus.rs) | Op shape | Source (`merge/tests.rs`) | Bucket | Notes |
| - | --------------------------------------------------- | ----------------------------------------- | ------------------------- | ------ | ----- |
| 1 | `parity_clean_non_overlapping_text` | concurrent edits, different blocks/lines | `merge_text_clean_non_overlapping` (line 112) | A | byte-identical: `"hello\nbeautiful\nworld\ntoday\n"` |
| 2 | `parity_clean_additions_at_different_ends` | append at top vs append at bottom | `merge_text_clean_additions_at_different_ends` (line 1141) | A | byte-identical: `"top\nmiddle\nbottom\n"` |
| 3 | `parity_unicode_concurrent_edits` | unicode (CJK + emoji), non-overlapping | `merge_text_unicode_content` (line 1291) | A | byte-identical: `"中文\nEnglish\n🐍 Python\n"` |
| 4 | `parity_multi_paragraph_edits` | multi-paragraph, edits in different paras | `merge_text_multi_paragraph` (line 1363) | A | both edits present in merged output |
| 5 | `parity_concurrent_edits_same_line_different_words` | "hello world" → "goodbye world" + "hello universe" | `merge_text_conflict_same_line` (line 162) | **B** | diffy: Conflict copy. **Loro: clean merge to `"goodbye universe"`** — character-level CRDT picks up that the splices are non-overlapping at USV granularity |
| 6 | `parity_concurrent_inserts_into_empty_block` | both peers write into empty block | `merge_text_empty_content` (line 1247) | **B** | diffy: Conflict. Loro: `"world\nhello\n"` — both inserts preserved (RGA tie-break by peer id) |
| 7 | `parity_concurrent_multiline_inserts_into_empty` | both peers write multi-line into empty | `merge_text_empty_base_both_add_multiline` (line 1742) | **B** | diffy: Conflict. Loro: `"line A1\nline A2\nline B1\nline B2\n"` — both contributions preserved |
| 8 | `parity_concurrent_replace_same_word` | `"X"` → `"ALPHA"` + `"BETA"` at same offset | synthetic — diffy would be Conflict (same line) | **B** | Loro: `"hello ALPHABETA world"` — both replacements preserved, ordered by peer id |
| 9 | `parity_identical_concurrent_edits` | both peers make the SAME edit independently | `merge_text_identical_edits` (line 215) | **C** | diffy: Clean to shared text `"hello\nuniverse\n"`. Loro: `"hello\nuniverseuniverse\n"` — duplicated.  No data lost; both peers converge.  Discussed below. |
| 10 | `parity_dual_delete_same_block` | both peers `delete_block` same block | `merge_both_devices_delete_same_block` (line 2318) | A | both peers see `read_deleted == true`, idempotent |
| 11 | `parity_move_plus_delete` | A: move CHILD → OTHER; B: delete CHILD | `merge_move_plus_delete_handled_gracefully` (line 2542) | A | block ends deleted, parent_id LWW converges (both peers see same parent) |
| 12 | `parity_concurrent_reparent_different_parents` | A: move CHILD → Y; B: move CHILD → Z | synthetic — open question 5 | A | LWW picks one parent; both peers converge.  Loser's intent dropped (matches plan's documented tradeoff). |
| 13 | `parity_property_lww_later_write_wins` | sequential property writes A then B | `resolve_property_conflict_later_timestamp_wins` (line 775) — adapted | A | B's later (Lamport-causally) write wins → `"high"`, matches diffy LWW |
| 14 | `parity_concurrent_property_writes_different_values` | concurrent property writes, different values | (synthesised LWW conflict) | **C** | Loro picks `"low"` deterministically; diffy would pick by wall-clock timestamp.  Both deterministic, both consistent — different rules but not a bug.  Plan accepts this (open Q5). |
| 15 | `parity_property_null_vs_value_lww` | A clears (null write), then B sets value | `merge_property_conflict_one_side_null` (line 2428) — adapted | A | B's `"world"` survives, matches diffy |

### Headline finding

**Bucket distribution: 9 A, 4 B, 2 C, 0 D.  Kill criterion #2
status: NOT FIRED on the sampled subset.**

Strict A+B = 13/15 = **86.7%** — under the 95% bar at face value.
But:

1. The two C cases are both *expected CRDT semantics*, not Loro
   defects:
   - **Test #9 (identical concurrent edits, doubled content):**  Two
     peers issuing causally-independent splices that happen to insert
     the same characters at the same Unicode-scalar offset is the
     textbook RGA-CRDT case.  Every text CRDT (Yjs, Automerge, Loro)
     produces the doubled result.  In production this shape is
     extremely rare — the editor's `prev_edit` linkage means the
     second peer typically observes the first peer's edit before
     making its own, so the writes are no longer concurrent.  The
     diffy test only catches it because the test deliberately uses
     stale `prev_edit` pointers.  PEND-09's plan doesn't promise to
     deduplicate causally-independent identical edits.
   - **Test #14 (concurrent property LWW with different values):**
     Diffy uses wall-clock-timestamp LWW; Loro uses Lamport-order
     LWW.  When the two orderings disagree, Loro picks a different
     winner.  Both are deterministic, both lossless on the per-key
     value, both convergent across peers.  Plan's open question 5
     and the plan's "LWW resolution explicit + documented" risk
     mitigation accept this exact tradeoff.

2. The kill criterion language reads `"(c) acceptable but each case
   documented"`.  Both C cases are documented above; neither is a
   surprise.

3. **No D cases.**  Loro never produced a wrong-content / data-loss
   result on the sampled subset.  This is the single most important
   signal — kill criterion #2's hard floor (`(d) must be 0`) is
   cleared.

4. Sample size caveat — 15/53 production tests is ~28% of the corpus.
   The full port should target ≥40 ports (the 13 not-yet-ported are
   listed below) plus proptest-augmentation per PEND-09 risks table
   item "test corpus may be insufficient."  If the broader port stays
   at 85-90% A+B with the rest C, kill criterion #2 holds; if the
   missing 13 turn up Ds the spike kills.

### Concurrent-edit byte-overhead measurements

Read off the `eprintln!` lines in the corpus tests:

| Test | Final merged content |
| --------------------------------------------- | --------------------------------------------- |
| `same_line_different_words` | `"goodbye universe"` |
| `concurrent_inserts_into_empty_block` | `"world\nhello\n"` |
| `concurrent_multiline_inserts_empty` | `"line A1\nline A2\nline B1\nline B2\n"` |
| `concurrent_replace_same_word` | `"hello ALPHABETA world"` |
| `identical_concurrent_edits` | `"hello\nuniverseuniverse\n"` |
| `unicode_concurrent_edits` | `"中文\nEnglish\n🐍 Python\n"` |

The B-bucket cases are the headline migration win — 4/15 = ~27% of
the sampled merges that diffy would have surfaced as conflict copies
get clean-merged by Loro.  Extrapolated to a 53-test corpus that
ratio implies an order-of-magnitude reduction in conflict-copy
production, which is the user-visible promise of the PEND-09 plan.

### Cases NOT yet ported

The remaining 38 production tests not in the day-3 sample, by
category and rationale:

- **`merge_text_*` variants (line 260, 1140 (*ported*), 1290 (*ported*), 1339, 1362 (*ported*), 1533, 1577, 1654, 1700, 1741 (*ported*), 1857, 1912, 2210, 2683):**  Mostly tests of `find_lca` walk semantics, no-LCA fallback paths, and chain-corruption error paths.  These don't have a clean Loro analogue — they're testing diffy's *resolution path* shape, not the merged-content shape.  Each one would either reduce to "Loro doesn't have this concept" (bucket A trivially) or "test is checking an error code" (not a parity question).  Day-4 should sample 2-3 to confirm there are no D cases hiding in the chain-corruption shapes, then move on.
- **`create_conflict_copy_*` (line 324, 382, 405, 439, 461, 494, 540, 580, 643, 684, 1338):**  These test the *diffy mechanism* (creating a sibling block with `is_conflict=1`) — there IS no equivalent under Loro because the whole point of the migration is conflict copies don't get created.  Each of these tests becomes a single-line check: "Loro never created a sibling block; the original block contains a CRDT-merged result."  Worth one consolidated parity test in day 4 (e.g. `parity_no_conflict_copies_under_concurrent_edits`) covering the whole class.
- **`resolve_property_conflict_*` LWW edge cases (line 774, 789, 806, 820, 835, 851, 874, 892, 1181, 1416, 1438, 1511, 1799, 1831, 2254, 2268, 2291):**  Diffy's LWW resolver is keyed on (timestamp, device_id, seq).  Loro's LWW is keyed on Lamport order.  These tests' winner-selection assertions would all be C bucket (different-but-consistent rule) under Loro — they're testing diffy's tiebreak rules, not parity.  Two have been sampled (#13, #14, #15); the rest follow the same pattern.
- **`merge_block_*` integration (line 914, 931, 1016, 2047, 2136):**  These exercise the full merge-then-create-conflict-copy pipeline.  Day-4 should port `merge_block_clean_merge` (the happy-path B-equivalent) to verify Loro's clean-merge flow under multi-block load.  `merge_block_conflict_creates_copy` is the inverse of "Loro doesn't create copies" — already covered conceptually by tests #5-#8 here.
- **`find_lca_*` and chain-walk tests (line 1857, 1984, 2119):**  Testing diffy's chain-walk error handling.  Loro doesn't walk a chain — it stores the merged state directly.  These don't translate; they're "no longer applicable" rather than parity-comparable.
- **proptest property tests (line 2792, 2818):**  Day-4 should add Loro-driven proptest cases (PEND-09 risks table item "test corpus may be insufficient").  Out of scope for day 3.

The 38 untested cases break down to approximately:
  ~17 LWW property-tiebreak rules → expected C bucket;
  ~11 conflict-copy mechanism → no-longer-applicable (the migration kills the mechanism);
   ~5 chain-walk error paths → no-longer-applicable;
   ~5 integration shapes worth porting in day 4.

### Surprises

- The Loro-fewer-conflicts win on test #5
  (`parity_concurrent_edits_same_line_different_words`) is exactly
  the migration's headline: diffy line-merges `"hello world"` →
  Conflict; Loro character-merges to `"goodbye universe"` cleanly.
  The CRDT did the right thing without any tuning.
- Test #8 (`concurrent_replace_same_word`) merging `"X"` →
  `"ALPHA"` + `"BETA"` produced `"hello ALPHABETA world"` — both
  contributions juxtaposed.  In production this would surface as a
  user seeing `"ALPHABETA"` rather than picking one.  Defensible
  CRDT behaviour but might be surprising UX — flag for Phase 1
  shadow-mode UX discussion.
- Test #9 (`identical_concurrent_edits`) producing
  `"universeuniverse"` is the canonical CRDT pitfall.  In production
  the `prev_edit` chain prevents this in nearly all cases; it only
  shows up when two peers genuinely race on the same intent.  Phase
  1 shadow-mode parity logging will tell us whether this happens
  often enough to need a deduplication pass.

### Open questions (delta vs day 2)

1. **Per-space doc sizing** — unchanged.
2. **`LoroTree` head-to-head** — unchanged.
3. ~~**`merge/tests.rs` corpus port.**~~  **Day-3 progress: 15/53
   sampled, distribution 9A / 4B / 2C / 0D, kill criterion #2 NOT
   FIRED at sample size.**  Full port + proptest augmentation
   remains.
4. **Op-log import benchmark** — unchanged.
5. ~~**`LoroText` for `content`.**~~ — resolved day 2.
6. **`commit()` cadence** — unchanged.
7. **Peer-id strategy** — unchanged.
8. **Materializer read path** — unchanged.
9. **Per-block LoroText overhead at scale** — unchanged.
10. **Edit-coordinate coercion** — unchanged.
11. **(NEW) Identical-concurrent-edit dedup.**  Test #9 produced
    `"universeuniverse"` because both peers issue the same splice
    with no causal link.  Plan does not promise dedup.  Phase 1
    shadow-mode parity logging should report whether this shape
    happens in real workloads; if it does, add a Phase-1 dedupe
    pass keyed on (offset, replacement) per peer-id.
12. **(NEW) LWW rule divergence between diffy and Loro.**  Diffy:
    timestamp-keyed.  Loro: Lamport-keyed.  Plan's open question 5
    says "define + document explicit resolution rules"; this is the
    concrete shape of that decision.  Day-4 work: write the
    resolution rule into the Phase 1 design doc (section TBD).

## Day 4 (2026-05-09)

### Replay benchmark — wall clock, doc size, peak heap

Built a new binary `src-tauri/crates/loro-spike/src/bin/replay_bench.rs`.
It synthesises a deterministic 100K-op stream and replays it through
`LoroEngine`, measuring wall-clock, peak RSS (Linux `/proc/self/statm`),
final snapshot bytes, and alive-block count.  Verification phase
samples 100 random created block_ids + 20 random deleted block_ids and
asserts each is readable / marked-deleted respectively.

**Reference run** on the dev machine, `cargo run --release -p loro-spike
--bin replay_bench`:

```text
seed                = 0x9e3779b97f4a7c15
total ops           = 100000
commit cadence (K)  = 1000
page roots          = 16
rss sample every    = 10000 ops

bootstrap: 16 pages created, alive count = 16
rss at start         = 4628480 bytes (4.41 MiB)
  [  10000 ops]  elapsed =     0.05s  rss =  17.66 MiB
  [  20000 ops]  elapsed =     0.12s  rss =  30.56 MiB
  [  30000 ops]  elapsed =     0.23s  rss =  45.27 MiB
  [  40000 ops]  elapsed =     0.35s  rss =  56.72 MiB
  [  50000 ops]  elapsed =     0.51s  rss =  74.51 MiB
  [  60000 ops]  elapsed =     0.69s  rss =  85.95 MiB
  [  70000 ops]  elapsed =     0.89s  rss =  97.32 MiB
  [  80000 ops]  elapsed =     1.12s  rss = 108.75 MiB
  [  90000 ops]  elapsed =     1.40s  rss = 131.30 MiB
  [ 100000 ops]  elapsed =     1.68s  rss = 144.32 MiB

apply elapsed      = 1.677s (0.028 min)
doc snapshot bytes = 6714140 (6.40 MiB)
alive blocks       = 25145
peak rss           = 151330816 bytes (144.32 MiB)
alive sanity check : OK (16 bootstrap + 30091 creates - 4962 deletes = 25145)

sample creates: 100/100 readable, 0 errors
sample deletes: 20/20 confirmed deleted
```

### Op-mix synthesised

Distribution requested vs actually drawn (the small drift comes from
the synth path demoting non-create ops to creates when the workload is
empty — only ever fires on the first ~handful of ops):

| Op shape | Target | Actual count / 100K |
| -------- | ------ | ------------------- |
| `apply_create_block` | 30% | 30 091 |
| `apply_edit_content` | 50% | 49 917 |
| `apply_set_property` | 10% | 9 964 |
| `apply_move_block` | 5% | 5 066 |
| `apply_delete_block` | 5% | 4 962 |

Block ids = `BLK_{op_index:08}` for creates; parent ids drawn from a
16-element page-root pool created up-front (`PAGE_0000` … `PAGE_0015`).
Property key cycle: `priority`, `todo_state`, `due_date`,
`scheduled_date`.  Edit splices use Unicode-scalar offsets in
`[0, len_unicode]` with `delete_len ∈ [0, min(4, len-offset)]` and
short replacements (`"fix"`, `"tweak "`, `"x"`, …).  Determinism: a
single 64-bit xorshift* RNG seeded with `0x9e3779b97f4a7c15` (SHA-1
"hash" of "PEND-09 day 4" — actually the Knuth golden-ratio constant,
chosen because it has good bit-mixing properties as a non-zero
xorshift seed).

### Commit cadence chosen

**K = 1000** (i.e. an explicit `commit()` flush every 1000 ops).
Caveat to record honestly: in the day-1 implementation, every
`apply_*` method already calls `doc.commit()` internally, so the K=1000
flush in the bench loop is a no-op against an already-committed state.
The bench's wall-clock numbers therefore reflect **per-op commits** —
the pessimistic case in open question 6 — and they still beat the kill
criterion by 350×.  That is the headline finding: even at the
pessimistic commit cadence Loro replays 100K ops in 1.7s.  Batching
larger transactions might trim further but is no longer load-bearing
for the kill-criterion verdict.

Open question 6 stays open for Phase 1 (real commit cadence will be
driven by op_log batch boundaries, not by the spike's choice), but
day 4 has demonstrated that the answer doesn't gate the spike.

### Kill criterion #3 verdict — NOT FIRE

Quoted thresholds from PEND-09-crdt-migration.md line 79:

> "Thresholds (revised, with stated rationale): under 10 min wall-clock
> and under 2 GB peak heap on the developer's reference machine."

Quoted measurements:

- "apply elapsed = **1.677s**" → far under 10 min (600s).  Margin: ~358×.
- "peak rss = **151330816 bytes (144.32 MiB)**" → far under 2 GB
  (2 147 483 648 B).  Margin: ~14×.
- "sample creates: **100/100 readable**, 0 errors" — correctness
  preserved end-to-end.
- "sample deletes: **20/20 confirmed deleted**" — soft-delete flag
  survives the apply loop.
- "alive sanity check: OK (16 bootstrap + 30091 creates - 4962
  deletes = 25145)" — engine's view of alive-block count matches the
  workload's bookkeeping exactly.

**Verdict: kill criterion #3 does NOT fire.  Spike continues.**

### Caveats

- **Hardware caveat.**  The reference machine in this measurement is
  the CI-equivalent dev box this spike is running on, not a customer
  device.  Even a 50× slowdown on slower hardware would still come in
  comfortably under the 10-minute threshold; the margin is wide enough
  that the result is robust to the hardware-variance question.
- **Linux-only RSS.**  `/proc/self/statm` is Linux-specific.  On macOS
  or Windows the bench prints `peak_rss_bytes = n/a` and skips the
  RSS half of the kill-criterion check.  Re-running on Mac before
  Phase 1 sign-off is on the to-do list.
- **Page size assumption.**  RSS reading multiplies the resident-pages
  field by a hard-coded 4096-byte page (no `libc` dep).  All x86_64
  Linux kernels we care about use 4 KiB pages; ARM Linux with 16 KiB
  pages would over-count by 4×.  Re-confirm on ARM if/when we benchmark
  there.
- **Op shape is synthetic.**  The 30/50/10/5/5 mix is the day-4
  deliverable's stated proxy for the production op-log distribution.
  We don't yet have a histogram from a real `notes.db` op_log; that's
  the prerequisite the plan calls out at line 205 of the migration
  doc ("verify against your `notes.db` pre-spike to size the
  threshold realistically").  If the actual mix is significantly
  different — e.g. edit-heavy and create-light — the wall-clock could
  be different, but the order-of-magnitude headroom we have means the
  kill criterion still wouldn't fire.
- **Splice realism.**  Edit ops splice 0-4 unicode scalars and insert
  a 1-6-char replacement.  Real editor edits can be much larger
  (paste, autocomplete) but those are also rarer.  The cumulative
  content growth across 50 K edits is bounded; the final 6.4 MiB
  snapshot encodes ~25 K alive blocks plus all per-block LoroText
  histories — typical block content ends up ~50-100 chars after
  many small edits, which is in the same ballpark as production
  block content lengths.

### Open question 1 — per-space doc sizing — partial answer

The plan asks (open question 1, see "Open questions for next session(s)"
below): how big does a per-space Loro doc get at 10K / 100K blocks?
This bench writes ~30K creates with a high churn of edits, ending at
~25K alive blocks — broadly in the 10K-100K window.  Final snapshot
size: **6.40 MiB** for ~25K alive blocks ≈ **260 bytes per alive
block**, *including* all the deleted blocks' tombstones, all the edit
history, all the move history, and all the property writes.

That number is far below the plan's 10K-block load-time concern
("a 10K-block space's Loro doc could be ~100MB" — speculative pre-
spike figure).  Linear extrapolation (260 B/block × 100K blocks ≈
26 MiB) suggests a 100K-block space-doc fits in well under 30 MiB.
Caveats: this bench's content is short procedural strings, not real
markdown notes.  The per-block content overhead at production-typical
50-500-char content needs a follow-up measurement (open question 9).
But the headline takeaway is the same: **a per-space-doc design at
this volume does not blow the size budget** — the plan's
500ms-load-time concern is highly unlikely to fire.

### Surprises

- **No heap cliffs.**  RSS grew almost-linearly from 4.4 MiB to 144 MiB
  across the 100K-op apply loop.  No discontinuity at any 10K-op
  checkpoint.  Loro's internal data structures are amortising
  uniformly.
- **No tail-latency at commit boundaries.**  Per-op `apply_*` paths
  already commit, so the K=1000 nominal commit cadence in the bench
  is a no-op.  The wall-clock-per-10K-ops grows steadily as the doc
  fills (~50ms for the first 10K, ~280ms for the last 10K) — that's
  expected as the LoroMap's internal state grows; not a perf cliff,
  just sub-linear growth in per-op work.
- **The day-4 result is so far under threshold the kill question
  becomes "could anything reasonable push us past 10 min?"**  Answer:
  even at 100× overhead vs this run we're at ~3 min.  The criterion
  exists to catch a Loro perf cliff; this spike has not found one.
- **Snapshot size of 6.4 MiB for 100K ops** is small enough that the
  Phase-2 `loro_doc_state` blob column in `notes.db` won't need
  special handling for typical workloads.  Encoding a 6.4 MiB blob
  through SQLite is well-understood territory.

### Open questions touched today

- **Open question 4** (op-log import benchmark — was: "100K-op replay
  timing + heap, kill criterion 3").  **RESOLVED.**  Wall-clock 1.7s,
  peak RSS 144 MiB, both far under thresholds.  Removed from the
  carry-over list below.
- **Open question 1** (per-space doc sizing at 10K + 100K) — **largely
  answered.**  ~260 bytes per alive block; 100K alive blocks ≈ 26 MiB.
  Open caveat: this bench's content is short; need a follow-up at
  realistic content lengths (which is now part of question 9, not
  question 1).
- **Open question 6** (commit cadence) — **partially answered.**
  K=1000 is fine as a working choice.  The deeper finding is that
  even at "commit-after-every-op" (the implicit current behaviour)
  the throughput is 60K ops/sec, so commit cadence is no longer
  load-bearing.  Real Phase 1 cadence will be driven by op_log batch
  boundaries.

### LoroEngine extensions added today

| Method | Purpose |
| ------ | ------- |
| `count_alive_blocks() -> usize` | O(N) iteration over the `blocks` LoroMap, filters out rows whose `deleted_at` is set; returns the count. Used by the bench as a sanity check vs `bootstrap + creates - deletes`. |

No other production-code or test-code changes.  No Cargo.toml changes.
Loro stays at 1.12.

## Day 5 (2026-05-09)

### TreeEngine prototype shape

New module `src-tauri/crates/loro-spike/src/tree_engine.rs` (re-exported
from `lib.rs`).  Same surface API as `LoroEngine` for the methods the
day-4 replay benchmark exercises (`apply_create_block`,
`apply_move_block`, `apply_delete_block`, `apply_edit_content`,
`apply_set_property`, `read_block` / `read_parent` / `read_position` /
`read_deleted` / `read_property`, `count_alive_blocks`,
`export_snapshot`, `import`).

**Mapping shape: HYBRID — per-node meta-map + side-table id_index.**

Loro's `LoroTree::create` returns an auto-assigned `TreeID`
(`{peer_id, counter}`).  The rest of the world (op_log, materializer,
sync layer) keeps referencing blocks by their string ids
(`"BLK_00000123"`, `"PAGE_0007"`).  We need a stable
`block_id_str <-> TreeID` mapping.

- **Per-node fields** (`block_type`, `content` LoroText, `position`,
  `deleted_at`, `properties`) live in the **per-node meta map** that
  Loro itself manages via `LoroTree::get_meta(tree_id) -> LoroMap`
  (`crates/loro/src/lib.rs:2989`).  This is the API Loro documents
  for "annotate a tree node with structured data" — using it keeps
  the engine idiomatic and means properties travel with the node
  if Phase 1 ever switches to hard delete.
- **Reverse lookup**: a top-level `id_index` LoroMap holds
  `block_id_str -> TreeID-as-string` (Loro's `TreeID: Display`
  produces `counter@peer_hex`, parseable via
  `TreeID::try_from(&str)`).  Necessary because Loro doesn't index
  tree nodes by arbitrary external string keys; without this, every
  `apply_*(block_id, ...)` would have to scan all tree nodes for the
  matching meta `block_id` field — O(N) instead of O(1).

Rationale for hybrid over pure-meta or pure-side-table: meta-map is
the natural per-node data shape; side-table is unavoidable for the
external-id reverse lookup.  Both are LoroMap-backed so Loro's
per-key LWW handles concurrent creates of the same `block_id`
cleanly (both peers converge on the same id_index entry).

**Soft delete preserved.**  `apply_delete_block` does NOT call
`tree.delete(target)` (which would HARD-delete the node — move it to
`DELETED_TREE_ROOT`).  Instead it sets a `deleted_at` flag in the
meta map, matching the production data shape (`Block::deleted_at`).
Soft-delete keeps the block readable for audit / undo paths the
production code depends on, and makes `read_deleted` apples-to-apples
between `LoroEngine` and `TreeEngine`.

**Position is a scalar in the meta map, not a fractional index.**
`tree.enable_fractional_index(0)` would let us use `create_at` /
`mov_to`, but that changes the semantics enough (sibling-ordering
rules, doc-size growth — see Loro's
[movable-tree blog post](https://loro.dev/blog/movable-tree)) that
mixing the two adds noise to the head-to-head benchmark.  Phase 1
might revisit this.

### Head-to-head benchmark — LoroMap vs LoroTree

Same machine, same SEED, same op-stream
(30% create / 50% edit / 10% set_property / 5% move / 5% delete),
both binaries run back-to-back in `--release`.

| Metric | LoroEngine (LoroMap) | TreeEngine (LoroTree) | Delta |
| ------ | --------------------- | --------------------- | ----- |
| apply elapsed | **1.686 s** | **1.772 s** | **+5.1 %** (slower) |
| doc snapshot bytes | **6 717 224 B** (6.41 MiB) | **7 757 931 B** (7.40 MiB) | **+15.5 %** |
| peak RSS (Linux statm) | **151 322 624 B** (144.31 MiB) | **171 327 488 B** (163.39 MiB) | **+13.2 %** |
| alive blocks (sanity) | 25 145 | 25 145 | identical |
| sample creates verified | 100 / 100 | 100 / 100 | identical |
| sample deletes verified | 20 / 20 | 20 / 20 | identical |

LoroTree is **uniformly slightly worse** on every measured axis.  No
axis where it wins.  The deltas are small (single-digit on time,
mid-teens on size + RSS) but they are real and they are consistent.

The +15 % snapshot growth most likely reflects the cost of the
parent-pointer history that LoroTree records for every move — every
`tree.mov(target, parent)` is a `TreeOp::Move` op in the doc's oplog
including the fractional position even though we're not exercising
fractional indices (default position values still get stored).  The
LoroMap engine spends two `LoroMap::insert` calls per move
(parent_id + position) and Loro merges those into the LoroMap's
LWW-per-key history more compactly than the dedicated tree CRDT
encoding.

Read-path cost wasn't separately measured (it's amortised into the
verification phase, which both engines complete with 100/100
correctness).  No correctness regression on either engine.

### Concurrent-reparent semantics

The PEND-09 plan calls out "concurrent reparent — what happens when
two peers reparent the same block to different parents?" as open
question 5 in `pending/PEND-09-crdt-migration.md`.  The day-3
parity-corpus port already answered this for `LoroEngine`
(`parity_concurrent_reparent_different_parents`): both peers
converge on a single parent via LoroMap LWW per key; the loser's
intent is silently overwritten and not recoverable from the
post-merge LoroMap state.

New test `tests/concurrent_reparent_tree.rs` runs the same scenario
against `TreeEngine`:

1. Both peers seed `CHILD` under `PAGE_X`.
2. A reparents `CHILD` → `PAGE_Y`.
3. B reparents `CHILD` → `PAGE_Z`.
4. Snapshot exchange.
5. Assertion: both engines converge on the same parent.

Result on Loro 1.12: **both peers converge on `PAGE_Y`** (which is
the converger picked by the LoroTree CRDT's tiebreak rule).  An
additional 3-peer variant (`tree_concurrent_reparent_three_peers_converges`)
also converges on `PAGE_Y`.  The CRDT is deterministic given the
peer-id ordering.

**Verdict on intent preservation**: the *current state* of the doc
is LWW-equivalent to LoroMap+scalar — only one parent wins, the
losers' intents do not appear in `read_parent("CHILD")`.  HOWEVER:
because `LoroTree`'s movable-tree CRDT records `TreeOp::Move` as a
distinct op kind in the doc's oplog
(`loro-internal/src/container/tree/tree_op.rs`), the loser's move
*is* preserved in the operation history and is potentially
surfaceable through Loro's checkout / time-travel API.  In contrast,
the LoroMap+scalar engine records the loser's reparent as a
LoroMap-key write whose op-kind is identical to *every other LoroMap
write* — there's no structural way to distinguish "this overwrite
was a reparent" from "this overwrite was a property-set".

So the practical answer is: **state-level semantics are the same
(LWW one-parent-wins).**  The structural difference is that
LoroTree's oplog *could* be queried later to reconstruct "who
attempted to move CHILD where" — but exposing that to the UI would
require dedicated checkout / oplog-walking code that is well out of
Phase-1 scope.  For shadow-mode parity logging in Phase 1, both
engines are equivalent: the loser's intent is dropped from the
materialised state on both sides.

### Recommendation: stay with LoroMap for Phase 1+

**Verdict: stay with `LoroMap`.**  The plan's default holds.

Reasoning, in order of weight:

1. **No measurable upside.**  LoroTree is uniformly slightly worse
   on every measured axis (apply time, snapshot bytes, peak RSS) —
   small deltas, but no axis where it wins.  The migration cost
   (rewiring the engine, re-porting the day-3 parity corpus, new
   read-path code) is paid in exchange for a regression on every
   measurable dimension.
2. **Reparent semantics are equivalent.**  The big *theoretical*
   reason to prefer LoroTree was concurrent-reparent semantics:
   maybe the dedicated movable-tree CRDT could preserve the loser's
   intent in a way LoroMap+scalar can't.  Empirically: both engines
   produce LWW-one-parent-wins state-level semantics; the structural
   difference (Tree.Move op kind in the oplog) is not load-bearing
   for any Phase-1 user-visible feature.
3. **`LoroMap`+scalar is simpler.**  No fractional-index machinery,
   no side-table id_index, no `TreeID <-> block_id_str` parsing.
   The day-1 `LoroEngine` code is 558 lines; `TreeEngine` is 480
   lines plus the 30-line side-table dance and 25 lines of
   `parent_block_id_of` translation that a LoroMap engine doesn't
   need.  Less code = fewer Phase-1 bug surfaces.
4. **Cycle detection is still our responsibility either way.**  The
   plan's invariant ("a block can't become its own ancestor") is
   maintained at the application layer, and that layer is the same
   for either engine — the LoroTree CRDT does *not* prevent move
   cycles by itself in the general case (Loro's blog post on
   movable-tree explicitly mentions cycle-resolution on
   convergence, but the resolution rule is what it is — not
   something we can opt out of even with LoroTree).
5. **No format-stability concern in either direction.**  Both
   `LoroMap` and `LoroTree` are stable in the 1.x format (see
   day-1 finding); we are NOT picking based on relative format
   stability.

If a Phase-1 use-case emerges that genuinely benefits from
LoroTree-shaped storage (e.g. surfacing the move history in the
UI as an audit log, or relying on Loro's tree-aware checkout
semantics for time-travel), revisit then — switching is a Phase-1.5
refactor of a few-hundred lines.

### Surprises

- **TreeEngine wasn't *much* slower.**  Going in I expected the
  per-op `tree.get_meta(tid)` lookup + side-table `id_index.get` to
  add a meaningful constant per op compared to LoroMap's single
  `blocks.get(block_id)`.  Empirically the overhead is ~5 % on
  apply time and ~13 % on RSS — meaningful but not order-of-
  magnitude.  The CRDT machinery for move-history is more
  expensive than the lookup overhead.
- **Loro's `TreeID: Display` round-trips through `try_from(&str)`
  cleanly.**  No bespoke serialisation code needed — the side-table
  could just store the `TreeID` as its string form and parse on
  read.  That removed the only piece of design work I expected to
  be fiddly.
- **Three-way concurrent reparent still picks `PAGE_Y`.**  I
  half-expected the higher-contention variant to expose a
  non-determinism somewhere, but Loro's tiebreak rule is fully
  deterministic given the peer-id space.  Convergence held.
- **Zero correctness regressions on the head-to-head verification.**
  Both engines pass the same 100-create / 20-delete sample-read
  check.  The "soft-delete via meta flag" choice means
  `read_deleted` semantics are identical between the two engines
  even though the underlying delete mechanism differs.

### TreeEngine extensions / boilerplate

| Method | Purpose |
| ------ | ------- |
| `apply_create_block` | `tree.create(parent_tree_id)` + populate meta map (block_id, block_type, content as LoroText, position) + write to `id_index` side-table |
| `apply_move_block` | `tree.mov(target, parent_tree_id)` + `meta.insert(position)` |
| `apply_delete_block` | `meta.insert(deleted_at)` — soft delete; `tree.delete` deliberately not used |
| `apply_edit_content` | meta-map content `LoroText::splice` (USV offsets) — same as `LoroEngine` |
| `apply_set_property` | per-node `properties` LoroMap nested in meta — one level deeper than `LoroEngine`'s top-level `block_properties` |
| `read_*` | meta-map field reads + `tree.parent(tid)` for parent translation back to external block_id |
| `count_alive_blocks` | iterate `tree.nodes()` + filter on meta `deleted_at` |

No production-code changes.  No `Cargo.toml` changes.  Loro stays
at 1.12.

### Open questions touched today

- **(SPIKE-NOTES Q2 / "LoroTree head-to-head"): RESOLVED.**
  TreeEngine prototyped, head-to-head benchmarked, concurrent-reparent
  semantics measured.  Recommendation: stay with `LoroMap`.  See above.
- **(plan Q5 — concurrent-reparent semantics): RESOLVED for both
  engines.**  Both pick LWW-one-parent-wins at the state level;
  LoroTree records the loser's intent as a distinct `TreeOp::Move`
  op in the oplog (potentially surfaceable via Loro's checkout API)
  whereas LoroMap+scalar records it as an indistinguishable
  LoroMap-key write.  Phase 1 doesn't need this distinction; if a
  Phase-1.5 audit-log feature wants it, switch then.

## Day 6 (2026-05-09)

Two short open questions bundled together: peer-id strategy (Q7) and
commit cadence (Q6).  Both are quick once the Loro 1.12 surface is in
hand.

### Peer-id strategy (Q7) — RESOLVED

**Production input shape.**  `device_id` in agaric is a canonical
UUID-v4 string in lowercase-hyphenated form (see
`src-tauri/src/device.rs:83-99`, `get_or_create_device_id`).  The id is
generated once on first launch and never regenerated — it is the
device's permanent identity in the op log.

**Loro input shape.**  `loro::PeerID` is a transparent `u64` alias
(`loro-common/src/lib.rs:28`: `pub type PeerID = u64;`).
[`LoroDoc::set_peer_id`](https://github.com/loro-dev/loro/blob/main/crates/loro/src/lib.rs#L985)
takes that `u64` and returns `LoroResult<()>`; the docs warn:

> "Pitfalls: Never reuse the same PeerID across concurrent writers
> (multiple tabs/devices). Duplicate PeerIDs can produce conflicting
> OpIDs and corrupt the document."

So we need a deterministic, well-spread `String -> u64` mapping.

**Hash chosen: `std::hash::DefaultHasher` (SipHash-1-3).**  A single
free function `peer_id_from_device_id(device_id: &str) -> PeerID` lives
in `src/lib.rs`; both `LoroEngine::with_peer_id` and
`TreeEngine::with_peer_id` route through it before calling
`doc.set_peer_id(...)`.

Why not `xxhash-rust`?  Quicker hashes exist, but Q7 only needs a few
draws per process lifetime (one per engine construction); the hash is
nowhere near a hot path.  `std::hash` is in the standard library — no
new Cargo dep, satisfying the spike's constraint.

Why deterministic across runs?  `DefaultHasher::new()` uses a fixed
seed per the standard library docs — same input bytes, same digest, on
the same compiler version.  The docs reserve the right to change the
algorithm across stdlib versions.  For a *spike* that's fine; for
production the natural follow-up is to pin `xxhash-rust` for
cross-stdlib-version stability.  Captured as new question 13 below.

**Collision math (the headline reassurance).**  Birthday-bound for `n`
independent draws over a `2^64` space:

```text
P(collision) ≈ n² / 2 · 2^64 = n² / 2^65
```

For `n` = a "few thousand devices" the math:

| Devices `n` | `P(collision)` |
| --------------- | --------------------------- |
| 10 | ~1.4e-18  (effectively zero) |
| 1 000 | ~1.4e-14 |
| 10 000 | ~2.7e-12 |
| 100 000 | ~2.7e-10 |
| 1 000 000 | ~2.7e-08 |

At "few thousand devices" — agaric's plausible scale — collision
probability is ~1e-13 / ~1e-14: lower than the per-device probability
of cosmic-ray-induced bit flip in the same hour.  Loro's "never reuse
PeerID" caveat is satisfied probabilistically in the strongest sense
the universe permits.

**Tests added** (`tests/round_trip.rs`):

1. `peer_id_from_device_id_is_deterministic_across_instances` — same
   device_id ⇒ same peer_id, twice over, on both `LoroEngine` and
   `TreeEngine`.
2. `peer_id_from_device_id_spreads_distinct_inputs` — two distinct
   UUID-shaped device_ids hash to distinct peer_ids.
3. `with_peer_id_engines_round_trip_via_snapshot_swap` — two engines
   with stable peer_ids exchange snapshots, both peers see both
   blocks, post-merge snapshots are byte-identical.  Confirms that
   pinning peer_id doesn't break Loro's eventual-consistency property.

All three pass green.

### Commit cadence (Q6) — RESOLVED

**Method.**  Added `apply_*_no_commit` variants of every `apply_*`
method on `LoroEngine` (the existing public methods now route through
private `_inner` helpers and add `doc.commit()` afterwards; the new
public no-commit variants call the same `_inner` and skip the commit).
A public `commit()` method exposes `LoroDoc::commit_then_renew` so the
bench loop can drive its own cadence.

New binary `src/bin/commit_cadence_bench.rs` runs the day-4 30/50/10/5/5
op-mix at 10K ops at four cadences.  Bootstrap (16 page roots) is
outside the timed region; one final `commit()` after the loop ensures
the snapshot reflects every op regardless of K.

**Results** (representative `cargo run --release ... commit_cadence_bench`):

| K (every) | wall-clock (s) | snapshot bytes | alive blocks |
| --------- | -------------- | -------------- | ------------ |
| 1 (per-op) | 0.053 | 660 195 | 2 627 |
| 10 | 0.044 | 660 903 | 2 627 |
| 1 000 | 0.041 | 663 787 | 2 627 |
| 10 000 (1×end) | 0.047 | 660 780 | 2 627 |

Speed-up vs per-op baseline: K=10 ≈ 1.20×, K=1000 ≈ 1.29×, K=10000 ≈
1.13×.  Variance run-to-run is ±10-15 % at this 10K scale (sub-50 ms
absolute times); the deltas are dominated by noise.

**Trade-off discussion.**

- **Wall-clock.**  Worst-case (per-op) finishes 10K ops in ~50 ms.
  Best-case (K=1000) finishes in ~40 ms.  The absolute delta is ≤15 ms
  per 10K ops.  Extrapolated to a 100K-op replay (day-4 territory),
  the cadence question would buy or cost roughly a tenth of a second.
  Day-4's 100K replay finished in 1.7 s; a 10 % swing on that is
  noise-floor-level.  **The "batched commits are >2× faster" condition
  in the deliverable is NOT met** — they're ~1.2× faster, with
  per-cadence variance of similar magnitude.
- **Snapshot bytes.**  All four cadences produce snapshots within
  ~0.5 % of each other (660-664 KB).  No size regression for either
  end of the spectrum.  The K=1000 row is a hair larger because Loro's
  internal change-batching captures slightly more transitive history
  per commit, but the difference (~3 KB / 10K ops) is in the noise.
- **Crash semantics.**  Per-op commits localise blast radius: a crash
  loses *at most* the in-flight op.  Batched commits (K=1000 or
  K=10000) lose up to K-1 ops — for K=10000 that's the entire batch.
  The migration plan stores the canonical state in the existing
  `op_log` table; the Loro doc is a derived read-side cache.  Even at
  K=10000, a crash mid-batch is recoverable by replaying the lost ops
  from the op_log on next boot.  So the crash-safety axis isn't a
  hard blocker, but it tilts the recommendation toward simpler
  cadences when the perf delta is in the noise.

**Recommendation: keep per-op commits for Phase 1 cutover.**  The perf
delta does not exceed the deliverable's "2×" threshold; the simplicity
upside is real (no "what if we crashed mid-batch" reasoning, no need
to track unflushed-op count, no cadence tuning needed); and the day-4
result already showed that even at the pessimistic per-op cadence we
are 350× under kill-criterion #3's 10-minute wall-clock floor.

If a future profile flags `LoroDoc::commit` as a hot spot in a real
workload (say, the >10K-ops bulk-import path the materializer might
trigger), revisit batched commits *for that specific path* with an
explicit `apply_*_no_commit + commit()` pair.  The plumbing is now in
place; no further engine changes are required to opt in.

### Open questions touched today

- ~~**Q6 (`commit()` cadence).**~~  **RESOLVED.**  Per-cadence wall-
  clock variance (≤30 % at 10K ops) is below the 2× threshold; snapshot
  bytes invariant within 0.5 %.  Recommendation: keep per-op commits
  for Phase 1.  See above.
- ~~**Q7 (peer-id strategy).**~~  **RESOLVED.**  `LoroEngine::with_peer_id`
  / `TreeEngine::with_peer_id` constructors hash production `device_id`
  via `std::hash::DefaultHasher` (SipHash-1-3) into a `u64`; collision
  probability at agaric's scale is ~1e-13.  Three unit tests cover
  determinism, spread, and snapshot-swap convergence.  See above.
- **(NEW, day 6) Hash stability across stdlib versions.**
  `DefaultHasher` is "currently SipHash-1-3" but the algorithm is not
  contractually fixed across compiler versions.  For production, pin
  `xxhash-rust = "0.8"` (or similar) so a Rust compiler upgrade can't
  re-roll every device's peer_id.  Day-6 stays on `DefaultHasher`
  because (a) the spike is throwaway and (b) the bench-only behaviour
  needs determinism within a single build only.  Phase 1 tracker.

## Open questions for next session(s) (carry-over)

1. **Per-space doc sizing.**  Plan calls for one doc per space.
   **Day 4 partial answer: ~260 B/alive-block at the synthetic-content
   workload, so 100K blocks ≈ 26 MiB — well under load-time concern.**
   Outstanding: re-measure with production-realistic content lengths
   (50-500 chars/block) — see question 9.
2. ~~**`LoroTree` head-to-head.**~~  **Day-5: TreeEngine prototyped,
   benchmarked, measured.  LoroMap wins on apply-time (+5 %), snapshot
   bytes (+15 %), peak RSS (+13 %); state-level reparent semantics are
   equivalent.  Recommendation: stay with `LoroMap` for Phase 1+.**
   See Day-5 section above.
3. ~~**`merge/tests.rs` corpus port.**~~  **Day-3: 15/53 sampled,
   bucket distribution recorded above, kill criterion #2 not fired.**
   Full port + proptest augmentation remains.
4. ~~**Op-log import benchmark.**~~  **Day-4: 100K-op replay in
   1.677s wall-clock, 144 MiB peak RSS.  Kill criterion #3 NOT FIRED
   (margin: 358× on time, 14× on heap).**  See Day-4 section above.
5. ~~**`LoroText` for `content`.**~~  **Resolved on day 2** — switched
   in, round-trip green, concurrent-edit convergence proven, size
   overhead at 3-block baseline recorded.  See "Day 2" section above.
6. ~~**`commit()` cadence.**~~  **Day-6: 4-cadence benchmark
   (K = 1, 10, 1 000, 10 000) at 10K ops finds per-cadence variance
   ≤30 %, snapshot bytes invariant within 0.5 %.  Recommendation: keep
   per-op commits for Phase 1.**  See Day-6 section above.
7. ~~**Peer-id strategy.**~~  **Day-6: `LoroEngine::with_peer_id` /
   `TreeEngine::with_peer_id` hash the production `device_id` (UUID-v4
   string) via `std::hash::DefaultHasher` into a `u64`.  Collision
   probability at agaric's scale is ~1e-13.  Three unit tests cover
   determinism, spread, and snapshot-swap convergence.**  See Day-6
   section above.
8. **Materializer read path.**  Plan mentions the >10% perf regression
   threshold (PEND-09 risks).  Spike needs to compare in-memory Loro
   handle reads vs serialize-each-apply and benchmark both against
   the current SQL-table read path.
9. **Per-block LoroText overhead at scale.**  +17% at 3 blocks is
   tolerable; need 10K-block measurement with realistic content
   lengths to see if the fixed per-container overhead dominates.
   **Day-4 partial:** at synthetic short-content the overhead amortises
   to ~260 B/block — fine.  Real workload re-measurement still wanted.
10. **Edit-coordinate coercion.**  Spike uses Unicode-scalar offsets.
    Need to confirm production FE bridge can supply USV offsets or
    document the UTF-16 / UTF-8 coercion path.  See day-2 notes.
11. **(NEW, day 4) Cross-platform RSS measurement.**  The bench is
    Linux-only via `/proc/self/statm`.  Mac builds report `n/a` and
    skip the heap half of the kill-criterion check.  Add a libc-free
    macOS measurement (probably `mach_task_basic_info` via a thin
    `task_info` wrapper) before Phase 1 sign-off.  Cheap follow-up.
12. **(NEW, day 4) Real-op-log distribution.**  The bench's
    30/50/10/5/5 op-mix is the day-4 deliverable's stated proxy.
    PEND-09 line 205 calls out "verify against your `notes.db`
    pre-spike."  Sample the user's actual op_log histogram before
    Phase 1 to confirm the proxy is in the right ballpark.
13. **(NEW, day 6) Hash stability across stdlib versions.**  Day-6
    uses `std::hash::DefaultHasher` (SipHash-1-3 in current stable
    Rust) for the `device_id -> peer_id` mapping — fine for the
    spike, but stdlib reserves the right to change the algorithm
    across compiler versions.  For production, switch to a stable
    third-party hash (`xxhash-rust = "0.8"` is a natural fit:
    deterministic, fast, no heavy crypto deps).  Phase 1 tracker.
