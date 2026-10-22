/**
 * E2E — a desktop window below the phone breakpoint, with a mouse and no
 * touch. Only a touch phone drops the tab bar, the tab shortcuts and the
 * header's date controls; a half-tiled window keeps them (#6053).
 */

import type { Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

async function chord(page: Page, key: string): Promise<void> {
  await page.keyboard.down('Control')
  await page.keyboard.press(key)
  await page.keyboard.up('Control')
}

test.describe('A narrow mouse window @pages @journal', () => {
  test.use({ viewport: { width: 700, height: 900 } })

  test('keeps the tab bar and its shortcuts', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    await page.getByText('Getting Started', { exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
    const tabs = page.getByRole('tab')

    await chord(page, 't')
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    await chord(page, 'Tab')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')

    await chord(page, 'w')
    await expect(page.getByRole('tablist')).toHaveCount(0)
  })

  test('keeps the header’s Today, Agenda and calendar', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    const header = page.locator('header').first()
    await expect(header.getByRole('button', { name: 'Go to today', exact: true })).toBeVisible()
    await expect(
      header.getByRole('button', { name: 'Open calendar picker', exact: true }),
    ).toBeVisible()

    await header.getByRole('button', { name: 'Go to agenda', exact: true }).click()
    await expect(page.getByTestId('journal-header')).toBeVisible()
  })
})
