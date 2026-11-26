# Session 4511 — every view titles itself in its content, at one of two column widths

Part of the #7040 UI review, item S3 (maintainer decisions 10 and 22).

**What shipped**

- **One title per view, in the content.** Pages, Search, History, Tags, Templates, Query, Graph and Settings render `FeaturePageHeader` with their sidebar name, as Journal, Trash and the page editor already did. The top bar's label is a `md:hidden` span, the same breakpoint as the h1's `max-md:sr-only`, so exactly one title shows at any width: the h1 on desktop, the bar's name on a phone. Trash no longer names itself twice on desktop.
- **One title edge.** List views' titles sit on their column's left edge at the same height; Pages, Search and History, whose headers are portalled into the outlet slot, take `md:mt-3` so they don't sit 12 px above the in-content ones.
- **Pages' New page on the title row** on desktop; a phone keeps it on the search row.
- **Settings centred.** Its panel is the reading width (736 px, it was 672 and left-aligned) on the journal's axis, the section rail hanging to its left (`@utility settings-column`). A pane too narrow to centre it, such as 1024 px with the sidebar open, falls back to the rail beside a narrower panel, with no horizontal scroll.
- **A hidden header takes no room.** A title-only `FeaturePageHeader` is `max-md:absolute`, so a `gap-*` parent (Graph, Query) adds nothing above the content on a phone.
- `VIEW_HEADING_OWNER`, `shellOwnsHeading` and their drift test are gone: every view owns its h1.

**False premises in the issue**

- The widths were already two: every list view was 960 px and Journal and the page editor 736 px. Only Settings was off.

**Left as they are**

- Actions beyond Pages' New page stay where they were: Tags' and Templates' create forms are input rows, Query's Edit toggles the form under its summary, History's "Show all pages" belongs to its scope line, Graph's controls are filters.
- The journal's title sits 4 px below the list views', as before.
- The page editor's title is PageTitleEditor's labelled field, not an h1, as before.
- `settings-column` pads with `padding-left`; no right-to-left locale ships, and the sidebar and rail don't flip either.

**Tests**

- e2e (mock lane): new `view-shell` — at 1440 px the lists share 960 px, one title edge and one title height with the top bar's label hidden; Journal, the page editor and Settings share one centred 736 px column; Graph runs full width; Pages' New page sits on the h1's row; at 1920 px Settings stays centred; on a phone, for nine views, the bar shows the name, the h1 is visually hidden and the hidden header takes no room. Red on the old code, 13 of 14 (phone Trash already had its h1).
- Falsified one mutation at a time: the label without `md:hidden`, Settings without `settings-column` (killed only at 1920, where centring and left-aligning differ), New page back on the search row, the h1 without `max-md:sr-only`, Settings without its title, `max-md:m-0` back, History without its `md:mt-3`.
- **Edited to the new markup:** `features-coverage`, `autocomplete`, `inner-links`, `breadcrumb-navigation`, `sync-ui`, `sync-pairing-flows` (the visible `header-label` → the view's h1); `pages-keyboard-controls` (a neutral click on the h1, not the label); `app-chrome` (Settings names itself once among visible elements); App.test (the label is a `md:hidden` span beside the view's own h1); SettingsView.test (its own h1); PageBrowserHeader.test (New page on the title row, off the search row); PageBrowser.bookmarks.test (the Pages section label, ignoring the view's h1). `e2e/AGENTS.md` § Header label selection points to the h1.
