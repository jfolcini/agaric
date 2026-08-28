# Session 1418 — the spelling the guard could not see

#4482, #4484, #4486 and #4490, shipped together because they are one finding wearing four
costumes: a check that reports "nothing is wrong" while structurally unable to see the thing
it is checking for. Three of the four came out of reviews of already-merged PRs, which is
where this class tends to surface — the code was correct, and what was missing was any way
to tell.

## The idiomatic spelling opted out of the guard

`scripts/check-doc-code-paths.mjs` resolves doc citations written in `src/…` form. This
codebase's own path alias is the normal way to name a module, and a citation written that way
was not recognised as a path at all — neither resolved nor reported, invisible in both
directions. It could not go stale loudly, and it could not be counted.

The number matters more than the mechanism. Instrumenting the scanner over the real tree
found **1425 candidate occurrences repo-wide, of which 267 are alias-form, over 82 distinct
refs in 184 citing files**. Every one of those was unguarded. The guard's output is a negative
claim — "no stale citations" — so a blind spot of that size does not degrade the claim, it
inflates it: there was no signal distinguishing "nothing is stale" from "nothing I can see".

The moment the guard could see them, it found four that were already stale: a
`render-keyboard-shortcut` module and a `nav-items` module both moved out from under their
citations with nothing left at the old paths, a `GraphView.helpers` citation pointing a
directory level above where the file actually lives, and a dead Tauri notifications wrapper
deleted in #4410. None of these were hypothetical drift. They were sitting in the tree,
described by comments that had been wrong for weeks, in front of a guard built to catch
exactly that.

The alias map is read from `tsconfig.app.json` at runtime rather than hardcoded, because a
hand-copied rewrite would itself be a second driftable copy of a config value — the defect
class this issue exists to close. `vite.config.ts` declares the same mapping in a different
shape; nothing in the tree enforces that the two agree, and this guard follows tsconfig alone.
That is now written down in the loader's header rather than left for a reader to infer a
cross-check that does not exist.

## Two ways to widen a guard wrongly, and how the second was caught

Widening what a guard *sees* is the easy half. Widening what it accepts as *resolved* is where
a fix of this shape fails open, and this one needed an extensionless fallback: alias citations
are overwhelmingly written the way the adjacent import is written, without an extension, so
without it **186 of the 267** real live citations became false failures.

A fallback that tries six extensions in turn is exactly the kind of broadening that quietly
converts a guard into a rubber stamp, so it was measured rather than argued about. Of the 186
rescues, **168 resolve via `.ts` and 18 via `.tsx`; zero via `.js`, `.jsx`, `.cjs` or `.mjs`** —
and there are **zero** such files tracked under `src/` for them to shadow. A dead extensionless
citation still exits 1. A candidate that already carries an extension refuses the fallback
entirely. The masking surface is real, narrow, and currently empty, which is a different
statement from "it is safe" and is the one the evidence supports.

The second failure mode was caught in review and was not a judgement call at all. The loader
called the config JSONC and handled only half of JSONC: `tsc` accepts a trailing comma, so
adding one to `tsconfig.app.json` is a legal edit to that file, and it would have hard-blocked
every commit in the repo with a parse error naming a config its author had just left valid.
The retry is attempted only after the strict parse has already thrown, so it cannot change how
an already-parseable config reads.

## A gap recorded as if complete

#4486's first item had a fail-open in `scripts/check-hook-deps.mjs`: after a pass reordering
fixed one direction, its mirror opened, and a `#` comment containing a triple-quote delimiter
would be read as an opening delimiter and swallow any import up to the next one. The issue
offered two acceptable resolutions — close it, or enumerate it — and closing it needs a real
string-literal lexer rather than a regex adjustment.

Documentation was the proportionate choice, but only because the documentation is *true*, and
that was verified rather than assumed: a fixture with a `#` comment carrying a `"""` really does
lose a following `import`. The point of the issue was never the unreachable bug. It was that the
function's doc comment enumerated its gaps, and a list that reads as exhaustive while missing one
borrows the reassurance of the entries that are complete. The new entry is marked fail-open in the
same voice as the existing one, distinguishable at a glance from the conservatisms that fail closed.

The second item looked like a one-character change and turned out to be the one worth measuring.
`\s` in the arithmetic grammar matches NBSP and friends; bash arithmetic does not. Rather than
trust that, the replacement set was checked against the shell itself: space, tab and newline all
evaluate; carriage return, vertical tab, form feed and NBSP each produce
`syntax error: invalid arithmetic operator`. `[ \t\n]` is bash's real accept set, so the fix does
not over-correct — and the old `\s` was itself the divergence, silently accepting expressions the
shell it stands in for would reject.

## Pinned, or merely relocated?

#4484 reported two near-verbatim copies of one scanner in a guard test, and named the duplication
as the mechanism behind two of the reviewing PR's three rounds: each round fixed one copy and left
the sibling, and each asymmetry was found by a reviewer rather than by a test. One copy cannot
drift from itself.

It was a third copy, not a second. `scripts/lib/js-scanner.mjs` already exports a shared,
self-tested tokenizer with the same primitive, so both hand-rolled copies were deleted rather than
merged — which also closes the template-literal limit the issue could otherwise only have
documented.

That resolution carried its own trap, and it is the most instructive thing in this session. One of
the two unpinned branches was declared covered on the grounds that the logic now lives in a file
with its own self-test. That is a relayed claim supporting the conclusion the change already
wanted, and the honest way to settle it is not to read the self-test but to break the branch and
watch. Deleting the line-comment branch in the shared scanner did not leave its self-test green —
it crashed outright. The branch is genuinely pinned. Had it stayed green, the finding would have
been laundered rather than fixed: moved to a file where nobody was looking, and closed.

The adapter also diverged from the code it replaced in a way well-formed fixtures could not
reveal. The old loop returned a sentinel on unbalanced input; the shared one throws. That is a
different failure *mode*, not a different value, and the right answer was not to catch and convert
it — the scanner's contract is that its error becomes a loud guard failure and never a silent skip.
It is documented and pinned instead.

## An assertion that could only pass

#4490's hook is correct and stays untouched; the whole item is coverage. Its render-facing value
moved from a ref to state, keeping the ref for one job, and the success-path clear is guarded on
the ref deliberately. Nothing pinned that, so swapping the guard to read state would have left the
suite green — the exact change the design exists to prevent.

The falsification found a sharper mechanism than the issue described. The callback's dependencies
never change, so its closure over the failed-write state is pinned at mount: a state-guard would
not merely strand a value inside one batched tick, it would never fire again after the first
render.

The review caught the failure mode the issue had warned about in a different costume. One test
asserted a setter was called zero times — the easiest assertion in the world to satisfy by
accident, and nothing in the file demonstrated that same spy ever firing. A zero-call assertion
without a matching non-zero control discriminates nothing; it passes identically whether the guard
works, the spy is wired to the wrong setter, or the mock never installed. A positive control now
pins the same spy firing twice with specific arguments in the failure case.

One item in this batch is not coverage at all and is easy to mistake for scope creep, because it
lives in #4490's comment thread rather than its body: #4489 aligned `package.json`'s `lint` script
with the prek hook by adding `--report-unused-disable-directives-severity=error` and left
`lint:fix` bare, so the two scripts disagreed about what counts as an error and a developer running
the fixing one stopped seeing the errors the checking one reports. The thread asked for the
one-word fix explicitly, and it is made here; it changes the exit contract of `npm run lint:fix`
and `just lint-fix`, and nothing else.

## What review actually changed

Worth recording because the adversarial pass is expensive and its value is easy to assume rather
than check. Across four items it produced four substantive changes, none cosmetic: the
trailing-comma parse gap, a formatting violation that would have aborted the pre-commit hook, the
missing positive control, and the documented-and-pinned error-path divergence in the scanner
adapter. Two of the four would have failed the local gate or blocked the repo outright.

It also killed a claim by measurement rather than argument in three separate places — the bash
character class, the extension-fallback blast radius, and a hand-classification of 25 sampled
alias citations confirming all 25 are genuine prose and none is a module specifier, which is the
arm the issue insisted must not regress.

## Verification

Whole frontend suite: **792 files, 18144 passed**, 1 expected fail, 37 skipped. `tsc -b` clean.
`oxfmt --check` clean across all 12 changed files. Guard self-tests all exit 0, including
`check-doc-code-paths.mjs` at 150 assertions (up from 146), `check-hook-deps.mjs`,
`check-session-log-pr-collision.mjs`, `scripts/lib/js-scanner.mjs` and
`check-main-module-detection.mjs` across 74 scanned scripts. Each guard was also run against the
real tree, not only its fixtures.

Every fix in this batch was falsified against a copied backup and the restore proven byte-identical
before moving on — the window in which the working tree holds a deliberately-disabled fix is the
hazard, and three have reached this repo through it.
