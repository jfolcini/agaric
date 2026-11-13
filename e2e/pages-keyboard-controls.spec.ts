import type { Page } from '@playwright/test'

import { activeAlertDialog, expect, navigateToView, test, waitForBoot } from './helpers'

/** The Pages list row for the page titled `title`. */
function pageRow(page: Page, title: string) {
  return page
    .getByRole('grid')
    .locator('[data-page-item]')
    .filter({ has: page.locator(`.page-browser-item-title[title="${title}"]`) })
}

const pageTitle = (page: Page) => page.locator('[aria-label="Page title"]')

/** Still on the Pages view: no page opened. */
async function expectStillOnPages(page: Page) {
  await expect(pageRow(page, 'Quick Notes')).toBeVisible()
  await expect(pageTitle(page)).toHaveCount(0)
}

/**
 * The Pages view hears list keys at the document, so the arrows move its
 * cursor wherever focus is. Enter and Space belong to the focused control, and
 * open the cursor's page only from the list itself. The cursor starts on
 * Getting Started, so a press the list takes opens that page instead.
 */
test.describe('Enter and Space press the focused control in the Pages view @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    await expect(pageRow(page, 'Getting Started')).toHaveAttribute('aria-selected', 'true')
  })

  test('Enter on a row title opens that page, and on the list the cursor page', async ({
    page,
  }) => {
    await pageRow(page, 'Quick Notes').getByRole('button', { name: 'Bookmark page' }).focus()
    await page.keyboard.press('Tab')
    const title = pageRow(page, 'Quick Notes').getByRole('button', { name: /^Quick Notes/ })
    await expect(title).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(pageTitle(page)).toHaveText('Quick Notes')

    await navigateToView(page, 'Pages')
    const grid = page.getByRole('grid')
    await grid.focus()
    await page.keyboard.press('ArrowDown')
    await expect(pageRow(page, 'Meeting Notes Template')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(pageTitle(page)).toHaveText('Meeting Notes Template')
  })

  test('Space on a bookmark star toggles that page and keeps focus on the star', async ({
    page,
  }) => {
    await pageRow(page, 'Quick Notes').getByRole('button', { name: 'Bookmark page' }).focus()
    await page.keyboard.press('Space')
    const starred = pageRow(page, 'Quick Notes').getByRole('button', {
      name: 'Remove page from bookmarks',
    })
    await expect(starred).toBeFocused()
    await expectStillOnPages(page)

    await page.keyboard.press('Space')
    await expect(
      pageRow(page, 'Quick Notes').getByRole('button', { name: 'Bookmark page' }),
    ).toBeFocused()
    await expectStillOnPages(page)
  })

  test('Space on a row checkbox selects that row', async ({ page }) => {
    const checkbox = pageRow(page, 'Quick Notes').getByRole('checkbox', { name: 'Select page' })
    await checkbox.focus()
    await page.keyboard.press('Space')
    await expect(checkbox).toBeChecked()
    await expect(page.getByRole('toolbar', { name: '1 selected' })).toBeVisible()
    await expectStillOnPages(page)
  })

  test('Enter on New Page opens the New page dialog', async ({ page }) => {
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New Page', exact: true })
      .focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('new-page-dialog')
    await expect(dialog.getByRole('textbox', { name: 'New page title' })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expectStillOnPages(page)
  })

  test('Enter on Delete opens its confirm dialog, and Cancel or Escape close it on the list', async ({
    page,
  }) => {
    const remove = pageRow(page, 'Quick Notes').getByRole('button', { name: 'Delete page' })
    await remove.focus()
    await page.keyboard.press('Enter')
    const dialog = activeAlertDialog(page)
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expectStillOnPages(page)

    await remove.click()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expectStillOnPages(page)
  })
})

/**
 * A bookmark toggle re-sorts the list, and on a long list it moves the page
 * out of the rendered window: into Bookmarks at the top, and back. Its row
 * stays mounted, so focus stays on the star instead of falling to <body>.
 */
test('a star keeps focus when its toggle moves the page out of view @pages', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('__mockExtraPages', '120'))
  await waitForBoot(page)
  await navigateToView(page, 'Pages')
  const grid = page.getByRole('grid')
  await expect(grid.locator('[data-page-item]').first()).toBeVisible()
  await expect
    .poll(() =>
      grid.evaluate((el) => {
        el.scrollTop = 900
        return el.scrollTop
      }),
    )
    .toBe(900)
  // A row in the middle of the viewport, far below where Bookmarks start.
  const midRowTitle = () =>
    grid.evaluate((el) => {
      const mid = el.getBoundingClientRect().top + el.clientHeight / 2
      const row = [...el.querySelectorAll('[data-page-item]')].find((r) => {
        const box = r.getBoundingClientRect()
        return box.top <= mid && box.bottom > mid
      })
      return row?.querySelector('.page-browser-item-title')?.getAttribute('title') ?? ''
    })
  await expect.poll(midRowTitle).toMatch(/^Bulk Page \d+$/)
  const title = await midRowTitle()

  await pageRow(page, title).getByRole('button', { name: 'Bookmark page' }).focus()
  await page.keyboard.press('Space')
  await expect(
    pageRow(page, title).getByRole('button', { name: 'Remove page from bookmarks' }),
  ).toBeFocused()

  await page.keyboard.press('Space')
  await expect(pageRow(page, title).getByRole('button', { name: 'Bookmark page' })).toBeFocused()
  await expect(pageTitle(page)).toHaveCount(0)
})
