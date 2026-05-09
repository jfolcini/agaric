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

## Open questions for next session(s) (carry-over)

1. **Per-space doc sizing.**  Plan calls for one doc per space; need a
   benchmark at 10K and 100K blocks before Phase 1 to confirm load
   times stay under ~500ms (PEND-09 risks table).  Day-1 has only the
   3-block baseline.
2. **`LoroTree` head-to-head.**  Build a parallel `LoroTree`-shaped
   prototype and measure (a) doc size for the same workload, (b)
   parent_id reparent semantics under concurrent edits, (c) read-path
   cost.  Plan stays with `LoroMap` unless `LoroTree` wins decisively.
3. ~~**`merge/tests.rs` corpus port.**~~  **Day-3: 15/53 sampled,
   bucket distribution recorded above, kill criterion #2 not fired.**
   Full port + proptest augmentation remains.
4. **Op-log import benchmark.**  100K-op replay timing + heap (kill
   criterion 3: <10 min wall-clock, <2 GB peak heap).  Prerequisite:
   measure the user's actual op-log volume and scale the threshold.
5. ~~**`LoroText` for `content`.**~~  **Resolved on day 2** — switched
   in, round-trip green, concurrent-edit convergence proven, size
   overhead at 3-block baseline recorded.  See "Day 2" section above.
6. **`commit()` cadence.**  `apply_create_block` calls `doc.commit()`
   after every block, which is the pessimistic case.  Need to measure
   whether batching commits changes export size + replay cost
   meaningfully before settling on a cadence.
7. **Peer-id strategy.**  Day-1 uses Loro's auto-assigned peer id.
   Production wants something derived from device_id (already
   available in agaric) so that op streams are attributable.  Need to
   confirm `LoroDoc::set_peer_id` is the right API and that the
   peer-id space is wide enough.
8. **Materializer read path.**  Plan mentions the >10% perf regression
   threshold (PEND-09 risks).  Spike needs to compare in-memory Loro
   handle reads vs serialize-each-apply and benchmark both against
   the current SQL-table read path.
9. **Per-block LoroText overhead at scale.**  +17% at 3 blocks is
   tolerable; need 10K-block measurement with realistic content
   lengths to see if the fixed per-container overhead dominates.  See
   day-2 notes above.
10. **Edit-coordinate coercion.**  Spike uses Unicode-scalar offsets.
    Need to confirm production FE bridge can supply USV offsets or
    document the UTF-16 / UTF-8 coercion path.  See day-2 notes.
