# Session 2069 — Review notes from #5545 and #5546

The sweep's follow-up. Two non-blocking reviewer notes, both trivial:

- #5545: `conformance-coverage.test.ts` aliased the shared classifier as
  `isReadOnly`. The call sites now name `isReadOnlyCommand` directly, and the
  doc block that sat on the alias stays as the section's comment.
- #5546: a comment in `blocks/queries.rs` said the pagination helpers keep
  `Option<&str>` "so other callers can still pass `None`". No production
  caller does since #5415; the sentence is gone.

Checked and dropped: the date-utils survivors #5544's diff-scoped mutation
run listed beyond the accepted set. Line 61 (the #5474 formatter cache) is
killed by the existing "reuses one formatter per locale" test (a Stryker
thread-pool run reports it as a timeout or survivor). The extra survivors on
the `y/m/d === undefined` guard are equivalent: after `parts.length === 3`
`Number()` never yields `undefined`, and the guard only narrows types. The
accepted ids in #4691 were re-anchored for #5474's line shift.

Suites run: `conformance-coverage.test.ts`, `npm run typecheck`, oxfmt.
