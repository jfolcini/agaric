import type { Locator, Page } from '@playwright/test'

import { activeAlertDialog, expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * E2E — deleting a page, or moving it to another space, drops it from every editor tab, not
 * only the active one.
 *
 * Seed data (tauri-mock): "Getting Started" and "Quick Notes" are pages.
 */

function tabs(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
}

/** Every page title held by a persisted tab stack, across every space slice. */
function persistedTabTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('agaric:tabs')
    if (raw === null) return []
    const state = (JSON.parse(raw) as { state: Record<string, unknown> }).state
    interface PersistedTab {
      pageStack: Array<{ title: string }>
    }
    const lists = [
      state['tabs'] as PersistedTab[],
      ...Object.values(state['tabsBySpace'] as Record<string, PersistedTab[]>),
    ]
    return lists.flat().flatMap((tab) => tab.pageStack.map((entry) => entry.title))
  })
}

test.describe('deleting a page open in several tabs', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the page-header delete closes it in the other tab too', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.keyboard.press('Control+t')
    await expect(tabs(page)).toHaveCount(2)

    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete page', exact: true }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete page', exact: true }).click()

    // Lands where a single-tab delete lands: the Pages view the page was opened from.
    await expect(page.getByTestId('header-label')).toHaveText('Pages')
    await expect(page.locator('[aria-label="Page title"]')).toHaveCount(0)
    await expect(tabs(page)).toHaveCount(0)
    await expect.poll(() => persistedTabTitles(page)).not.toContain('Getting Started')

    await navigateToView(page, 'Tags')
    await navigateToView(page, 'Pages')
    await expect(page.getByRole('grid').getByText('Quick Notes', { exact: true })).toBeVisible()
    await expect(page.getByRole('grid').getByText('Getting Started', { exact: true })).toHaveCount(
      0,
    )
    await expect(tabs(page)).toHaveCount(0)
  })

  test('the Pages-list delete drops it from a background tab and from under another page', async ({
    page,
  }) => {
    // Tab 1 = [Getting Started]; tab 2 = [Getting Started, Quick Notes].
    await openPage(page, 'Getting Started')
    await page.keyboard.press('Control+t')
    await openPage(page, 'Quick Notes')
    await expect(tabs(page)).toHaveCount(2)

    await navigateToView(page, 'Pages')
    const grid = page.getByRole('grid')
    await grid
      .locator('[data-page-item]:has-text("Getting Started")')
      .getByRole('button', { name: 'Delete page' })
      .click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(grid.getByText('Getting Started', { exact: true })).toHaveCount(0)

    // Tab 1 emptied and closed; the view stays on Pages.
    await expect(tabs(page)).toHaveCount(0)
    await expect(page.getByTestId('header-label')).toHaveText('Pages')
    await expect.poll(() => persistedTabTitles(page)).not.toContain('Getting Started')
    expect(await persistedTabTitles(page)).toContain('Quick Notes')

    await openPage(page, 'Quick Notes')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
    await expect(tabs(page)).toHaveCount(0)
  })
})

test.describe('moving a page open in several tabs to another space', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the page-header move closes it in the other tab too', async ({ page }) => {
    // A second space to move into.
    await page.getByRole('combobox', { name: 'Switch space', exact: true }).click()
    await page.mouse.move(0, 0)
    await page.getByRole('option', { name: 'Manage spaces…', exact: true }).click()
    const spaces = page.getByTestId('settings-panel-spaces')
    await spaces.getByRole('button', { name: 'Create new space', exact: true }).click()
    await spaces.getByPlaceholder('New space name').fill('Work')
    await spaces.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(spaces.getByRole('textbox', { name: 'Rename space' }).last()).toHaveValue('Work')

    await openPage(page, 'Getting Started')
    await page.keyboard.press('Control+t')
    await expect(tabs(page)).toHaveCount(2)

    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Work', exact: true }).click()

    await expect(page.getByTestId('header-label')).toHaveText('Pages')
    await expect(page.locator('[aria-label="Page title"]')).toHaveCount(0)
    await expect(tabs(page)).toHaveCount(0)
    await expect.poll(() => persistedTabTitles(page)).not.toContain('Getting Started')
  })
})
