# Session 1644 — the CodeQL alert, and the notes from #4898/#4899/#4900

Six non-blocking notes from the three PRs merged into 0.11.0, plus the one
open CodeQL alert. Nothing here is a new feature; two of the six had a
concrete failure behind them.

## The dead pair in the cause chain

CodeQL alert 277 said `src/lib/logger.ts:75` — "this guard always evaluates to
false" — and it was right. `extractSingleCause` has exactly one caller, and
that caller's loop condition is already `current != null`, so
`if (cause == null) return null` cannot fire. Its only consumer,
`if (!info) break`, therefore cannot fire either: a dead branch feeding a dead
branch.

Both are gone and the return type is now `CauseInfo` rather than
`CauseInfo | null`, which is what makes the deletion checkable rather than a
matter of trust — the compiler now rejects re-adding the null return without
re-adding the branch that consumed it.

Falsified by replacing the guard with a `throw` and running the logger suite
plus `src/__tests__` — 160 tests, nothing reached it.

## Two storage spies outside the sweep

#4896 wrapped eleven storage spies in `finally`; the review found a twelfth.
`GraphFilterBar.test.tsx` installs a `setItem` that **throws**, and restores it
on a bare line after a `waitFor`. If that `waitFor` fails, a throwing
`localStorage` leaks into every later test in the file — the exact failure the
eleven wraps were fixing, in the one file that had no `finally` anywhere.

The three bare restores in `use-block-collapse.test.ts` are observation spies
with nothing to poison, so they were left alone last round on the reasoning
that the rule's stated cause did not apply. That left
`src/__tests__/AGENTS.md`'s blanket phrasing knowingly wider than the code.
Wrapping the three is the cheaper of the two ways to close that gap: it needs
no maintainer approval on a doc, and it removes the exception rather than
documenting it.

## A comment that explained the wrong cost

#4899 raised `vi.waitFor`'s budget to 15 s and attributed the cost to "two
dynamic imports (`@/lib/tauri-mock` and the locale chunk)". Neither is real.
`beforeEach` sets `__TAURI_INTERNALS__`, so the single `await import()` in
`main.tsx:120` is gated off — and `@/lib/tauri-mock` is `vi.doMock`ed besides,
so it could not have loaded either way. `setLocale` is a static import
(`main.tsx:16`) whose lazy chunk table has no entry for `en`. What is left is
module-graph evaluation and rendering, which is enough under shard load. The
timeout was right; the reason given for it was not, and the reason is the whole
justification for the constant.

## The integrity section could cost the reporter their bug report

`formatReportFields` caps `logs` at `MAX_BODY_CHARS` because GitHub silently
drops an over-long prefill — and `buildGitHubIssueUrl`'s docblock promises that
"callers cap any large field". #4886's integrity section went into `notes`
uncapped.

It is not a small field. 21 artefacts (`reconciliation_oracle.rs`) times
`SAMPLE_KEYS_PER_ARTEFACT` = 10 ULIDs is **7211 characters** measured, before
URL-encoding turns every backtick into `%60` and every em-dash into nine bytes,
and it doubles again for the artefacts whose key is an arrow-joined pair. On a
diverged vault with logs near their own cap, the prefill is dropped and the
reporter loses the description they typed — in the dialog they opened because
something was already broken.

The section is now capped at 1500 characters in the `notes` field only. The
preview and the copied body have no URL ceiling and keep it whole, so nothing
is lost that the reporter cannot paste. The test pins both halves: uncapped it
reports 7211 against the 1500 bound.

## The sweep blocked saving diagnostics

`runningIntegrity` was folded into the single `loadingMetadata` prop, which
`SubmitSection` uses to disable *Copy report*, *Download zip* and *Open GitHub
issue* alike. Copy and submit carry the integrity section, so they should wait
for it. The ZIP does not — it holds logs and metadata — so on a large vault the
user could not save diagnostics while an unmeasured whole-vault sweep ran.

The flag is now its own prop. Both arms are falsified separately: adding it
back to the ZIP's disabled list reddens the enabled assertion, and removing it
from copy/submit reddens the disabled ones.

## Also

`docs/FEATURE-MAP.md` gains a **Diagnostics & bug report** row. The dialog was
never in the map at all, so adding only the integrity card would have described
a feature whose host was undocumented.

## Deferred, with the reason

Two notes on #4900 are about the oracle's cost and belong together rather than
in a frontend batch: `fold_projected_agenda_from_base`'s `prop` closure is a
linear scan called four times per dated block, and `reconcile_all` re-runs
`dump_blocks` about a dozen times. Both are the "cost is unmeasured on a large
vault" decision the PR flagged, and threading one dump through the sweep is
also most of the snapshot-isolation fix. Both are #4901.

The mock's `compute_reconciliation_report` returning a constant `0` is real but
premature: the reviewer's own suggestion was an e2e fixture knob, and there is
no e2e spec asking for one yet.

## Verification

231 tests across the nine touched files, unfiltered. `npm run typecheck`
clean; `npm run lint` (type-aware) zero errors. Every probe ran against a `cp`
backup and was restored with `cmp` confirming byte identity.
