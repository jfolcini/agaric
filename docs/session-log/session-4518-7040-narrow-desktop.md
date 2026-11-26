# Session 4518 — a desktop in a 1024 px window

Part of the #7040 UI review, coverage item C2 (maintainer decision 29).

**What shipped**

- **Settings › Properties' new-property row wraps instead of squeezing.** At 1024 px with the sidebar open, the name box shrank to 55 px, leaving 5 px for text. The name and select-options boxes now keep a floor (`sm:min-w-48`), so the row wraps: name and type on the first line, "Holds several values" and Create on the next. With type `select` the row also wraps at 1280 and 1440, where it used to squeeze both boxes; with type `text` it is unchanged there.
- **The top bar's Search shows its word from 1280 px (decision 29).** Below that it is an icon with its tooltip and accessible name, which frees the header so the Week view's date ("Nov 23 – Nov 29, 2026") shows whole at 1024 px with the sidebar open.

**Reviewed, not defects**

At 1024×768, with the sidebar expanded and as a rail, every view and Settings tab fits with no horizontal scroll and no control off screen: the journal and page headers, the formatting toolbar, the multi-select bar, the agenda's View menu, the graph filters, Trash's header. Sheets, dialogs and the palette fit. The tag-colour popover caps itself to a short window and scrolls inside.

**Left as they are**

Settings' cards are about 520 px wide at 1024 px with the sidebar open (the 736 column less its section rail), so descriptions wrap to several lines. Nothing clips.

**Tests**

- e2e (mock lane): new `narrow-desktop` — the name box fits its placeholder, the select-options box keeps its floor, and the Week date shows whole beside an icon-only Search with the accessible name kept. Each was red on the old code with the predicted assertion.
- Falsified one mutation at a time: each floor removed, and the Search word back from `lg`.
- A separate session reviewed it and added the options-box test and decision 29.
