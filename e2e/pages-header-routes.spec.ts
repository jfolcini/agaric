/**
 * Where the page-adjacent views open from. #6544 — the Pages header's view
 * buttons name their destination in visible text at desktop widths. #7155 R21 —
 * Graph and Trash sit at the foot of the app sidebar, just above Sync and
 * Settings and under the daily views and Bookmarks, on the phone's drawer too;
 * Templates opens from Settings › General.
 */

import { devices, type Locator } from '@playwright/test'

import {
  expect,
  expectViewLoaded,
  navigateToView,
  openMobileSidebar,
  test,
  waitForBoot,
} from './helpers'

const HEADER_DESTINATIONS = ['Tags', 'Advanced query'] as const
const SIDEBAR_DESTINATIONS = ['Graph', 'Trash'] as const

/** The sidebar's rows and the Bookmarks header, top to bottom. */
const SIDEBAR_ORDER = [
  'New page',
  'Journal',
  'Agenda',
  'Pages',
  'Search',
  'Tags',
  'Collapse Bookmarks',
  'Graph',
  'Trash',
  'Sync',
  'Settings',
]

/** The space between Trash's bottom edge and Sync's top: Graph and Trash sit just above Sync. */
async function gapAboveSync(sidebar: Locator): Promise<number> {
  const [trash, sync] = await Promise.all([
    sidebar.getByRole('button', { name: /^Trash/ }).boundingBox(),
    sidebar.getByRole('button', { name: 'Sync', exact: true }).boundingBox(),
  ])
  if (!trash || !sync) throw new Error('Trash or Sync has no box')
  return sync.y - (trash.y + trash.height)
}

/** The sidebar's row and Bookmarks-header labels, in the order they are laid out on screen. */
async function rowsTopToBottom(sidebar: Locator): Promise<string[]> {
  return sidebar
    .locator('[data-sidebar="menu-button"], [data-testid="sidebar-bookmarks-toggle"]')
    .evaluateAll((rows) =>
      rows
        .map((row) => ({
          top: row.getBoundingClientRect().top,
          label: (row.getAttribute('aria-label') ?? row.textContent ?? '').trim(),
        }))
        .toSorted((a, b) => a.top - b.top)
        .map((row) => row.label),
    )
}

test.describe('desktop @pages @graph @search', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  for (const view of HEADER_DESTINATIONS) {
    test(`the ${view} button in the Pages header shows its name and opens the view`, async ({
      page,
    }) => {
      await waitForBoot(page)
      await navigateToView(page, 'Pages')
      const label = page
        .locator('.page-browser-header')
        .getByRole('button')
        .getByText(view, { exact: true })
      // A visually hidden label is a 1 px box; a shown one is as wide as its word.
      await expect
        .poll(() => label.evaluate((el) => el.getBoundingClientRect().width))
        .toBeGreaterThan(20)
      await label.click()
      await expectViewLoaded(page, view)
    })
  }

  test('the Pages header has no Graph, Templates or Trash button', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    const header = page.locator('.page-browser-header')
    await expect(header.getByRole('button', { name: 'Tags', exact: true })).toBeVisible()
    for (const view of [...SIDEBAR_DESTINATIONS, 'Templates']) {
      await expect(header.getByRole('button', { name: new RegExp(`^${view}`) })).toHaveCount(0)
    }
  })

  test('the sidebar lists the daily views, Bookmarks, then Graph, Trash, Sync and Settings; no Templates', async ({
    page,
  }) => {
    await waitForBoot(page)
    const sidebar = page.locator('[data-slot="sidebar"]')
    await expect(sidebar.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    const rows = (await rowsTopToBottom(sidebar)).map((label) =>
      label.replace(/^Trash\b.*/u, 'Trash'),
    )
    expect(rows).toEqual(SIDEBAR_ORDER)
    expect(await gapAboveSync(sidebar)).toBeLessThan(24)
  })

  test('the collapsed rail keeps Graph and Trash as icons at its foot, above Sync', async ({
    page,
  }) => {
    await waitForBoot(page)
    const sidebar = page.locator('[data-slot="sidebar"]')
    await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed')
    const graph = sidebar.getByRole('button', { name: 'Graph', exact: true })
    const trash = sidebar.getByRole('button', { name: /^Trash/ })
    for (const row of [graph, trash]) await expect(row).toBeVisible()
    expect(await gapAboveSync(sidebar)).toBeLessThan(24)
    await trash.click()
    await expectViewLoaded(page, 'Trash')
    await expect(trash).toHaveAttribute('aria-current', 'page')
  })

  for (const view of SIDEBAR_DESTINATIONS) {
    test(`the sidebar's ${view} item opens the view`, async ({ page }) => {
      await waitForBoot(page)
      const item = page
        .locator('[data-slot="sidebar"]')
        .getByRole('button', { name: new RegExp(`^${view}`) })
      await expect(item).toBeVisible()
      await item.click()
      await expectViewLoaded(page, view)
      await expect(item).toHaveAttribute('aria-current', 'page')
    })
  }

  test('Settings › General opens the Templates view', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Templates')
    await expectViewLoaded(page, 'Templates')
  })
})

const pixel = devices['Pixel 7']

test.describe('phone drawer @pages @graph @mobile', () => {
  test.use({
    viewport: pixel.viewport,
    userAgent: pixel.userAgent,
    hasTouch: true,
    isMobile: true,
  })

  test('the drawer lists the daily views, Bookmarks, then Graph, Trash, Sync and Settings, and closes on opening one', async ({
    page,
  }) => {
    await waitForBoot(page)
    const sheet = await openMobileSidebar(page)
    await expect(sheet.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    const rows = (await rowsTopToBottom(sheet)).map((label) =>
      label.replace(/^Trash\b.*/u, 'Trash'),
    )
    expect(rows).toEqual(SIDEBAR_ORDER)
    expect(await gapAboveSync(sheet)).toBeLessThan(24)
    await sheet.getByRole('button', { name: 'Graph', exact: true }).click()
    await expect(sheet).toHaveCount(0)
    await expectViewLoaded(page, 'Graph')
  })

  test('Settings opens the Templates view', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Templates')
    await expectViewLoaded(page, 'Templates')
  })
})
