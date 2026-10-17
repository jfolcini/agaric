import type { Page } from '@playwright/test'

import { activePopover, expect, openPage, submitSearch, test, waitForBoot } from './helpers'

/**
 * E2E — the Search view's controls below the history dropdown take a single
 * click while the dropdown is open. Pressing one blurred the search input, the
 * blur closed the dropdown, and everything below it moved up under the
 * pointer, so the release landed elsewhere and no click fired. A press across
 * a layout shift happens only in a real browser, and the panel is frontend
 * state, so the mock-backed build can show it failing.
 */

const pageTitle = (page: Page) => page.locator('[aria-label="Page title"]')
const searchInput = (page: Page) => page.getByRole('combobox', { name: 'Search blocks' })
const historyDropdown = (page: Page) => page.getByTestId('search-history-dropdown')

function recentCard(page: Page, title: string) {
  return page
    .getByRole('list', { name: 'Recent' })
    .getByRole('button', { name: title, exact: true })
}

async function goToSearch(page: Page) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Search', exact: true })
    .click()
  await expect(page.getByTestId('header-label')).toContainText('Search')
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await openPage(page, 'Quick Notes')
  await goToSearch(page)
  await submitSearch(page, 'welcome')
  await searchInput(page).fill('')
  await expect(historyDropdown(page)).toBeVisible()
})

test('one click on a Recent card opens its page while search history shows', async ({ page }) => {
  await recentCard(page, 'Getting Started').click()
  await expect(pageTitle(page)).toHaveText('Getting Started')

  // Back on Search the input focuses itself, so the dropdown is open again.
  await goToSearch(page)
  await expect(searchInput(page)).toBeFocused()
  await expect(historyDropdown(page)).toBeVisible()
  await recentCard(page, 'Quick Notes').click()
  await expect(pageTitle(page)).toHaveText('Quick Notes')
})

test('one click on Add filter opens it while search history shows', async ({ page }) => {
  await page.getByRole('button', { name: 'Add filter' }).click()
  await expect(activePopover(page)).toBeVisible()
})

test('one click on a chip remove or Clear all lands while a history recall shows', async ({
  page,
}) => {
  const input = searchInput(page)
  await submitSearch(page, 'welcome path:Projects/* path:Meetings/*')
  const chipBar = page.getByRole('group', { name: 'Filters active' })
  const removeButtons = chipBar.getByRole('button', { name: /^Remove filter / })
  // ArrowUp on the empty input recalls the newest entry and keeps the dropdown open.
  const recall = async () => {
    await input.fill('')
    await input.press('ArrowUp')
    await expect(historyDropdown(page)).toBeVisible()
    await expect(removeButtons).toHaveCount(2)
  }

  await recall()
  await chipBar.getByRole('button', { name: 'Remove filter path:Meetings/*' }).click()
  await expect(removeButtons).toHaveCount(1)
  await expect(removeButtons).toHaveAccessibleName('Remove filter path:Projects/*')

  await recall()
  await chipBar.getByRole('button', { name: 'Clear all' }).click()
  await expect(removeButtons).toHaveCount(0)
  await expect(input).toHaveValue('welcome')
})
