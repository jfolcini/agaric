# Session 4540 — #7155 R10, R15, R16, R17, R19: toast width, disabled primary, icon optics, muted menu hints, phone segments

Round 2 of the UI review (#7155), five agreed fixes in shared primitives.

**What shipped**

- **R15 (phone):** a toast left room for the capture button even when the button was hidden.
  - The `index.css` rule now keeps the offset only under `body:has([data-testid=quick-capture-fab][data-shown=true])`.
  - The builder also excluded modal layers, but that guard could never fire alone: Quick capture's focused field already hides the button. It also misfired under an open dropdown, so the reviewer dropped it.
- **R16:** the default Button lost its `dark:disabled:` override (muted fill and text). A disabled primary is now the primary at the base 50% opacity, in both themes.
- **R17:** a leading icon's box carries whitespace, so "+ Create" read right of centre.
  - Button and Badge mark `data-leading-icon` when an icon is followed by bare text, and a base class pulls that icon 2 px into the start padding (`-ms-0.5`).
  - Plain CSS cannot see a text node, and a `has-[>svg:first-child]` padding would have fought the 17 callers that set their own `px`.
  - The bare-text condition keeps icon-only, sr-only-labelled and chevron-only buttons untouched; the first cut moved the phone hamburger 1 px off the gutter. `AddBlockButton`'s hang went from `-ml-3` to `-ml-2.5`.
- **R19:** `Kbd` gains a `muted` tone (no keycap, muted text). The block menu, page menu, toolbar rows, table menu and palette action menu use it. The Shortcuts sheet, tooltips and pickers keep keycaps.
- **R10 (phone):** a `ToggleGroup` of up to four segments grows into equal segments on `useIsTouch() && usePhoneLayout()`.
  - It uses `grow`, not `w-full`, so a group sharing a row (Advanced query's All/Any between two ⓘ) fills only what its siblings leave.
  - The references panel's kind row got `coarse:mt-2`, so the spanning segments' hit areas clear the source-page filter.

**Tests**

- `primitive-optics.spec.ts`: a disabled primary keeps the primary fill; a leading icon is pulled into its padding while an icon alone stays centred; menu hints are muted text.
- `phone-bottom-sheets.spec.ts`: a toast spans the gutters while the button hides.
- `page-editor-polish.spec.ts`: segments are equal on a phone and hug on desktop, and the 44 px target holds. `advanced-query-layout.spec.ts`: All/Any stays on its row.
- Each test was shown red by the builder or the reviewer, with the predicted assertion. The reviewer's run of 74 phone, menu, toast, toolbar, settings and page-editor specs passed (424 tests).
- The reviewer left the Graph depth picker's offset, SpaceSwitcher's keycaps and a toast covering the phone Quick capture sheet's buttons (older than this branch) to the batched follow-up.
