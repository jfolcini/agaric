/**
 * #5927 — on a phone the view header scrolls away with the content instead of
 * pinning a third of the screen, and each screen names its view once.
 *
 * On a touch phone the view header portals into a slot inside App's
 * scroller, so it leaves the screen when the content scrolls; only a search
 * field stays pinned (Pages). `FeaturePageHeader`'s title is screen-reader only there, because
 * the header bar already names the view: the view keeps exactly one heading.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { expect, ipc, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

const VIEWPORT = { width: 360, height: 780 }
const iPhone = devices['iPhone 13']

test.use({
  viewport: VIEWPORT,
  hasTouch: iPhone.hasTouch,
  isMobile: iPhone.isMobile,
  deviceScaleFactor: iPhone.deviceScaleFactor,
  userAgent: iPhone.userAgent,
})

/** The first list row must start within the top 40% of the screen. */
const FIRST_ROW_LIMIT = VIEWPORT.height * 0.4

function rect(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, height: r.height }
  })
}

async function barBottom(page: Page): Promise<number> {
  return (await rect(page.locator('header').first())).bottom
}

/** Scroll App's main scroller to its end and return how far it moved. */
function scrollMainToEnd(page: Page): Promise<number> {
  return page.locator('#main-content').evaluate((el) => {
    el.scrollTop = el.scrollHeight
    return el.scrollTop
  })
}

/** The view's one heading carries its name but is not painted a second time. */
async function expectOneHiddenHeading(page: Page, name: string): Promise<void> {
  const heading = page.getByRole('heading', { name, exact: true })
  await expect(heading).toHaveCount(1)
  expect((await rect(heading)).height).toBeLessThanOrEqual(1)
}

async function openJournalMode(page: Page, mode: string): Promise<void> {
  await page
    .locator('header')
    .first()
    .getByRole('button', { name: /^Journal view mode/ })
    .click()
  await page.getByRole('button', { name: mode, exact: true }).click()
}

test.describe('phone view headers (#5927) @mobile @pages @journal', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('Pages: one header row, rows high on the screen, search pinned while the content scrolls', async ({
    page,
  }) => {
    for (let i = 0; i < 30; i++) {
      await ipc(page, 'create_page_in_space', {
        parentId: null,
        content: `Phone page ${String(i).padStart(2, '0')}`,
        spaceId: 'SPACE_PERSONAL',
      })
    }
    await navigateToView(page, 'Pages')
    const firstRow = page.locator('.page-browser-list [role="row"]').first()
    await expect(firstRow).toBeVisible()
    expect((await rect(firstRow)).top).toBeLessThan(FIRST_ROW_LIMIT)
    await expect(page.getByRole('heading', { name: 'Pages', exact: true })).toHaveCount(1)

    // Search, sort, ⋮ and New Page share one row.
    const header = page.locator('.page-browser-header')
    const search = header.getByRole('textbox', { name: 'Search pages...' })
    const searchBox = await rect(search)
    const centre = (box: { top: number; height: number }) => box.top + box.height / 2
    for (const control of [
      header.getByRole('combobox', { name: 'Sort order' }),
      header.getByRole('button', { name: 'More Pages options', exact: true }),
      header.getByRole('button', { name: 'New Page', exact: true }),
    ]) {
      expect(Math.abs(centre(await rect(control)) - centre(searchBox))).toBeLessThan(2)
    }

    // The ⋮ menu holds saved views and the view shortcuts.
    await page.getByTestId('page-browser-more').click()
    const menu = page.getByTestId('saved-views-menu')
    await expect(menu.getByTestId('saved-views-save-current')).toBeVisible()
    await expect(menu.getByRole('button', { name: 'Graph', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    expect(await scrollMainToEnd(page)).toBeGreaterThan(0)
    const bar = await barBottom(page)
    await expect.poll(async () => Math.round((await rect(search)).top - bar)).toBeLessThan(16)
    expect((await rect(search)).top).toBeGreaterThanOrEqual(bar)
    // The filter chips are content, not header: they scroll under the pinned row.
    expect((await rect(page.getByTestId('page-browser-filter-row'))).bottom).toBeLessThanOrEqual(
      (await rect(page.getByTestId('view-header-outlet'))).bottom,
    )
  })

  test('Agenda: no nested scroll box, the header scrolls away, the list stays windowed', async ({
    page,
  }) => {
    await page.evaluate(() =>
      (window as unknown as { __addMockAgendaItems: (n: number) => string[] }).__addMockAgendaItems(
        60,
      ),
    )
    await openJournalMode(page, 'Agenda')
    const items = page.locator('[data-testid="agenda-results-item"]')
    await expect(items.first()).toBeVisible()
    expect((await rect(items.first())).top).toBeLessThan(FIRST_ROW_LIMIT)
    await expect(page.locator('.agenda-results-scroll')).toHaveCount(0)
    await expectOneHiddenHeading(page, 'Journal')
    expect(await items.count()).toBeLessThan(60)

    // Halfway down the list, clear of both ends of the window.
    const scrolled = await page.locator('#main-content').evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
      return el.scrollTop
    })
    expect(scrolled).toBeGreaterThan(0)
    const bar = await barBottom(page)
    expect((await rect(page.getByTestId('view-header-outlet'))).bottom).toBeLessThanOrEqual(bar)
    // The window follows the page scroll: the rows on screen are mounted, and
    // only the virtualizer's overscan (5) lies past each edge. A window placed
    // against the list's own top instead of its place in the page mounts a
    // screen's worth too far down.
    const rows = page.locator('.agenda-results-list > li[data-index]')
    await expect
      .poll(() =>
        rows.evaluateAll((els, top) => {
          const boxes = els.map((el) => el.getBoundingClientRect())
          return {
            onScreen: boxes.filter((r) => r.bottom > top && r.top < window.innerHeight).length > 3,
            above: boxes.filter((r) => r.bottom <= top).length,
            below: boxes.filter((r) => r.top >= window.innerHeight).length,
          }
        }, bar),
      )
      .toEqual({ onScreen: true, above: 5, below: 5 })
    expect(await items.count()).toBeLessThan(60)
  })

  test('Trash: one title, its actions kept, rows high on the screen', async ({ page }) => {
    const ids = await seedSearchBlocks(
      page,
      Array.from({ length: 20 }, (_, i) => ({ content: `Phone trashed ${i}` })),
    )
    for (const blockId of ids) await ipc(page, 'delete_block', { blockId })
    await navigateToView(page, 'Trash')
    const firstRow = page.getByTestId('trash-item').first()
    await expect(firstRow).toBeVisible()
    expect((await rect(firstRow)).top).toBeLessThan(FIRST_ROW_LIMIT)
    await expectOneHiddenHeading(page, 'Trash')
    await expect(page.getByTestId('trash-empty-trash-btn')).toBeVisible()

    // The list scrolls inside its own box, so how far `#main-content` can scroll
    // is its bottom padding: the header leaves with the scroll, by exactly it.
    const header = page.locator('[data-slot="feature-page-header"]')
    const before = (await rect(header)).top
    const scrolled = await scrollMainToEnd(page)
    expect(scrolled).toBeGreaterThan(0)
    expect((await rect(header)).top).toBe(before - scrolled)
  })

  test('Journal: Day names the date once, Week drops the generic heading', async ({ page }) => {
    const fullDate = (await page.getByTestId('date-display').textContent()) ?? ''
    expect(fullDate).not.toBe('')
    await expectOneHiddenHeading(page, fullDate)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

    await openJournalMode(page, 'Week')
    await expectOneHiddenHeading(page, 'Journal')
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  })
})
