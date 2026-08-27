# Session 1409 — the signpost pointing away from the bug

#4468 and #4460, both review follow-ups recorded rather than blocked on, and both instances
of the failure mode this repo keeps producing: prose that confidently describes something
the code does not do. Four of the five items are comments. The fifth is a divergence signal
that fires on exactly the state it should stay quiet about.

## A comment can be worse than no comment, and this is the shape

The #4460 case is the one worth leading with, because the comment was doing real harm rather
than merely being stale.

`agaric-sync/src/snapshot/create.rs` told anyone grepping for op-log ordering after #4402
that its `ORDER BY` was "the ONLY remaining `device_id`-before-`seq` comparator with an LWW
shape". That was false — `db/recovery.rs` still orders by `(created_at, device_id, seq)` in
the pre-migration block replay and again in the derived-state replay chunk, and #4448's own
comment a few hundred lines up describes that as the pass's deliberate LWW convention.

What makes it more than a stale claim is *why* the comment existed. It was written to orient
a future reader who greps for op-log ordering — and it orients them away from the one place
where the bug #4402 fixed is still live. `ATTACHMENT_REPLAYABLE` carries no `is_replicated`
filter and replays both provenances, so a same-millisecond cross-device
`rename_attachment`/`delete_attachment` pair resolves to a different winner in
`recover_attachments_from_op_log` than in `commands::history` and `reverse::*`. That is
#4455. The reader most likely to find it was the one this comment talked out of looking.

The comment now says what #4402 actually did — it canonicalised the sweep/history/reverse
comparators and left none of the old shape in *those* layers — and cross-references #4455 by
number, naming `recover_attachments_from_op_log` as the pass it is about. The first rewrite
of that sentence still claimed this `ORDER BY` was "the only remaining" such comparator
*within* those layers, which it cannot be: it lives in the snapshot layer, not one of them.
A scoping that puts the exception inside the set it is an exception to is the same defect in
a smaller font, and review caught it. Both halves were re-derived against the code rather
than taken from the issue — worth doing, since the issue's cited line numbers for the
recovery orderings were off in this checkout. Same claim, different lines.

## The same mistake twice, thirty files apart

#4468's first two items are one mistake made twice in a single PR: a new item inserted
between a docstring and the thing it documented.

In `agaric-engine/src/apply/kernel.rs`, `UnsweptBlock` landed between `ApplyEffects`'s
33-line type-level doc and `ApplyEffects` itself. Those 33 lines describe `restored_cohort`,
`deleted_cohort` and `delete_space_id` — fields `UnsweptBlock` does not have — so they had
become rustdoc for the wrong type, and `ApplyEffects` was left with no type-level doc at all.
In `agaric-sync/src/sync_daemon/session_supervisor.rs`, a new #4385 test landed between the
#4120 docstring ("a responder-only device dials, fails, and re-raises the red toast on every
cycle, forever…") and the test that prose belongs to.

Neither changes behaviour, and both mislead a reader who trusts what they read. Both are
reunited, and the newly-inserted items got their own accurate summaries rather than
inheriting someone else's.

That this happened twice in one PR is the useful part. It is not a lapse of care; it is what
inserting a definition above another definition does by default, and nothing in the toolchain
notices. A misattached rustdoc compiles.

## The signal that fired because routing failed

The one behavioural item. `dispatch_unswept_cohort` handled a block missing from the engine
asymmetrically: the `None` arm is a silent no-op, because `apply_restore_block` returns `Ok`
on a missing node, while the `Some(_)` arm goes through `get_block_map`, which errors on a
missing node — and that error is converted into a `divergence::record` bump plus a `warn!`.

So the durable divergence signal fired precisely on the arm reached *because* engine routing
had failed. A block projected SQL-only during a no-space window that later acquired a
`space_id` is a legitimate state, and it was raising drift.

The fix mirrors the guard the engine-arm inline sweep already uses for this exact case
(`if engine.read_block(id)?.is_some()`). The care is all in what it does *not* do: only a
known-absent block (`Ok(None)`) is skipped, so a `read_block` error or a `for_space` failure
dispatches exactly as before. A guard that swallowed those would be strictly worse than the
over-reporting it replaces. It is deliberately not metered on `descendant_fanout_dropped` —
that counter means "a skip that left the engine potentially divergent", and this skip is the
opposite of that.

## What the falsification actually proved, and what it did not

The new test drives two cohort members down the same `Some(ts)` arm so that engine
membership is the only difference between them, and asserts a pair: no `engine_apply_diverged`
in the captured warn stream, **and** the present member's engine register carries the settled
cohort ts. The pair exists because "no divergence recorded" is otherwise true for two
reasons — the guard fired, or control never entered the loop at all, since the empty-cohort
and no-space early returns are both silent.

Neutering the guard to `if false` reddens the test, with the engine's "block not found"
warning and the `engine_apply_diverged counter=1` line both in the output.

Worth recording precisely because it cuts against the tidy version of the story: under that
mutation the **register half of the pair passed**. Only the log half failed. So the register
assertion is not discriminating for this particular break, and the test's RED is attributable
to one of its two halves. That does not make the pair pointless — the positive membership
preconditions are what catch a guard that over-fires and skips the present member too — but
"I broke the fix and the test went red" proves *something* covers the behaviour, not that
every assertion in it does. The honest report of which half moved is more useful than the
count of assertions.

## A claim narrowed, then found to be narrower still

`unswept_space_id`'s comment said `None` happens "only when the block carries a NULL
`space_id` (pre-spaces data)". Checking it: `resolve_soft_deleted_block_space` selects
`b.space_id` alone, with none of the `COALESCE(b.space_id, p.space_id)` page fallback that
`resolve_block_space` has — so it also answers `None` for a block whose own column has not
been propagated while its page is spaced. That is the second case the issue named.

There is a third the issue did not: an absent row, where `fetch_optional` yields `None`
outright. The wording now covers all three. An identical "(pre-spaces data)" gloss on the
no-space early return inside `dispatch_unswept_cohort` was rewritten too — leaving one of a
matched pair stale would have reproduced the exact failure mode the issue is about.

## What shipped

- #4468 — two docstrings reunited with what they document; the unswept mirror's divergence
  signal guarded against a legitimate SQL-only projection, with a test; `unswept_space_id`'s
  `None` cases stated exhaustively, in both places the claim appeared.
- #4460 — `snapshot/create.rs`'s ordering claim restated as what #4402 canonicalised, with
  this `ORDER BY` named as the exception outside those layers rather than a member of them,
  and #4455 cross-referenced (by its actual pass) instead of implied out of existence.

## Left for a follow-up

`dispatch_delete_descendants`, ~120 lines above the guarded helper in the same file, has the
identical asymmetry and a *more* reachable trigger: `ApplyEffects::deleted_cohort` and
`delete_space_id` are populated whether or not `apply_delete_block_via_loro` took the engine
path, so a delete whose seed is absent from the engine records `EngineMissingTarget`, falls
back to SQL — and then the post-commit fan-out feeds that same absent seed to `engine_apply`,
which bumps `divergence::record` for a state the apply path had already classified as
legitimate. Deliberately not folded into this PR: it is a second behavioural path outside
#4468's scope and needs its own falsified test.
