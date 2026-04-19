import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E tests for suggestion popup + keyboard interactions (T-1).
 *
 * Verifies that Enter, Tab, Escape, and Backspace work correctly when a
 * suggestion popup is open.  These interactions were fixed in session 228
 * (Enter/Tab/Escape/Backspace passthrough to Suggestion plugin).
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks
 *   PAGE_QUICK_NOTES ("Quick Notes") — 2 child blocks
 *   Tags: work, personal, idea
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type [[ to open the page link picker and wait for it. */
async function openPagePicker(page: import('@playwright/test').Page) {
  await page.keyboard.press('End')
  await page.keyboard.type(' [[', { delay: 30 })
  const popup = page.locator('[data-testid="suggestion-popup"]')
  await expect(popup).toBeVisible()
  return popup
}

/** Type @ to open the tag picker and wait for it. */
async function openTagPicker(page: import('@playwright/test').Page) {
  await page.keyboard.press('End')
  await page.keyboard.type(' @', { delay: 30 })
  const popup = page.locator('[data-testid="suggestion-popup"]')
  await expect(popup).toBeVisible()
  return popup
}

/** Type / to open the slash command picker and wait for it. */
async function openSlashPicker(page: import('@playwright/test').Page) {
  await page.keyboard.press('End')
  await page.keyboard.type(' /', { delay: 30 })
  const popup = page.locator('[data-testid="suggestion-popup"]')
  await expect(popup).toBeVisible()
  return popup
}

// ===========================================================================
// 1. Enter selects suggestion item (not create new block)
// ===========================================================================

test.describe('Enter key with suggestion popup', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('[[ picker: Enter selects highlighted item instead of creating new block', async ({
    page,
  }) => {
    await focusBlock(page)
    await openPagePicker(page)

    // Type a query to filter
    await page.keyboard.type('Quick', { delay: 30 })

    // The suggestion list should have a "Quick Notes" item
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()

    // Press Enter to select the item
    await page.keyboard.press('Enter')

    // The suggestion popup should close
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()

    // A block_link chip should be inserted (not a new block)
    await expect(
      page.locator('[data-testid="block-link-chip"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()
  })

  test('@ picker: Enter selects highlighted tag', async ({ page }) => {
    await focusBlock(page)
    await openTagPicker(page)

    await page.keyboard.type('work', { delay: 30 })

    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list.locator('[data-testid="suggestion-item"]', { hasText: 'work' })).toBeVisible()

    await page.keyboard.press('Enter')

    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()
    await expect(page.locator('[data-testid="tag-ref-chip"]', { hasText: 'work' })).toBeVisible()
  })
})

// ===========================================================================
// 2. Tab autocompletes with highlighted item
// ===========================================================================

test.describe('Tab key with suggestion popup', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('[[ picker: Tab selects highlighted item (autocomplete)', async ({ page }) => {
    await focusBlock(page)
    await openPagePicker(page)

    await page.keyboard.type('Quick', { delay: 30 })
    await expect(
      page.locator('[data-testid="suggestion-item"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()

    // Tab should autocomplete (select first item)
    await page.keyboard.press('Tab')

    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()
    await expect(
      page.locator('[data-testid="block-link-chip"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()
  })

  test('Tab does NOT indent block when popup is open', async ({ page }) => {
    await focusBlock(page)

    await openSlashPicker(page)

    // Tab with popup open should select, not indent
    await page.keyboard.press('Tab')

    // Popup should close (command selected)
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()
  })
})

// ===========================================================================
// 3. Escape dismisses popup (not close editor)
// ===========================================================================

test.describe('Escape key with suggestion popup', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('Escape closes popup but keeps editor focused', async ({ page }) => {
    await focusBlock(page)
    await openPagePicker(page)

    // Press Escape — should dismiss popup, NOT unmount the editor
    await page.keyboard.press('Escape')

    // Popup should be gone
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()

    // Editor should still be mounted (contenteditable visible)
    await expect(page.locator('.block-editor [contenteditable="true"]')).toBeVisible()
  })

  test('second Escape after popup dismissed closes the editor', async ({ page }) => {
    await focusBlock(page)
    await openPagePicker(page)

    // First Escape: dismiss popup
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()

    // Second Escape: close editor (return to static block)
    await page.keyboard.press('Escape')
    await expect(page.locator('.block-editor [contenteditable="true"]')).not.toBeVisible()
  })
})

// ===========================================================================
// 4. Backspace edits query (not merge blocks)
// ===========================================================================

test.describe('Backspace key with suggestion popup', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('Backspace deletes query character instead of merging blocks', async ({ page }) => {
    await focusBlock(page)
    await openTagPicker(page)

    // Type a query
    await page.keyboard.type('work', { delay: 30 })

    // Backspace should delete the last character of the query
    await page.keyboard.press('Backspace')

    // Popup should still be visible (query is now "wor")
    await expect(page.locator('[data-testid="suggestion-popup"]')).toBeVisible()

    // The suggestion list should still show items matching "wor"
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list.locator('[data-testid="suggestion-item"]')).toHaveCount(
      await list.locator('[data-testid="suggestion-item"]').count(),
    )
  })
})

// ===========================================================================
// 5. Arrow keys navigate within popup
// ===========================================================================

test.describe('Arrow key navigation in popup', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('ArrowDown moves selection in suggestion list', async ({ page }) => {
    await focusBlock(page)
    await openSlashPicker(page)

    const list = page.locator('[data-testid="suggestion-list"]')
    const items = list.locator('[data-testid="suggestion-item"]')

    // First item should be selected by default
    await expect(items.first()).toHaveAttribute('aria-selected', 'true')

    // ArrowDown should move to second item
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(items.first()).toHaveAttribute('aria-selected', 'false')
  })
})
