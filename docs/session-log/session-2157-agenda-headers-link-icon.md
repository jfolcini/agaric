# Session 2157 — Agenda group headers and the external-link icon

Two things looked broken in dark mode.

In the Agenda, each group header was a filled rounded chip
(`SectionGroupHeader`: `bg-muted/50 rounded`), and the row right under it is
rounded too and tints on the keyboard cursor, which rests on the first row.
In dark mode the two greys are nearly the same, so a header and its first
row read as two boxes notched into each other. The header is now a plain
section label with space above it and no fill. DuePanel and DonePanel use
the same component and change with it.

External links ended in a `↗` text character. Fonts with a colour emoji for
it drew a grey tile, which looked worst on the dark background. It is now
lucide's `ArrowUpRight` SVG in the text colour.

Both were checked by screenshot in the dark and light themes against the
mock backend. The tests that pinned the old fill and the old glyph now pin
the new shapes; each went red against the old code and green against the new.
