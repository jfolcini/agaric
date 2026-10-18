# Session 2656 — the SearchPanel breadcrumb test models the page prefetch its click starts

A #5908 flake: `SearchPanel.test.tsx` failed only under full-suite load with an
unstubbed `load_page_subtree` call.

- **Cause:** "clicking page title in breadcrumb navigates to the page" clicks
  a `PageLink`, whose mouseenter and focus start the hover-intent prefetch
  (`usePagePrefetchIntent`, 120 ms dwell). Alone, the test unmounts within the
  dwell and the timer is cancelled; under load `user.click`'s own timer steps
  stretch past 120 ms, the prefetch sends `load_page_subtree`, and the
  strict-invoke guard fails the test. The call is real: hovering a result's
  page title does warm that page.
- **Fix, in that test only:** it stubs `load_page_subtree` with a typed
  subtree, waits for exactly that one call, and checks the effect:
  `consumePrefetchedPageSubtree` hands the opened page that subtree.

Shown red the way it failed: with the dwell injected to 0 ms the old test
failed with the CI message, and under 48 CPU-hog processes it failed 1 of 5
runs; the fixed test passed 10 of 10 under both. With `PageLink`'s prefetch
removed, the new assertion fails as predicted.

Ran: the six `SearchPanel*.test.tsx` files (154), the file 20 times alone,
`npm run typecheck`.
