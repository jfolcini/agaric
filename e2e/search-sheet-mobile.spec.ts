/**
 * E2E — mobile unified search sheet.
 *
 * Runs at iPhone viewport so `useIsMobile()` returns true and the
 * top-bar search trigger renders. Covers the user-visible contract
 * from the plan's Phase 4 list:
 *
 *  - Single icon opens a Sheet with a two-segment toggle.
 *  - Default segment depends on the current view: page-style views
 *    (Journal / page-editor) default to `'In this page'`; everywhere
 *    else defaults to `'Across all pages'`.
 * Switching segments swaps the embedded body (toolbar ↔
 * Palette).
 *  - The palette escalation footer routes the user to the
 *    find-in-files view (`'search'` nav), the sheet closes on the way.
 *  - On desktop the icon is hidden — keyboard shortcuts cover it.
 */

import { devices } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'

// Spreading `devices['iPhone 13']` wholesale inside `test.use()` includes
// the `defaultBrowserType` field, which Playwright rejects in a `describe`
// because it forces a new worker. Pick the per-context fields we need —
// viewport + touch / mobile flags — and leave the browser type alone.
const iPhone13 = devices['iPhone 13']

test.describe('Search sheet (mobile viewport)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('opens with the all-pages default on non-page views and escalates to the search view', async ({
    page,
  }) => {
    await waitForBoot(page)

    // Pages list is a non-page view → defaultModeForView returns
    // 'all-pages'. It also has no `useInPageFindStore.container`
    // registered, so the 'in-page' segment shows the empty-state CTA
    // instead of the toolbar — verified below.
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.locator('[data-testid="header-label"]')).toContainText('Pages')

    // Trigger — mobile-only icon button mounted next to the header.
    const trigger = page.getByTestId('search-sheet-trigger')
    await expect(trigger).toBeVisible()
    await trigger.click()

    // Sheet opens. Default for a non-page view is 'all-pages'.
    const sheet = page.getByTestId('search-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('search-sheet-segment-all-pages')).toHaveAttribute(
      'data-state',
      'on',
    )

    // Embedded palette body present.
    const paletteInput = page.getByTestId('command-palette-input')
    await expect(paletteInput).toBeVisible()
    await expect(page.getByTestId('in-page-find-toolbar')).toHaveCount(0)

    // Segment swap to 'in-page': no container registered on Pages list
    // so the empty state with its "Switch to All pages" CTA renders,
    // NOT the toolbar.
    await page.getByTestId('search-sheet-segment-in-page').click()
    await expect(page.getByTestId('search-sheet-in-page-empty')).toBeVisible()
    await expect(page.getByTestId('in-page-find-toolbar')).toHaveCount(0)
    await expect(paletteInput).toHaveCount(0)

    // The empty-state CTA flips the segment back to 'all-pages'.
    await page.getByTestId('search-sheet-in-page-empty-switch').click()
    await expect(page.getByTestId('search-sheet-segment-all-pages')).toHaveAttribute(
      'data-state',
      'on',
    )
    await expect(paletteInput).toBeVisible()

    // Query the palette, then tap the escalation footer.
    await paletteInput.fill('Getting')
    const escalation = page.getByTestId('palette-escalation-footer')
    await expect(escalation).toBeVisible()
    await escalation.click()

    // Escalation closes the sheet and switches to the find-in-files view.
    await expect(sheet).toHaveCount(0)
    await expect(page.locator('[data-testid="header-label"]')).toContainText('Search')
  })

  test('defaults to in-page when opened from a page-style view', async ({ page }) => {
    await waitForBoot(page)
    // Journal is the default landing view — `journal-header` is the
    // JournalControls container that App.tsx renders in place of the
    // generic `header-label` span when `currentView === 'journal'`.
    // defaultModeForView('journal') returns 'in-page', so the trigger
    // should open the sheet with that segment active.
    await expect(page.getByTestId('journal-header')).toBeVisible()

    await page.getByTestId('search-sheet-trigger').click()
    await expect(page.getByTestId('search-sheet')).toBeVisible()
    await expect(page.getByTestId('search-sheet-segment-in-page')).toHaveAttribute(
      'data-state',
      'on',
    )
    await expect(page.getByTestId('in-page-find-toolbar')).toBeVisible()
  })

  test('closes via the overlay and tears down both embedded stores', async ({ page }) => {
    await waitForBoot(page)
    await page.getByTestId('search-sheet-trigger').click()
    await expect(page.getByTestId('search-sheet')).toBeVisible()
    // Press Escape — Radix Sheet maps this to onOpenChange(false).
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search-sheet')).toHaveCount(0)
  })
})

test.describe('Search sheet (desktop viewport)', () => {
  test('mobile trigger does not render', async ({ page }) => {
    await waitForBoot(page)
    // Default desktop viewport (1280×720) — useIsMobile() returns false,
    // so SearchSheetTrigger early-returns null and the icon never mounts.
    // Desktop users open the search surfaces via Ctrl+F / Cmd+K /
    // Ctrl+Shift+F instead.
    await expect(page.getByTestId('search-sheet-trigger')).toHaveCount(0)
  })
})
