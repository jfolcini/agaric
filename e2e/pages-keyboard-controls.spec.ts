import type { Page } from '@playwright/test'

import { pageRow } from './domain'
import {
  activeAlertDialog,
  expect,
  navigateToView,
  seedBulkPages,
  test,
  waitForBoot,
} from './helpers'

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

  test('Enter on a row a click focused beside its title opens no page', async ({ page }) => {
    // The click lands in the row's padding: it focuses the row, and the cursor
    // stays on Getting Started.
    const row = pageRow(page, 'Quick Notes')
    await row.click({ position: { x: 1, y: 1 } })
    await expect(row).toBeFocused()
    await page.keyboard.press('Enter')
    await expectStillOnPages(page)
    await expect(row).toBeFocused()
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

  test('Enter on New page opens the New page dialog', async ({ page }) => {
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New page', exact: true })
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
  await waitForBoot(page)
  await seedBulkPages(page, 120)
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
      return row?.querySelector('.page-browser-item-title')?.getAttribute('data-page-title') ?? ''
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

/**
 * #7040 — keyboard affordances show once the keyboard is in use. At rest the
 * cursor sits on the first row unpainted (a tint and a bar there read as a
 * selection); a key that moves it paints it, and a pointer press puts it back
 * to rest. The search field App focuses on arrival draws no ring, and Tab does.
 */
test.describe('Pages keyboard affordances at rest @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    await expect(pageRow(page, 'Getting Started')).toHaveAttribute('aria-selected', 'true')
  })

  const bar = (row: ReturnType<typeof pageRow>) =>
    row.evaluate((el) => {
      const cursor = el.closest('.list-cursor') ?? el.querySelector('.list-cursor')
      return cursor === null ? null : getComputedStyle(cursor, '::before').content
    })

  test('the first row paints no cursor bar until a key moves the cursor', async ({ page }) => {
    const first = pageRow(page, 'Getting Started')
    await expect.poll(() => bar(first)).toBe('none')

    await page.getByRole('grid').focus()
    await page.keyboard.press('ArrowDown')
    const second = pageRow(page, 'Meeting Notes Template')
    await expect(second).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => bar(second)).toBe('""')
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => bar(first)).toBe('""')

    await page.getByTestId('header-label').click()
    await expect.poll(() => bar(first)).toBe('none')
  })

  test('the search field App focuses draws no ring, and Tab draws one', async ({ page }) => {
    // A first visit right after boot can mount the lazy view after App's
    // one-frame focus pass (`new-page-dialog.spec.ts`), so focus is checked on
    // an entry with it loaded.
    await navigateToView(page, 'Journal')
    await navigateToView(page, 'Pages')
    const search = page.getByLabel('Search pages...', { exact: true })
    await expect(search).toBeFocused()
    expect(await search.evaluate((el) => el.matches(':focus-visible'))).toBe(false)

    await page.keyboard.press('Tab')
    await expect(search).not.toBeFocused()
    expect(await page.evaluate(() => document.activeElement?.matches(':focus-visible'))).toBe(true)
  })
})
