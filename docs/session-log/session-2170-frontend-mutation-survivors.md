# Session 2170 — The seven frontend mutation survivors

This morning's weekly run on main reopened #3752 (date-utils, 1 survivor)
and #3756 (history-utils, 6 survivors).

date-utils `61:5` (`CallExpression`, the formatter cache's `.set` removed)
was covered by a test Stryker never ran against it: earlier tests had
already cached the `en` formatter, so per-test coverage never saw the cache
test reach the `.set` line. The test now formats in `fr`, a locale no other
test uses, and asserts the exact output and that `Intl.DateTimeFormat` was
constructed once over six calls. Breaking `.set` by hand turned it red
("expected … 1 times, but got 6 times").

history-utils: five of the six die to two new cases in the alias-payload
tests (an alias on a non-alias op type renders nothing; an empty-string or
non-string alias returns null), covering `64:7`, `66:12` ×2, `66:41` ×2.
`7:42` (`parsed !== null` → `true`) is equivalent: `typeof null === 'object'`
and `Array.isArray(null)` is false, so a `null` payload returns that same
`null` either way. The check stays because it narrows the type for the cast
below it; it is recorded in the test file's equivalence ledger and in the
parent issue's accepted block.

Stryker, targeted: history-utils 7 → 1 survivor (the equivalent),
date-utils `61:5` killed with nothing new surviving. No production code
changed.
