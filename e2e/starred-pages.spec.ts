import { expect, test, waitForBoot } from './helpers'

/**
 * E2E coverage for FEAT-12 + FEAT-14 — PageBrowser unified
 * `Starred` + `Pages` model.
 *
 * The PageBrowser used to ship a toolbar Star toggle that filtered the
 * list down to starred pages only. FEAT-12 replaced that filter with
 * always-visible grouping: starred pages render on top under a
 * `Starred` section header, non-starred under `Other pages`, and sort
 * applies independently within each group. FEAT-14 then unified the
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
 * on mount. Persistence lives in localStorage at the `starred-pages`
 * key.
 */

async function openPagesView(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  // Wait for the page-list grid to render (MAINT-162 — flipped from
  // `role="listbox"` so the mixed-mode flat/tree rows have a uniform
  // ARIA contract).
  await expect(page.getByRole('grid')).toBeVisible()
}

test.describe('FEAT-12 + FEAT-14 — PageBrowser unified Starred + Pages model', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    // Reset starred-pages so each test starts from a clean slate even
    // if the underlying browser-context survived between tests.
    await page.evaluate(() => window.localStorage.removeItem('starred-pages'))
  })

  test('no Starred header visible when no pages are starred; Pages still renders', async ({
    page,
  }) => {
    await openPagesView(page)

    // The `Starred` section is hidden because it would be empty.
    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
    // The `Pages` section renders all flat seeded pages.
    await expect(page.locator('[data-page-section="pages"]')).toBeVisible()
    // The viewport's accessible name reflects the non-grouped state.
    const grid = page.getByRole('grid')
    await expect(grid).toHaveAttribute('aria-label', 'Page list')
  })

  test('starring a page surfaces the Starred header and moves the row to the top', async ({
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
      'Page list, grouped by starred',
    )
  })

  test('starred set persists across reload via localStorage', async ({ page }) => {
    await openPagesView(page)

    // Star "Projects".
    await page.locator('[data-page-item]:has-text("Projects") .star-toggle').click()
    await expect(page.locator('[data-page-item]').first()).toContainText('Projects')

    // Inspect localStorage directly — the persistence contract.
    const stored = await page.evaluate(() => window.localStorage.getItem('starred-pages'))
    expect(stored).not.toBeNull()
    const parsed = stored ? (JSON.parse(stored) as string[]) : []
    expect(parsed).toHaveLength(1)

    // Reload the page — starred set should survive.
    await page.reload()
    await openPagesView(page)
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    await expect(page.locator('[data-page-item]').first()).toContainText('Projects')
  })

  test('starring a second page respects the active sort within the group', async ({ page }) => {
    await openPagesView(page)

    // Star "Quick Notes" then "Meetings". Default sort is alphabetical
    // → starred ordering should be Meetings, Quick Notes (M < Q).
    await page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle').click()
    await page.locator('[data-page-item]:has-text("Meetings") .star-toggle').click()

    const pageRows = page.locator('[data-page-item]')
    await expect(pageRows.nth(0)).toContainText('Meetings')
    await expect(pageRows.nth(1)).toContainText('Quick Notes')
  })

  test('unstarring drops the page back into Pages', async ({ page }) => {
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

  test('FEAT-14: namespaced pages and starred pages coexist in the unified layout', async ({
    page,
  }) => {
    await openPagesView(page)

    // Create a namespaced page — under FEAT-14, this no longer flips
    // the entire view to a tree-only mode. The flat seeded pages
    // continue to render alongside the new namespace tree under
    // `Pages`, and any starred page keeps its `Starred` row.
    const newPageInput = page.getByPlaceholder('New page name...')
    await newPageInput.fill('work/project-a')
    // The bare `getByRole('button', { name: /New Page/i })` resolves to
    // both the sidebar's "New Page" entry (`sidebar.newPage`) and the
    // PageBrowser form's submit button (`pageBrowser.newPage`). Scope to
    // the view header outlet so the click targets the form's submit
    // button regardless of locale or sidebar state.
    await page
      .getByTestId('view-header-outlet')
      .getByRole('button', { name: /New Page/i })
      .click()

    // Navigate back to Pages (creating a page typically navigates to
    // its editor view).
    await openPagesView(page)

    // Star a flat page — under FEAT-14 the `Starred` header DOES
    // render even when namespaced pages exist.
    await page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle').click()

    // Both sections render.
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    await expect(page.locator('[data-page-section="pages"]')).toBeVisible()
    // The `work` namespace folder appears inside `Pages`.
    await expect(page.getByText('work', { exact: true })).toBeVisible()
  })
})
