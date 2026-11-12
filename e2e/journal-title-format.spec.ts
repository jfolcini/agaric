/**
 * A journal page's title follows Settings › General › Journal date format
 * outside the journal too (#6544): in the `[[` picker and in a list's source
 * link. Only the display changes: the picker still finds the day by its stored
 * `YYYY-MM-DD` title, and the link it inserts names that page.
 *
 * The preference is localStorage-backed and the seed's journal page is
 * titled with today's date, so the mock-backed build shows the whole effect.
 * The clock is pinned so that page is 2026-06-17.
 */

import type { Page } from '@playwright/test'

import {
  activeSuggestionList,
  chooseSelectOption,
  expect,
  focusBlock,
  navigateToView,
  openPage,
  openSettingsTab,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

const NOW = new Date('2026-06-17T12:00:00')
const SHOWN = '17/06/2026'

async function chooseSlashFormat(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'General')
  await chooseSelectOption(page, 'Journal date format', 'DD/MM/YYYY (e.g. 17/06/2026)')
}

test.describe('journal titles in the journal date format outside the journal @settings @journal @editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW })
    await waitForBoot(page)
    await chooseSlashFormat(page)
  })

  test('the [[ picker shows the day in the format and finds it by its stored date', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[2026-06', { delay: 30 })

    const items = activeSuggestionList(page).getByTestId('suggestion-item')
    await expect(items.filter({ hasText: SHOWN })).toHaveCount(1)
    await expect(items.filter({ hasText: '2026-06-17' })).toHaveCount(0)

    await items.filter({ hasText: SHOWN }).click()
    await saveBlock(page)
    // The chip in block text keeps the stored title, as the page's own text does.
    await expect(
      page.locator('[data-testid="block-static"] [data-testid="block-link-chip"]', {
        hasText: '2026-06-17',
      }),
    ).toHaveCount(1)
  })

  test('the Agenda source link shows the day in the format', async ({ page }) => {
    await navigateToView(page, 'Journal')
    await page.getByRole('tab', { name: 'Agenda view' }).click()

    const row = page.getByTestId('agenda-results-item').filter({ hasText: 'Buy groceries' })
    await expect(row.getByRole('link', { name: SHOWN })).toBeVisible()
  })
})
