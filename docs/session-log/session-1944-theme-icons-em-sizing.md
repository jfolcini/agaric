# Session 1944 — icons take the theme's color and follow the font size (#5368, #5369)

Icons were plain ink in every theme, and the row controls kept a fixed pixel
size when the user changed the font size.

What shipped:

- `src/index.css`: a `--icon` token. The default theme keeps `currentColor`
  (red marks today and blue is focus, so neither can tint icons); Solarized
  light and dark, Dracula and Nord take their blue or purple, and
  `prefers-contrast: more` puts every theme back on `currentColor`. The
  Solarized light blue is darkened to 0.56 so it clears 3:1 on the active nav
  row.
- `Button` tints the icons of ghost and outline buttons with `text-icon`,
  unless the caller's class sets a text color. The check asks tailwind-merge
  whether `text-icon` survives `cn('text-icon', className)`, so `text-xs` or
  `text-left` keep the tint and `text-destructive` drops it. An icon's own
  `text-*` class always wins. Sidebar nav rows get the same tint.
- `.block-tree` carries the font-size setting, and the row controls (drag
  handle, checkbox, task markers, date chip icons, MIME icons) are sized in
  em, so they scale with the text. Medium is pixel-identical to before; the
  app chrome stays at 1rem.
- e2e: `theme-icons.spec.ts` checks icon colors and contrast in all six
  themes, including the journal date button; `font-size-scaling.spec.ts`
  checks control sizes at Small, Medium and Large.

Verified: the reviewer replaced the builder's `className.includes('text-')`
check, which had left 24 of 305 ghost/outline call sites untinted because
they set only a text size, and showed the change touches exactly those 24.
Falsified on copies (old Solarized blue, tint removed, old heuristic
restored, caller color ignored; all red, restored and `cmp`-checked).
Targeted vitest 784 + 568 passed; typecheck, oxlint and oxfmt clean;
Playwright 25/25 across theme-icons, font-size-scaling, nav-active-item,
block-metadata-row-layout, gutter-control-clicks and journal-block-controls.
