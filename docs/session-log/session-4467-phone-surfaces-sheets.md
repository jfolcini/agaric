# Session 4467 — phone surfaces: popovers with inputs open as sheets, the last centred dialogs become sheets, and the phone's menus are menu sheets

Part of the #7040 UI review, items M8, M9 and S13, on the phone rule from #7088 (`usePhoneLayout()`).

**What shipped**

- **A sheet mode on `Popover`.** `ui/popover.tsx` takes `sheetTitle`. On a phone an opted-in popover renders a bottom `Sheet` titled `sheetTitle`: `PopoverTrigger` becomes `SheetTrigger`, `PopoverAnchor` renders only its children, and `PopoverContent` renders `SheetContent` with the popover's classes on an inner body, their width, height cap, padding and overflow reset.
  - A plain popover nested inside a sheet one stays anchored.
  - Only opted-in popovers call `usePhoneLayout`.
  - The anchored form is exported as `AnchoredPopoverContent`.
  - The bottom sheet sits on the layout viewport, which on Android ends at the keyboard (#216).
- **Opted in:** `PageTagSection`, `TagComposer`, `SelectEditor`'s options (stacked over the properties sheet), `RefEditor`, the Pages and Advanced query `AddFilterPopover`, the agenda's add and edit filter, `FilterHelperPopover`, `GraphFilterBar`, `SourcePageFilter`, `HasTagFilterForm`, `PeerListItem`, `ImageBubbleMenu` and the selection bubble's link editor.
- **One mechanism.** `AddPropertyPopover` and the due-date chip lose their hand-rolled touch sheets and follow `usePhoneLayout` like the rest, so a wide touch tablet now gets their anchored popover, as it does every other phone surface.
- **Dialogs.** `VoiceNoteDialog`, `MeetingDialog` and `PageSourceConflictDialog` use `useDialogOrSheet('dialog')`; `MeetingDialog`'s fields scroll in a body so its buttons stay in view. `DiagnosticsCollector`'s log preview is a sheet over the bug-report sheet.
- **Menus.** On a phone the toolbar's More (also Edit as Markdown's toolbar), the Pages ⋮ (`SavedViewsDropdown`) and the space switcher are `MenuSheet`s. The editor keeps focus after a More row acts.
- **The first Escape closes the page tag picker.** `PageHeader`'s `tagPickerForcedRef` suppressed an immediate close that no longer happens, so after ⋮ → Add tag the first Escape did nothing, on desktop too. The suppression is gone.
- **Docs.** `docs/UI-MAP.md`'s "No Sheet ↔ Popover viewport swaps" line, `docs/UX.md`'s phone rule and the phone line in `docs/FEATURE-MAP.md` say the one rule.

**False premises in the issue**

- `TagList`'s popover holds no text input: it is swatches and a native colour input. It stays anchored.
- The theme Select is not clipped on a phone: at 412 px its list sits inside the gutters. It stays a Select.
- The two hand-rolled sheets keyed on `useIsTouch`, not on M1's predicate.

**Left as popovers:** short menus with no input outside S13's list (the journal view mode, agenda sort and group, the query column picker, copy definition to space, the query board menus).

**Tests**

- e2e `phone-bottom-sheets`: on a 412 × 915 touch phone, the tag picker, the Pages filter, the options editor, the toolbar's More, the Pages ⋮, the voice-note dialog and the space switcher open from the bottom edge, and the tag picker closes on the first Escape. At 1440 × 900 the same controls stay anchored, and the tag picker closes on the first Escape there too.
- vitest: `popover` sheet mode (four cases with axe, including the nested popover that stays anchored and the body reset), `SpaceSwitcher` on a phone.
- Each was shown red by a mutation: sheet mode never on, always on, each call site's switch turned off, the old `PageHeader`, no context reset, no body reset.
- Edited to the new surfaces: `mobile-a11y-216` and `AddPropertyPopover` (phone, not touch), `AppSidebar` (the switcher is a button on a phone), `phone-touch-targets`, `formatting-toolbar-mobile`, `navigateToView` (the Pages ⋮ by test id), and the UI-review tour's switcher steps. `BlockListItem`'s coarse-pointer date-sheet test is deleted: that file mocks the popover module, and the cap stays pinned in `AddPropertyPopover` and `mobile-a11y-216`.
