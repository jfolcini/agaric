# Session 2640 — the active page tab joins the page below it

#5924: the desktop tab bar's active tab was a bordered, shadowed pill floating
above the strip, and outside the page editor a grey pill, so it read as a
button rather than a tab.

- **Shape:** the hairline moves from the scroll container to the tablist, and
  every tab sits `-mb-px` on it. The active tab takes the page's
  `bg-background`, has no side or bottom border and no radius, and carries a
  2 px bar on its square top edge, so it opens into the content. The hairline
  could not stay on the scroll container: its viewport clips anything below
  its edge, so the tab could not cover it.
- **Outside the page editor** the active tab keeps that shape with muted text;
  the `sidebar-accent` pill is gone. The three states are one `cva`.
- **Token:** `--tab-indicator` (`var(--primary)`), registered for Tailwind so
  #5920's underline tabs can reuse it. It clears 3:1 against `--background` in
  every theme, now pinned by `theme-contrast.test.ts` (lowest: Solarized
  Light).
- **Focus ring** is drawn inside the tab, which now sits on the clipped edge.

Shown red: the old pill classes on the editing state, a radius on the
outside-editor state, and `--tab-indicator` set to `--border` each failed
their test.

Ran: `vitest run` on the TabBar and theme-contrast tests (299),
`npm run typecheck`, `oxlint src/components/layout`.
