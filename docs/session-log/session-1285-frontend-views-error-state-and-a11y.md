# Session 1285 — list-view error states, cross-space link navigation, and four UX/a11y fixes

One PR closing two deep-review batches: **#3306** (list views collapse load failures into the
empty state; `[[ULID]]` navigation is not space-scoped) and **#3308** (four small UX/a11y
fixes in onboarding, keybindings, graph zoom and headings). Every finding was re-verified
against current `main` before it was touched — all six still held.

## Shipped

### #3306 — list views had no error state

`ListViewState` had three branches and no fourth for error, so a settled failure
(`loading === false`, `items === []`) was byte-identical to an empty list and every consumer
painted its "nothing here yet" copy with a "create your first…" CTA over the failure. The only
signal was a ~4s toast.

- `ListViewState` gained `error` + `onRetry`; the empty branch is now reachable only on a
  settled SUCCESS. The new `ListErrorState` card (`role="alert"` + Retry) is modelled on the
  two siblings that already got this right (`HistoryView`, `SearchPanel`), so the app has one
  presentation of "this list failed to load" instead of four.
- Threaded through `TagList`, `TrashView`/`TrashListView`, `TemplatesView`,
  `PropertyDefinitionsList`.
- `usePageBrowserData` now returns `isError` (gated on `!isFetching`, mirroring the toast's
  #2639 gating) and `PageBrowser` renders the error card ahead of "No pages yet".
- `TrashView.test.tsx` had a test named *"handles failed load gracefully"* that asserted the
  defect — that the empty state is shown on a failed load. Rewritten to assert the error card.

### #3306 — `[[ULID]]` navigation was not space-scoped

`commands.getBlock` → `get_active_block_inner` carries a soft-delete predicate and nothing
else, so it returns rows from any space; `handleNavigate` then wrote the fetched title into
the ACTIVE space's resolve slice (`keyFor(activeSpaceId(), id)`). `loadPageSubtree` did reject
and the #2810 heal bounced the user back, but the foreign title stayed readable on the chip
for the rest of the session — against the locked-in "no live links between spaces, ever"
policy.

`handleNavigate` now asks the space-scoped `batch_resolve` (`b.space_id = ?`) whether the
target belongs to the active space before the cache write and before navigating, fails closed
when the space store has not hydrated (same policy as the resolve store's FE-H-22 guard), and
surfaces `error.pageNotInCurrentSpace` under the same toast id the page-load heal uses.

Covered by a real integration test that stubs neither command and routes every IPC through the
in-memory backend model, whose `get_block` / `batch_resolve` handlers reproduce the exact
asymmetry the bug lives in; the fixture is built by actually calling `create_page_in_space`
with a second space id.

The finding's secondary ask — a third `'unresolved'` chip status for unknown ids — was left
out. It is a presentation change across `blockLink` / `useRichContentCallbacks` / `resolveStatus`
with a much wider blast radius than the leak itself, and the leak is what the issue title is
about. Noted on the PR.

### #3308 — four UX/a11y fixes

- **Onboarding.** `handleDismiss` was bound to every close path (including Escape via
  `CLOSE_ALL_OVERLAYS_EVENT` and Android Back) with no reset helper anywhere, and
  `createSamplePages` fired eight sequential un-transacted IPCs whose failure left half-built
  pages behind a still-enabled button. Now: idempotent (existing sample pages are reused and
  only missing body blocks back-filled), `notify.retry` on failure, navigates to the created
  page on success, and a new `resetOnboarding()` + "Show the welcome tour again" Settings row
  wired to the App shell through a `SHOW_WELCOME_EVENT` gate that remounts the modal.
  Note: `writePreference(onboardingDone, false)` does NOT work — the preference uses the
  legacy presence-means-done format; `removePreference` is the documented reset.
- **Keybindings.** `validateBindingInput` accepted any leftover token as a key name, so
  `Ctrl + Shift + Esc` saved a chord the matcher can never fire on while `getShortcutKeys`
  preferred it over the working default. Added an `'unknownKey'` outcome derived from what
  `normalizeKey` actually folds (moved into a new `keyboard-config/keys.ts` so there is one
  canonicalisation), wired into the Save guard and the existing `role="alert"` slot.
- **Graph zoom.** Six d3 `.transition().duration(...)` sites ignored
  `prefers-reduced-motion`; the global CSS rule cannot cover rAF-driven JS. Added
  `reducedMotionDuration(ms)`, read at call time so a mid-session OS change is respected.
- **Headings.** Five views (`pages`, `tags`, `history`, `query`, `search`) rendered no `<h1>`
  at all while six others rendered one that duplicated the shell's label. Introduced
  `VIEW_HEADING_OWNER`, exhaustive over the `View` union: the shell's `header-label` element
  is the `<h1>` for views that own no heading and stays a `<span>` for views that do. A drift
  test cross-checks every entry against the presence/absence of `FeaturePageHeader` in that
  view's source, so the map cannot silently diverge from the components.

## Notes

- Every fix carries a test proven RED by reverting the production change and watching the
  named test fail — the per-fix revert output is recorded in the PR body.
- Full vitest suite green (750 files / 16,416 tests). e2e run for `inner-links`,
  `editor-lifecycle`, `keyboard-shortcuts`, `keyboard-customization`, `palette-desktop`,
  `graph-view`, `pages-view`, `trash-bulk`, `templates`, `features-coverage`. Two
  `pages-view` property-filter tests were flaky (passed on retry) in an area the batch does
  not touch.
- `PageBrowser` crossed its cognitive-complexity budget once the error branch was added; the
  settled-empty region was extracted into `PageBrowserSettledEmptyState` rather than
  suppressing the rule.
