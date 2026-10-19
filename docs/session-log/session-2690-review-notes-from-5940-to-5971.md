# Session 2690 — review notes from #5940, #5943, #5946, #5948, #5949, #5950, #5953, #5955, #5956, #5957 and #5967

One follow-up for the non-blocking notes of the PRs merged after #5954. Every
note's premise was read against the code first.

Applied:

- #5940: the `useMemo` on `Tooltip`'s context did nothing, since `useLongPress`
  returned a fresh object each render. Deleting it trips oxlint's
  `jsx-no-constructed-context-values`, so `useLongPress` now memoizes what it
  returns instead.
- #5943: Edit options now sits at the right with Delete after it in the DOM, so
  the tab order is the drawn order on desktop; on a phone Delete and Built-in
  take grid cell 2 of row 1 explicitly and the options keep line 2.
- #5948: the coarse chevron's `-ml-3.75` stuck out 3 px past the header; now
  `-ml-3`, with the phone e2e pinning that it starts at the header's edge.
- #5949: Radix keeps the tab stop on the last-focused tab, so a mode changed
  from outside the strip left Tab landing on the wrong tab. `TabsTrigger` now
  makes the selected tab the tab stop; the Journal test that pinned the old
  roving behaviour follows.
- #5955: with no pages the phone ⋮ menu offered "Save current view" for an
  empty list; it now holds only the view rows, as on desktop. The second note
  (lift the popover out of `SavedViewsDropdown` if a second overflow item
  lands) is conditional on a second caller and was not acted on.
- #5956: `QuickCaptureFab` read a scroll restore as a scroll down. The first
  scroll of an element with no user input behind it (touch, wheel, key, pointer)
  now only records its position. The e2e goes Getting Started, scroll, Pages,
  Back, and was shown red against the unfixed code. The note's own example,
  Pages' list, does not restore a position at all (it is a nested viewport, not
  `#main-content`), so the e2e uses a page, where `#main-content` is the
  scroller.
- #5957: deleted the stale `#136` comment over the recent-searches keys.
- #5967: dropped the unregenerable "near half the cap" claim; the comment names
  #5915 as the sizing source.

Not applied:

- #5946: renumbering 0128 to 0127 would edit a merged migration, which the
  append-only guard forbids, and a database that already ran 0128 would run 0127
  after it either way. The gap is harmless.
- #5950 and #5953: the notes were about a PR body and a session log, which
  cannot change after merge. Nothing to do.

Ran: vitest for `components/mobile`, `ui`, `PageBrowser`, `journal`,
`properties`; `phone-views`, `mobile-overflow` and the related Playwright
specs.
