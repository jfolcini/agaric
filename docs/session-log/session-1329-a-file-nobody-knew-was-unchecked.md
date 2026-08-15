# Session 1329

## A file nobody knew was unchecked

`tsc` gives a `.ts` file priority over a same-basename `.tsx` sibling when both match an
`include` glob. The `.tsx` is dropped from the compiled root set — no error, no warning, exit 0.
`src/hooks/__tests__/useStarredPages.test.tsx` had therefore never been type-checked.

The tidy fix is a rename. It is also the wrong fix on its own, because it closes one instance and
leaves the mechanism live for the next one. What makes this worth a session is that the failure is
**silent by design**: the compiler is doing what it documents, and the only way to notice is to
compare what it compiled against what you asked it to compile.

### The gate, and why its own model is the risk

For every project referenced from the root `tsconfig.json` — read live, so the list cannot drift
from what is actually type-checked — the guard takes the **actual** root-file set from
`tsc -p <project> --showConfig`, independently re-walks the filesystem against that project's raw
`include`/`exclude` patterns to get the **intended** set, and fails on a difference in either
direction.

Deliberately, the re-walk does **not** replicate tsc's same-basename collapsing. That collapsing is
the behaviour under test; modelling it would make the guard agree with the bug.

Which puts all the risk in one place: a reimplementation of tsc's glob semantics. Get it wrong in
one direction and the guard misses drops; wrong in the other and it cries wolf until somebody
disables it. So the review's job was not to check the finding — it was to attack the model.

Two gaps came out of that, both dormant in this repo and both real:

- **A bare `?` glob silently matched nothing.** The builder claimed unmodeled shapes *throw* rather
  than silently skip, which is the difference between failing closed and failing open. `?` is
  documented tsc syntax, `isGlobPattern` only tested for `*`, so a `?`-bearing pattern fell to the
  literal-path branch and matched nothing at all. That is precisely the fail-open path the claim
  said could not happen.
- **A `.d.ts` beside a same-stem `.ts` cried wolf.** TypeScript's *other* intentional priority
  collapse, and a legitimate pattern. The header comment already declared it out of scope; the code
  never implemented that. A guard that fails on correct input gets switched off.

Everything else attacked either handled correctly or failed **closed**: brace expansion, bracket
classes, single-star globs, `extends` merging, symlinked subdirectories, projects with no `include`
at all, `files:`-only projects, `bower_components`. Loud and sometimes misdiagnosed, never silently
passing. That distinction is the one worth keeping — a wrong diagnosis costs a confused hour, a
silent pass costs the thing the guard exists for.

### The denominator, which is the whole point

One violation, across five projects and 1735 files, matching the issue's own manual `comm` scan.

A single instance sounds like it did not need a gate. It is the opposite: the reason to build one is
that nobody knew about the single instance either, and the count was only obtainable *by* building
the thing that counts. Before the guard, "how many files are silently unchecked" had no answer;
after it, the answer is zero, continuously.

### The file was fine

Once actually type-checked, `useStarredPages.test.tsx` had **zero** errors. It had been correct the
whole time.

Worth resisting the reading that this makes the work unnecessary. The file being correct was
unverified, not established — and an unverified correct file and an unverified broken one are the
same epistemic object until something checks. The gate is what converts one into the other.

### Cost, measured rather than assumed

`always_run = true` plus five `--showConfig` invocations plus a 1735-file re-walk, on every commit:
**0.31–0.55s** for the guard, 0.10–0.19s for its self-test. Comfortably under a second.

Recorded with numbers because "it's probably fine" is how a per-commit hook becomes a per-commit
annoyance, and because the objection — a guard developers disable is worth nothing — is correct
whenever the number is bad.

### The other half of the batch was already done

#3890 asked for the `SENTINEL_ID` fold's ledger to stop saying "redundant" where it meant "same in
practice". `git blame` puts that rewrite in #3887 — the very PR the finding was raised on — landing
about half an hour after the issue was filed.

Closed with the evidence rather than re-fixed. One tension recorded rather than smoothed over: the
check is not logically unreachable, so strictly it sits in the "never hit today" bucket, which would
argue for reverting the fold rather than documenting it. The issue's own framing forecloses that,
and #3793 carried a pre-approval for the removal — but the argument for reverting is not *wrong*,
and pretending the question is settled would be the same move the ledger was corrected for.
