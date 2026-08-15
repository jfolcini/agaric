# Session 1312

## What the triage dismissed

Two issues about the same shape: a value read back from `localStorage`, `JSON.parse`d,
and cast to a type nobody checked it actually has. #3889 is one instance (a wholly-invalid
graph-filter value that re-warns on every mount and never heals). #3881 says the pattern is
repo-wide.

The interesting work was not the fixing. It was deciding which sites needed fixing at all.

### The denominator matters more than the count

#3881 enumerated ~21 candidate call sites. The build pass came back with: 5 needed a real
fix, 15 were already safe, 1 too large to do here. That ratio is the whole finding — the
issue reads as "this pattern is everywhere and unguarded", and the truth is that most of
the sites had already grown a guard, just not a uniform one.

But "already safe" is a claim that costs nothing to make and is invisible when wrong. A
site wrongly waved through looks exactly like a site correctly waved through: no diff, no
test, no trace. So the review re-audited them independently — 17 of them, more than the
15 claimed — and the triage held at 17/17, including the security-adjacent
`useExternalImagePolicy` the issue flagged as highest priority.

That is the part worth recording. Not "we fixed 5 sites", but "we checked the 15 we
*didn't* fix, and here is who checked them."

### What actually needed fixing

- `useLocalStoragePreference` gained an opt-in `validate?:`. A value that parses but is
  the wrong shape now falls back to the default instead of being handed to the caller.
- `SearchPanel`'s toggles adopted it — found during the caller audit, not listed in the
  issue.
- `preferences.ts`'s two bare `jsonParse<string[]>` definitions now drop non-string
  entries, matching the idiom their siblings in the same file already used.
- `keyboard-config/storage.ts` validates the blob is an object and drops non-string
  bindings.
- `agenda-filters.ts`'s `decodeUnfilteredCursor` type-checks each field instead of
  casting the whole object.

### #3889's self-heal, and the thing to get wrong

The heal fires only when *every* predicate drops — `predicates.length === 0 &&
droppedCount > 0`, which is arithmetically reachable only on total corruption. That
scoping is load-bearing. A self-heal that also fired on partial corruption would silently
destroy the predicates that were still good, which is a worse bug than the re-warn it
replaces.

### The compile error the tests could not see

Build subagents run targeted tests only; the reviewer owns the full run. That division
earned itself here. `npx vitest run` was green — 16763 passing — while `tsc -b` failed
with `TS2375`: under `exactOptionalPropertyTypes`, `decodeUnfilteredCursor`'s
`return { due, scheduled, undated }` sets keys to `undefined` where the type says the key
should be *absent*. Vitest transpiles without typechecking, so no amount of test-running
would have surfaced it. It was a genuine compile-breaking regression, found and fixed in
review.

### What is deliberately not closed

`stores/advancedQuery.ts`'s `parseQuerySpec` checks `filter == null` and then trusts the
inner shape. Fixing it properly means a validator for `FilterExpr`/`SortKey`/`GroupSpec`/
`AggregateSpec` — nested unions comparable in size to the 24-variant one in
`lib/filters/validate.ts`. That is its own PR.

So this closes #3889 and leaves #3881 open with a scope comment. A `Closes` line on
#3881 would have been the easy thing and the false thing: 5 of 21 is not a repo-wide
sweep, and marking it done would have buried the one site that still needs the work.
