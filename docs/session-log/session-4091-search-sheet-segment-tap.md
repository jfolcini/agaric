# Session 4091 — a tap on the search sheet's All pages segment was swallowed

`e2e/attachments.spec.ts` failed once on PR #6710 inside `openPageMobile`: the
click on `search-sheet-segment-all-pages` resolved and the segment stayed
`data-state="off"` for the whole 15 s. That PR does not touch the sheet.

It was a product bug, not the helper. `SearchSheet` rendered its two segment
bodies through `lazy` + `Suspense fallback={null}`, so a sheet opened before the
idle preload had fetched `InPageFind` came up without its body and grew by the
toolbar's height when the chunk arrived. The sheet is anchored to the bottom, so
growing moves the scope toggle up. A press that went down on "All pages" before
that and came up after it releases over the toolbar: the browser sends no
`click` to the segment. Playwright checks the hit target on the first event of a
click only, so its `click()` still resolves. A finger holds a tap far longer
than Playwright does, so a user is more exposed than the spec was.

The fix is to import `InPageFind` and `PaletteBody` in `SearchSheet.tsx`
instead of lazy-loading them. The sheet is itself a lazy chunk behind App's
`Suspense`, so it now appears with its body or not yet at all, and the main
bundle is unchanged. The module-level preload loop and both inner `Suspense`
boundaries go; `SearchSheet.preload.test.tsx` goes with them, since an import
cannot suspend.

Traps:

- The plain repeat run never reproduced it (60 of 60 green before the fix): the
  window is the few milliseconds between Playwright's press and release.
  Stretching the gap did: the spec holds the `InPageFind` chunk back for a second
  after the trigger tap, presses the segment, waits for the toolbar, releases.
  On the old code that is red every time with the CI signature.
- The spec's red depends on that second of latency outlasting the sheet's
  opening; its green does not depend on timing.
- `openPageMobile` is unchanged. A retry around its click would have hidden the
  swallowed tap.

Ran: `e2e/search-sheet-mobile.spec.ts` ×20 (100 passed; the new test 5 of 5 red
before the fix), `e2e/attachments.spec.ts -g "44 px"` ×60 (60 passed), seven
other specs that open the sheet ×5 (230 passed), vitest over
`src/components/mobile` and `App.test.tsx`, `npm run typecheck`, `npm run lint`,
`prek run --hook-stage manual --all-files`.
