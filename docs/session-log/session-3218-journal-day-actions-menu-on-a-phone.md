# Session 3218 — The journal day's switch moves into a Page actions menu on a phone

#6220 put a page's *Blocks | Page* switch into its *Page actions* menu on a phone, because the header row had no room. The journal Daily view kept its switch inline, so on a phone it wrapped onto a row of its own under the day's actions. The maintainer asked for a menu there too.

**What changed**
- `DayPageEditor`: on a phone (`useIsTouch() && useIsMobile()`) the day's row ends in a *Page actions* trigger opening a `MenuSheet` that holds `EditModeItem`; choosing the row closes the sheet and switches the day. Desktop and touch tablets keep the inline switch.
- `PageHeaderMenu` exports `MENU_ITEM_CLASS` so the row looks like the page's; `PageHeaderMenu` itself is not reused, because its rows are page-only (undo, outline, aliases, templates, export…).
- Comments and the feature docs that said where the day's switch sits.

**Decisions and traps**
- At 390 px the row (*Open in page editor*, bookmark, delete, *Page actions*) fits one line, so *Open in page editor* stays a button.
- A mode chosen with the switch is not remembered after leaving the view: the day reopens as the *Edit pages as* setting says, on every device and before this change too. The e2e switches both ways instead of navigating away and back.

**Red first**
- the phone check keyed on touch alone (a touch tablet lost its inline switch);
- the sheet left open after choosing;
- the phone branch off, in vitest and in the e2e (the switch wrapped 55 px under the row).

**Suites:** vitest over `src/components/journal`, `src/components/pages`, `src/editor/page-mode`, `src/components/mobile`; typecheck, lint, the manual-stage hooks; Playwright `page-mode-touch`, `page-mode`, `page-mode-setting`, `page-kebab`, every `journal-*`, `app-chrome`, `mobile-overflow` and the phone layout specs. The whole Playwright and WebdriverIO lanes are CI's.
