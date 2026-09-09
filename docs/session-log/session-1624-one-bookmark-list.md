# Session 1624 — one bookmark list, not two

Session 1622 renamed the command palette's pin to a bookmark, on the reading
that the palette and the sidebar's Bookmarks section were one feature under
two names. They were, but that was not the whole picture: the maintainer
pointed out a third surface and a second list. The star in the page header
already was a bookmark feature, and it wrote somewhere else entirely.

## What the two lists were

| | Storage | Written from | Read by |
|---|---|---|---|
| Starred | `starred-pages`, a flat id array | page header, Pages browser rows, batch toolbar | the Pages browser's Starred section |
| "Bookmarks" | a `pinned` flag on `recent-pages` entries | the command palette only | the sidebar's Bookmarks section |

They never met. Starring a page from its header did not put it in the sidebar
section called Bookmarks, and the palette's toggle did not fill the star.

The `pinned` half also had a defect the arrangement hid: `togglePinRecentPage`
returned null for an id that was not already in the recents MRU, so a page you
had not visited recently could not be bookmarked at all.

## Which one survived

`starred-pages`. It has the affordances (three surfaces to the palette's one)
and, on the reporting vault, it has the data: two entries, against zero pinned
recents out of thirty-two. Collapsing onto it loses nothing.

The sidebar section now reads that list. Titles come from the app-wide resolve
cache instead of from a recents row, which also gives the space filter for
free: that cache is keyed by `(space, id)`, so a bookmark belonging to another
space does not resolve under the active one and is left out. A rename is
picked up without rewriting storage.

`pinned` is deleted — the field, `togglePinRecentPage`, the pin-first
ordering, the exemption that kept pinned entries out of the `MAX_RETAINED`
eviction, the union in the raw-key merge, and the sanitizer arm. Recents are
plain MRU capped at ten.

## Which name survived

Bookmarks, per the maintainer. The page header's star, the Pages browser's row
toggles and section header, and the batch toolbar all now say bookmark and
draw the `Bookmark` glyph the sidebar already used. The i18n keys moved with
their values.

The storage key is still `starred-pages`, and so are the identifiers in
`src/lib/starred-pages.ts` and `useStarredPages`. Renaming the key means
migrating everyone's bookmarks for a string no user ever sees, so the seam
stops at that file, which now says so in its docblock.

## Verification

Two falsifications, each against a `cp` backup restored and `cmp`-checked in
the same command. Deleting the sidebar's space filter reddens "shows only the
active space bookmarks". Making the palette's action-menu bookmark a no-op
reddens "selecting Bookmark toggles the state" — that one asserts the shared
preference, so it is also the proof that the palette and the star write the
same list.

`BookmarksSection.test.tsx` is rewritten against the new source: it seeds the
bookmark preference and the resolve cache separately, which is what lets the
cross-space case be written at all. Two of its cases carry properties that
were false under the old model — a bookmark outliving the recents cap, and the
space filter.

18967 unit tests pass across the whole frontend, plus 53 Playwright cases over
the Pages view, the palette and the bookmark specs. `npm run typecheck` is
clean. `e2e/starred-pages.spec.ts` and `PageBrowser.starred-pages.test.tsx`
are renamed to match what they test.
