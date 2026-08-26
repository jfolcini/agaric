# Session 1393 — the residue three approved reviews left behind (Rust half)

## Why this session exists

PRs #4368, #4369 and #4370 were all APPROVED and all green, and each carried a
list of non-blocking notes in the review body. An approved verdict is not "nothing
to address" — the notes were real, and the repo's own process rule says they must
be disposed of rather than dropped.

The dispositions here are deliberately NOT "file an issue". #4368 landed a tightened
filing bar in the same batch: an issue needs a named victim and a stated harm.
Documentation that describes a mechanism which no longer exists has a named victim —
the next reader — and the fix is to correct the sentence, not to track it. An
optimisation nobody needs has no victim, and belongs in a comment next to the code
so the next reader knows the shape was considered.

## What changed

### #4289's rename left five sites naming deleted symbols

#4289 renamed `descendant_cascade_truncated` to `materialize_cascade_cohort` and
deleted `ancestor_probe_truncated` outright.

Counted, not estimated: `git grep -c` for the two stale symbols at the base commit
(`27fd4e5`) returns **5**, all in `src-tauri/src/db/recovery.rs` — lines 1186, 2171,
4762, 4877 and 4964. At HEAD it returns **1**.

So it is **five sites, four rewritten, the fifth kept** — not five plus a sixth. One
of the four was inside an assertion *message string*, so a failing test would have
pointed the reader at a symbol they could not grep for.

The fifth (line 2171, a `//` comment in the `move_block` arm) was deliberately KEPT —
it refers to the mechanism #4289 replaced, which is legitimate history — but
disambiguated with "(deleted by #4289; named here only as the shape this replaced)"
so nobody greps for a live symbol.

*(An earlier draft of this log headed this section "#4269" and described the count as
"five sites plus a sixth occurrence". #4269 is the unrelated TypeScript
`declare`-erasure guard, and the count was off by one. Both were caught in review —
a misattribution and a miscount, in the section that exists to fix a misattribution
and in a log whose own thesis is that every count names what it is over.)*

Verified with `RUSTDOCFLAGS="-D rustdoc::broken_intra_doc_links" cargo doc`: zero
broken intra-doc links remain in `db/recovery.rs`. (155 pre-existing ones live in
other modules and are out of scope.)

### A doc describing a guard that was retired in the same PR

`cascade_cohort_unreached_children` said cohort-member frontier ids "are NOT filtered
out here; `purge_truncated_tails`'s still-orphaned guard drops them instead". #4287
retired that guard. The behaviour is still correct — the `step.rows_removed == 0`
skip does the work — but the doc named a mechanism that no longer existed. Rewritten
to name the one that does.

### The session-1392 log contradicted itself

Lines 38-41 described the `still_orphaned` guard in the present tense as "what stops
it over-reaching"; lines 80-83 of the same file said it was retired. Both are true of
different moments. The earlier passage is kept as history and reframed as
"*As first written* — this is the pre-review design, superseded later in the session".

### Three-way issue misattribution

The `CascadeTruncation::depth` removal was filed under #4290 in the code heading, #4289
in the PR body, and "the second half of #4290" in the session log — while #4290 is the
unrelated bug-report log-rotation issue. #4289 is the owner; the code and log now say so.

### The sync scheduler claimed an ordering it does not deliver

#4231's `evict_for_new_peer` documented its victim as "least-recently-touched, measured
by `next_retry_at`". That holds while peers sit on different ladder rungs. Once the
ladder SATURATES at `MAX_BACKOFF`, every offset is 60s ±10% — a ~12s spread that swamps
the true touch-time spread of peers that failed close together, so within a saturated
cohort the victim is effectively **arbitrary**.

The decision does not rest on picking the right victim (evicting any entry costs at most
one premature retry), so the policy is unchanged — only the claim is. This is the repo's
"claims must carry their denominator" rule applied to a doc comment.

The `tracing::debug!` at the eviction site repeated the same overstatement and now says
"earliest-retry" instead. It is the only executable-adjacent line in the Rust doc pass.

A second paragraph records that the cap's cost is **attacker-influenceable**: anyone on
the LAN can hold the map at the cap by announcing more than 64 device ids, keeping a
legitimate peer's retry hint evicted for as long as the flood lasts. That is the
documented "noisier, never quieter" direction and is what the code did before #4231, so
it is not a regression — but the previous text let a reader infer that only incidental
churn could reach the cap.

### A missing test, and a review claim that was wrong

#4370's review noted that `set_property_batch_inner`'s new `warn_if_batch_skips_recurrence`
call had no test, and said it was "covered only indirectly, through the pre-existing
`set_todo_state_batch_inner` path".

**That second half was false.** `grep -rn batch_recurrence_skip --include=*.rs` matched
only `properties.rs` — *neither* call site had a test. A relayed claim is evidence that
someone believes it, not that it is true; this one was checked and did not survive.

The new test pins the warn to `command="set_property_batch_inner"` and asserts the
sibling call site is NOT what it is observing — necessary, because both sites emit the
same target, so an assertion on the target alone would pass with the code under test
deleted. A control case (a non-`todo_state` key must stay silent) pins the gate as well
as the call.

Falsification: with only the `set_property_batch_inner` call commented out and the
sibling left live, the captured buffer is empty — `got: ""` — proving the test observes
the intended site.

## Dispositions that were NOT fixes

Two review notes were recorded as code comments rather than acted on:

- `purge_truncated_tails` issues one four-statement step per frontier seed (4×N round
  trips per level). The single-seed-per-round form was considered and rejected: it merges
  the per-seed answers the loop reads apart (`rows_removed == 0` distinguishes a
  really-purged seed from an already-gone one). Recovery replay is rare.
- `CREATE TEMP TABLE IF NOT EXISTS` is re-issued per cascade op. Hoisting it once per
  replay was considered; the self-contained form is callable from any arm or a test with
  no precondition, for one no-op DDL round trip on a recovery-only path.

## Verification

- `cargo check --all-targets`: clean.
- `cargo nextest run --workspace -E 'test(recovery) or test(purge) or test(cascade)'` — 340 passed.
- `cargo nextest run --workspace -E 'test(sync_scheduler) or test(backoff) or test(property) or test(recurrence)'` — 628 passed.
- `cargo fmt --all --check`: clean.

No executable line changed in this branch apart from the one `tracing::debug!` string
and the new test.
