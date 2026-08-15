# Session 1324

## A barrier you cannot demonstrate

#3902 replaced non-waiting reads in `pages-view.spec.ts`'s **filter** assertions — `.resolves`,
`evaluateAll`, `allTextContents`, all of which opt out of Playwright's auto-waiting. The sort
block has the same shape and was missed (#3918).

The obvious fix is to apply the same treatment to all seven sort steps. That would have been
wrong in two directions at once, and finding out which required measuring rather than reasoning.

### Only three of the seven modes can race

`usePageBrowserSort` re-sorts client-side and synchronously for the four frontend-only modes
(`alphabetical`, `default`, `created`, `recent`) over rows already loaded. It does nothing for
the three server-derived modes (`most-linked`, `most-content`, `recently-modified`), which
render server rows in received order. So a barrier on the four frontend modes would guard a
transition that cannot be observed mid-flight.

### And one of the three has nothing to observe either

Probing the mock's `list_pages_with_metadata` directly, bypassing the UI, gives the deterministic
order per sort mode. `default`, `most-linked` and `recently-modified` return the **byte-identical**
array in this fixture: the two one-inbound pages already sort first by id ASC, and the ~90-day-tie
pages fall back to the same tiebreak.

So the `Most linked` step's read is unobservable — stale and settled are indistinguishable. A
barrier there could not be shown to block anything, which is the definition of the vacuous barrier
this repo has shipped before. It was left un-barriered with a comment saying why, rather than
decorated.

The alternative — reshaping the fixture so the transition becomes observable — was considered and
rejected as disproportionate: it means perturbing the shared `Quick Notes` / `Getting Started`
link topology that has broken unrelated specs before. What is lost is only the *race* coverage for
that one step; the ordering itself is pinned by `usePageBrowserSort.test.ts` and
`sort-cursor-conformance.test.ts`.

### The two real barriers, demonstrated

`Most content` and `Recently modified` do transition observably, and got retrying `toHaveText`
assertions. Both were proven by injecting a 2000ms delay into the mock handler and swapping the
barrier for a naive one-shot read: each failed 3/3 including retries, capturing the previous
step's array verbatim, and passed with the barrier restored under the same delay.

That is the whole method, and it is cheap. The reason it matters here is that this repo has
already shipped three `expect.poll` barriers that could not fail — and the agent sent to fix them
produced two more vacuous attempts before the delay-injection test settled it. Reasoning about
whether a barrier blocks has a worse track record than making the thing slow and looking.

### The other half was already done

#3885 asked for a fixture derived from `MAX_TRASH_BATCH_IDS` instead of a hardcoded 1001, and for
the flake against the 20s budget to be addressed. Both had already landed via #3895 — the constant
is exported, all three chunked-path fixtures derive from it, and the three tests run in 5.3s, 3.6s
and 4.2s against that budget on a machine with several builds running.

Closed with those numbers attached rather than with "already fixed", because the issue's claim was
about a *budget*, and only a measurement answers that.
