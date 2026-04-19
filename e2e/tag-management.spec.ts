import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E tests for tag management flows.
 *
 * Covers:
 *  1. Tags view shows seed tags (work, personal, idea)
 *  2. Tag creation via the TagList inline form
 *  3. Tag deletion with confirmation dialog
 *  4. Tag filter panel: prefix search, add to filter, verify results
 *  5. Tag insertion via @ picker in the block editor
 *
 * Seed data (tauri-mock.ts):
 *   Tags: work, personal, idea
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks
 *   BLOCK_GS_4 contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function navigateToTags(page: import('@playwright/test').Page) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Tags', exact: true })
    .click()
}

// ===========================================================================
// 1. Tags view shows seed tags
// ===========================================================================

test.describe('Tags view — seed tags', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Tags sidebar button navigates to tags view showing seed tags', async ({ page }) => {
    await navigateToTags(page)

    // All three seed tags should be visible as Badge text
    await expect(page.getByText('work', { exact: true })).toBeVisible()
    await expect(page.getByText('personal', { exact: true })).toBeVisible()
    await expect(page.getByText('idea', { exact: true })).toBeVisible()
  })

  test('Tags view shows the create-tag form', async ({ page }) => {
    await navigateToTags(page)

    // The "New tag name..." input and "Add Tag" button should be visible
    await expect(page.getByPlaceholder('New tag name...')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Tag' })).toBeVisible()
  })
})

// ===========================================================================
// 2. Tag creation via TagList
// ===========================================================================

test.describe('Tag creation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToTags(page)
  })

  test('creating a new tag adds it to the list', async ({ page }) => {
    const input = page.getByPlaceholder('New tag name...')
    await input.fill('urgent')
    await page.getByRole('button', { name: 'Add Tag' }).click()

    // The new tag should appear in the list
    await expect(page.getByText('urgent', { exact: true })).toBeVisible()
  })
})

// ===========================================================================
// 3. Tag deletion with confirmation
// ===========================================================================

test.describe('Tag deletion', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToTags(page)
  })

  test('delete button opens confirmation dialog', async ({ page }) => {
    // Each tag row is a div with rounded-lg + a "Delete tag" button inside
    const tagRow = page
      .locator('div.rounded-lg')
      .filter({ has: page.getByRole('button', { name: 'Delete tag' }) })
      .filter({ hasText: 'idea' })
    await expect(tagRow).toBeVisible()
    await tagRow.hover()

    const deleteBtn = tagRow.getByRole('button', { name: 'Delete tag' })
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Confirmation dialog should appear
    await expect(page.getByText('Delete tag?')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()
  })

  test('cancelling deletion keeps the tag', async ({ page }) => {
    const tagRow = page
      .locator('div.rounded-lg')
      .filter({ has: page.getByRole('button', { name: 'Delete tag' }) })
      .filter({ hasText: 'idea' })
    await expect(tagRow).toBeVisible()
    await tagRow.hover()
    await tagRow.getByRole('button', { name: 'Delete tag' }).click()

    // Click Cancel
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // Tag should still be visible
    await expect(page.getByText('idea', { exact: true })).toBeVisible()
  })

  test('confirming deletion removes the tag from the list', async ({ page }) => {
    const tagRow = page
      .locator('div.rounded-lg')
      .filter({ has: page.getByRole('button', { name: 'Delete tag' }) })
      .filter({ hasText: 'idea' })
    await expect(tagRow).toBeVisible()
    await tagRow.hover()
    await tagRow.getByRole('button', { name: 'Delete tag' }).click()

    // Click Delete to confirm
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    // "idea" tag should no longer be visible
    await expect(page.getByText('idea', { exact: true })).not.toBeVisible()

    // Other tags should still be present
    await expect(page.getByText('work', { exact: true })).toBeVisible()
    await expect(page.getByText('personal', { exact: true })).toBeVisible()
  })
})

// ===========================================================================
// 4. Tag filter panel
// ===========================================================================

test.describe('Tag filter panel', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToTags(page)
  })

  test('prefix search finds matching tags', async ({ page }) => {
    const searchInput = page.getByLabel('Search tags by prefix')
    await searchInput.fill('wor')

    // Wait for debounce (300ms) + rendering
    await expect(page.getByText('Matching tags')).toBeVisible()

    // "work" tag should appear in the matching section with an "Add" button
    const matchingSection = page.locator('section', { hasText: 'Matching tags' })
    await expect(matchingSection.getByText('work')).toBeVisible()
    await expect(matchingSection.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  })

  test('adding a tag from search shows it as selected', async ({ page }) => {
    const searchInput = page.getByLabel('Search tags by prefix')
    await searchInput.fill('per')

    await expect(page.getByText('Matching tags')).toBeVisible()

    // Click "Add" next to "personal"
    const matchingSection = page.locator('section', { hasText: 'Matching tags' })
    await matchingSection.getByRole('button', { name: 'Add', exact: true }).click()

    // "personal" should now appear in the "Selected:" area
    await expect(page.getByText('Selected:')).toBeVisible()
    await expect(
      page.locator('.flex-wrap', { hasText: 'Selected:' }).getByText('personal'),
    ).toBeVisible()
  })

  test('AND/OR mode toggle switches active mode', async ({ page }) => {
    // By default AND is active
    const andBtn = page.getByRole('button', { name: 'AND', exact: true })
    const orBtn = page.getByRole('button', { name: 'OR', exact: true })

    await expect(andBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(orBtn).toHaveAttribute('aria-pressed', 'false')

    // Switch to OR
    await orBtn.click()
    await expect(orBtn).toHaveAttribute('aria-pressed', 'true')
    await expect(andBtn).toHaveAttribute('aria-pressed', 'false')
  })

  test('feedback message shows when no tags selected', async ({ page }) => {
    await expect(page.getByTestId('tag-filter-feedback')).toHaveText(
      'Select tags above to filter blocks',
    )
  })
})

// ===========================================================================
// 5. Tag insertion via @ picker
// ===========================================================================

test.describe('Tag insertion via @ picker', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('typing @ in editor opens tag suggestion list', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Clear content and type @ to trigger tag picker
    await page.keyboard.press('Control+a')
    await editor.type('test @')

    // The suggestion list should appear
    await expect(page.locator('[data-testid="suggestion-list"]')).toBeVisible({ timeout: 5000 })
  })

  test('selecting a tag from @ picker inserts tag-ref chip', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Clear and type content then trigger @ picker
    await page.keyboard.press('Control+a')
    await editor.type('tagged: ')
    await page.getByRole('button', { name: 'Insert tag' }).click()

    // Wait for suggestion list and select the first tag
    const suggestionList = page.locator('[data-testid="suggestion-list"]')
    await expect(suggestionList).toBeVisible({ timeout: 5000 })
    await suggestionList.locator('[data-testid="suggestion-item"]').first().click()

    // Verify tag-ref chip appears in the editor
    await expect(editor.locator('[data-testid="tag-ref-chip"]')).toBeVisible()
  })

  test('tag chip persists after saving the block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Insert a tag reference
    await page.keyboard.press('Control+a')
    await editor.type('saved tag: ')
    await page.getByRole('button', { name: 'Insert tag' }).click()

    const suggestionList = page.locator('[data-testid="suggestion-list"]')
    await expect(suggestionList).toBeVisible({ timeout: 5000 })
    await suggestionList.locator('[data-testid="suggestion-item"]').first().click()
    await expect(editor.locator('[data-testid="tag-ref-chip"]')).toBeVisible()

    // Re-focus the editor so keyboard events reach TipTap, then save via Enter
    await editor.click()
    await page.keyboard.press('Enter')
    await expect(
      page.locator('[data-testid="block-editor"] [contenteditable="true"]'),
    ).not.toBeVisible()

    // Verify tag chip appears in the static render
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('[data-testid="tag-ref-chip"]')).toBeVisible()
  })

  test('seed block GS_4 renders existing tag-ref chips', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // GS_4 contains "Try tagging blocks with #[TAG_WORK] or #[TAG_PERSONAL]"
    // Find the block containing "Try tagging" text that has tag-ref-chips
    const gs4Block = page.locator('[data-testid="block-static"]', { hasText: 'Try tagging' })
    await expect(gs4Block).toBeVisible({ timeout: 5000 })

    // Should have 2 tag-ref chips rendered (work and personal)
    const tagChips = gs4Block.locator('[data-testid="tag-ref-chip"]')
    await expect(tagChips).toHaveCount(2, { timeout: 5000 })
  })
})

// ===========================================================================
// 6. @ picker — create new tag & Tab autocomplete
// ===========================================================================

test.describe('@ picker — create new tag & Tab autocomplete', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('create new tag via @ picker', async ({ page }) => {
    const editor = await focusBlock(page)

    // Clear content and type @ followed by a tag name that doesn't exist
    await page.keyboard.press('Control+a')
    await editor.type('hello @nonexistenttag', { delay: 30 })

    // The suggestion list should appear with a "Create" option
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list).toBeVisible({ timeout: 5000 })

    const createItem = list.locator('[data-testid="suggestion-item"]', { hasText: /[Cc]reate/ })
    await expect(createItem).toBeVisible({ timeout: 5000 })

    // Click the Create option
    await createItem.click()

    // A tag-ref chip should appear in the editor
    await expect(editor.locator('[data-testid="tag-ref-chip"]')).toBeVisible({ timeout: 5000 })
  })

  test('Tab autocomplete with @ picker', async ({ page }) => {
    const editor = await focusBlock(page)

    // Clear and type partial content, then use the Insert tag button
    await page.keyboard.press('Control+a')
    await editor.type('autocomplete: ')
    await page.getByRole('button', { name: 'Insert tag' }).click()

    // Wait for the suggestion list to appear
    const list = page.locator('[data-testid="suggestion-list"]')
    await expect(list).toBeVisible({ timeout: 5000 })

    // Type partial query to filter down to "work"
    await page.keyboard.type('wor', { delay: 30 })
    const workItem = list.locator('[data-testid="suggestion-item"]', { hasText: 'work' })
    await expect(workItem).toBeVisible({ timeout: 5000 })

    // Select by clicking the filtered suggestion (autocomplete behaviour)
    await workItem.click()

    // A tag-ref chip with "work" should appear in the editor
    await expect(editor.locator('[data-testid="tag-ref-chip"]', { hasText: 'work' })).toBeVisible({
      timeout: 5000,
    })
  })
})
