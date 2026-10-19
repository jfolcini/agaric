# Session 2710 — Markdown reveal beside page, tag and block-ref chips

#5974, option A (maintainer's pick). The maintainer's "link markers do not
show" report was `[[Page]]` chips, which #5689 kept as chips (ids protected by
#5686) and session 2420 recorded as "Chips stay chips"; the earlier block-mode
and page-mode checks only exercised external links.

**What shipped.** With *Show Markdown syntax around the cursor* on, a page link
draws `[[` and `]]`, a tag `#` and a block ref `((` and `))` as widget
decorations beside the chip, in block mode and page mode (one plugin). No new
setting, op, store or migration.

**The rule: "next to a chip".** An empty selection touching a chip
(`$from.nodeBefore` / `nodeAfter`), or a NodeSelection on one. Both sides of
the touched chip are drawn whichever side the caret is on, as for a mark's two
delimiters; the caret stays outside the syntax (opening widget `side` 100,
closing -200, so a mark's delimiters sit outside them, as the serializer
writes). A range selection shows none: it is the narrowest rule that shows the
syntax where the user is at the chip, and it needs no walk (`nodeBefore` and
`nodeAfter` are O(1)). Page mode's cross-block guard (`spansPageBlocks`) is
reused.

**Why separate from `revealedMarkers`.** Those markers are one unit with
Backspace, Delete, arrows and click stops (`markerBesideCaret`,
`stopForClick` counts `.md-reveal-marker`). Chips are not text, so
`revealedChipMarkers` (still in `revealed-markers.ts`, no TipTap import, the
cold-start boundary holds) feeds only decorations, with class and test id
`md-reveal-chip-marker`: every key keeps behaving as with the setting off, and
a test compares the outcome with it on and off for each key and position.
An alias label or a broken link needs nothing: the chip's label or title is
whatever is drawn, and the syntax is the same.

**Layout.** Same muted token and `aria-hidden` / `data-find-skip` as the other
markers. The text after a revealed page link shifts by the two widgets' width
(about 24 px at the default size, as the existing markers do); read from the
screenshots at 1280x800 and 360x780.

**Tests.** `markdown-reveal.test.ts` and `page-mode-reveal.test.ts` (positions,
selected chip, setting off, range, cross-block, 60-block page, key parity, order
against bold's delimiters), `e2e/chip-reveal.spec.ts` (block mode, phone, page
mode; Backspace and persistence) and a case in
`e2e-tauri/markdown-reveal-persist.e2e.ts` (WebKitGTK caret and typing beside
the widget). Each was shown red by breaking the code it covers.
