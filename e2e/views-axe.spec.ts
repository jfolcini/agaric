/**
 * #6528 — every top-level view, measured by axe in a real browser in the light and
 * dark themes. The vitest DOM computes no colours, so this is where a view's
 * contrast and its rendered ARIA are checked as one page.
 */

import {
  expect,
  expectViewLoaded,
  navigateToView,
  runAxe,
  test,
  type TopLevelView,
  VIEW_HEADING,
  waitForBoot,
} from './helpers'

const VIEWS = Object.keys(VIEW_HEADING) as TopLevelView[]

for (const theme of ['light', 'dark'] as const) {
  for (const view of VIEWS) {
    test(`the ${view} view has no axe violations in the ${theme} theme @pages @settings`, async ({
      page,
    }) => {
      // axe reads colours, which a fade in progress makes wrong.
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.addInitScript((t) => localStorage.setItem('theme-preference', t), theme)
      await waitForBoot(page)
      await navigateToView(page, view)
      await expectViewLoaded(page, view)

      const { violations } = await runAxe(page)
      expect(
        violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
      ).toEqual([])
    })
  }
}
