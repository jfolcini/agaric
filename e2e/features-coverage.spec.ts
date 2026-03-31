import { expect, test } from '@playwright/test'

/**
 * E2E coverage tests for remaining feature gaps.
 *
 * Covers: Journal view modes, Search, Page editor title/add-block,
 * Trash (delete + restore), Sidebar collapse, Context menu actions,
 * External link editing/removal, and Undo/Redo.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks:
 *     GS_1: "Welcome to Block Notes! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *   PAGE_QUICK_NOTES ("Quick Notes") — 2 child blocks
 *   3 tags: work, personal, idea
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForBoot(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
}

async function openPage(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

async function focusBlock(page: import('@playwright/test').Page, index = 0) {
  await page.locator('.block-static').nth(index).click()
  const editor = page.locator('.block-editor [contenteditable="true"]')
  await expect(editor).toBeVisible({ timeout: 3000 })
  await editor.focus()
  return editor
}

// ===========================================================================
// 1. Journal view modes
// ===========================================================================

test.describe('Journal view modes', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('switching to weekly view shows week layout', async ({ page }) => {
    // Click "Week" tab in journal header
    await page.getByRole('tab', { name: 'Weekly view' }).click()

    // Weekly view renders 7 day sections (Mon-Sun)
    const sections = page.locator('section[aria-label^="Journal for"]')
    await expect(sections.first()).toBeVisible({ timeout: 3000 })
    const count = await sections.count()
    expect(count).toBe(7)
  })

  test('switching to monthly view shows month layout', async ({ page }) => {
    // Click "Month" tab
    await page.getByRole('tab', { name: 'Monthly view' }).click()

    // Monthly view renders 28-31 day sections
    const sections = page.locator('section[aria-label^="Journal for"]')
    await expect(sections.first()).toBeVisible({ timeout: 3000 })
    const count = await sections.count()
    expect(count).toBeGreaterThanOrEqual(28)
  })

  test('switching to agenda view shows task panels', async ({ page }) => {
    // Click "Agenda" tab
    await page.getByRole('tab', { name: 'Agenda view' }).click()

    // Verify the agenda view container and all three task sections are visible
    await expect(page.locator('.agenda-view')).toBeVisible({ timeout: 3000 })
    await expect(page.getByRole('button', { name: 'To Do tasks' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'In Progress tasks' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Completed tasks' })).toBeVisible()
  })
})

// ===========================================================================
// 2. Search
// ===========================================================================

test.describe('Search', () => {
  test('search panel shows results for a query', async ({ page }) => {
    await waitForBoot(page)

    // Navigate to Search view via sidebar
    await page.locator('[data-slot="sidebar"]').getByRole('button', { name: 'Search' }).click()
    await expect(page.locator('[data-testid="header-label"]', { hasText: 'Search' })).toBeVisible({
      timeout: 3000,
    })

    // Type a query matching seed data and submit
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('Welcome')
    await input.press('Enter')

    // Verify search results appear
    await expect(page.locator('.search-results')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.search-results button').first()).toBeVisible()
  })
})

// ===========================================================================
// 3. Page editor
// ===========================================================================

test.describe('Page editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('page title is editable', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Click the title to focus it
    const titleEl = page.locator('[aria-label="Page title"]')
    await titleEl.click()

    // Clear and type a new title
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Renamed Page')

    // Press Enter to blur the title (triggers save)
    await page.keyboard.press('Enter')

    // Verify the title changed
    await expect(titleEl).toContainText('Renamed Page', { timeout: 3000 })
  })

  test('Add block button creates a new block in page', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('.sortable-block').count()
    expect(countBefore).toBeGreaterThan(0)

    // Click the "Add block" button
    await page.getByRole('button', { name: 'Add block' }).click()

    // Verify a new block appears
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore + 1, { timeout: 3000 })
  })
})

// ===========================================================================
// 4. Trash
// ===========================================================================

test.describe('Trash', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('deleted block appears in trash view', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Delete the first block via hover button
    const firstBlock = page.locator('.sortable-block').first()
    await firstBlock.hover()
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible({ timeout: 3000 })
    await deleteBtn.click()

    // Navigate to Trash
    await page.getByRole('button', { name: 'Trash' }).click()

    // Verify at least one trash item is visible
    await expect(page.locator('.trash-item').first()).toBeVisible({ timeout: 3000 })
  })

  test('restore button in trash restores block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Delete a block
    const firstBlock = page.locator('.sortable-block').first()
    await firstBlock.hover()
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible({ timeout: 3000 })
    await deleteBtn.click()

    // Navigate to Trash
    await page.getByRole('button', { name: 'Trash' }).click()

    // Verify trash has items
    await expect(page.locator('.trash-item').first()).toBeVisible({ timeout: 3000 })

    // Click Restore on the first trash item
    await page.locator('.trash-restore-btn').first().click()

    // Verify the item was removed from trash
    await expect(page.locator('.trash-item')).toHaveCount(0, { timeout: 3000 })
  })
})

// ===========================================================================
// 5. Sidebar collapse
// ===========================================================================

test.describe('Sidebar', () => {
  test('sidebar collapse button hides sidebar labels', async ({ page }) => {
    await waitForBoot(page)

    // Sidebar should be expanded initially
    const sidebar = page.locator('[data-slot="sidebar"]')
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')

    // Click the Collapse button in sidebar footer
    await sidebar.getByRole('button', { name: 'Collapse' }).click()

    // Verify sidebar collapsed
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed', { timeout: 3000 })
  })
})

// ===========================================================================
// 6. Context menu actions
// ===========================================================================

test.describe('Context menu actions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('context menu Delete removes the block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('.sortable-block').count()
    expect(countBefore).toBeGreaterThan(0)

    // Right-click the first block
    await page.locator('.sortable-block').first().click({ button: 'right' })

    // Click Delete in the context menu
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible({ timeout: 3000 })
    await menu.locator('[role="menuitem"]', { hasText: 'Delete' }).click()

    // Verify block count decreased
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore - 1, { timeout: 3000 })
  })

  test('context menu Set TODO sets task state', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const firstBlock = page.locator('.sortable-block').first()

    // Right-click block
    await firstBlock.click({ button: 'right' })

    // Click "Set as TODO" in context menu
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible({ timeout: 3000 })
    await menu.locator('[role="menuitem"]', { hasText: 'Set as TODO' }).click()

    // Verify TODO checkbox appears on the block
    await expect(firstBlock.locator('.task-checkbox-todo')).toBeVisible({ timeout: 3000 })
  })

  test('context menu Set Priority cycles priority', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const firstBlock = page.locator('.sortable-block').first()

    // Right-click block
    await firstBlock.click({ button: 'right' })

    // Click "Set priority 1" in context menu
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible({ timeout: 3000 })
    await menu.locator('[role="menuitem"]', { hasText: 'Set priority 1' }).click()

    // Verify priority badge with "1" appears
    const badge = firstBlock.locator('.priority-badge')
    await expect(badge).toBeVisible({ timeout: 3000 })
    await expect(badge).toHaveText('1')
  })
})

// ===========================================================================
// 7. External link editing and removal
// ===========================================================================

test.describe('External link editing and removal', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('editing an existing link shows Update button with pre-filled URL', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text so the link wraps existing content
    await page.keyboard.press('Control+a')

    // Open link popover and apply a URL
    await page.getByRole('button', { name: 'External link' }).click()
    const urlInput = page.getByPlaceholder('https://...')
    await expect(urlInput).toBeVisible({ timeout: 3000 })
    await urlInput.fill('https://example.com')
    await urlInput.press('Enter')

    // Verify link exists in editor
    const link = page.locator('.block-editor .external-link')
    await expect(link).toBeVisible({ timeout: 3000 })

    // Wait for popover to close
    await expect(page.getByTestId('link-edit-popover')).not.toBeVisible({ timeout: 3000 })

    // Click on the link text to ensure cursor is inside the link
    await link.click()

    // Click link button again to re-open popover in edit mode
    await page.getByRole('button', { name: 'External link' }).click()

    // Verify popover shows "Update" button and pre-filled URL
    await expect(page.getByTestId('link-edit-popover')).toBeVisible({ timeout: 3000 })
    await expect(page.getByTestId('link-url-input')).toHaveValue('https://example.com')
    await expect(
      page.getByTestId('link-edit-popover').getByRole('button', { name: 'Update' }),
    ).toBeVisible()
  })

  test('Remove button in link popover removes the link', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text and apply a link
    await page.keyboard.press('Control+a')
    await page.getByRole('button', { name: 'External link' }).click()
    const urlInput = page.getByPlaceholder('https://...')
    await expect(urlInput).toBeVisible({ timeout: 3000 })
    await urlInput.fill('https://example.com')
    await urlInput.press('Enter')

    // Verify link exists
    const link = page.locator('.block-editor .external-link')
    await expect(link).toBeVisible({ timeout: 3000 })

    // Wait for popover to close
    await expect(page.getByTestId('link-edit-popover')).not.toBeVisible({ timeout: 3000 })

    // Click on the link to place cursor inside
    await link.click()

    // Re-open popover in edit mode — use Ctrl+K which dispatches the custom event
    // directly on the editor DOM, keeping the popover anchored in-viewport
    await page.keyboard.press('Control+k')
    await expect(page.getByTestId('link-edit-popover')).toBeVisible({ timeout: 3000 })

    // Click Remove — the popover portal may position outside the viewport,
    // so use dispatchEvent to bypass the viewport check
    const removeBtn = page.getByTestId('link-edit-popover').getByRole('button', { name: 'Remove' })
    await removeBtn.dispatchEvent('click')

    // Verify the link is gone from the editor
    await expect(page.locator('.block-editor .external-link')).not.toBeVisible({ timeout: 3000 })
  })
})

// ===========================================================================
// 8. Undo/Redo
// ===========================================================================

test.describe('Undo/Redo', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Z undoes the last formatting change', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text
    await page.keyboard.press('Control+a')

    // Apply Bold
    await page.keyboard.press('Control+b')
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 3000 },
    )

    // Undo
    await page.keyboard.press('Control+z')

    // Verify Bold is no longer pressed
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'false',
      { timeout: 3000 },
    )
  })

  test('Ctrl+Y redoes after undo', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text
    await page.keyboard.press('Control+a')

    // Apply Bold
    await page.keyboard.press('Control+b')
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 3000 },
    )

    // Undo
    await page.keyboard.press('Control+z')
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'false',
      { timeout: 3000 },
    )

    // Redo
    await page.keyboard.press('Control+y')

    // Verify Bold is pressed again
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 3000 },
    )
  })
})
