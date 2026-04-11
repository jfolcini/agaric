import { expect, test } from '@playwright/test'
import { focusBlock, openPage, waitForBoot } from './helpers'

/**
 * E2E tests for the (( block-ref picker.
 *
 * The (( trigger opens a search-based picker that searches block content
 * via the `search_blocks` IPC command. Selecting an item inserts a
 * block_ref chip (violet chip with data-testid="block-ref-chip").
 *
 * Note: The picker requires at least 2 characters of query text to
 * return search results (searchBlockRefs guards with q.length < 2).
 * An empty query or single character returns no results.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks
 *     GS_1: "Welcome to Agaric! This is your personal knowledge base."
 *     GS_2: "Use the sidebar to navigate between pages, tags, and search."
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: tag refs block
 *     GS_5: "**Use the search panel** to find anything across all your pages."
 *   Plus blocks on Daily, Quick Notes, Projects, Meetings pages.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type (( with a search query to open the block ref picker and wait for results. */
async function openBlockRefPicker(page: import('@playwright/test').Page, query: string) {
  await page.keyboard.press('End')
  await page.keyboard.type(` ((${query}`, { delay: 30 })
  const list = page.locator('[data-testid="suggestion-list"]')
  await expect(list).toBeVisible({ timeout: 5000 })
  return list
}

test.describe('Block ref picker — (( trigger', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('(( trigger opens suggestion popup', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' ((', { delay: 30 })
    // The popup container is created even before results arrive
    await expect(page.locator('[data-testid="suggestion-popup"]')).toBeVisible()
  })

  test('picker shows search results matching block content', async ({ page }) => {
    await focusBlock(page)
    const list = await openBlockRefPicker(page, 'Welcome')
    // Should find GS_1: "Welcome to Agaric!..."
    const items = list.locator('[data-testid="suggestion-item"]')
    await expect(items.first()).toBeVisible()
    expect(await items.count()).toBeGreaterThanOrEqual(1)
  })

  test('selecting a block via Enter inserts block-ref chip', async ({ page }) => {
    await focusBlock(page)
    const list = await openBlockRefPicker(page, 'Welcome')
    await expect(list.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
    await page.keyboard.press('Enter')
    // Popup should close and block-ref chip should appear
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="block-ref-chip"]')).toBeVisible()
  })

  test('clicking a suggestion item inserts block-ref chip', async ({ page }) => {
    await focusBlock(page)
    const list = await openBlockRefPicker(page, 'Welcome')
    await list.locator('[data-testid="suggestion-item"]').first().click()
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="block-ref-chip"]')).toBeVisible()
  })

  test('Escape dismisses the picker without inserting', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' ((', { delay: 30 })
    await expect(page.locator('[data-testid="suggestion-popup"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()
    // No block-ref chip should have been inserted
    await expect(page.locator('[data-testid="block-ref-chip"]')).not.toBeVisible()
    // Editor should still be active
    await expect(page.locator('.block-editor [contenteditable="true"]')).toBeVisible()
  })

  test('ArrowDown navigates suggestion items', async ({ page }) => {
    await focusBlock(page)
    // "the" matches multiple blocks: GS_2, GS_3, GS_5, and others
    const list = await openBlockRefPicker(page, 'the')
    const items = list.locator('[data-testid="suggestion-item"]')
    const count = await items.count()
    expect(count).toBeGreaterThanOrEqual(2)
    // First item should be selected by default
    await expect(items.first()).toHaveAttribute('aria-selected', 'true')
    // ArrowDown should move selection to the second item
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(items.first()).toHaveAttribute('aria-selected', 'false')
  })

  test('Backspace edits query without closing popup', async ({ page }) => {
    await focusBlock(page)
    const list = await openBlockRefPicker(page, 'Welcome')
    await expect(list.locator('[data-testid="suggestion-item"]')).toHaveCount(
      await list.locator('[data-testid="suggestion-item"]').count(),
    )
    // Backspace should delete the last character — query becomes "Welcom"
    await page.keyboard.press('Backspace')
    // Popup should still be visible (query still >= 2 chars)
    await expect(page.locator('[data-testid="suggestion-popup"]')).toBeVisible()
  })

  test('Tab selects highlighted item (autocomplete)', async ({ page }) => {
    await focusBlock(page)
    const list = await openBlockRefPicker(page, 'Welcome')
    await expect(list.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
    // Tab should autocomplete (select first highlighted item)
    await page.keyboard.press('Tab')
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="block-ref-chip"]')).toBeVisible()
  })
})
