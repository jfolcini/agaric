/**
 * E2E — the journal's header, section counts and Agenda controls (#7040 P1,
 * D1, P3). On a touch phone the view switch says its mode in a word, and the
 * day's delete is a row of its ⋮ menu that asks first. On a desktop every
 * section header reads its label, then its number in the muted count tone; a
 * week's empty day keeps its "+" beside its date; and the Agenda is called
 * Agenda in the sidebar, the tab and the title. One View button holds the
 * Agenda's Group by and Sort by, a bottom sheet on a phone.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { activeSheet, expect, navigateToView, test, waitForBoot } from './helpers'

const pixel = devices['Pixel 7']
const PHONE = {
  viewport: { width: 412, height: 915 },
  userAgent: pixel.userAgent,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
}

/** The app shell's header; a view's own title is a `header` too. */
const appHeader = (page: Page): Locator => page.locator('header').first()

const viewSwitch = (page: Page): Locator =>
  appHeader(page).getByRole('button', { name: /^Journal view mode/ })

async function pickMode(page: Page, mode: string): Promise<void> {
  await viewSwitch(page).click()
  await page.getByRole('button', { name: mode, exact: true }).click()
}

/** A section header's count: the metadata badge after its label, holding a number. */
function countOf(header: Locator): Locator {
  return header.locator('[data-slot="badge"][data-variant="metadata"]')
}

test.describe('journal on a phone @journal @mobile', () => {
  test.use(PHONE)

  test('the view switch says its mode in a word', async ({ page }) => {
    await waitForBoot(page)
    await expect(viewSwitch(page)).toHaveText('Day', { useInnerText: true })
    await pickMode(page, 'Agenda')
    await expect(viewSwitch(page)).toHaveText('Agenda', { useInnerText: true })
    // The switch names the mode; no second label beside it repeats it.
    const header = appHeader(page)
    await expect(header.getByText('Agenda', { exact: true }).filter({ visible: true })).toHaveCount(
      1,
    )
    await expect(header.getByText('Tasks', { exact: true }).filter({ visible: true })).toHaveCount(
      0,
    )
  })

  test('the day’s delete is a row of its ⋮ menu that asks first', async ({ page }) => {
    await waitForBoot(page)
    const day = page.locator('section[id^="journal-"]').first()
    await expect(day.getByRole('button', { name: 'Delete page', exact: true })).toHaveCount(0)

    const more = day.getByRole('button', { name: 'Page actions', exact: true })
    await more.click()
    await activeSheet(page)
      .getByRole('menu', { name: 'Page actions' })
      .getByRole('menuitem', { name: 'Delete page' })
      .click()
    const confirm = activeSheet(page)
    await expect(confirm).toContainText('Delete the note for')
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()

    await expect(confirm).toHaveCount(0)
    await expect(more).toBeFocused()
    await expect(page.getByText('Morning standup notes go here')).toBeVisible()
  })

  test('the day’s bookmark sits in its checkboxes’ column, its ⋮ on the right content edge', async ({
    page,
  }) => {
    await waitForBoot(page)
    const day = page.locator('section[id^="journal-"]').first()
    const iconBox = async (button: Locator) => {
      const b = await button.locator('svg').first().boundingBox()
      if (b == null) throw new Error('icon has no box')
      return { left: Math.round(b.x), right: Math.round(b.x + b.width) }
    }
    const checkbox = await day.getByTestId('task-checkbox-todo').first().boundingBox()
    if (checkbox == null) throw new Error('checkbox has no box')

    const bookmark = await iconBox(
      day.getByRole('button', { name: 'Bookmark this page', exact: true }),
    )
    expect(bookmark.left).toBe(Math.round(checkbox.x))
    const menu = await iconBox(day.getByRole('button', { name: 'Page actions', exact: true }))
    const search = await iconBox(appHeader(page).getByTestId('search-sheet-trigger'))
    expect(menu.right).toBe(search.right)
  })

  test('one View button opens Group by and Sort by in a sheet', async ({ page }) => {
    await waitForBoot(page)
    await pickMode(page, 'Agenda')
    await page.getByRole('button', { name: 'View', exact: true }).click()
    const sheet = activeSheet(page)
    await expect(sheet.getByRole('list', { name: 'Group by' })).toBeVisible()
    await expect(sheet.getByRole('list', { name: 'Sort by' })).toBeVisible()
  })
})

test.describe('journal on a desktop @journal', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('each section header reads its label, then its number in the count tone', async ({
    page,
  }) => {
    await waitForBoot(page)
    const due = page.getByTestId('due-panel')
    // #7155 R7 — the Due panel's counts are on today's tabs, not its header.
    await expect(page.getByTestId('due-panel-header')).toHaveText('Tasks')
    const overdue = due.getByRole('tab', { name: /^Overdue/ })
    await expect(overdue).toHaveText(/^Overdue \d+$/)
    await expect(countOf(overdue)).toHaveText(/^\d+$/)
    const done = page.locator('.done-panel-header')
    await expect(done).toHaveText(/^Completed \d+$/)
    await expect(countOf(done)).toHaveText(/^\d+$/)
  })

  // #7155 R6 — the Day view's title row works like a page's.
  test('the day’s title row holds its switch, bookmark and menu, the toolbar beneath it', async ({
    page,
  }) => {
    await waitForBoot(page)
    const header = page.locator('.journal-page-header')
    const title = header.getByRole('heading', { level: 1 })
    await expect(title).toBeVisible()
    await expect(header.getByRole('radiogroup', { name: 'Editing mode' })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Bookmark this page' })).toBeVisible()
    const menu = header.getByRole('button', { name: 'Page actions' })
    await expect(page.getByRole('button', { name: 'Delete page', exact: true })).toHaveCount(0)
    const titleBox = await title.boundingBox()
    const menuBox = await menu.boundingBox()
    expect(Math.abs((menuBox?.y ?? 0) - (titleBox?.y ?? 0)), 'one row').toBeLessThan(
      titleBox?.height ?? 0,
    )

    await page.locator('[data-testid="block-static"]').first().click()
    const bar = page.getByTestId('formatting-toolbar')
    await expect(bar).toBeVisible()
    const headerBox = await header.boundingBox()
    expect((await bar.boundingBox())?.y, 'toolbar beneath the title row').toBeGreaterThanOrEqual(
      (headerBox?.y ?? 0) + (headerBox?.height ?? 0),
    )

    await page.keyboard.press('Escape')
    await menu.click()
    await expect(page.getByRole('menuitem', { name: 'Properties…' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete page' })).toBeVisible()
  })

  test('a week’s empty day keeps its + beside its date', async ({ page }) => {
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const add = page.getByRole('button', { name: 'Add block', exact: true }).first()
    await expect(add).toBeVisible()
    const gap = await add.evaluate((el) => {
      const heading = el.closest('section')?.querySelector('h3')
      return el.getBoundingClientRect().left - (heading?.getBoundingClientRect().right ?? 0)
    })
    expect(gap).toBeLessThan(48)
  })

  test('the Agenda is called Agenda in the sidebar, the tab and the title', async ({ page }) => {
    await waitForBoot(page)
    const sidebar = page.locator('[data-slot="sidebar"]')
    await sidebar.getByRole('button', { name: 'Agenda', exact: true }).click()
    await expect(sidebar.getByRole('button', { name: 'Agenda', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByRole('tab', { name: 'Agenda view' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agenda')
    await expect(page.getByTestId('agenda-group-header').first()).toHaveText(/^.+ \d+$/)
    await expect(countOf(page.getByTestId('agenda-group-header').first())).toHaveText(/^\d+$/)
  })

  test('one View button opens Group by and Sort by', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Agenda')
    await page.getByRole('button', { name: 'View', exact: true }).click()
    await page.getByRole('list', { name: 'Group by' }).getByText('State', { exact: true }).click()
    await page.getByRole('list', { name: 'Sort by' }).getByText('Priority', { exact: true }).click()
    await expect(
      page.getByRole('list', { name: 'Group by' }).getByRole('button', { name: 'State' }),
    ).toHaveAttribute('aria-current', 'true')
    await expect(
      page.getByRole('list', { name: 'Sort by' }).getByRole('button', { name: 'Priority' }),
    ).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId('agenda-group-header')).toHaveText([/^DOING \d+$/, /^TODO \d+$/])
    // The two chips it replaces are gone.
    await expect(page.getByRole('button', { name: 'Group by', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('list', { name: 'Sort by' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'View', exact: true })).toBeFocused()
  })
})
