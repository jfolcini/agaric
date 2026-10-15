# Session 2091 — Week view: copy, cut and paste a selection across days

The journal week view mounts one `BlockTree` per day, and every tree runs the
copy/cut/paste listener over the one global selection. Each tree filtered the
selection to the ids its own store held, so a selection spanning two days was
copied twice (each day's share, in whichever order the listeners ran), cut
removed both shares but left a clipboard holding only one, and paste landed once
per day that held a selected block.

Only the tree whose store owns the anchor (the last selected id) now acts.
`selectionByPage` collects the selection roots of every mounted page store
(`forEachPageStore`) and orders the pages by the document position of their
first root. Copy renders each page with its own `get_blocks_source` call,
because the backend renders one page per call, and joins the text in that
order. Cut removes blocks only after the clipboard write resolves, and nothing
at all when any page fails to render. Paste lands once, after the anchor.
Single-day behaviour is unchanged.

Tests:
- Hook tests for cross-day copy order, cut and single paste, and a cut that
  writes and removes nothing when one day fails to render. They went red with
  the per-tree gate restored, with the document-order sort disabled, and with
  one page's render failure swallowed.
- `e2e/week-cross-day-clipboard.spec.ts` and
  `e2e-tauri/week-cross-day-clipboard.e2e.ts` select a block on each of two days
  and check copy, cut and paste end to end.

Suites run: vitest on `src/components/block-tree`, `src/components/journal` and
`src/components/editor`, typecheck, the wdio tsconfig, lint, and Playwright on
the new spec and `block-paste-outline`.
