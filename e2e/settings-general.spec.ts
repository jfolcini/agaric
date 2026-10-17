/**
 * Settings › General: the week start and the journal date format change what
 * the journal shows (#5741).
 *
 * Both preferences are localStorage-backed and read by the journal views, so
 * the mock-backed build shows the whole effect: the weekly view's first day
 * and the daily view's heading. The clock is pinned to a Wednesday so the
 * expected week is fixed.
 */

import type { Page } from '@playwright/test'

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

// Wednesday. A Monday week holds Jun 15-21, a Sunday week Jun 14-20.
const NOW = new Date('2026-06-17T12:00:00')

function dayRegions(page: Page) {
  return page.getByRole('region', { name: /^Journal for / })
}

async function openGeneral(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'General')
  await expect(page.getByTestId('settings-panel-general')).toBeVisible()
}

async function choose(page: Page, combobox: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: combobox }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  await expect(page.getByRole('combobox', { name: combobox })).toHaveText(option)
}

test.describe('Settings › General journal preferences', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW })
    await waitForBoot(page)
  })

  test('week start and date format reshape the weekly and daily views, and persist', async ({
    page,
  }) => {
    // Baseline: the default week starts on Monday.
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    await expect(dayRegions(page)).toHaveCount(7)
    await expect(dayRegions(page).first()).toHaveAttribute('id', 'journal-2026-06-15')

    await openGeneral(page)
    await choose(page, 'Week starts on', 'Sunday')
    await choose(page, 'Journal date format', 'Month D, YYYY (e.g. June 17, 2026)')

    await navigateToView(page, 'Journal')
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const days = dayRegions(page)
    await expect(days).toHaveCount(7)
    await expect(days.first()).toHaveAccessibleName('Journal for June 14, 2026')
    await expect(days.last()).toHaveAccessibleName('Journal for June 20, 2026')

    await page.getByRole('tab', { name: 'Daily view' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('June 17, 2026')

    // Back in Settings, both choices are still the selected values.
    await openGeneral(page)
    await expect(page.getByRole('combobox', { name: 'Week starts on' })).toHaveText('Sunday')
    await expect(page.getByRole('combobox', { name: 'Journal date format' })).toHaveText(
      'Month D, YYYY (e.g. June 17, 2026)',
    )
  })
})
