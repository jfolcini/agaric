# PEND-09 — LWW resolution rule (concurrent property + move writes)

## Scope

This doc captures the project's **Last-Writer-Wins (LWW) rule** for two specific kinds of concurrent operation: `set_property` writes to the same `(block_id, key)` pair, and `move_block` ops on the same block. It is the design-doc artefact called for by `pending/PEND-09-crdt-migration.md` Q5 (line 201) and the Phase-1 readiness checklist item 9 in `pending/PEND-09-SPIKE-REPORT.md` §6 (line 243).

It does **not** cover three-way text merge (that's `merge_block_text_only`'s job; it produces a conflict copy if diffy can't resolve cleanly), nor any other class of concurrent operation. Items explicitly out of scope are listed in the "When the rule does NOT fire" section below.

## What LWW means in agaric

When two devices write the same scalar property (or the same block's parent / position) on disjoint causal histories — i.e. neither device's op cites the other in `parent_seqs` — exactly one write must win at materialisation time, deterministically, on every device that sees both ops. There is no merging, no concatenation, no conflict copy, and no user-facing UI: the losing write is silently dropped from the materialised state.

The **timebase is wallclock UTC**, not Lamport, not hybrid. Every op carries a `created_at: String` field populated at append time by `crate::now_rfc3339()` (`src-tauri/src/lib.rs:288-290`), which returns `chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)` — a fixed-width `YYYY-MM-DDTHH:MM:SS.sssZ` string. The `lib.rs:280-287` doc comment explicitly enforces the `Z` suffix so lex order matches instant order; `op_log::append_local_op_in_tx` carries a `debug_assert!` to that effect.

This is a deliberate, load-bearing choice. Wallclock is what the user means by "later" when they edit the same property on two devices; Lamport timestamps would surprise the user (an offline device whose clock has not advanced could "lose" to an online device that came back online after a real-world day of inactivity, despite the user remembering they had set the property after that other write).

## The resolution rule, plainly stated

**For `set_property` conflicts on the same `(block_id, key)`:**

The op with the **later `created_at` wins.** If `created_at` ties exactly, the op with the **lexicographically larger `device_id` wins.** If `device_id` also ties (same device, same millisecond), the op with the **larger `seq` wins** — guaranteeing commutativity even in pathological same-device-same-ms cases.

Implementation: `resolve_property_conflict()` in `src-tauri/src/merge/resolve.rs:223-297`. The dispatcher that finds conflicting pairs and applies the rule lives in `src-tauri/src/sync_protocol/operations.rs:515-697` (the "set_property conflicts (LWW)" section).

**For `move_block` conflicts on the same `block_id`:**

Almost the same rule: later `created_at` wins, larger `device_id` breaks ties. Implementation: inline in `src-tauri/src/sync_protocol/operations.rs:699-822` (specifically the `match` at lines 768-778). Two intentional simplifications relative to the property path:

- The timestamp compare is **lexicographic on the raw `String`** (`op_a.created_at.cmp(&op_b.created_at)`), not RFC 3339 parsed. This is sound today because every op routes through `now_rfc3339()` which produces fixed-width `Z`-suffixed timestamps that lex-sort matches instant-sort; a future ingest path mixing `Z` with `+00:00` would silently break this comparison without the parse-and-fall-back guard the property path carries (`resolve.rs:252-266`).
- There is **no `seq` tertiary tiebreaker.** When `created_at` and `device_id` both tie (same device, same millisecond), `op_a` wins by default via `>=` at line 772. In practice `op_a` is the local-side op, so the rule is "ties go to the local device" — deterministic but not symmetric with the property rule. This is acceptable because the same-device-same-ms case never arises in single-device flushes (a single device's `seq` monotonically advances at sub-ms cadence), and cross-device `device_id` ties are impossible by construction (each device's id is a ULID).

## What "concurrent" means

Two ops are concurrent for the purposes of this rule iff their causal histories are disjoint — neither op's transitive `parent_seqs` chain includes the other. In DAG terms: they're on different branches that have not yet been merged.

The detection logic does **not** walk the DAG explicitly. It relies on a simpler proxy: look at the post-sync `op_log` and ask "are there two devices that each emitted a `set_property` op for the same `(block_id, key)`?" (the `HAVING COUNT(DISTINCT device_id) > 1` clause at `src-tauri/src/sync_protocol/operations.rs:520-528`). If yes, the latest op per device is fed to `resolve_property_conflict`. The DAG-walk version would catch cases where one device's later op already cites the other's (i.e. the conflict was already merged) — the proxy version handles those via the post-resolution **idempotency guard** described below.

## What the user sees

Nothing. The losing write is materialised away — overwritten by a fresh `set_property` op carrying the winner's value (`operations.rs:675-683`). There is no toast, no badge, no "your edit was overridden" dialogue. The new op enters the `op_log` like any other write, propagates to the other device on the next sync, and converges both devices' materialised state on the winner.

This is the same UX surface as Phase 0 + Phase 1 of the Loro migration: `LoroMap` + scalar value uses LWW with key-write timestamps, and produces no user-visible conflict event for property writes. The user's only signal that the rule fired is the absence of a property value they thought they set — and even that is only visible if they happen to look. (The `pending/PEND-09-SPIKE-NOTES.md` day-3 corpus confirms ~17 of the 53 `merge/tests.rs` cases exercise LWW-tiebreak paths and all converge silently.)

A future "remote-overrode-your-move" awareness log is logged as a Phase-4 polish in `pending/PEND-09-crdt-migration.md:121` and `pending/PEND-09-SPIKE-REPORT.md` §5 (the LWW-tree-op risk row); it is **not** part of the Phase-1 surface.

## What this is NOT

- **Not 3-way merge.** Three-way text merge of block content is a separate code path (`merge::merge_block_text_only` at `src-tauri/src/merge/apply.rs:47-140`); it can produce a conflict copy. Property/move LWW never produces a conflict copy.
- **Not CRDT-counter / OR-set semantics.** Properties are scalar fields, not counters or sets. Two concurrent `set_property` ops do not combine into a multi-value blob; one wins.
- **Not user-visible conflict resolution.** No `is_conflict=1` row is created for property/move LWW. The losing intent is dropped from materialised state and is recoverable only by walking the `op_log` directly (audit / debugger / future Phase-4 log).
- **Not commutative across all devices in all cases.** The rule itself is commutative (same input → same winner), but if a device's wallclock skews far enough to flip the `created_at` order from the user's intuition, the user-visible "later" can disagree with the rule's "later". See "Edge cases" below.

## Where the rule is implemented

- **Property LWW algorithm:** `src-tauri/src/merge/resolve.rs:213-297` — `resolve_property_conflict()`. Compares `created_at` via `chrono::DateTime::parse_from_rfc3339`, falls back to lexicographic string compare on parse error (with a `tracing::warn!`).
- **Property LWW dispatcher:** `src-tauri/src/sync_protocol/operations.rs:515-697`. Finds candidate `(block_id, key)` pairs, fetches the latest op per device (single-pass `ROW_NUMBER()` query), feeds them to `resolve_property_conflict`, applies the winner via a fresh `set_property` op.
- **Property LWW idempotency guard (M-43):** `src-tauri/src/sync_protocol/operations.rs:592-673`. Skips the apply if the materialised value already matches the winner — prevents perpetual re-emission of the same LWW op every sync round when no real divergence remains.
- **Move LWW algorithm + dispatcher:** `src-tauri/src/sync_protocol/operations.rs:699-822`. Inline; `created_at` (lex) → `device_id` (with `op_a` winning on full tie) ordering. See the move-rule section above for the two simplifications relative to the property path (no RFC-3339 parse, no `seq` tertiary tiebreak).
- **Move LWW idempotency guard (M-44):** `src-tauri/src/sync_protocol/operations.rs:783-807`. Same shape as M-43.
- **Tiebreak commutativity tests:** `src-tauri/src/merge/tests.rs:775-907` — five tests covering later-wins, earlier-loses, larger-device-id-wins, same-device-higher-seq-wins, commutativity under equal timestamp + device.

## Loro-side equivalence

`pending/PEND-09-SPIKE-REPORT.md` §3 Q5 (line 45) is the load-bearing reference:

> LoroMap+scalar: LWW one-parent-wins (`parity_concurrent_reparent_different_parents`). LoroTree: also LWW one-parent-wins at the state level (`tree_concurrent_reparent_two_peers_converges` + 3-peer variant). Structurally LoroTree records `TreeOp::Move` as a distinct oplog op, potentially surfaceable via Loro's checkout API; LoroMap+scalar records it as an indistinguishable LoroMap-key write. Phase 1 picks LoroMap+scalar (see §4); the LWW resolution rule will be documented in the Phase-1 design doc per plan risks table.

So: `LoroMap` + scalar value uses **LWW with key-write timestamps**. In normal cases (`pending/PEND-09-SPIKE-REPORT.md` §2 row 2: bucket A = byte-identical or B = Loro better), Loro's per-key LWW resolves to the same winner the SQL dispatcher does, because the timestamps Loro stamps on key writes are derived from the same underlying clock the `created_at` column carries. The day-3 parity port (`pending/PEND-09-SPIKE-REPORT.md` §3 Q5; spike `tests/parity_corpus.rs`, archived — see git tag `pend-09/spike-archive`) confirms this: 13/15 cases A+B, two C cases documented as expected CRDT semantics (RGA-CRDT identical-edit doubling and Lamport-vs-wallclock LWW tiebreak — neither a property/move LWW disagreement).

Phase 1 dual-writes both engines; the existing diffy-based dispatcher remains authoritative. Phase 2 cutover hands authority to Loro, at which point `resolve_property_conflict` and the `operations.rs` dispatchers become deletable. The wallclock-based timebase semantics survive the cutover unchanged — Loro's internal LWW is timestamp-driven, and the timestamps come from the same `now_rfc3339()` source.

## When the rule does NOT fire

- **Text-content edits (`edit_block`).** These go through `merge::merge_block_text_only` (`apply.rs:47-140`), which calls a 3-way diffy merge (`merge::detect::merge_text`). On clean merge: a synthetic `edit_block` op stitches the two heads. On conflict: a conflict copy is created carrying "theirs" content; the original retains "ours". This is the **only** path that produces user-visible `is_conflict=1` rows.
- **Block creates / deletes / restores / purges.** These flow through the DAG merge and the materializer dispatcher (`materializer/handlers.rs::apply_op`); the DAG itself is the merge mechanism, not LWW.
- **Tag / link adds + removes.** Set-semantics at the materialiser level (dedup on read); concurrent add+remove does not invoke the LWW rule. Discussed in `pending/PEND-09-crdt-migration.md:43`.
- **`delete_block` vs concurrent `edit_block` ("resurrect" path).** A fourth case in `merge_diverged_blocks` (`operations.rs:824` onward): the edit wins and a `restore_block` op is emitted. Not LWW — it's an **edit-beats-delete** rule, intentionally biased toward not losing user content.
- **`move_block` vs `delete_block`.** Commutative — both ops apply in sequence and the block ends up deleted regardless of order. Documented at `operations.rs:415-419`.

## Edge cases

- **Wallclock skew across devices.** The rule trusts each device's wallclock at op-append time. A device whose clock is 30s fast will reliably "win" LWW races against a device whose clock is correct, even when the user interaction order on the slow device came later in real time. There is no NTP dependency in the codebase. Mitigation: the user owns both devices in agaric's offline-occasional-sync model, so skew is bounded by OS clock-sync (typically sub-second on modern OSes) and the user is the same person on both sides.
- **Identical timestamps + Lamport-tiebreak claim.** The phrase "Lamport-vs-wallclock LWW tiebreak" appears in `pending/PEND-09-SPIKE-REPORT.md` §2 (kill criterion 2) as a documented C-bucket case in the day-3 corpus port. The agaric production rule does **not** use Lamport — it uses `device_id` lex compare as the first tiebreaker (`resolve.rs:271-274`), `seq` as the second (`resolve.rs:275-278`). The C-bucket label in the spike refers to a corpus test where Loro's internal tiebreak (which is closer to Lamport-of-write-order) picked a different winner than the production rule did. Both winners are CRDT-correct; production reproducibility is preserved because both the SQL path and (post-cutover) Loro use a deterministic tiebreaker, just not the same one. Phase 2 cutover may need a one-shot "re-run LWW with Loro's rule" pass on legacy `is_conflict=1` rows; this is captured as `pending/PEND-09-crdt-migration.md` Q8.
- **Clock drift backward.** A device whose clock jumps backward (e.g. NTP correction, or user manually setting the date) can produce a `created_at` smaller than its previous op's `created_at`. The rule still works — later real-world writes on that device will still beat the device's own earlier writes once the clock catches up — but during the drift window, the device may "lose" races against its previous self. The op_log's per-device `seq` is monotonic regardless of wallclock (`op_log::append_local_op_in_tx`), so the seq tiebreaker is the safety net for the same-device-same-ms-after-drift edge case. There is **no** "is the new `created_at` plausibly later than the previous one?" guard — by design, since the user's clock is the authority.
- **`created_at` parse failure.** `resolve_property_conflict` falls back to lexicographic string compare with a `tracing::warn!` if either timestamp fails RFC 3339 parsing (`resolve.rs:257-265`). Given the `Z`-suffix invariant enforced at write time, this should be unreachable in practice; it's a defence-in-depth log, not a behaviour the rule depends on.

## See also

- `pending/PEND-09-crdt-migration.md` Risks table (line 105) and Q5 (line 201) — the open question this doc answers.
- `pending/PEND-09-SPIKE-REPORT.md` §3 Q5, §5 (the LWW-tree-op risk row) — the spike-side equivalence.
- `pending/PEND-09-fe-edit-coordinate-space.md` — companion doc covering the FE-vs-BE edit-coordinate boundary.
