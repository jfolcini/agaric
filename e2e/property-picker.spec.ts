import { expect, test } from '@playwright/test'
import { focusBlock, openPage, waitForBoot } from './helpers'

/**
 * E2E tests for the :: property picker.
 *
 * Seed data (tauri-mock.ts):
 *   list_property_keys returns keys gathered from the `properties` map
 *   plus the hard-coded 'todo' and 'priority' keys.  With default seed
 *   data the full sorted list is:
 *     completed_at, context, priority, project, template, todo
 *
 * Property picker behaviour:
 *   - Typing :: in the editor opens the suggestion popup
 *   - The popup lists property keys as suggestion items
 *   - Selecting an item inserts `key:: ` (key + double-colon + space)
 *   - Escape dismisses without inserting
 *   - Typing further characters after :: filters the list
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type :: to open the property picker and wait for the popup. */
async function openPropertyPicker(page: import('@playwright/test').Page) {
  await page.keyboard.press('End')
  await page.keyboard.type(' ::', { delay: 30 })
  const popup = page.locator('[data-testid="suggestion-popup"]')
  await expect(popup).toBeVisible()
  return popup
}

// ===========================================================================
// Property picker — :: trigger
// ===========================================================================

test.describe('Property picker — :: trigger', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test(':: trigger opens suggestion popup', async ({ page }) => {
    await focusBlock(page)
    await openPropertyPicker(page)
    await expect(page.locator('[data-testid="suggestion-popup"]')).toBeVisible()
  })

  test('picker shows property definitions', async ({ page }) => {
    await focusBlock(page)
    await openPropertyPicker(page)
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list).toBeVisible()
    // Seed data provides at least: completed_at, context, priority, project, template, todo
    const items = list.locator('[data-testid="suggestion-item"]')
    await expect(items).not.toHaveCount(0)
    // Verify a couple of known seeded property keys are present
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'context' }),
    ).toBeVisible()
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'project' }),
    ).toBeVisible()
  })

  test('selecting a property inserts key:: text', async ({ page }) => {
    const editor = await focusBlock(page)
    await openPropertyPicker(page)

    // Type 'con' to narrow to 'context'
    await page.keyboard.type('con', { delay: 30 })
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'context' }),
    ).toBeVisible()

    // Press Enter to select
    await page.keyboard.press('Enter')

    // Popup should close
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()

    // The editor should contain the property key followed by ::
    await expect(editor).toContainText('context::')
  })

  test('Escape dismisses the picker without inserting', async ({ page }) => {
    await focusBlock(page)

    await openPropertyPicker(page)
    await expect(page.locator('[data-testid="suggestion-popup"]')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()

    // Editor should still be mounted
    await expect(editor).toBeVisible()
  })

  test('picker filters results as user types', async ({ page }) => {
    await focusBlock(page)
    await openPropertyPicker(page)
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list).toBeVisible()
    const countBefore = await list.locator('[data-testid="suggestion-item"]').count()

    // Type 'pro' — should match 'project' (and maybe 'priority') but not all 6
    await page.keyboard.type('pro', { delay: 30 })
    const countAfter = await list.locator('[data-testid="suggestion-item"]').count()
    expect(countAfter).toBeLessThanOrEqual(countBefore)
    expect(countAfter).toBeGreaterThan(0)

    // 'project' should be visible
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'project' }),
    ).toBeVisible()
  })

  test('clicking a suggestion item selects it', async ({ page }) => {
    const editor = await focusBlock(page)
    await openPropertyPicker(page)
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list).toBeVisible()

    // Click the 'context' item directly
    const contextItem = list.locator('[data-testid="suggestion-item"]', { hasText: 'context' })
    await expect(contextItem).toBeVisible()
    await contextItem.click()

    // Popup should close
    await expect(page.locator('[data-testid="suggestion-popup"]')).not.toBeVisible()

    // The editor should contain the property key
    await expect(editor).toContainText('context::')
  })

  test('ArrowDown navigates suggestion items', async ({ page }) => {
    await focusBlock(page)
    await openPropertyPicker(page)
    const list = page.locator('[data-testid="suggestion-list"]')
    const items = list.locator('[data-testid="suggestion-item"]')

    // First item should be selected by default
    await expect(items.first()).toHaveAttribute('aria-selected', 'true')

    // ArrowDown should move selection to second item
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(items.first()).toHaveAttribute('aria-selected', 'false')
  })
})
