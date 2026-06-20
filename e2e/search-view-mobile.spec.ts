/**
 * E2E — E2E-A9: the full SearchPanel (find-in-files view) at a
 * mobile viewport.
 *
 * `search-sheet-mobile.spec.ts` covers the mobile search SHEET (the embedded
 * palette). This file covers the FULL search PANEL the user lands on after
 * escalating out of that sheet, verifying the responsive panel actually lays
 * out and FUNCTIONS at an iPhone-width viewport — not just that it mounts.
 *
 * The desktop sidebar is `hidden` below the `md` breakpoint, so the sheet's
 * escalation footer is the real mobile route into this view (the desktop
 * `openSearchView` sidebar click is unreachable here).
 */

import { devices } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'

// Per search-sheet-mobile: spread only the per-context fields — including
// `defaultBrowserType` forces a new worker and Playwright rejects it inside a
// describe.
const iPhone13 = devices['iPhone 13']

test.describe('Search view — full panel at mobile viewport (E2E-A9)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  /** Reach the full SearchPanel via the mobile sheet's escalation footer. */
  async function escalateToSearchView(page: import('@playwright/test').Page) {
    await waitForBoot(page)
    // Land on a non-page view so the sheet defaults to 'all-pages' (palette).
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.locator('[data-testid="header-label"]')).toContainText('Pages')
    await page.getByTestId('search-sheet-trigger').click()
    await expect(page.getByTestId('search-sheet')).toBeVisible()
    const paletteInput = page.getByTestId('command-palette-input')
    await expect(paletteInput).toBeVisible()
    await paletteInput.fill('Review')
    await page.getByTestId('palette-escalation-footer').click()
    // Escalation closes the sheet and switches to the find-in-files view.
    await expect(page.getByTestId('search-sheet')).toHaveCount(0)
    await expect(page.locator('[data-testid="header-label"]')).toContainText('Search')
  }

  test('escalates to the full panel and renders grouped results at iPhone width', async ({
    page,
  }) => {
    await escalateToSearchView(page)

    // The full SearchPanel input is mounted and usable at mobile width.
    const input = page.getByPlaceholder('Search blocks...')
    await expect(input).toBeVisible()
    await input.fill('Review')
    await input.press('Enter')

    const region = page.getByTestId('search-result-region')
    await expect(region).toBeVisible()
    // Same grouped-result contract as desktop — proves the panel FUNCTIONS at
    // a narrow viewport, not merely that it mounts. "Review" matches 3 seed
    // blocks across 2 pages.
    await expect(region.locator('[data-testid^="search-result-group-"]')).toHaveCount(2)
    await expect(region).toContainText(/3 matches in 2 pages/)
  })

  test('a result row navigates to its owning page on mobile', async ({ page }) => {
    await escalateToSearchView(page)
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('Welcome')
    await input.press('Enter')
    const region = page.getByTestId('search-result-region')
    await expect(region).toBeVisible()
    const firstRow = region.locator('[role="option"]').first()
    await expect(firstRow).toBeVisible()
    await firstRow.click()
    // "Welcome…" lives under "Getting Started" — assert the specific landing.
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })
})
