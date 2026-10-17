/**
 * Search: a result for an indented block opens its page with the block focused (#5738).
 *
 * An indented block's `parent_id` is the block above it, not its page. The mock's
 * `load_page_subtree` refuses a content block id, so a click that opens the parent
 * as a page is healed away from it and never focuses the hit; this lane shows that.
 * The real-backend twin is `e2e-tauri/search-nested-result.e2e.ts`.
 */

import {
  createPageFromPagesView,
  expect,
  navigateToView,
  reopenPage,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'

const PAGE = 'Nested Result Page'
// `zircon` is in no seed block and not in the parent, so it finds only the child.
const CHILD = 'Nested result child zircon'

test('a result for an indented block opens its page with the block focused', async ({ page }) => {
  await waitForBoot(page)
  await navigateToView(page, 'Pages')
  await createPageFromPagesView(page, PAGE)
  const editor = page.locator('[data-testid="block-editor"]')
  const parentId = (await editor.getAttribute('data-block-id')) ?? ''
  await page.keyboard.insertText('Nested result parent')
  await page.keyboard.press('Enter')
  await expect(editor).not.toHaveAttribute('data-block-id', parentId)
  const childId = (await editor.getAttribute('data-block-id')) ?? ''
  await page.keyboard.insertText(CHILD)
  await page.keyboard.press('Tab')
  const child = page.locator(`li[data-block-id="${childId}"]`)
  await expect(child).toHaveAttribute('aria-level', '2')
  await page.keyboard.press('Escape')
  await expect(child.getByTestId('block-static')).toHaveText(CHILD)

  await navigateToView(page, 'Search')
  await submitSearch(page, 'zircon')
  await page.getByTestId(`search-result-row-${childId}`).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(PAGE)
  await expect(editor).toHaveAttribute('data-block-id', childId)
  await expect(child).toHaveAttribute('aria-level', '2')

  await reopenPage(page, PAGE)
  await expect(page.locator('li[data-block-id]')).toHaveCount(2)
  await expect(page.locator(`li[data-block-id="${parentId}"]`)).toHaveAttribute('aria-level', '1')
  await expect(child).toHaveAttribute('aria-level', '2')
})
