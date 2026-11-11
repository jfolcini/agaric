# Session 3787 — Review notes from #6489

The follow-up batch for the list-row card pattern (#6489).

- The Pages list drew a 2px seam above its Pages section header whenever bookmarks preceded it. The header's own `border-t` stacked on the hairline the last bookmarked row already draws (`list-row::after`). The header now draws no border of its own, and the renderer's `hasStarred` prop, which existed only for that border, goes.
  - The renderer test that pinned the border now pins a header row with no top border. It went red with the border restored.
  - Before and after screenshots are on the PR.
- The other three notes had already landed in #6489's last commit:
  - the duplicate coarse-pointer `min-h-11` in `BlockListItem`;
  - History's stale estimate comment;
  - Trash's "inset divider" wording.
- A pass over the merged lists (Pages with bookmarks and namespaces, Trash, History, Agenda, Search, Tags; phone and desktop, light and dark) found nothing wrong with the card pattern. Two older issues showed up: History rows on a phone put Reset on its own line, and Trash's mock rows read "Deleted: NaNd ago". They are reported, not changed here.
