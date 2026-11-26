# Session 4497 — the find bar no longer loses the block tree mid-commit

A regression from #7117, found by the `in-page-replace` bridge spec failing on every PR's merge run.

**What broke**

- On a desktop with the find bar open, a long page's Replace all walked the page to its bottom, and a re-render could send the bar back to match 1.
- `useBlockTreeEventListeners` re-registers its tree with the block command bus whenever its handlers change, which is nearly every render. React runs every passive cleanup in a commit before any passive create, in tree order. Since #7117 the desktop find bar sits in the App header, ahead of the content, so its matcher effect could run in that gap.
- There `treeStoresIn` came back empty, the bar walked the DOM instead, and the next block run counted as a fresh search: match 0, scrolled into view. Replace all saves block by block, so each save could jump the page further down, and scroll restore kept the bottom on the next visit.

**What shipped**

- The registration is a layout effect. Its cleanup and re-registration both finish before any passive effect in the commit, so a passive reader of the bus (find's matcher, `countUnreplaceable`) never sees the tree missing.

**Tests**

- vitest: `use-block-tree-event-listeners`, a passive reader placed ahead of the tree sees it registered at mount and across a re-render.
- e2e (bridge): the existing `in-page-replace` "replaces one and all … one Ctrl+Z undoes a replace all" is the regression spec, unchanged.
- Shown red on `main`: the bridge spec at its reopened-page check, and the new vitest. The registration back to a passive effect turns both red again.
