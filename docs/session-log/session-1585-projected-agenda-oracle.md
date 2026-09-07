# Session 1585 — the `projected_agenda_cache` reconciliation oracle (#3345)

## What

Artefact 11, and the last table on #3345's list. `projected_agenda_cache` now
reconciles against a from-base fold in both directions.

## This artefact audits ONE layer, and it is not the arithmetic

Every prior artefact folds base rows into expected rows with no help from the
code it audits. This one cannot. The occurrence arithmetic lives in
`agaric_store::recurrence_math::project_block_dates`, and a second
implementation of a recurrence expander would be a large new surface whose own
bugs would read as production defects.

So the fold **calls** it, and audits the layer around it: which blocks are
eligible, and with which parameters — the `repeat` rule, `todo_state = 'DONE'`,
the due/scheduled precondition, the template exclusion, the
`repeat-count`/`repeat-seq` arithmetic, and the per-source horizon cap.

A divergence here means the wrong blocks were projected, or the right ones with
the wrong bounds. It does **not** mean an `RRULE` was expanded incorrectly;
`recurrence_math` has its own tests for that. The module doc says so outright,
because an oracle that quietly shares the code it audits is worse than no
oracle — it reports confidence it does not have.

## `today` is a parameter, and that is load-bearing

Production reads `chrono::Local::now()`, so the expected contents of this table
change at local midnight. This is the one artefact that is not a pure function
of the database. Both `rebuild_projected_agenda_from_base` and
`reconcile_projected_agenda` take `today`, callers must pass the same date the
rebuild used, and it is deliberately **not** wired into the aggregate
`reconcile()` sweep — that sweep has no date to pin, so adding it there would
turn a midnight rollover into a red run. A flake, not a defect.

Production already exposes `rebuild_projected_agenda_cache_with_today` for
exactly this reason; the oracle reuses that injection point.

## Falsification deleted a branch I had written

Six mutants, each against a copy, restored and `cmp`-verified.

The first one **survived**, and that was the useful result. I had mirrored
`project_block_into`'s `Some(r) if !r.is_empty()` guard into the fold, and the
fixture carried an empty-rule block with a comment claiming "a fold that
transcribed only the SELECT would expect rows here". Removing my guard left the
suite green — because `project_block_dates` normalises the rule and returns on
an empty one (`recurrence_math.rs:495`), so the empty rule was dropped for a
reason that had nothing to do with my check.

The guard was dead code and the assertion was passing for a different reason
than its comment gave. Both are now fixed: the branch is deleted, and the
fixture case is kept but re-labelled as a contract pin rather than proof of an
independent gate. This is the "an assertion true for TWO reasons hides a dead
fix" failure, caught only because the mutant was run rather than assumed.

The other five were all killed:

- fold: drop the `DONE` check — the completed block reappears;
- fold: drop the template exclusion — the template page's child reappears;
- fold: `remaining` returns `None` instead of `Some(0)` when `count <= seq` — a
  finished series starts emitting again;
- **production**: remove the template exclusion from the source `SELECT`;
- **production**: remove `todo_state != 'DONE'` from the source `SELECT`.

The last two are the ones that matter: the fold mutants only prove the test pins
the fold, while these prove the oracle catches real drift in the code it audits.

## Also folded in

The #4825 review note: `date_tag_date`'s comment described its offsets as "minus
the five-character prefix", but the array is minus the prefix *and* minus one
for 0-indexing. The code was right; that comment is the audit trail for the
transcription, so the arithmetic in it has to be right too.
