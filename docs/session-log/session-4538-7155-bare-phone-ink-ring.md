# Session 4538 — #7155 R5, R9, R12: a bare phone draws no keyboard UI or rings; the ring is an ink outline

Round 2 of the UI review (#7155).
- The maintainer saw keyboard hints and focus rings in the phone shots of the #7040 report.
- They also found the blue ring foreign in the warm default theme.

**What shipped**

- **R12: no rings on a bare phone.**
  - `useHasHardwareKeyboard`'s latch now writes `<html data-keyboard>`.
  - A `bare-touch` custom variant (`[data-touch]:not([data-keyboard])`) removes the ring in the ring utility itself, so no component changed.
  - A focused text field keeps `focus-visible:border-ring`, so it still shows which field is focused.
  - The first hardware keydown brings rings back. The desktop is never `data-touch`.
- **R9: the tour shoots a bare phone.**
  - The keyboard hints in the phone shots were the tour's doing. Escape, End and typed keys are trusted keydowns, and they latched the probe.
  - The phone profile now enters text with `insertText`, places the caret without End, and dismisses layers by tapping.
  - The shortcuts shot is desktop-only, since a bare phone cannot open that sheet.
  - The shooter fails a phone shot if `<html>` has `data-keyboard`.
- **R5: the default theme's ring is ink.**
  - `--ring` follows `--primary`, as every other theme already does.
  - An ink ring flush against an ink fill disappears, so the maintainer chose to draw rings as a 3 px outline with a 2 px transparent `outline-offset`.
  - Rows and clipping boxes use `-outline-offset-3`; the Pages row title uses offset 0, because an inset outline covered its first letter.
  - `focus-outline` was folded into `focus-ring-visible`.
  - The high-contrast block's `--ring` overrides are gone. They forced a blue ring onto the alternate themes in high contrast.
  - The prefers-contrast global outline moved into `@layer base`, so the utility wins where it is set.
- **Side effect:** block selection, the list cursor's edge bar and drop indicators read `--ring` too, so in the default theme they are ink-tinted rather than blue, as in the other themes.

**Tests**

- `interaction-states.spec.ts` "Focus rings on a bare phone": a tapped field has no outline and an ink border; after a hardware key, the ring returns.
  - Red with the `bare-touch` rule removed.
  - Red with the attribute write removed.
- The ring probes in `interaction-states`, `high-contrast-chip-focus` and `menu-sections` now read the outline (style, width, offset). The maintainer asked for that change; every edited assertion is listed in the PR.
- Tour guard: phone text entry switched back to key presses fails 8 phone shots on the `data-keyboard` check.
- A separate session reviewed the branch:
  - it re-ran every red;
  - it ran 344 ring, theme, contrast, phone and menu e2e tests, all passing;
  - it shot the phone tour, 98 shots with no failures, and no key hints, chips or rings;
  - it screenshotted keyboard focus across six themes;
  - it fixed the stale ring description in `docs/UX.md` and `breadcrumb.tsx`.
- Rings that bypass the utility do not follow the bare-phone rule: the editor row ring, the list cursor's `:has` ring, PropertyChip, PageSourceEditor, PropertyDefinitionsList and the toast close button. A tapped button never matches `:focus-visible`, so none showed in the tour. Left until one does.
- The review bot noticed that moving the prefers-contrast outline into `@layer base` let the image caption field's `outline-none` win, leaving it with no focus cue at all; in normal mode it had none before either. It now uses `focus-ring-visible`, with a class test shown red without it.
