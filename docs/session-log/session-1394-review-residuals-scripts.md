# Session 1394 — the residue three approved reviews left behind (script half)

Companion to session 1393, which carried the Rust half. Same origin: PRs #4368,
#4369 and #4370 were all APPROVED and green, and each review body listed
non-blocking findings. An approved verdict is not "nothing to address".

Under the filing bar #4368 landed in the same batch, almost none of these warranted
a tracked issue — they warranted a fix. What follows is what the fixes turned up,
which is more interesting than the fixes.

## Both reviewers found a real defect the builder had shipped

This is the entry worth reading. Adversarial review is expensive and there is
standing pressure to streamline it into a rubber stamp. On this batch it paid twice,
and in both cases the defect was **introduced by the fix**, not inherited.

### The filer: a fix that could silently erase every triage verdict

Review note 2 on #4368 asked for a durable record when accepted-equivalent entries
are dropped. The obvious implementation — write the dropped ids into a note in the
issue body — introduced a marker-injection hole.

Mutant ids come from a **hand-edited** fence. `markerBlockLines` locates the accepted
block with a bare `indexOf` over the whole body, and the note renders *above* the
markers. So:

- An id containing `<!-- mutation-accepted:begin -->` makes the next run's `indexOf`
  land inside the note. Two phantom "live" entries get parsed out of the history.
  They are stale every run, so notes churn and evict real history — non-convergent.
- An id containing `<!-- mutation-accepted:end -->` makes `end < start`, so
  `markerBlockLines` returns `[]`. **The accepted block reads empty forever**, every
  accepted mutant re-reports as new, and the next rewrite renders an empty block —
  erasing every triage verdict on the page.

Position outside the markers was never a proof of safety, and the pre-fix docstring
had actively told triagers to re-seed by pasting "the whole block, markers included".

Closed with `noteSafeId()`, which breaks `<!--` and `-->` in any id written into a
note; the cap is now enforced on read as well as write so an over-full history
converges instead of being carried forever. Assertion 14h pins both directions and
also fails if the history is simply deleted, so it cannot be satisfied by dropping
the feature. Verified independently against hand-built adversarial input, not just
by the self-test.

### The doc-citation guard: a fail-closed fix that cried wolf

Notes 1 and 2 on #4370 described a fail-OPEN hole: an unbalanced backtick inside a
`/** */` comment swallowed citations for the rest of that comment, because the
paragraph-break reset (`/\n[ \t\r]*\n/`) cannot fire between ` *` gutter lines.

The fix widened the reset and added a "fail-closed backstop" — if any paired span
crossed a newline, re-scan with the old line-scoped regex and union both yields.
Unioning can only ADD candidates, which was the safety argument.

That argument was wrong in the direction nobody checks. `crossedLines` fires even on
a **perfectly balanced** comment, where pass 1 is already correct, so pass 2 invents
a different pairing from coincidental adjacent backticks. A real false positive:

```
/**
 * Sample output: `error: cannot stat
 * `src/nowhere/example-b.ts`: No such file` was the original bug report.
 */
```

Four backticks, two correctly-closed spans, the path sitting in the *gap* between
them as plain prose. Pre-diff: exit 0. Post-diff: exit 1 on a path that is not cited.

Now gated on `openAt === -1` — a genuinely dangling backtick — which is the only
condition under which the two passes can disagree at all. Both original rescue
fixtures still pass; a `balanced.ts` fixture locks the false positive out.

"Fail-closed" is a justification, not an exemption. A guard that reds valid docs
gets suppressed by the next person who hits it, and then it guards nothing.

## Two measured claims that were wrong

Both plausible, both supporting the conclusion their author wanted, both false:

- The #4370 review said `set_property_batch_inner`'s recurrence-skip call was
  "covered only indirectly, through the pre-existing `set_todo_state_batch_inner`
  path". `grep -rn batch_recurrence_skip --include=*.rs` matched only
  `properties.rs`: **neither** call site had a test. (Fixed in session 1393.)
- The always-rendered accepted block was reported as costing "~900 characters".
  Measured: **1085**, moving the #3257 ceiling from 597 to 586 rust-shaped findings.
  About 20% low. Clamp rungs are unaffected — the block is state, never a rung — but
  the docstring now carries the measured number.

## The rest

- **The false all-clear (the one with a deadline).** An area whose remaining findings
  were all accepted closed its child with "No mutants survive or go uncovered in X any
  more" — false; they survive, triage ruled them unkillable. `buildChildCloseComment`
  now has two arms, and fixtures pin *both* directions: a genuinely clean area must
  still get the plain all-clear, so "always qualify" is not a passing strategy either.
  #3751/#3760/#3763/#3764 would have closed with the wrong reason at the next Monday
  04:17 UTC run.
- **A log line that fired before the no-op return** now sits behind `willWrite`, so a
  quiet week reports entries as left in place rather than dropped.
- **The empty accepted block always renders**, because the issue head told a first-time
  triager to paste into a block that only existed once someone had already pasted into it.
- **A self-test comment** claiming coverage moved from assertion 14a to 14b, the one
  that actually reddens when the `known`-side filter is removed. Confirmed by
  measurement: 14a stays green.
- `is_test_file` in `check-op-log-delete.py` was bound and never called; the docstring
  claimed the guard reused it. Both corrected.
- A merged JSDoc block in `check-types-erasure.mjs` split back onto the two functions
  it describes, closing an undocumented `@param i`.

## Verification

All four self-test suites green; all three guards exit 0 over the real repo.
`check-doc-code-paths.mjs`'s real-run output is byte-identical to the pre-diff
baseline — compared via `git worktree add --detach`, because a HEAD copy under a
different filename disables `KNOWN_INTENTIONAL_WARNINGS` and makes the comparison lie.

## Known, not fixed

`oxlint` reports `selfTestChildGh` at complexity 29 (ceiling 25). It was already at 27
before this batch. Warning only; the prek hook does not gate on it.
