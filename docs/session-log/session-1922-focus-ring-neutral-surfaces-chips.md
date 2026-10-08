# Session 1922 — focus ring, neutral surfaces, soft chips (#5332 items 1, 2, 6)

The second PR of the #5332 design plan this session. It fixes the contrast
failures the design lead measured, which do not depend on the brand items
(3–5, decided this session and following as their own PR).

What shipped:

- **Focus and selection.** `--ring` is blue (`oklch(0.58 0.17 255)` light,
  `oklch(0.72 0.13 255)` dark; 4.33:1 and 8.13:1 on the page) and painted
  opaque everywhere it marks focus: `focus-ring-visible`, chip focus,
  `.embed-container`, `list-cursor`, `block-selected` (now a blue tint with an
  inset ring). The old half-alpha red ring was 2.61:1 / 2.20:1. High contrast
  got its own blue rings. `focus-ring-soft` existed only because the red ring
  read as an alarm; it and its consumers' uses are deleted. The unused
  `--sidebar-ring` is deleted.
- **Neutral surfaces.** `--accent` and `--sidebar-accent` lost their brand-red
  tint in the default light and dark themes. `.search-result-mark` uses the
  existing `--status-pending` pair instead of `--accent`.
- **Active nav item.** The maintainer saw the Settings rail's active tab (a
  red-tinted pill with a red bar against its rounded edge) and chose a neutral
  pill with no bar, for the rail and the app sidebar alike — this supersedes
  the issue's "the sidebar keeps its 3px red active bar". Review then found
  the bar had been the only thing separating active from hover: both painted
  the same `sidebar-accent` fill. Active now keeps the full fill (light
  `--sidebar-accent` darkened to 0.93) and hover paints half of it;
  `e2e/nav-active-item.spec.ts` asserts hover and active fills differ in both
  places, light and dark, and went red with the old hover class.
- **Priority and date chips.** P1/P2/P3 are soft tints with one foreground
  token per level in every theme (5.4–10.1:1 measured across the six themes,
  with and without high contrast); `--priority-foreground` is deleted. Due and
  scheduled chips are neutral (`secondary`) and told apart by their icons;
  only overdue and today keep a hue. Solarized Light's
  `--alert-error-foreground` darkened 0.55 → 0.5 because its overdue chip was
  4.05:1.

`theme-contrast.test.ts` now reads every theme through the real cascade (high
contrast, theme block, `.dark`, `:root`) and checks ring, chip and accent pairs
for all six themes, with and without high contrast.

Two container restarts earlier in the session did not touch this work, which
ran in its own worktree. A builder, then a separate reviewer, then the
orchestrator's hover fix; every new assertion was shown red against a mutated
copy and restored.

Verified: `npm run typecheck` clean; full vitest 870 files, 20 642 passed,
1 expected fail, 51 skipped (reviewer run, before the hover fix); after the
hover fix the touched suites (48 files, 1 073 tests) and the new nav spec pass.
Playwright: the chip, focus, layout, settings and every priority-touching spec
(292 passed, 2 skipped across the reviewer's batches).

Left for the maintainer: `AGENTS.md`'s mandatory-pattern line still says
`focus-visible:ring-ring/50`, the half-alpha ring this PR removes; new code
following it would paint the failing ring. It should point at
`focus-ring-visible`.
