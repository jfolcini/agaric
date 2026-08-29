# Session 1434 — a marker that was not a marker

#4509. `check-mutation-harness-clones` verifies that hand-copied clones inside the mutation
harnesses still match their source, via sha256 pin markers. A marker whose hash was *malformed*
— rather than mismatched — was indistinguishable from a line that was never a marker at all, so
the guard dropped it and the clone it protected became silently unpinned.

## The count was the thing that lied

The guard ends by printing `OK: N source-pin(s) across M harness file(s) all match their source`.
That line is what a reader trusts, and it was reporting the number of pins the guard *managed to
parse*, not the number that were *written*. Reconstructed against the real pre-fix code: eleven
good pins plus one `sha256=PLACEHOLDER` produced `violations: []`, `pinCount: 11`, exit 0. The
twelfth marker existed, was intended as protection, and left no trace anywhere in the output.

That is the same failure this codebase keeps meeting from different directions — a negative claim
("all pins match") made over a population smaller than the reader believes. The fix is not only
that a malformed marker now fails; it is that the count can no longer be printed short, because
any malformed marker forces a violation and the OK line only prints when there are none.

## Splitting the regex is what made the state expressible

The old `PIN_RE` was a single all-or-nothing pattern requiring the full
`path#symbol sha256=<64 hex>` shape. There was no way for the parser to say "this was meant to
be a pin and is wrong" — the only outcomes were *valid pin* and *not a pin*.

Splitting it into a prefix (does this line claim to be a marker?) and a body (is the claim
well-formed?) creates the third state, and the third state is the entire fix. Seven malformed
shapes are now reported rather than dropped: a placeholder instead of a hash, a truncated or
overlong hash, an uppercase hash, a missing `#symbol` separator, a missing `sha256=` prefix, and
trailing garbage after an otherwise-valid hash.

## Where the same defect still lives, one step earlier

Review probed the boundary rather than the fix, and found the prefix itself is byte-identical to
the old pattern — this change alters only what happens *after* a prefix matches. So a marker
written in a single-line `/* … */` block comment, or with a differently-cased keyword, is still
invisible: not reported, not counted, not a violation.

That is the same defect one step earlier in the pipeline, and it is **pre-existing rather than
introduced here**. Filed as #4526 rather than widened into this change, because #4509's own text
scoped itself to the hash case and deferred the recognition question explicitly.

Worth noting the asymmetry that makes the follow-up non-obvious: those shapes should become
*violations*, not accepted pins. Someone who wrote a marker in an unsupported envelope wants to
be told; accepting it silently would be a different and larger decision about what the canonical
syntax is.

## Falsified without touching the file under test

The mutation was applied to a copy at a scratch path and run from there, so the real file was
never in a broken state at any point — no window in which an interrupted run could have shipped
the disabled guard. Eight assertions reddened: the seven malformed shapes plus the end-to-end
case pinning that a malformed marker alongside a valid one fails and does not inflate the count.

The opposite arm was checked too, since a guard that rejects everything would satisfy every
malformed-shape assertion: forcing the body match to fail unconditionally reddens 22 assertions,
including the well-formed parse and essentially every pre-existing fixture.

## Verification

Self-test green at 65 assertions. Real tree: `OK: 13 source-pin(s) across 5 harness file(s)`,
verified against an independent count of the markers on disk — all 13 well-formed, so the repo
has no malformed markers today and this changes nothing about the current state. It is about the
next one written by hand.

No `prek.toml` change was needed: the self-test hook already existed and its `files` glob already
covered the script.
