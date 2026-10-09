# Session 1961 — open a page's local graph from the page (#5433)

A page's local graph took three steps: open Graph, turn on local mode, pick
a depth. Now one action does it from the page.

What shipped:

- "Show in graph" in the page menu, `Ctrl+Shift+G` (rebindable), and the
  palette's "Show this page in graph" all call `showPageInGraph()`
  (`src/stores/show-page-in-graph.ts`): it turns local mode on, keeps the
  saved depth (default 2) and switches to Graph, seeded on the open page.
  With no page open, or before a space is known, it shows a notice and
  changes nothing (#5415).
- Local mode and depth are saved per space (`agaric:graph-local:<spaceId>`,
  through the preferences registry), so they survive leaving the graph and
  coming back. Unreadable storage opens the global graph and logs a
  warning.
- When filters hide the seed page the graph now says so ("<page> is hidden
  by the active filters"); the old "This page has no links yet" only ever
  appeared when the seed was missing, never for a linkless page. A tag page
  gets its own notice, since the graph's nodes are pages only.
- `docs/features/views.md` and `docs/features/keyboard.md` list the action
  and the shortcut.

Verified: 20 falsifications on copies (the tag branch, the hidden-seed
message, the stored mode and depth read/write and per-space key, each guard
in the action, the shortcut and menu wiring, the arrow-key order, the
rebindable hint, the stored-value checks, the palette command), all red,
restored and `cmp`-checked. Full vitest 20,820 passed; Playwright
graph-view, keyboard-collisions and keyboard-shortcuts 43 passed (one known
flake on the journal view passed 5/5 alone); typecheck, oxlint and oxfmt
clean.
