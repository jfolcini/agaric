# Session 1321

## Documenting a divergence is not closing it

#3898 and #3884 each named the same fork: seed real `op_log` rows and drop the mock's
last-modified fallback, or accept the divergence and write it down. The first attempt at this
work measured the fallout of option (a) carefully, found it broke two e2e specs, and chose
option (b) — consolidating three scattered comments into one authoritative note declaring the
divergence permanent.

That was a good piece of work reaching the wrong conclusion, and it was overridden. The
project's standard is that a green conformance ratchet means the behaviour is right. A mock
that is *documented* to disagree with the backend does not satisfy that; it converts a bug
into a convention, and the convention is what future readers trust.

### The e2e breakage was the symptom, not the obstacle

The measured fallout was real: remove the fallback and all eleven seed pages have zero op-log
activity, so "Edited today/this week/this month" matches 0 instead of 5 and "Edited long ago"
matches 11 instead of 6. Read as a cost, that argues for option (b).

Read correctly, it argues the opposite. Those numbers were only ever produced by the fallback.
The specs were green because the mock was wrong in a way that happened to satisfy them. Seeding
real `op_log` rows at exactly the timestamps the fallback map had been supplying makes every
assertion hold **unchanged** — and now for the reason the assertion claims.

No expectation number moved. That is the evidence the fix is right, not a lucky outcome.

### What "structurally impossible" bought

`pageLastModified` and `pageLastModifiedAt` are deleted outright rather than bypassed, so
`buildPageMetaRow` reads `rawOpLogLastEditedAt` with no intermediary. There is no longer a
place a per-command fallback could be reintroduced without recreating a map and a function
together. `LastEditedSource` survives, re-documented as what it now is — a memoization hook —
rather than what it was pretending to be, a semantic fork.

Three tests in the mock's own suite asserted a fresh seed carries zero ops, which is now false.
Each had its precondition made explicit (`opLog.length = 0`) instead of its intent weakened.
That distinction is where lost coverage usually hides: a test edited to accommodate a change
is precisely the test that should be read twice.

### The fix for the third issue closed one divergence by opening a narrower one

#3917 was that `run_advanced_query`'s `groupBy` branch never validated its cursor while the
flat path did. The fix routed the grouped branch through the flat path's `decodeCursor`, and
its tests went red on revert, so it looked settled.

The review read the Rust rather than the issue and found the premise inverted. Grouping *is*
considered first — `run_grouped` returns before the flat `QueryCursor::decode` is ever reached
— and it decodes a **differently shaped** cursor: `{version, count, key}`, not
`{version, values}`. So the mock was now validating the wrong shape in both directions at once:
rejecting a well-formed `GroupCursor` for a missing `values` array, and accepting a
`{version, values: []}` payload the backend itself rejects.

A fix whose test reddens on revert is not thereby correct. It proves the line is load-bearing;
it says nothing about whether it bears the right load. Only reading the backend catches that,
and the review's fix mirrors `GroupCursor::decode` with two tests pinning the shape-confusion
boundary in both directions.

### One overstated claim, recorded

The builder's report said every new test mutates `opLog` and demands the answer move, which is
what makes them discriminating — as seeded, the fallback and the op-log carry identical
timestamps, so a pristine-seed assertion passes under both implementations and pins nothing.

Four of the ten do not mutate. Three of those four still discriminate for a different reason,
and one genuinely does not. No coverage gap results, because it sits beside a mutation-based
test that does. But the blanket framing was wrong, and a claim about *why* a suite is
non-vacuous deserves the same denominator as any other.
