# Session 1927 — hanging control lane, one section-label style (#5332)

The last open parts of the #5332 design plan, plus review notes from #5342 and
#5346.

What shipped:

- Item 7: on desktop (`md` + fine pointer) the block tree's control lane, the
  drag grip and the chevron, hangs in the pane's left margin. A depth-0 checkbox
  now starts where the page title or the journal day heading starts. At
  1440px: title 252 → 288, checkbox 302 → 288, block text 336 → 322. The pane
  and the chrome rows above it take `pl-16` instead of `px-6` on the left in
  every view, so all view titles share one column edge. `pl-14` was enough for
  the 54px lane, but it put the grip 1px from the sidebar's resize rail, which
  reaches 7px into the pane, so a near miss started a sidebar resize. Phones
  have no lane and keep their layout. The page title's hover plate hangs 4px
  into the margin so its text sits on the column edge.
- One section-label style: sentence case, no letter-spacing, `text-xs
  font-medium text-muted-foreground`, at 12 call sites and in
  `SectionGroupHeader`. The DOING / TODO / DONE group names stay upper case
  because they are the task keywords. The Advanced Query NOT toggle is a
  control, not a label.
- Dialog, alert-dialog and sheet scrims are `bg-black/20 dark:bg-black/50`.
- Calendar day buttons and the due / scheduled chips use tabular numerals.
  `Badge` already did.

Review notes taken from earlier PRs:

- #5342: the breadcrumb comment no longer quotes the half-alpha ring as the
  house pattern. The class-name assertions in `AppSidebar.test.tsx` and
  `SettingsView.test.tsx` are gone. `nav-active-item.spec.ts` now also checks
  that the active item differs from an item at rest, which the deleted
  assertions covered: with the active fill removed, the old spec passed 6/6.
- #5346: the `KeyboardTab` Reset link keeps its own classes.
  `buttonVariants({ variant: 'link' })` also carries Button's sizing and
  inline-flex layout, which would change the link to share three class names.

Also found this session: #5348 (item 8) broke the six real-backend specs that
open Settings, because their nav helper matched a label `<span>` and Settings
became an icon-only button. That PR's helper now also matches `aria-label`.

Known limits:

- On Linux the Tauri webview reports a coarse pointer for a mouse (#1236), so
  the lane stays in the row there: nothing overlaps, but the checkbox does not
  line up with the title.
- The AGENTS.md mandatory-pattern line still quotes `focus-visible:ring-ring/50`.
  Changing it needs maintainer approval.

Verified:

- `npm run typecheck`.
- Full vitest, before the `pl-16` change: 871 files, 20 736 passed, 1 expected
  fail, 51 skipped. After it, App, TabBar and QuickAccessBar: 212 passed.
- Playwright: 90 passed across the geometry, drag, chrome, nav, settings and
  search specs before `pl-16`. After it, 78 passed across
  `block-metadata-row-layout`, `mobile-overflow`, `pages-namespace-indent`,
  `block-dnd*`, `page-outline`, `app-chrome` and `nav-active-item`.
- The new alignment checks failed against copies with the lane margin
  reverted, the pane padding reverted, and padding at `pl-14` (lane 226 against
  the rail's right edge at 231). Each copy was restored and compared.
