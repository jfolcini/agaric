# Session 1320

## A line number is a perishable fact

#3904 collected four non-blocking notes from the #3895 review. Three are ordinary test
hygiene. The second one is a small idea worth keeping.

### The citations drifted inside the diff that wrote them

`PairingDialog.test.tsx:676` pointed at a helper "below, near :2286" — and the same diff
moved that helper to `:2324`. The `TrashView.test.tsx` citations each landed one line off,
on the comment above the fixture rather than the fixture.

These were not stale from age. They were wrong on arrival, written and invalidated by a
single change. That is the sharper form of the rule: a line number is not a fact that
decays slowly, it is a fact with no defence at all against the next edit to its own file.
A grep-able name — the `it(...)` title, the helper's identifier, the describe block —
survives.

### The sweep found more drift than the issue reported

The issue named three citations. Converting them meant reading the neighbours, and two more
were already wrong in ways nobody had noticed: one `(~:961)` pointing at a different test
than the one it described, and a `PairingDialog.tsx:747-751` pointing at an effect that had
since moved. Ten sites converted in total across the two files.

The denominator matters more than the ten. Searching every `*.test.ts(x)` for the same shape
— prose comments citing `file:line` for navigation — turns up roughly **23 more instances
outside the two files in scope**, in `SearchPanel`, `ViewDispatcher`, `BlockTree`,
`platform`, `graph-worker`, `navigation`, `resolve`, `pairing-peer-reveal`,
`BlockPropertyEditor`. Two large conventions were deliberately excluded from that count:
mutation-testing `Kills X.ts:LINE:COL` citations and `AGENTS.md:198`-style doc-checklist
citations, both of which pin exact coordinates on purpose.

They are left alone rather than swept, because converting 23 more would swamp a diff about
three. But left alone *with a number attached*, so the next person knows this is a partial
pass and how partial.

### The failure path had the defect the test exists to prevent

The drain guard exists so an unresolved `invoke` promise cannot leave the 15s
`PAIRING_MUTATION_TIMEOUT_MS` timer armed past the test that created it. When the guard
itself trips, it threw with `pendingInvokes` still full — re-arming exactly the timer it was
written to disarm, so a red test would also poison the tests after it.

Worth noticing the shape: a cleanup mechanism that is correct on the success path and
carries the original bug on its error path. The fix resolves the remainder before throwing;
the review confirmed the causal chain rather than the wording — resolving the leftover
settles `op()`, which settles `runWithTimeout`'s race, which fires the `finally` that clears
the timer.

### Verification, since the review is the point

The review re-derived each of the builder's four claims instead of accepting them: it traced
the timer chain through `promise-timeout.ts`, reproduced the guard trip with
`MAX_DRAIN_PASSES = 0` for verbatim red output, checked every converted citation resolves to
the test it now names, and confirmed `vi.clearAllMocks()` really does leave a
`mockImplementation` sticky (only `mockReset` clears it) — which is what makes the `finally`
restore in item 3 load-bearing rather than decorative.

One builder claim came back imprecise rather than wrong: the "10 (7+3)" tally is 6–7 sites
in one file and 3–4 in the other depending on whether you count comment sites or individual
citations. Recorded because a count that cannot be reproduced from the diff is a count worth
distrusting, even when every item under it checks out.
