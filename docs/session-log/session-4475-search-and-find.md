# Session 4475 — search and find: results that read as text, one toggle row, a field that holds still, and a find bar in the header

Part of the #7040 UI review, items P6, D4, O5 and the search and find parts of S12.

**What shipped**

- **A result with no snippet reads as text (P6).**
  - A filter-only search sends a row with neither a snippet nor match offsets, and the palette sends none for a short query. Such a row showed the block's raw Markdown. `SearchResultBlockRow` and the palette's `SearchModeGroups` now render it inline and inert, as the Due panel and Trash rows do.
  - In the Search view a one- or two-character term (`scans_short_terms` in `agaric-store/src/fts/search/fetch.rs`) carries match offsets instead of a snippet, so its row keeps the raw content with those marked: stripping it would move the offsets. The same holds with a search toggle on.
- **Recent pages are rows (P6, D4).** One list card with a header row and compact rows, the shape of the results.
- **One toggle row (S12).**
  - `SearchToggleRow` draws lucide `CaseSensitive`, `WholeWord` and `Regex` icon buttons with `aria-pressed`. Each is named in a tooltip and is 44 px on a coarse pointer. A pressed toggle is outlined, as `ToggleGroup` shows a pressed item.
  - Replace, in Search and in find, takes the same cue (`TOGGLE_CUE`), keyed on its `aria-expanded`: it opens a row, so it stays a disclosure, and now looks pressed the way the modes do.
  - The group is a named `fieldset`: a `toolbar` would sit inside find's toolbar.
  - In-page find uses the same row in place of its own three buttons, so both read: the modes, a rule, then Replace. Find's three toggle keys are gone from every locale.
- **The search field holds still (D4).** The field was sized by its text, so the clear button pushed the Search button 28 px. It now has a set width on a desktop. A field that filled the row would shift each time the "Searching…" indicator appears.
- **Find sits in the header (O5).** The bar floated over the App header and covered Today and Search.
  - On a page it sits in the header row, left of Today and Search. Its input is `w-48` at every width, so a page header at 1024 px stays one row.
  - In the Journal the row already holds the view tabs, the date controls, Today and Search, with no room for the bar at 1024 or 1440 px: inline, it covered Previous day. There the bar takes its own line in the header, right-aligned under Today and Search, and the header grows while it is open.
  - On a phone, where Ctrl+F needs a hardware keyboard and the search sheet is the usual path, it stays the overlay below the header. `InPageFind`'s variants are `header`, `overlay` and `embedded`; App picks the overlay with `usePhoneLayout`.

**False premises in the issue**

- The phone's "Press ?" hint was already hidden by #7085.
- Find's match colours were already the soft yellow pair, with the current match inverted (#7084).

**Trap:** `Separator`'s `data-[orientation=vertical]:h-full` beats a plain `h-*` class, so a vertical rule given `h-4` measures 0 px. The new rules size themselves with `data-[orientation=vertical]:h-*`.

**Not done**

- Opening Replace in the header bar adds a line, so the header grows while it is open.
- The phone overlay still covers the page's title row under the header, as before.

**Tests**

- **vitest:**
  - `SearchResultBlockRow` and a new `SearchModeGroups` file: a row with no snippet shows text, not Markdown.
  - `SearchToggleRow`: tooltip names and the named group.
  - `InPageFind`: its modes sit apart from Replace.
- **e2e:**
  - New `search-view-layout` (mock lane): the Search button holds still as the query grows; a Recent page is the height of a result row, on a desktop and a phone; the rule between modes and Replace is drawn.
  - `in-page-find`: at 1024 and 1440 px, on a page and in the Journal, the open bar is inside the header, every header control takes a click, and nothing overflows; on a phone the bar floats below the header; Replace takes the modes' cue; the rule is drawn.
  - `search-toggles` (bridge): a pressed toggle is outlined, and Replace takes the same cue.
- Each was shown red on the old code and under a mutation, e.g. the fallback back to `row.content`, the old `top-14` placement on the header bar, the Journal's header back to one row, `FindBar` ignoring the phone layout, Replace back on `secondary`, a plain `h-6` on the rule, the outline class removed.
- **Edited to the new surfaces:**
  - `SearchToggleRow`: toolbar → named group; the abbreviation and active-dot tests are deleted with those features.
  - `SearchPanel.toggles`: toolbar → group.
  - `InPageFind`: the shared test ids and names.
  - `search-toggles`: the dot and `data-state` checks → the outline. The tooltip trigger overwrites `data-state`.
