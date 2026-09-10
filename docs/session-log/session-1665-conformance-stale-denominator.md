# Session 1665 — a denominator that only drifts

Two small corrections against #4670 and #3830, both of the same shape: a number
recorded in a place that outlives it.

## `conformance_query.rs`

The module doc said "Three of the 119 steps opt out today". The three is exact
— verified, still three, in two fixtures, all for the documented reason (the
command has no `ORDER BY`). The 119 was the corpus when the sentence was
written; it is 124 now.

Updating it to 124 would buy one release. The denominator is dropped instead,
and says why. The sentence above it — "47 of 119 steps compared SETS" — keeps
its number: it is explicitly historical, describing the world before the
opt-in/opt-out flip, and 119 was the corpus then.

## #3830's body

The maintainer's last status comment asked for exactly this: keep the issue as
the standing inventory and replace the body with the reconciliation.

Re-derived from source on current `main` rather than carried forward:
`READ_NO_QUERY_ALLOWLIST` **39** = `NO_DOMAIN_STATE_READ` **14** (permanent) +
`NOT_YET_PINNED_READ` **25** (the debt). The status comment measured 40/14/26
on `154a473ec`; one read command has been pinned since.

Stating it as an identity rather than three loose figures is the point — the
next reader can check 39 = 14 + 25 without trusting any of them.

## Getting the count wrong twice first

Worth recording because it is the third instance this session. I hand-rolled a
parse of the allowlist twice: a regex that stopped at the first `]`, giving 13;
then a bracket matcher that found the `[]` in `readonly string[]` before the
array, giving 0. Both produced a confident wrong number rather than an error.

The reviewer's finding on #4923 the same morning was the same class — a
hand-rolled argument splitter that read a clean tree for a file it could not
parse. `scripts/lib/js-scanner.mjs` exists so this stops happening, and #3991
says not to write a fourth copy. The count that went into the issue is a
line-based one that can be checked by eye.
