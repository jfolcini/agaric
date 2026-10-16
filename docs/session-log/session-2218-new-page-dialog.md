# Session 2218 — Pages leads with search, and one New page dialog (#5637)

The Pages view opened on a "New page name…" input that took focus, which on a
phone raised the keyboard over the list every visit. Search sat below it.
Nothing warned about a near-duplicate name before creating.

**Premises the build corrected:**

- **The shortcut.** The new-page shortcut (`createNewPage`) is Ctrl+N. The
  issue said Ctrl+Alt+N, which is the system-wide Quick Capture hotkey and is
  unchanged. Ctrl+N now opens the dialog.
- **The handlers.** The sidebar button, the chord and the palette command were
  three copies that shared only `createUntitledPage`. It is deleted.
- **Duplicates.** An exact duplicate never failed: `create_page_in_space` opens
  the existing page (#4723). Near duplicates went through silently, as the
  issue said: case variants and other pages' aliases.

**What changed:**

- **Search first.** The Pages view's first row is search, sort, saved views,
  then New page, which is icon-only on phones. Search takes focus only with a
  fine pointer. The inline create row is gone.
- **One dialog.** Every entry point opens `NewPageDialog` through
  `openNewPageDialog`, a window event that `useAppDialogs` holds, as the
  shortcuts and bug-report dialogs already do. No store was added. The entry
  points are:
  - the sidebar button;
  - Ctrl+N;
  - the palette command;
  - the Pages header button;
  - a namespace's `+`;
  - a new "Create page" row at the top of a search with no exact match.
- **One matcher.** The `[[` picker's page matcher moved into `page-matcher.ts`
  as `matchPages`, and the picker and the dialog both call it. The dialog
  warms its page cache on open, as the picker's already is.
- **Exact matches.** A title or alias that matches the typed name, ignoring
  case, makes Open the primary action and disables Create. Near matches are
  listed with Open buttons. Creating opens the new page.
- **No optimistic prepend.** Creating now always navigates to the new page and
  unmounts the list, and every local write marks the list stale. The dead
  branches in `usePageBrowserData` went with it.

**Review** found the dialog missed accented near-duplicates. Before its page
cache filled, a query searched the full-text index alone, which folds case but
not accents, so "cafe plans" listed nothing beside "Café plans" while the `[[`
picker found it. The cache now warms on open, and the test that compares the
two warms the picker as well and includes that pair. Review also had the
Similar pages section hidden while the title is blank or under "already
exists".

**Not done:**

- At the narrowest phone width the icon-only New page still takes its own
  line; fitting it means shrinking sort or saved views.
- Escape from a dialog opened by the palette leaves focus on the page body.
- On the first visit to Pages in a session, search may not take focus. This
  predates the change.

**Suites:** full vitest, typecheck and lint in review; Playwright on
`new-page-dialog`, `pages-view`, `keyboard-shortcuts` and `mobile-overflow`
after the fixes. The `e2e-tauri` specs and helpers changed but were not run
locally; CI's real-backend lane caught one spec,
`pages-most-linked.e2e.ts`, still waiting for the field in the Pages view,
and it now opens the dialog.
