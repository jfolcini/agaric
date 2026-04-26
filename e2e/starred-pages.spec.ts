import { expect, test, waitForBoot } from './helpers'

/**
 * E2E coverage for FEAT-12 — PageBrowser starred-on-top grouping.
 *
 * The PageBrowser used to ship a toolbar Star toggle that filtered the
 * list down to starred pages only. FEAT-12 replaced that filter with
 * always-visible grouping: starred pages render on top under a
 * "Starred" section header, non-starred under "Other pages", and
 * sort applies independently within each group.
 *
 * Seed data (tauri-mock seed):
 *   PAGE_GETTING_STARTED ("Getting Started")
 *   PAGE_QUICK_NOTES ("Quick Notes")
 *   PAGE_DAILY (today's date)
 *   PAGE_PROJECTS ("Projects")
 *   PAGE_MEETINGS ("Meetings")
 *
 * Five seeded pages, none contain `/` so tree mode is not engaged on
 * mount. Persistence lives in localStorage at the `starred-pages` key.
 */

async function openPagesView(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  // Wait for the listbox to render.
  await expect(page.getByRole('listbox')).toBeVisible()
}

test.describe('FEAT-12 — PageBrowser starred-on-top grouping', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    // Reset starred-pages so each test starts from a clean slate even
    // if the underlying browser-context survived between tests.
    await page.evaluate(() => window.localStorage.removeItem('starred-pages'))
  })

  test('no group headers visible when no pages are starred', async ({ page }) => {
    await openPagesView(page)

    // Both group containers should be absent on a vault with zero
    // starred pages. The "Starred" section is hidden because it would
    // be empty; with no starred page rendered, grouping is inactive.
    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
    // The viewport's accessible name reflects the non-grouped state.
    const listbox = page.getByRole('listbox')
    await expect(listbox).toHaveAttribute('aria-label', 'Page list')
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
    // Other-pages header is also visible (non-starred remain).
    await expect(page.locator('[data-page-section="other"]')).toBeVisible()

    // Quick Notes is now the first option in the listbox.
    const firstOption = page.getByRole('option').first()
    await expect(firstOption).toContainText('Quick Notes')
    await expect(firstOption).toHaveAttribute('data-starred', 'true')

    // Viewport aria-label reflects the grouped state.
    await expect(page.getByRole('listbox')).toHaveAttribute(
      'aria-label',
      'Page list, grouped by starred',
    )
  })

  test('starred set persists across reload via localStorage', async ({ page }) => {
    await openPagesView(page)

    // Star "Projects".
    await page.locator('[data-page-item]:has-text("Projects") .star-toggle').click()
    await expect(page.getByRole('option').first()).toContainText('Projects')

    // Inspect localStorage directly — the persistence contract.
    const stored = await page.evaluate(() => window.localStorage.getItem('starred-pages'))
    expect(stored).not.toBeNull()
    const parsed = stored ? (JSON.parse(stored) as string[]) : []
    expect(parsed).toHaveLength(1)

    // Reload the page — starred set should survive.
    await page.reload()
    await openPagesView(page)
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    await expect(page.getByRole('option').first()).toContainText('Projects')
  })

  test('starring a second page respects the active sort within the group', async ({ page }) => {
    await openPagesView(page)

    // Star "Quick Notes" then "Meetings". Default sort is alphabetical
    // → starred ordering should be Meetings, Quick Notes (M < Q).
    await page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle').click()
    await page.locator('[data-page-item]:has-text("Meetings") .star-toggle').click()

    const options = page.getByRole('option')
    await expect(options.nth(0)).toContainText('Meetings')
    await expect(options.nth(1)).toContainText('Quick Notes')
  })

  test('unstarring drops the page back into Other pages', async ({ page }) => {
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
    await expect(page.locator('[data-page-section="other"]')).toBeVisible()

    // Search for "Project" — only "Projects" matches; the Starred
    // group becomes empty so its header should hide while the
    // Other-pages header stays visible.
    const search = page.getByPlaceholder('Search pages...')
    await search.fill('Project')

    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
    await expect(page.locator('[data-page-section="other"]')).toBeVisible()
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option').first()).toContainText('Projects')
  })

  test('tree mode (titles with "/") renders without grouping headers', async ({ page }) => {
    await openPagesView(page)

    // Create a namespaced page — the moment any title contains "/",
    // PageBrowser switches to tree mode and bypasses grouping.
    const newPageInput = page.getByPlaceholder('New page name...')
    await newPageInput.fill('work/project-a')
    await page.getByRole('button', { name: /New Page/i }).click()

    // Navigate back to Pages (creating a page typically navigates to
    // its editor view).
    await openPagesView(page)

    // Star a page — even with starred, tree mode should not render
    // group headers because namespace hierarchy wins.
    await page.locator('[data-page-item]:has-text("Quick Notes") .star-toggle').click()

    // No section headers should be visible in tree mode. The "work"
    // namespace folder should appear instead.
    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
    await expect(page.locator('[data-page-section="other"]')).toHaveCount(0)
    await expect(page.getByText('work', { exact: true })).toBeVisible()
  })
})
