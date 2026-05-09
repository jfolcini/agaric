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

| Peer | Edit                                                      |
| ---- | --------------------------------------------------------- |
| A    | offset 4, len 5, replacement `"slow"`  → "quick" → "slow" |
| B    | offset 16, len 3, replacement `"dog"` → "fox" → "dog"     |

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

## Open questions for next session(s)

1. **Per-space doc sizing.**  Plan calls for one doc per space; need a
   benchmark at 10K and 100K blocks before Phase 1 to confirm load
   times stay under ~500ms (PEND-09 risks table).  Day-1 has only the
   3-block baseline.
2. **`LoroTree` head-to-head.**  Build a parallel `LoroTree`-shaped
   prototype and measure (a) doc size for the same workload, (b)
   parent_id reparent semantics under concurrent edits, (c) read-path
   cost.  Plan stays with `LoroMap` unless `LoroTree` wins decisively.
3. **`merge/tests.rs` corpus port.**  53 test functions; need to map
   each to a Loro-driven equivalent and measure parity (kill
   criterion 2: byte-identical or CRDT-correct on >=95% of cases).
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
