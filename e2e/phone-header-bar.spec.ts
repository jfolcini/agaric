/**
 * E2E — the phone header bar and the pinned formatting toolbar (#5926): on a
 * touch phone every control in them is a 44 × 44 target, clear of the bar's
 * top and bottom edges and of its neighbours, on one row; the hamburger's
 * icon sits on the 16 px content edge.
 */

import { devices, type Locator } from '@playwright/test'

import { expect, focusBlock, navigateToView, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']
const TARGET = 44
const CLEAR = 4

/** Every way a bar's visible controls break the rules above, as readable lines. */
function layoutViolations(bar: Locator): Promise<string[]> {
  return bar.evaluate(
    (el, { target, clear }) => {
      const style = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      const top = box.top + parseFloat(style.borderTopWidth)
      const bottom = box.bottom - parseFloat(style.borderBottomWidth)
      const controls = [...el.querySelectorAll('button, a[href], input, [role="tab"]')]
        .filter((c) => {
          const r = c.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && c.closest('[aria-hidden="true"]') === null
        })
        .map((c) => ({
          name: c.getAttribute('aria-label') ?? c.textContent?.trim() ?? c.tagName,
          r: c.getBoundingClientRect(),
        }))
        .sort((a, b) => a.r.left - b.r.left)
      const out: string[] = []
      if (controls.length === 0) out.push('no controls found')
      const centre = (top + bottom) / 2
      controls.forEach(({ name, r }, i) => {
        if (r.width < target - 0.5 || r.height < target - 0.5) {
          out.push(`${name}: ${r.width}×${r.height}`)
        }
        if (r.top - top < clear) out.push(`${name}: ${r.top - top}px below the top edge`)
        if (bottom - r.bottom < clear) out.push(`${name}: ${bottom - r.bottom}px above the bottom`)
        if (Math.abs(r.top + r.height / 2 - centre) > 1) out.push(`${name}: off the bar's one row`)
        const prev = controls[i - 1]
        if (prev && r.left - prev.r.right < clear) {
          out.push(`${prev.name} → ${name}: ${r.left - prev.r.right}px apart`)
        }
      })
      return out
    },
    { target: TARGET, clear: CLEAR },
  )
}

const VIEWS = ['Pages', 'Settings', 'Search', 'History', 'Advanced Query'] as const
const JOURNAL_MODES = ['Day', 'Week', 'Month', 'Stream', 'Agenda'] as const

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
]) {
  test.describe(`phone header bar at ${viewport.width} × ${viewport.height} @mobile @journal @pages @search @editor`, () => {
    test.use({
      viewport,
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: iPhone13.deviceScaleFactor,
      userAgent: iPhone13.userAgent,
    })

    test('the journal header fits its controls in every mode', async ({ page }) => {
      await waitForBoot(page)
      const header = page.locator('header').first()
      const hamburgerIcon = page.getByTestId('mobile-sidebar-trigger').locator('svg')
      expect((await hamburgerIcon.boundingBox())?.x).toBe(16)
      for (const mode of JOURNAL_MODES) {
        await header.getByRole('button', { name: /^Journal view mode/ }).click()
        await page.getByRole('button', { name: mode, exact: true }).click()
        await expect(header.getByRole('button', { name: `Journal view mode: ${mode}` })).toBeVisible()
        expect(await layoutViolations(header), `journal ${mode}`).toEqual([])
      }
    })

    for (const view of VIEWS) {
      test(`the ${view} header fits its controls`, async ({ page }) => {
        await waitForBoot(page)
        await navigateToView(page, view)
        const header = page.locator('header').first()
        await expect(header.getByTestId('header-label')).toBeVisible()
        expect(await layoutViolations(header), view).toEqual([])
      })
    }

    test('the pinned formatting toolbar fits its controls', async ({ page }) => {
      await waitForBoot(page)
      await focusBlock(page, 0)
      const toolbar = page.getByTestId('formatting-toolbar')
      await expect(toolbar).toHaveAttribute('data-pinned', 'true')
      expect(await layoutViolations(toolbar)).toEqual([])
    })
  })
}
