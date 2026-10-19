# Session 2666 — a Tabs primitive with an underline indicator, and the five panel switchers use it

#5920: the controls that switch one panel for another looked like button
groups, and the selected one barely showed (the Journal mode fill was 1.08:1
light, 1.35:1 dark; Query builder and Pair device drew it in the submit
button's primary fill).

- **`ui/tabs.tsx`** wraps Radix Tabs (already in the `radix-ui` package) with
  CVA. `underline`: muted labels on a hairline, the selected tab marked by a
  2 px `--tab-indicator` bar (from #5935) laid over it, square-cornered, 44 px
  tall on touch. `vertical`: the Settings rail's pill look. Radix puts
  `aria-controls` on every tab while mounting only the selected panel, so the
  primitive drops it from unselected tabs.
- **Journal modes:** manual activation (focus doesn't select), the
  hand-written arrow-key and roving-tabindex code deleted; the phone mode menu
  stays. In the header the tab row has no hairline of its own, the header's
  border is the line under it.
- **Edit as Markdown:** full-width tabs over the editor. The Edit panel stays a
  plain `div`, since a Radix panel unmounts when hidden and would lose the
  buffer; selecting Edit focuses the buffer on click, as Radix selects on
  mousedown.
- **Query builder** Simple / Advanced and **Pair device** Scan / Type (manual
  activation, so arrowing onto Scan doesn't start the camera; the Recommended
  badge stays on Scan). The Tag/Property/Backlinks picker is #5921's.
- **Settings rail:** vertical, one tab stop, Up/Down select; it had 12 tab stops
  and no arrow keys.

Indicator contrast against page and dialog backgrounds, pinned in
`theme-contrast.test.ts`: lowest 3.40 (Solarized Light).

Tests: `tabs.test.tsx` (render, click, one tab stop, arrows, Home/End,
manual activation, vertical, axe), a Settings rail keyboard test, pairing
manual activation, and `e2e/journal-mode-tabs.spec.ts`; each shown red by its
predicted assertion. Selectors that change role move to `tab`.

Ran: the full vitest suite, the 52 Playwright specs touching these surfaces
(386), `npm run typecheck`, `npm run lint`. `just e2e-related` selects 212
Playwright and 71 WebdriverIO specs, so CI's run is the check for the rest;
the real-backend specs address these surfaces by ids that are unchanged.
