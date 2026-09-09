# Session 1633 — review notes from the type-aware lint sweep

Four PRs (#4884, #4887, #4888, #4889) turned `oxlint --type-aware` on one rule
at a time and merged approved. Between them they collected six non-blocking
notes, batched here. Two of the six turned out to rest on a premise that is no
longer true, and one had to be resolved the opposite way round from how it was
written, because the fix the note preferred is itself a type-aware violation.

## The cause chain still had an `[object Object]` arm

#4889 fixed `extractSingleCause` in `src/lib/logger.ts` for a cause object with
no `message`. The reviewer pointed out the same loss survives one branch
earlier: `'message' in cause` accepts a `message` that is itself an object, and
`String()` on it produces exactly the `[object Object]` the new arm below was
added to prevent. `AppError` is `{ kind, message }`, so a wrapper carrying one
whole — `{ message: { kind: 'Internal' } }` — is the shape that hits it, and it
reaches both the console line and the IPC context JSON in the daily rolling log.
`no-base-to-string` did not catch it because the value is `unknown` at that
point, and the rule leaves `unknown` alone.

The arm now requires `typeof … === 'string'`, which is how `renderFatalBootError`
in `main.tsx` already reads the same field; anything else falls through to
`safeStringify` and shows its shape. A `{ message: 42 }` cause now logs as
`{"message":42}` rather than `42`, which is the only behaviour change and is the
more informative of the two.

## The mock carried a cast and a coercion over the same value

`propertyLikeMatches` in `src/lib/tauri-mock/handlers/shared.ts` read
`String(stored as string)`. The note is right that carrying both invites a later
reader to delete the "redundant" half and get the wrong one — but its preferred
resolution, dropping the cast and leaving the coercion, does not survive the
lane this sweep exists to serve: `stored` is non-null `unknown`, which narrows
to `{}`, and `String({})` is a `no-base-to-string` error. Verified by making the
change and running the flag.

So it went the other way: the coercion is gone and the cast stands alone, which
is also the idiom `propertyCompareMatches` uses three lines above. The comment
now says why the cast holds — `value_num` is excluded by the guard, so the
column is one of the three TEXT ones — instead of admitting to the belt and
braces. `String(vc.wanted)` stays; that one is a real `string | number` union.

## The `Storage.prototype` spies do intercept — the note's premise is stale

Two tests spy on `Storage.prototype.setItem` and make it throw:
`useTheme.test.ts` ("keeps instances in sync even when localStorage writes
fail") and `useDeepLinkRouter.test.ts` ("still switches view if localStorage
write throws"). `src/__tests__/AGENTS.md` records that such a spy does not
intercept `localStorage` under happy-dom and neither file opts into jsdom, which
would make both tests vacuous — they would pass without anything ever throwing.

It is not true on happy-dom 20.12.0. A probe run under the repo's own vitest
config reports `Object.getPrototypeOf(localStorage) === Storage.prototype` and
the spy called once with the write throwing. Adding
`expect(setItem).toHaveBeenCalled()` to each of the two tests passed, and
inverting it to `toHaveBeenCalledTimes(99)` reddened with "expected setItem to
be called 99 times, but got 1 times" — so the throwing implementation really
runs, and the assertions after it really are made against a failed write.

Both tests are left exactly as they were; the probes were run against `cp`
backups and restored. The stale line is in `src/__tests__/AGENTS.md`, which is
not this PR's to edit — it needs maintainer approval, and it is worth one,
because the file is what a future author will consult before choosing an
environment.

## Two test hooks and a mount that nothing read

Three smaller notes, all confirmed as written.

`GatedImage.test.tsx` created its `createObjectURL` spy call-through and then
had all three tests in the block override it with `mockReturnValue`, so the
call-through arm could never run. The hook now returns the value and the three
per-test lines are gone; the two assertions that named their own blob URL name
the shared one.

The three `parse cache (#2272)` tests in `RichContentRenderer.test.tsx` asserted
only `mockedParse` call counts, but #4888 had wrapped each discarded node in
`render(…)` to satisfy `no-floating-promises` — including a `render(null)`.
`renderRichContent` is a plain function that calls `parseCached` before it
returns, so the mounts contributed nothing to what the tests measure. They are
`void renderRichContent(…)` now.

`use-roving-editor.ts` spelled the `searchBlockRefs` fallback thunk twice, in
two different line wrappings after #4884 reformatted them. The two are
behaviourally identical — the thunk's identity is never compared, only
`.current(query)` is ever called — so a module-level `noBlockRefs` carries both.

## Verification

`npm run typecheck` clean. `oxlint --type-aware` reports 60 errors, the same 13
`only-throw-error` and 47 `require-array-sort-compare`/`no-misused-spread` that
belong to the rules this sweep has not reached; none of them in the six touched
files. The one diagnostic those files do carry is the pre-existing
`complexity` warning on `metaRowMatchesFilter`, three hundred lines from
anything changed here.

Each behavioural change was falsified against a `cp` backup and restored with
`cmp`. Reverting the logger guard reddens the new test with `expected '[object
Object]'`. Hardcoding `objectUrl` in `GatedImage.tsx` reddens both surviving
blob assertions, and disabling the revoke reddens the unmount one. Bypassing the
parse cache reddens the memoization test and removing the empty-content early
return reddens the tokenizer one, so the `void` rewrite kept both honest. The
`shared.ts` change is type-level only and erases to the same code.

The six touched files run 584 tests green; `src/editor` plus `EditableBlock`,
which is the blast radius of the `use-roving-editor` hoist, another 2181.

## Addendum — the stale line is corrected, then corrected again

The maintainer approved editing `src/__tests__/AGENTS.md`, so the claim that
`Storage.prototype` spies do not intercept `localStorage` under happy-dom is
gone from its "known cases" list, and a short paragraph records that it was
there and why it is not true on happy-dom 20.12.0 — with the two tests that
depend on the working behaviour named, and a re-check trigger for the next
happy-dom major. Deleting the clause outright would have left the next person
who remembers the old rule free to reinstate it.

The first correction was itself too strong. It said the spies work, full stop.
They work once per file: happy-dom's `Storage` is a `Proxy` whose `get` trap
copies the prototype method onto the instance as an own bound property on first
access and caches the name, so the first `Storage.prototype` spy in a file
intercepts and every later one is invisible. jsdom forwards to the prototype on
every access, which is why the same file passes there. Four files stay pinned to
jsdom for exactly that, and one of them is order-dependent — it passes in
isolation and fails once a preceding test has frozen the binding.

The two tests the review note worried about are fine because their spy is the
first in the file, which is what the three probes measured. The mechanism is
what the probes did not reach, and the paragraph now names it, along with the
trap that follows from it: a `not.toHaveBeenCalled()` behind a later spy is
vacuous under happy-dom rather than red.
