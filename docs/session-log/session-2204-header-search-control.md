# Session 2204 — A visible search control in the desktop header (#5636)

Desktop had three search surfaces: the Ctrl+K palette, in-page find
(Ctrl+F), and the full search view (Ctrl+Shift+F). Only the last had a
visible entry point, the sidebar's "Search", and it is the slowest way to
open a page. Phones already had a magnifier at the right end of the header.

`HeaderSearchButton` puts a magnifier and "Search" in that same spot on
desktop. It opens the palette through `useCommandPaletteStore.open$`, the
call the Ctrl+K handler makes, so there is no second path. As the maintainer
asked, the shortcut lives in the tooltip ("Search Ctrl K", "Find in page
Ctrl F"), built the way `JournalControls` builds its own: `getShortcutKeys`
plus `KbdChord`. Both lines follow a rebinding. The accessible name is the
action alone and `aria-keyshortcuts` carries the chord, as in
`JournalControls`, so macOS users are not read "Ctrl".

The same `useShouldShowMobileChrome()` gate picks between this button and
the mobile `SearchSheetTrigger`, so exactly one renders. Desktop chrome
starts at 1024 px. Below `lg` the word hides and the icon keeps its name.
The header stays one 48 px row at 1024 and 1440 on Journal, the busiest
header, and on Pages.

Each new test was shown red against a one-line break: the click handler,
the palette call, each tooltip binding, and both triggers rendering. A
Playwright spec opens the control, types a page title, and lands on that
page.

Review also found that closing the palette leaves focus on `<body>`, from
every trigger, including Ctrl+K. That predates this control and lives in the
palette, so it is #5639 rather than part of this change.
