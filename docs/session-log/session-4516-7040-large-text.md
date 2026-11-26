# Session 4516 — tables and code blocks follow the note text size

Part of the #7040 UI review, coverage item C4 (the largest note text size).

**What shipped**

- **Tables and code blocks follow the note text size.** They were pinned at `text-sm`, so at Large a table cell or a code block read 14 px beside 18 px body text, and at Small they matched the body. A new `@utility text-block-sm` (0.875 × `--agaric-font-size`, the `text-sm` line height) sets the static table cells, the static code block, and the editor's `pre`, `pre code`, `th` and `td`. Medium is pixel-identical; Large reads 15.75 px.
- **A code block's revealed fences** follow it: the `::before` / `::after` fences take `text-block-sm` and their line height, and the room the `pre` leaves for them is that line height, so an edited code block at Large shows 15.75 px fences with their room.
- The size comes from the variable rather than `em`, as headings do, because the list rows that render a block in full (agenda, due and done panels, history) draw it inside `text-sm` chrome, where `em` would shrink a table below the body text at Medium.

**Reviewed, not defects**

At Large, on desktop and a phone: checkboxes, chevrons and grips stay centred on their block's first line; no chip leaves its row; no note content is cropped; no view scrolls sideways. Headings, links, tags, quotes, callout bodies, inline code and list markers already scaled.

**Left as they are**

- Chip text (priority, dates, properties, repeat and reference counts) stays at 12 px while the date chip's icon scales, and the callout label stays at 14 px beside its scaling icon. The maintainer chose to scale both, in a follow-up.
- Agenda and due-panel task rows read at 14 px at every size; the maintainer's call is pending.
- On a phone, a URL's ↗ can wrap alone onto the next line: nothing keeps it with the link's last word.

**Tests**

- e2e (mock lane): `font-size-scaling` gains "a table and a code block keep their ratio to the block text, read and edited" at all three sizes, with the revealed fences and their room. Red on the old code at Small and Large (14 px), Medium passing, as predicted.
- Falsified one mutation at a time: each of the five sites back to `text-sm`, and the fence's room back to `1.25rem`.
- A separate session reviewed it, measured Medium identical in block mode, page mode and the journal on desktop and a phone, and added the fences.
