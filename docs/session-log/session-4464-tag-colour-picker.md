# Session 4464 — a sleek tag colour picker

The maintainer asked for a better tag colour picker, "something from Radix like the rest". The old popover had:
- a 4 + 3 grid of preset circles;
- a native `<input type="color">` for custom colours (#1099), which opened an unstyled OS dialog;
- a full-width "Clear color" text button.

**Radix has no colour picker.** Weekly npm downloads on 2026-11-25:
- react-colorful: 9.1M (no dependencies, last release 2026-09-01);
- react-aria-components: 9.2M (a second component system);
- @uiw/react-color: 230k;
- react-color: 2.7M (unmaintained);
- the one Radix-based picker found: 7.

Most shadcn/Radix pickers wrap react-colorful, so the maintainer chose it.

**The new popover.**
- **Presets.** `src/components/ui/color-swatch-picker.tsx` puts the presets in a Radix ToggleGroup, one row exposed as a radiogroup.
  - Arrow keys move focus only; Enter, Space or a click picks. A pick saves, so selecting on focus would write a colour per arrow press.
  - The selected swatch gets a ring rather than a check: no single check colour reads on every accent.
  - A "no colour" circle sits after a separator. It is disabled, not hidden, when the tag has no colour, so the row does not shift.
- **Custom colour.** A "Custom color" disclosure holds react-colorful's `HexColorPicker`, a preview swatch and our `Input` for the hex.
  - The picker saves on its `onChangeEnd` (pointer up, or the arrow key's keyup), never per drag frame.
  - The field accepts `#rgb` / `#rrggbb` with or without `#` and saves on Enter, or on blur after an edit. Invalid input shows an error and is not saved.
  - A custom save keeps the popover open. The close moved out of `useTagColors.setColor` / `clearColor` into TagList's preset and clear handlers.
- **Styling.** react-colorful injects its `<style>` at runtime. The app CSP allows inline styles, and Radix's scroll lock already injects one. An unlayered block in `src/index.css`, keyed on react-colorful's classes, restyles it to our radii, borders and focus ring.
- **Accessible name.** The popover's dialog was nameless before; it is now "Set tag color".
- **i18n.** Two new keys in all five locales; `customColorLabel` now labels the disclosure.

**From review.** On a 360 px phone the row overflowed and cut the "no colour" button in half, because 32 px touch swatches did not fit the popover's `100vw - 2rem` cap. The swatches now stay 28 px on touch screens, and `touch-hit-area` still gives each one a 44 px target.

**Not changed:** `HighlightColorPicker`. Its swatches must not take focus from the editor, its "default" swatch is a real choice rather than a clear, and it uses toolbar styling.

**Ran:**
- vitest on the picker, TagList, TagsView, useTagColors, HighlightColorPicker and `src/lib/i18n`: 193 passed.
- `npm run typecheck`, oxlint, oxfmt, and the pre-commit hooks on the changed files.
- The new mock-lane spec `e2e/tag-custom-color.spec.ts`.
- The two edited bridge specs on a locally built bridge: 3 passed.
- Each new test was shown red under a mutation of the code it covers.
