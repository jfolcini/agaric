import { clearConsoleErrors, expect, getConsoleErrors, test, waitForBoot } from './helpers'

/**
 * #6554 — a view that crashes during render shows its error panel, and the
 * panel stays with that view: every other view still renders, and returning
 * to the crashed view shows its own panel again, not another view's.
 */

test('a crashed view keeps its error panel to itself @boot @pages', async ({ page }) => {
  await waitForBoot(page)
  // A malformed Pages response crashes the Pages view during render.
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const invoke = internals.invoke.bind(internals)
    internals.invoke = (c, a) =>
      c === 'list_pages_with_metadata'
        ? Promise.resolve({ items: [null], next_cursor: null, has_more: false, total_count: 1 })
        : invoke(c, a)
  })
  const sidebar = page.locator('[data-slot="sidebar"]')
  const panel = page.getByRole('alert').filter({ hasText: 'encountered an error' })

  await sidebar.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(panel).toHaveText(/Pages encountered an error/)
  expect(getConsoleErrors(page).some((e) => e.includes("reading 'content'"))).toBe(true)
  clearConsoleErrors(page)

  await sidebar.getByRole('button', { name: 'Tags', exact: true }).click()
  await expect(page.getByTestId('header-label')).toHaveText('Tags')
  await expect(page.getByTestId('tag-item-work')).toBeVisible()
  await expect(panel).toHaveCount(0)

  await sidebar.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(panel).toHaveText(/Pages encountered an error/)
  clearConsoleErrors(page)
})
