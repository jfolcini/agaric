# Session 1428 — one string doing two jobs

#4238. The resolve-store block title was answering two questions at once — "what do I show the
user" and "is this row resolved" — and those answers disagree for exactly one input: a row that
resolved successfully and is genuinely blank. A single string cannot say both, which is why
#4228 normalised three writers and stopped at the fourth.

## The signal was living in the label

`resolveBlockDisplay` detects a cache miss by pattern-matching the title against
`/^\[\[[0-9A-Z]{1,12}\.{3}\]\]$/`, and `useBacklinkResolution`'s `storeTitle` wrote that shape
deliberately so `has()` stays true and a name-less-but-real row is not re-fetched every pass.
Normalising it to `"Untitled"` like its three siblings would have turned a resolved blank row
into a permanent cache miss — which is precisely what #4228's symmetric arm pinned.

So the fix was never "normalise the fourth writer". It was to move the signal off the string, at
which point all four can normalise unconditionally and the title becomes purely presentational.

## Why the existing `deleted` flag could not carry it

The obvious economy was to reuse `deleted` rather than add a field. It does not work, and the
reason is worth recording because it is invisible from the frontend: `batch_resolve_inner` has
**no `deleted_at IS NULL` filter**. Soft-deleted blocks come back with their real title, so
`deleted: true` is an ordinary *resolved* state. Folding the two concepts would have put every
trashed block's chip back on the `[[id…]]` label — the same two-meanings-in-one-field mistake,
relocated one field over.

That reasoning is now pinned by a test rather than left in a commit message: a soft-deleted row
asserts both `isResolved === true` and its real title, and both invert under `resolved := !deleted`.

## The default that looks like a fail-open and is not

`resolved` is required on the stored entry — which is real compiler work, since 88 test sites had
to state it — but optional and defaulting to `true` at the setters, so the echo writers stay
untouched. That reads like the exact defect being removed, relocated from a string to a boolean:
a future writer that cannot resolve a row and forgets the flag records it as resolved.

Review pushed on it, and the argument that makes it safe is structural rather than convenient.
**This cache is not a total map.** "I could not resolve this id" already has a correct, zero-effort
representation: write nothing. An absent key falls through to the same unresolved label as an
explicit `resolved: false`. So the default does not govern failure to resolve at all — it governs
only the deliberate parking of a sentinel entry to suppress a re-fetch, which is an act a writer
has to choose, not one it can drift into.

The residual is narrow and is now written down: a *second* sentinel writer that omitted the flag
would have no textual footprint for any guard to find. The other bulk resolver facing the same
"some ids did not come back" case, `useBacklinkResolution`, deliberately does not park in the
shared store at all (#2635) — it keeps a hook-local attempted set. So the scenario is remote
rather than merely unlikely, and the shape of the fix if it ever appears (make sentinel-parking a
named store operation) is recorded beside the field.

The docblock originally justified the default by "every echo writer is resolved by construction",
which is the convenient answer rather than the load-bearing one. It now states the real argument.

## Two of the fixes were not covered, and only falsification said so

Six mutations were run. Four reddened. **Two went green on the first attempt** — disabling
`resolveTagName`'s flag check, and making the `use-block-resolve` resolvers ignore the flag. Both
were changes that looked obviously covered by the surrounding suite and were not.

Tests were added for each, with fixtures that store a title which is deliberately *not* the
unresolved label, so neither can pass on coincidental bytes — the second one's failure output
shows `'parked label'` actually surfacing, which is the proof it discriminates.

A third claim was demoted rather than defended: `resolveBlockTitle`'s `isResolved` probe is
annotated as **not** load-bearing, because both probes agree today and no test could catch it if
it stopped being true. Better an honest annotation than a comment implying coverage that does not
exist.

## The retargeted test was passing for a reason its name did not claim

#4228's symmetric arm asserted three things; two became false by design. The third —
that `resolveBlockDisplay` falls back to the row's own content — **would have kept passing
untouched**, and not for the reason the test's name implied: #4239 already classes `"Untitled"`
as a synthetic title, so the assertion survives through an entirely different mechanism than the
`[[id…]]` cache-miss shape it appeared to guard.

Left alone it would have been a test passing for a completely different reason than its name
claims, which is the failure mode this codebase keeps finding. Confirmed by disabling #4239's arm
and watching the surviving assertion go red. The property it used to guard is re-homed in a new
test where the backend returns an empty result — the only input that still exercises it — and the
two were shown to be independent, since the new one does not fail under that same mutation.

## Verification

`tsc -b` clean; `oxlint` and `oxfmt --check` clean across all 22 changed files. Targeted suites:
496 passed across the seven core files, plus 485 across the peripheral consumers a required field
forced to update.

oxlint's silence was probed rather than trusted — a throwaway file with known violations produced
three errors and exit 1 before being deleted. That habit comes from #4493, filed two sessions ago,
where an unrelated disable directive was found to suppress another rule's findings for a whole
file; a clean lint run means nothing until you have seen the linter fail.

Every fix was falsified against a copied backup with the restore proven byte-identical — seven
round-trips, each `cmp`-verified.
