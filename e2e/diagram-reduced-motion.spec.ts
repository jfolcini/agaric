/**
 * #5692 — Mermaid measures its labels while laying a diagram out, so any
 * transition the reduced-motion reset adds to its nodes makes it measure a
 * mid-transition size and draw the diagram several times too large.
 */
import type { Page } from '@playwright/test'

import { expect, openPage, seedSearchBlocks, test, waitForBoot } from './helpers'

const FLOWCHART =
  '```mermaid\ngraph TD\n  A[Capture idea] --> B{Worth doing?}\n  B -->|yes| C[Plan it]\n  B -->|no| D[Archive]\n  C --> E[Do it] --> F[Review]\n```'

/** The diagram's natural size, as Mermaid laid it out. */
async function renderedSize(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await waitForBoot(page)
  await seedSearchBlocks(page, [{ content: FLOWCHART }])
  await openPage(page, 'Projects')
  const svg = page.locator('[data-testid="mermaid-diagram"] svg')
  await expect(svg).toBeVisible()
  return svg.evaluate((el) => {
    const { width, height } = (el as SVGSVGElement).viewBox.baseVal
    return { width, height }
  })
}

for (const [label, reduce] of [
  ['the OS setting', (page: Page) => page.emulateMedia({ reducedMotion: 'reduce' })],
  [
    'Animations "Off"',
    (page: Page) => page.addInitScript(() => localStorage.setItem('agaric-motion', 'off')),
  ],
] as const) {
  test(`a flowchart renders at the same size with reduced motion from ${label}`, async ({
    page,
  }) => {
    const normal = await renderedSize(page)
    await reduce(page)
    const reduced = await renderedSize(page)
    expect(Math.abs(reduced.width - normal.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(reduced.height - normal.height)).toBeLessThanOrEqual(1)
  })
}
