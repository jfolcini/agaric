/**
 * E2E — the Pages view leads with search, and every new page is made in the
 * New page dialog, which lists pages with a similar name first (#5637).
 *
 * Each create is checked by re-querying: back on the Pages view, searching the
 * title finds exactly one row. Seed pages include `Meetings`, `Projects`
 * (alias `proj`) and `Meeting Notes Template`.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { activeDialog, expect, navigateToView, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']

const searchInput = (page: Page): Locator =>
  page.locator('.page-browser-header').getByRole('textbox', { name: 'Search pages...' })

const titleInput = (page: Page): Locator =>
  activeDialog(page).getByRole('textbox', { name: 'New page title' })

/** On the Pages view, how many rows the search for `title` finds with exactly that title. */
async function expectOnePageTitled(page: Page, title: string): Promise<void> {
  await navigateToView(page, 'Pages')
  await searchInput(page).fill(title)
  await expect(page.getByRole('grid').getByText(title, { exact: true })).toHaveCount(1)
}

async function createInOpenDialog(page: Page, title: string): Promise<void> {
  await expect(titleInput(page)).toBeFocused()
  await titleInput(page).fill(title)
  await expect(activeDialog(page).getByText('No similar pages')).toBeVisible()
  await titleInput(page).press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

test.describe('New page dialog (desktop) @pages @mobile', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the Pages view leads with search, focused, and New Page creates through the dialog', async ({
    page,
  }) => {
    // A first visit right after boot can mount the lazy view after App's
    // one-frame focus pass, so focus is checked on an entry with it loaded.
    await navigateToView(page, 'Pages')
    await navigateToView(page, 'Journal')
    await navigateToView(page, 'Pages')
    await expect(searchInput(page)).toBeFocused()

    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New Page', exact: true })
      .click()
    await createInOpenDialog(page, 'Quarterly plan')

    await expectOnePageTitled(page, 'Quarterly plan')
  })

  const openers: ReadonlyArray<[string, (page: Page) => Promise<void>]> = [
    ['the Ctrl+N chord', (page) => page.keyboard.press('Control+n')],
    [
      'the sidebar New Page button',
      (page) =>
        page
          .locator('[data-slot="sidebar"]')
          .getByRole('button', { name: 'New Page', exact: true })
          .click(),
    ],
    [
      'the palette command',
      async (page) => {
        await page.keyboard.press('Control+k')
        await expect(page.getByTestId('command-palette-input')).toBeFocused()
        await page.getByTestId('palette-mode-chip').click()
        await page.getByTestId('palette-cmd-create-new-page').click()
      },
    ],
  ]
  for (const [name, open] of openers) {
    test(`${name} opens the dialog, which creates exactly one page`, async ({ page }) => {
      const title = `From ${name}`
      await open(page)
      await createInOpenDialog(page, title)
      await expectOnePageTitled(page, title)
    })
  }

  test('an exact duplicate, ignoring case, offers the existing page instead of creating', async ({
    page,
  }) => {
    await page.keyboard.press('Control+n')
    await expect(titleInput(page)).toBeFocused()
    const dialog = activeDialog(page)

    // Near matches are listed with Open buttons, and Create stays available.
    await titleInput(page).fill('meeting')
    await expect(dialog.getByRole('button', { name: 'Open Meetings', exact: true })).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Open Meeting Notes Template', exact: true }),
    ).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()

    await titleInput(page).press('End')
    await titleInput(page).pressSequentially('s')
    await expect(dialog.getByRole('status')).toHaveText('A page named “Meetings” already exists.')
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()

    await dialog.getByRole('button', { name: 'Open it', exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Meetings')
    await expectOnePageTitled(page, 'Meetings')
    await expect(page.getByRole('grid').getByText('meetings', { exact: true })).toHaveCount(0)
  })

  test('a search that names no page offers to create it, pre-filled', async ({ page }) => {
    await navigateToView(page, 'Pages')
    await searchInput(page).fill('Roadmap 2027')

    await page.getByRole('button', { name: 'Create page “Roadmap 2027”', exact: true }).click()
    await expect(titleInput(page)).toHaveValue('Roadmap 2027')
    await titleInput(page).press('Enter')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Roadmap 2027')

    await expectOnePageTitled(page, 'Roadmap 2027')
  })

  test('Escape closes the dialog and returns focus to the button that opened it', async ({
    page,
  }) => {
    await navigateToView(page, 'Pages')
    const newPage = page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New Page', exact: true })
    await newPage.click()
    await expect(titleInput(page)).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(activeDialog(page)).toHaveCount(0)
    await expect(newPage).toBeFocused()
  })
})

test.describe('New page dialog (phone) @pages @mobile', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
  })

  test('entering Pages does not focus search, so no keyboard covers the list', async ({ page }) => {
    // Re-enter with the view loaded, as the desktop test does, so this cannot
    // pass only because focus came too late.
    await navigateToView(page, 'Journal')
    await navigateToView(page, 'Pages')
    await expect(searchInput(page)).toBeVisible()
    await expect(searchInput(page)).not.toBeFocused()
    await expect(page.locator('input:focus, textarea:focus')).toHaveCount(0)
  })

  test('New Page creates a page through the dialog', async ({ page }) => {
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New Page', exact: true })
      .tap()
    await createInOpenDialog(page, 'Phone page')
    await expectOnePageTitled(page, 'Phone page')
  })

  test('an exact duplicate is reported and Create stays disabled', async ({ page }) => {
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New Page', exact: true })
      .tap()
    await expect(titleInput(page)).toBeFocused()
    await titleInput(page).fill('PROJECTS')

    const dialog = activeDialog(page)
    await expect(dialog.getByRole('status')).toHaveText('A page named “Projects” already exists.')
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
    await titleInput(page).press('Enter')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Projects')
  })
})
