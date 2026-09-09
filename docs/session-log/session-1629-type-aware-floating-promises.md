# Session 1629 — clearing `no-floating-promises`

`oxlint --type-aware` has never been run against this tree, so its eight rules
have eight PRs' worth of backlog behind them. This is the
`typescript/no-floating-promises` one: 56 sites, cleared to zero so the flag can
go on with the rule at `"error"`. The rule fires on an expression statement
whose value is promise-like and is neither awaited, returned, `.catch`-ed nor
explicitly discarded — the shape that lets an assertion run before the effect it
is checking.

Every site is in test or script code. That is the honest headline, and it is
worth stating up front rather than dressing the result up: none of the 56 was a
promise that resolves later than the code around it assumes today. What the
sweep found instead was three distinct shapes, and each wants a different fix.

## Latent, not live: the slash-command handlers

Twenty-three sites are a test calling a slash-command handler and asserting
immediately:

```ts
result.current.exact['query']?.(ctx, { id: 'query', label: 'Query' })
expect(openQueryBuilder).toHaveBeenCalledOnce()
```

`SlashHandler` is `(ctx, item) => Promise<void> | void`, so the call site cannot
know. Every handler these particular tests reach — the date pickers, the mark
toggles, `attach`, `query`, `emoji`, `table`, `link`, `tag`, `block-ref`, `code`,
`quote` — happens to be synchronous, which is why the suite was green without the
await and stays green with it. But the trap is real and one edit away: make any
of those handlers `async` and the assertions start reading pre-handler state
while still passing on the broken code, because the union already permits it.
So the fix is the missing `await`, and twenty enclosing `it` callbacks became
`async`. Neighbouring tests in the same files already awaited these calls, so
this is the file catching up with itself, not a new convention.

Two calls the regex swept in were not violations and had to be put back: one
inside `expect(() => …).not.toThrow()` and one inside
`await expect(…).resolves.toBeUndefined()`. Both already handle the promise; an
`await` there would have turned the second assertion into
`expect(undefined).resolves`, which is a broken test that still reports green on
a broken handler. `git diff -U0` against the original violation line numbers is
what caught them.

The three `navigation.test.ts` sites are the same shape: `persist.rehydrate()`
is `void | Promise<void>` because zustand's storage may be async. Backed by
`localStorage` it settles synchronously, which is why the assertions after it
have always held; awaiting it stops that from being luck.

## Type noise, fixed at the call site

`RichContentRenderer.test.tsx` has six calls that discard the returned node —
the parse-cache tests care only that `renderRichContent` was invoked. React 19's
`ReactNode` includes `Promise<AwaitedReactNode>`, so the rule sees a union with a
thenable in it and fires on a value that is never a promise at runtime. `void`
would be a lie about what the value is. The fix is to stop discarding: each call
is now wrapped in `render(…)`, which is what every other call in the file does,
costs nothing (the parse happens eagerly inside `renderRichContent`, not at
render time, so the `mockedParse` counts are untouched) and exercises the node
instead of dropping it.

`useLongPress.test.ts`'s eight sites are the same class with a different cause:

```ts
act(() => vi.advanceTimersByTime(DEFAULT_LONG_PRESS_DELAY))
```

`vi.advanceTimersByTime` returns the chainable `vi` object, and a concise arrow
body returns it. That picks React's `act<T>(cb: () => T | Promise<T>):
Promise<T>` overload instead of the `() => void` one, so `act` is typed as
handing back an unawaited thenable. At runtime nothing went wrong — `VitestUtils`
has no `.then`, so `act` took its synchronous path, and the original file emits
no act warning; this was checked by running it, not assumed. The fix is a block
body, which is what the code meant and restores the `void` overload.

## The one deliberate un-awaited promise

`useSyncTrigger.test.ts:370` starts a sync and deliberately leaves it in flight
so the next call can be tested against a busy `syncInProgressRef`. That promise
is now bound to `firstSync` and awaited inside the closing `act` that settles it,
so the test waits for the run to unwind rather than relying on `act`'s flush to
have drained it. An assertion on `syncing` was drafted alongside it and then
dropped: removing the new `await` left it green, which makes it the vacuous kind
of assertion `AGENTS.md § Testing` names.

## The fifteen `void`s

`scripts/check-bundle-budget.test.mjs` and `scripts/pr-diff-base.test.mjs` run
under `node:test`, whose top-level `test()` returns a promise that is documented
to fulfil even when the test fails. That was verified rather than taken on
trust — a deliberately throwing `test()` resolves with `undefined` while the
runner reports `fail 1` and sets the exit code. There is nothing for a caller to
await or catch, so all fifteen are `void test(…)` with the reason stated once per
file rather than fifteen times. These are the only `void`s in the change and
there are no rule suppressions anywhere in it.

## Verification

`oxlint --type-aware` reports zero `no-floating-promises` diagnostics, down from
56, and the per-rule counts for the other seven rules are byte-identical before
and after — 138 `unbound-method`, 42 `require-array-sort-compare`, 10
`await-thenable` and so on — so the awaits added here did not trade one rule's
violations for another's. `npm run typecheck` is clean. All ten touched vitest
files pass, 393 tests, and both script files pass under `node --test`. No test
changed outcome, which is the expected result given that none of the 56 sites was
sitting on a live defect; the change removes the conditions under which one could
appear unnoticed.
