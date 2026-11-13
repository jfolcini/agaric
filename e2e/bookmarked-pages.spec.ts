import { devices, type Locator, type Page } from '@playwright/test'

import {
  createPageFromPagesView,
  dragBlock,
  dragBlockTouch,
  expect,
  ipc,
  navigateToView,
  openMobileSidebar,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E coverage for the PageBrowser's unified
 * `Starred` + `Pages` model.
 *
 * The PageBrowser used to ship a toolbar Star toggle that filtered the
 * list down to starred pages only. That toggle was replaced with
 * always-visible grouping: starred pages render on top under a
 * `Starred` section header, non-starred under `Other pages`, and sort
 * applies independently within each group. A later change then unified the
 * two organising axes (favourites vs hierarchy) into a stable
 * two-section model: `Starred` (flat, conditional) + `Pages` (single
 * section interleaving top-level flat pages and namespace roots). A
 * starred-and-namespaced page renders twice — once flat in `Starred`
 * with its full `work/foo` title, once nested under `Pages` in its
 * namespace position.
 *
 * Seed data (tauri-mock seed):
 *   PAGE_GETTING_STARTED ("Getting Started")
 *   PAGE_QUICK_NOTES ("Quick Notes")
 *   PAGE_DAILY (today's date)
 *   PAGE_PROJECTS ("Projects")
 *   PAGE_MEETINGS ("Meetings")
 *
 * Five seeded pages, none contain `/` so the namespace tree is empty
 * on mount. A bookmark is the page's `bookmark` property, whose number is its
 * place in the sidebar (#6544).
 */

// Seed ids (`src/lib/tauri-mock/seed.ts`), in the order the reorder specs bookmark them.
const BOOKMARKED = [
  '00000000000000000000PAGE02', // Quick Notes
  '00000000000000000000PAGE04', // Projects
  '00000000000000000000PAGE05', // Meetings
]

/**
 * Leave the seed pages in the device's old localStorage bookmark list, then
 * boot: the one-time migration moves them into the `bookmark` property, in
 * that order, and deletes the list.
 */
async function bookmarkSeedPages(page: Page): Promise<void> {
  await page.evaluate(
    (ids) => window.localStorage.setItem('starred-pages', JSON.stringify(ids)),
    BOOKMARKED,
  )
  await waitForBoot(page)
  await expect
    .poll(() => storedBookmarkOrder(page))
    .toEqual(['Quick Notes', 'Projects', 'Meetings'])
  expect(await page.evaluate(() => window.localStorage.getItem('starred-pages'))).toBeNull()
}

/** The bookmarked pages' titles as the backend orders them, by the property's number. */
async function storedBookmarkOrder(page: Page): Promise<string[]> {
  const { items } = await ipc<{ items: Array<{ id: string; content: string | null }> }>(
    page,
    'query_by_property',
    {
      request: {
        key: 'bookmark',
        valueText: null,
        valueDate: null,
        operator: null,
        cursor: null,
        limit: 50,
        excludeParentId: null,
        contentNonEmpty: null,
        blockType: 'page',
        valueTextIn: null,
        valueDateRange: null,
        excludeTodoStates: null,
      },
      scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
    },
  )
  const props = await ipc<Record<string, Array<{ key: string; value_num: number | null }>>>(
    page,
    'get_batch_properties',
    { blockIds: items.map((item) => item.id) },
  )
  const order = (id: string) =>
    props[id]?.find((p) => p.key === 'bookmark')?.value_num ?? Number.NaN
  return items.toSorted((a, b) => order(a.id) - order(b.id)).map((item) => item.content ?? '')
}

/** The sidebar's bookmark rows (the open buttons, not the remove actions). */
function sidebarBookmarkRows(scope: Page | Locator) {
  return scope.getByTestId('sidebar-bookmarks').locator('[data-sidebar="menu-button"]')
}

async function openPagesView(page: import('@playwright/test').Page) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  // Wait for the page-list grid to render (flipped from
  // `role="listbox"` so the mixed-mode flat/tree rows have a uniform
  // ARIA contract).
  await expect(page.getByRole('grid')).toBeVisible()
}

test.describe(' + PageBrowser unified Bookmarks + Pages model @pages @mobile', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('no Bookmarks header when nothing is bookmarked; Pages still renders', async ({ page }) => {
    await openPagesView(page)

    // The `Starred` section is hidden because it would be empty.
    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
    // The `Pages` section renders all flat seeded pages.
    await expect(page.locator('[data-page-section="pages"]')).toBeVisible()
    // The viewport's accessible name reflects the non-grouped state.
    const grid = page.getByRole('grid')
    await expect(grid).toHaveAttribute('aria-label', 'Page list')
  })

  test('bookmarking a page surfaces the Bookmarks header and moves the row to the top', async ({
    page,
  }) => {
    await openPagesView(page)

    // Locate "Quick Notes" via its row + click its star toggle.
    const quickNotesRow = page.locator('[data-page-item]:has-text("Quick Notes")')
    await quickNotesRow.locator('.star-toggle').click()

    // Starred header is now visible.
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    // Pages header is also visible (non-starred remain).
    await expect(page.locator('[data-page-section="pages"]')).toBeVisible()

    // Quick Notes is now the first page row in the grid.
    const firstPageRow = page.locator('[data-page-item]').first()
    await expect(firstPageRow).toContainText('Quick Notes')
    await expect(firstPageRow).toHaveAttribute('data-starred', 'true')

    // Viewport aria-label reflects the grouped state.
    await expect(page.getByRole('grid')).toHaveAttribute(
      'aria-label',
      'Page list, grouped by bookmarked',
    )
  })

  test('a bookmark is stored on the page and survives navigating away and back', async ({
    page,
  }) => {
    await openPagesView(page)

    // Star "Projects".
    await page.locator('[data-page-item]:has-text("Projects") .star-toggle').click()
    await expect(page.locator('[data-page-item]').first()).toContainText('Projects')

    // The persistence contract: the page carries the property, and no
    // device-local list does.
    await expect.poll(() => storedBookmarkOrder(page)).toEqual(['Projects'])
    expect(await page.evaluate(() => window.localStorage.getItem('starred-pages'))).toBeNull()

    await navigateToView(page, 'Journal')
    await openPagesView(page)
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    await expect(page.locator('[data-page-item]').first()).toContainText('Projects')
  })

  test('bookmarking a second page respects the active sort within the group', async ({ page }) => {
    await openPagesView(page)

    // Star "Quick Notes" then "Meetings". Default sort is alphabetical
    // → starred ordering should be Meetings, Quick Notes (M < Q).
    const pageRows = page.locator('[data-page-item]')
    await page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle').click()
    // The list re-sorts a task after the click and keeps each row element at
    // its position, so a row found before the re-sort shows another page by
    // the time it is clicked.
    await expect(pageRows.nth(0)).toContainText('Quick Notes')
    await page.locator('[data-page-item]:has-text("Meetings") .star-toggle').click()

    await expect(pageRows.nth(0)).toContainText('Meetings')
    await expect(pageRows.nth(1)).toContainText('Quick Notes')
  })

  test('removing a bookmark drops the page back into Pages', async ({ page }) => {
    await openPagesView(page)

    // Star then unstar "Quick Notes" — should round-trip out of the
    // Starred group.
    const star = page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle')
    await star.click()
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()

    await star.click()
    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
    // The row's data-starred reverts to "false".
    await expect(page.locator('[data-page-item]:has-text("Quick Notes")')).toHaveAttribute(
      'data-starred',
      'false',
    )
  })

  test('search narrows both groups; emptied group hides its own header', async ({ page }) => {
    await openPagesView(page)

    // Star "Quick Notes" so we have a populated Starred group.
    await page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle').click()
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    await expect(page.locator('[data-page-section="pages"]')).toBeVisible()

    // Search for "Project" — only "Projects" matches; the Starred
    // group becomes empty so its header should hide while the Pages
    // header stays visible.
    const search = page.getByPlaceholder('Search pages...')
    await search.fill('Project')

    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
    await expect(page.locator('[data-page-section="pages"]')).toBeVisible()
    await expect(page.locator('[data-page-item]')).toHaveCount(1)
    await expect(page.locator('[data-page-item]').first()).toContainText('Projects')
  })

  /**
   * #5075 — the sidebar Bookmarks section renders the same list. A page
   * created during the session is in no resolve-cache scan (`preload` runs on
   * boot, on a space switch and on `sync:complete`), and the section used to
   * drop every bookmark it could not resolve — then claim, to a user whose
   * only bookmark this was, that they had none.
   */
  test('the sidebar lists a page bookmarked in the session it was created in', async ({ page }) => {
    await openPagesView(page)
    await createPageFromPagesView(page, 'Brand New Page')

    await openPagesView(page)
    await page.locator('[data-page-item]:has-text("Brand New Page") .star-toggle').click()

    await expect(page.getByTestId('sidebar-bookmarks')).toContainText('Brand New Page')
  })

  test('namespaced pages and bookmarks coexist in the unified layout', async ({ page }) => {
    await openPagesView(page)

    // Create a namespaced page — under this no longer flips
    // the entire view to a tree-only mode. The flat seeded pages
    // continue to render alongside the new namespace tree under
    // `Pages`, and any starred page keeps its `Starred` row.
    await createPageFromPagesView(page, 'work/project-a')

    // Creating a page opens it in the editor; go back to Pages.
    await openPagesView(page)

    // Star a flat page — under the `Starred` header DOES
    // render even when namespaced pages exist.
    await page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle').click()

    // Both sections render.
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    await expect(page.locator('[data-page-section="pages"]')).toBeVisible()
    // The `work` namespace folder appears inside `Pages`.
    await expect(page.getByText('work', { exact: true })).toBeVisible()
  })
})

/**
 * #6544 — a bookmark made from the page header is the page's `bookmark`
 * property, listed in the sidebar in the property's order, and a drag there
 * rewrites that order on the page itself, which is what syncs.
 */
test.describe('Bookmarks as a page property @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('bookmark pages from the header, reorder them in the sidebar, and the order is stored', async ({
    page,
  }) => {
    const bookmarkButton = page.getByRole('button', { name: 'Bookmark this page' })
    await openPage(page, 'Quick Notes')
    await bookmarkButton.click()
    await openPage(page, 'Projects')
    await bookmarkButton.click()

    const rows = sidebarBookmarkRows(page)
    await expect(rows).toHaveText(['Quick Notes', 'Projects'])
    await expect.poll(() => storedBookmarkOrder(page)).toEqual(['Quick Notes', 'Projects'])

    // Away and back, through the bookmark: the header reads the page as
    // bookmarked, and the sidebar keeps its order.
    await navigateToView(page, 'Journal')
    await rows.nth(0).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
    await expect(
      page.getByRole('button', { name: 'Remove this page from bookmarks' }),
    ).toBeVisible()
    await expect(rows).toHaveText(['Quick Notes', 'Projects'])

    await dragBlock(page, rows.nth(1), rows.nth(0))

    await expect(rows).toHaveText(['Projects', 'Quick Notes'])
    await expect.poll(() => storedBookmarkOrder(page)).toEqual(['Projects', 'Quick Notes'])
    await navigateToView(page, 'Journal')
    await expect(rows).toHaveText(['Projects', 'Quick Notes'])
  })
})

/**
 * #5359 — the sidebar is the one surface that shows the stored bookmark order,
 * and dragging a row rewrites it. A drag is not a click: the page it moved
 * must not open.
 */
test.describe('Sidebar bookmark reorder @pages @mobile', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await bookmarkSeedPages(page)
  })

  test('a mouse drag reorders bookmarks, and the order is stored', async ({ page }) => {
    const rows = sidebarBookmarkRows(page)
    await expect(rows).toHaveText(['Quick Notes', 'Projects', 'Meetings'])

    await dragBlock(page, rows.nth(2), rows.nth(0))

    await expect(rows).toHaveText(['Meetings', 'Quick Notes', 'Projects'])
    // Still on the journal: opening the page would swap this header for its title.
    await expect(page.getByTestId('journal-header')).toBeVisible()

    await expect
      .poll(() => storedBookmarkOrder(page))
      .toEqual(['Meetings', 'Quick Notes', 'Projects'])
  })
})

test.describe('Sidebar bookmark reorder on touch (iPhone viewport) @pages @mobile', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await bookmarkSeedPages(page)
  })

  test('a hold-then-drag reorders bookmarks and leaves the drawer open', async ({ page }) => {
    const drawer = await openMobileSidebar(page)
    const rows = sidebarBookmarkRows(drawer)
    await expect(rows).toHaveText(['Quick Notes', 'Projects', 'Meetings'])
    await rows.nth(2).scrollIntoViewIfNeeded()

    await dragBlockTouch(page, rows.nth(2), rows.nth(0))

    await expect(rows).toHaveText(['Meetings', 'Quick Notes', 'Projects'])
    // Opening a bookmark closes the drawer; a drag must not. `data-state`, not
    // visibility: a closing drawer stays visible through its exit animation.
    await expect(drawer).toHaveAttribute('data-state', 'open')

    await expect
      .poll(() => storedBookmarkOrder(page))
      .toEqual(['Meetings', 'Quick Notes', 'Projects'])
  })
})
