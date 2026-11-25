# Session 4421 — UI review on phone and desktop, and the first design-system step for mobile

**Ask.** Review every view, component and state on a phone and on a desktop, with data and from screenshots, against "modern, sleek, pleasant, intuitive". File the review as an issue and prepare the design system to work on mobile.

**Review.** Playwright on the e2e build and its mock (a Pixel 7 user agent at 412 × 915, desktop at 1440 × 900, light and dark), plus a seeded rich page, captured 348 screens. The findings are #7040: colour roles that share hues, five task-row layouts, one grey chip for every meaning, chrome stacked above content, keyboard affordances shown without a keyboard, dark popovers on cards of the same colour, and the mobile design-system gaps (M1–M10). The capture script was not committed: nothing would run it, so it would rot.

**Shipped.**
- **Sheets.** Every bottom sheet has the `xl` radius on its top edge and a 44 px grab handle; a pull down on the handle closes the sheet through the Root's `onOpenChange` (`Sheet` passes it down by context). The search sheet's own handle and `usePullToDismiss` wiring are gone; its i18n key went with them. A bottom sheet's close button shares the handle's strip.
- **Breakpoint.** The sheet and `SheetBody` gutter switch at `md`, where `useIsMobile` stops picking sheets. They used to switch at `sm`, so from 640 to 767 px a sheet's text sat 24 px in while the view's sat at 16 px. `Card`'s section variant still drops its box at `max-sm`, matching Settings' rail, which also appears at `sm`; that is #7040 M3.
- **Pressed fill.** List rows, popover menu rows, the page menu's rows and the block menu's rows fill with `--accent` while pressed: tap highlight is off and `hover:` never fires on touch. `ContextMenuItem` was left alone: it only renders where tabs exist, never on a phone.
- **Icons.** Icon-size buttons draw a 20 px glyph on a coarse pointer. 24 icons inside icon buttons that restated the default 16 px (`h-4 w-4`) lost the class, so they follow the button; icons pinned smaller on purpose keep their size. The header's hamburger, its sync dot and the search trigger moved their negative margins so the glyph stays on the 16 px gutter.

**Trap.** `sheet.test.tsx` pinned square corners on every side, against `docs/UX.md`'s modal radius tier for sheets. Only a bottom sheet has a free edge on screen; the other sides stay square.

**Ran:**
- `npm run typecheck`; `npx oxlint src/components e2e`.
- `npx vitest run` over every touched component folder (`ui`, `mobile`, `journal`, `history`, `pages`, `graph`, `rendering`, `settings`, `filters`, `common`, `SearchPanel`, the block menu).
- Playwright on the mock, on the related phone, sheet and menu specs: `phone-*`, `mobile-*`, `search-sheet-mobile`, `touch-*`, `pairing-sheet-phone`, `settings-phone`, `new-page-dialog`, `list-rows-phone`, `android-phone`, `icon-button-sizes`, `block-history-sheet`, `property-list-drawer`, `keyboard-shortcuts`, `page-kebab`, `menus-popovers`, `due-panel-reschedule-touch`, `toolbar-touch-labels`, `graph-view`, `journal-monthly`, `page-outline`, `history-keyboard`, `formatting-toolbar-mobile`, `sync-ui`.
- **Shown red:**
  - each new unit test, with the handle unwired, the radius gone and the gutter back at `sm`;
  - each new e2e test, with the glyph rule, the radius, the gutter, the handle wiring and the pressed fill of the first (`PopoverMenuItem`) and last (`ListItem`) rows reverted.
