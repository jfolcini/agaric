# Session 1411 — a cohort is not its seed

#4472, plus three documentation residuals from #4473. The fix is four lines; choosing
between the two candidate fixes took the rest, and the choice turned on a counterexample
that had to be constructed rather than reasoned about.

## Two fixes, one of which quietly reintroduces the bug

`dispatch_delete_descendants` had the asymmetry #4468 fixed one helper over: the apply
path probes the engine, finds the seed absent, records a legitimate SQL-only fallback —
and then the post-commit fan-out feeds that same absent seed to `engine_apply`, which
raises a divergence. One half of the system calls the state a soft fallback and the other
calls it drift.

The issue offered two fixes and said explicitly it was worth deciding between them:

- **(a)** mirror #4468's per-member guard in the fan-out;
- **(b)** stop populating `deleted_cohort` unconditionally at `kernel.rs:590-598`, since
  the apply path already knows the seed is absent and is discarding that knowledge.

(b) is the tempting one. It removes the contradiction at what looks like its source, and
it is cheaper. It is also wrong, and wrong in a way no test would have caught, because no
test asserts divergence on this path at all.

The counterexample: `apply_move_block_via_loro` falls back on **either** of two probes —
the block missing, *or* its new parent missing. So a block C that exists in the engine can
be moved under an absent parent A, and SQL reparents C under A while the engine keeps C
exactly where it was, still present. Deleting A then yields a cohort whose **seed is absent
and whose descendant is present**. Under (b) the whole cohort is dropped, C stays alive in
the engine, and SQL tombstones it — a fresh divergence, of exactly the kind this helper
exists to prevent.

So the contradiction's real source is not that the cohort is populated unconditionally. It
is that **the fan-out was reading SQL-cascade membership as engine membership**, and those
are different sets. Per-member is the only granularity at which that is correctable. The
reasoning is recorded at the code, because the next person to look at this will have the
same idea about `kernel.rs` that the issue did.

Review reconstructed the counterexample in source rather than accepting it — including that
`resolve_block_space`'s `COALESCE` really does resolve A's space through its page when A's
own column is NULL, so the fan-out does target the engine that holds C. The construction
closes. It also found the builder's "6 consumers" was really 4 production read sites plus 3
test ones; the load-bearing half of the claim held, the count did not. Claims carry their
denominator or they carry nothing.

## Metering a skip so the skipped population stays countable

#4468's skip was `trace!`-only and bumped no counter, and the #4473 review's objection was
sharp: "absent from the engine" is *also* the shape of genuine drift — a `CreateBlock` whose
engine mirror failed and was swallowed — and that class now produced nothing at any
production level.

Both skips now record `SqlOnlyFallbackReason::EngineMissingTarget`, the vocabulary the in-tx
delete path already uses for the identical decision about the identical block, one
transaction earlier. Not `descendant_fanout_dropped`, which means "SQL moved a cohort the
engine did not mirror": for an absent member the engine state is the same whether we skip or
dispatch-and-fail, so nothing diverges that was not already unrepresented.

The `record` sits at the **skip site, not inside the probe** — deliberately, so a guard that
stops skipping also stops counting. That is what makes the counter assertion falsifiable; if
the probe metered, the assertion would hold whether or not the guard fired.

## The batch reproduced the defect it was fixing

This is the part worth remembering. The change widens what
`StatusInfo::sql_only_fallback_count` counts — same population, but a new recorder. Two
shipped, operator-facing descriptions still said the counter was handler-only, and the diff
made both false:

- the **OTel exported description** for `agaric.materializer.sql_only_fallback` — the string
  an operator reads on a dashboard;
- the `StatusInfo::sql_only_fallback_count` doc, which tauri-specta copies verbatim into
  `src/lib/bindings.ts` as JSDoc, so it is a generated artefact and a docs-only edit to it
  is not docs-only.

Both also still named `engine uninit`, a reason #2249/#2250 deleted and whose module docs
say must not come back — stale independently of this work.

A batch about prose drifting from code drifted its own prose from its own code, in the two
places most visible to someone outside the codebase. The lesson is not "check the docs"; it
is that **widening what a metric counts is an interface change**, and its description is
part of the interface.

## What a mutation actually proves

The test asserts a triple, because "no divergence recorded" is true for at least three
different reasons: the guard fired, the loop never ran, or the guard over-fired and skipped
everything. So it pins the present member's register carrying the delete's timestamp, the
counter advancing by exactly one, and the warn stream carrying no `engine_apply_diverged`.

Four mutations were run, and review found the set incomplete in an instructive way.
Disabling the guard reddens the **counter** assertion, which is evaluated first — so that
mutation never demonstrates the *log* assertion is live at all. The mutation that does is
keeping the `record` and dropping the `continue`, which produces the issue's exact warn line
from the real subscriber. Without it, the third arm of the triple was decoration.

The over-fire mutation was likewise weaker than it looked: the test's own helper shares the
probe, so forcing the probe false kills the precondition rather than exercising the
over-fire arms. Making the *helper* over-fire is the real test.

Both are the same lesson in different costumes: **an assertion you have never seen fail is
not covered, and the mutation that reddens a test may be reddening a different assertion
than the one you meant to prove.**

## Contention, not failure

The full workspace suite ran 6227 tests: 6224 passed, 2 flaky (passed on retry), and 3 timed
out — `import_markdown_multi_chunk_tree_matches_single_chunk` and two `compute_reverse`
proptests. Re-run in isolation they finish in 16-18s against a 60s cap. That is contention
under a 6227-test parallel run, not breakage, and none of the three touches the fan-out or
the counter. It is also a live corroboration of #4474, which says the full-suite contention
model the slow-test leashes were sized against is wrong.

## Round two: a justification that proved less than it claimed

Review approved the code and then took the *reasoning* apart, which is the more useful
outcome. The skip's justification read "a block with no node in this engine has nothing to
diverge". The probe only establishes absence from the **seed's** space engine, and that is
strictly weaker. `apply_move_block_sql_only` reparents through
`project_move_block_to_sql`, which binds `block_id` / `parent_id` / `position` and leaves
`blocks.space_id` alone — so a block stamped for space Y can become a `parent_id`
descendant of a block in space X, and the cohort CTE, which walks `parent_id` and nothing
else, sweeps it into X's delete cohort. The fan-out asks X, hears "absent", and files a soft
fallback while the block is alive in Y's engine and SQL has tombstoned it. That member
really is the `descendant_fanout_dropped` case.

Every step of that was checked in source before it was written down. The disposition was to
**narrow the sentence, not split the counter**: nothing regresses (the fan-out only ever
dispatches into the seed's space, so the mirror onto Y never happened either way — the old
behaviour merely failed loudly against an engine that could not have taken it), and
splitting would cost a `resolve_block_space` per member on a post-commit path that today
issues no query at all, to separate a residue needing a cross-space move under a
since-deleted parent. The cost is recorded at the code rather than papered over.

The counter's framing was wrong in a second, smaller way: it counts **decisions, not
blocks**. A `DeleteBlock` whose seed is absent records once in-tx and once from the fan-out,
whose cohort deliberately includes the seed. The double-count is harmless under "nonzero
means investigate" — but only once the doc stops implying a population.

## A comment defending against a deadlock that does not exist

The new test carried `flavor = "multi_thread"` and a rationale: the single-threaded flavour
deadlocks on the post-commit fan-out. `dispatch_delete_descendants` contains no `.await` at
all, so there is nothing for a current-thread runtime to block on — the rationale was
guessed, and the sibling #4468 test drives the structurally identical helper on a plain
`#[tokio::test]`. Measured: four consecutive runs under the plain flavour, four passes.

The flavour still matters, for the reason the original comment was arguing *against*:
`set_default` installs the subscriber as a thread-local, so the capture is only sound if the
dispatch is polled on the installing thread — which under the plain flavour it is, twice
over (`block_on` polls on the calling thread, and there is no `.await` to yield at). Proven,
not asserted: dropping the `continue` while keeping the `record` reddens the log assertion
with the real `engine_apply_diverged` warn line, under the new flavour.

An invented justification for a correct decision is still a defect, and it is the harder
kind to find, because the test was green the whole time.

## What shipped

- #4472 — the per-member guard, chosen over the cohort-level one on a constructed
  counterexample, with the reasoning recorded at the code.
- An O(1) `contains_block` replacing a probe that materialised a whole `BlockSnapshot`
  per member — equivalence to the old condition verified in source, not assumed.
- Both skips metered on the reason the in-tx path already uses.
- #4473's three doc residuals, plus the two operator-facing descriptions this diff
  falsified and the generated JSDoc mirror of one of them.
