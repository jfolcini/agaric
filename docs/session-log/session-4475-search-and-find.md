# Session 4475 — search and find: results that read as text, one toggle row, a field that holds still, and a find bar under the header

Part of the #7040 UI review, items P6, D4, O5 and the search and find parts of S12.

**What shipped**

- **A result with no snippet reads as text (P6).**
  - The backend returns no snippet for a query of only one- or two-character terms (`scans_short_terms` in `agaric-store/src/fts/search/fetch.rs`) and for a filter-only search. The mock never returns one.
  - Such a row showed the block's raw Markdown. `SearchResultBlockRow` and the palette's `SearchModeGroups` now render it inline and inert, as the Due panel and Trash rows do.
  - With a search toggle on, a row still shows its raw content: stripping it would move the match offsets.
- **Recent pages are rows (P6, D4).** One list card with a header row and compact rows, the shape of the results.
- **One toggle row (S12).**
  - `SearchToggleRow` draws lucide `CaseSensitive`, `WholeWord` and `Regex` icon buttons with `aria-pressed`. Each is named in a tooltip and is 44 px on a coarse pointer. A pressed toggle is outlined, as `ToggleGroup` shows a pressed item.
  - The group is a named `fieldset`: a `toolbar` would sit inside find's toolbar.
  - In-page find uses the same row in place of its own three buttons, so both read: the modes, a rule, then Replace. Find's three toggle keys are gone from every locale.
- **The search field holds still (D4).** The field was sized by its text, so the clear button pushed the Search button 28 px. It now has a set width on a desktop. A field that filled the row would shift each time the "Searching…" indicator appears.
- **Find hangs below the header (O5).** The bar covered the App header's Today and Search; it now sits under it.

**False premises in the issue**

- The phone's "Press ?" hint was already hidden by #7085.
- Find's match colours were already the soft yellow pair, with the current match inverted (#7084).

**Trap:** `Separator`'s `data-[orientation=vertical]:h-full` beats a plain `h-*` class, so a vertical rule given `h-4` measures 0 px. The new rules size themselves with `data-[orientation=vertical]:h-*`.

**Tests**

- **vitest:**
  - `SearchResultBlockRow` and a new `SearchModeGroups` file: a row with no snippet shows text, not Markdown.
  - `SearchToggleRow`: tooltip names and the named group.
  - `InPageFind`: its modes sit apart from Replace.
- **e2e:**
  - New `search-view-layout` (mock lane): the Search button holds still as the query grows; a Recent page is the height of a result row, on a desktop and a phone; the rule between modes and Replace is drawn.
  - `in-page-find`: the open bar leaves Today and Search clickable, and its rule is drawn.
  - `search-toggles` (bridge): a pressed toggle is outlined.
- Each was shown red on the old code and under a mutation, e.g. the fallback back to `row.content`, `top-2` restored, a plain `h-6` on the rule, the outline class removed.
- **Edited to the new surfaces:**
  - `SearchToggleRow`: toolbar → named group; the abbreviation and active-dot tests are deleted with those features.
  - `SearchPanel.toggles`: toolbar → group.
  - `InPageFind`: the shared test ids and names.
  - `search-toggles`: the dot and `data-state` checks → the outline. The tooltip trigger overwrites `data-state`.
