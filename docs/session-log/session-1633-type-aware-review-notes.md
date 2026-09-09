# Session 1633 — review notes from the type-aware lint sweep

Four PRs (#4884, #4887, #4888, #4889) turned `oxlint --type-aware` on one rule
at a time and merged approved. Between them they collected six non-blocking
notes, batched here. One had to be resolved the opposite way round from how it
was written, because the fix the note preferred is itself a type-aware
violation. One I first judged to rest on a stale premise and was wrong about
twice — see the addendum at the end, which is the part of this log worth
reading.

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

## The `Storage.prototype` spies — I called this one wrong, twice

Two tests spy on `Storage.prototype.setItem` and make it throw:
`useTheme.test.ts` ("keeps instances in sync even when localStorage writes
fail") and `useDeepLinkRouter.test.ts` ("still switches view if localStorage
write throws"). `src/__tests__/AGENTS.md` recorded that such a spy does not
intercept `localStorage` under happy-dom and neither file opts into jsdom, which
would make both tests vacuous.

The recorded reason was wrong — the prototype is not bypassed — and I stopped
there, concluding the tests were fine. They are not. The addendum below has the
whole thing; the short version is that the probes which said "spy called once"
were `-t` filtered, and a filtered run skips the earlier test whose write freezes
the binding. Unfiltered, the same probe reports zero.

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

## Addendum — the note was right and I was wrong twice

The #4887 review note said `useTheme.test.ts` and `useDeepLinkRouter.test.ts`
might be vacuous. This log's first version contradicted it on the strength of
three probes. The reviewer on #4891 blocked that, and the reviewer was right.

The mechanism is real: happy-dom's `Storage` is a `Proxy` whose `get` trap runs
`ClassMethodBinder.bind`, which reads the descriptor off `Storage.prototype` at
that moment, copies it onto the instance as an own bound property, and caches
the name so it never rebinds. Interception is first-come, per file.

What was wrong was applying it. `useTheme.test.ts` writes
`localStorage.setItem('theme-preference', 'dark')` at line 67, in the second
test in the file — 380 lines before the spy at :447. By the paragraph's own
rule that spy is dead, and it is. Re-running the probe over the whole file
**unfiltered** reports `expected "setItem" to be called 99 times, but got 0
times`. The earlier probes that reported 1 must have been `-t` filtered, which
skips the test whose write froze the binding. A filtered probe is live and the
same spy is dead in CI, which is the worst possible shape for a check.

So `src/__tests__/AGENTS.md` now carries the rule without the roster of
supposedly-fine files, plus the thing the roster was missing: how to prove a spy
live, and that the proof has to run the whole file. Session 1636 carries the
audit of every remaining `Storage.prototype` spy in a happy-dom file and the
tests that turned out to be asserting nothing.

Two corrections in one paragraph is worth stating plainly: the first version of
this note claimed the spies always work, the second claimed they work once per
file *and* that these two files were on the right side of that line. Only the
mechanism survived.
