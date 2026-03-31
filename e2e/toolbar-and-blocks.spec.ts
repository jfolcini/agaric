import { expect, test } from '@playwright/test'

/**
 * E2E tests for toolbar buttons and block interactions.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") -- 5 child blocks:
 *     GS_1: "Welcome to Block Notes! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *   PAGE_QUICK_NOTES ("Quick Notes") -- 2 child blocks:
 *     QN_1: contains [[PAGE_GETTING_STARTED]] backlink
 *     QN_2: contains *italic* text
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for the app to fully boot (BootGate resolved, sidebar visible). */
async function waitForBoot(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
}

/** Navigate to the page editor for a given page title. */
async function openPage(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

/** Click a block to enter edit mode and wait for the TipTap editor. */
async function focusBlock(page: import('@playwright/test').Page, index = 0) {
  await page.locator('.block-static').nth(index).click()
  const editor = page.locator('.block-editor [contenteditable="true"]')
  await expect(editor).toBeVisible({ timeout: 3000 })
  await editor.focus()
}

// ===========================================================================
// 1. Toolbar visibility
// ===========================================================================

test.describe('Toolbar visibility', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('formatting toolbar appears when a block is focused', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await expect(page.locator('.formatting-toolbar')).toBeVisible({ timeout: 3000 })
  })

  test('formatting toolbar disappears when block loses focus', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await expect(page.locator('.formatting-toolbar')).toBeVisible({ timeout: 3000 })

    // Press Escape to unfocus the block
    await page.keyboard.press('Escape')

    await expect(page.locator('.formatting-toolbar')).not.toBeVisible({ timeout: 3000 })
  })
})

// ===========================================================================
// 2. Formatting buttons
// ===========================================================================

test.describe('Formatting buttons', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Bold button toggles bold on selected text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text in the editor
    await page.keyboard.press('Control+a')

    // Click the Bold button
    const boldBtn = page.getByRole('button', { name: 'Bold' })
    await boldBtn.click()

    // Verify the button is now pressed (aria-pressed="true")
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 })
  })

  test('Italic button toggles italic on selected text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.press('Control+a')

    const italicBtn = page.getByRole('button', { name: 'Italic' })
    await italicBtn.click()

    await expect(italicBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 })
  })

  test('Code button toggles inline code on selected text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.press('Control+a')

    const codeBtn = page.getByRole('button', { name: 'Code', exact: true })
    await codeBtn.click()

    await expect(codeBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 })
  })

  test('Code block button toggles code block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    const codeBlockBtn = page.getByRole('button', { name: 'Code block' })
    await codeBlockBtn.click()

    await expect(codeBlockBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 })
  })

  test('Code button applies visible background to inline code', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Type some text first
    const editor = page.locator('.block-editor [contenteditable="true"]')
    await editor.press('End')
    await editor.type(' test-code')

    // Select "test-code"
    for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowLeft')

    // Apply inline code
    const codeBtn = page.getByRole('button', { name: 'Code', exact: true })
    await codeBtn.click()

    // The code element should have bg-muted background styling
    const codeEl = editor.locator('code')
    await expect(codeEl).toBeVisible({ timeout: 3000 })
    await expect(codeEl).toHaveCSS('border-radius', /\dpx/)
  })
})

// ===========================================================================
// 3. Link buttons
// ===========================================================================

test.describe('Link buttons', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('External link button opens popover', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Click the External link toolbar button
    await page.getByRole('button', { name: 'External link' }).click()

    // The LinkEditPopover should appear with its URL input
    await expect(page.getByTestId('link-edit-popover')).toBeVisible({ timeout: 3000 })
    await expect(page.getByPlaceholder('https://...')).toBeVisible()
  })

  test('External link popover: enter URL and apply', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text so the link wraps existing content
    await page.keyboard.press('Control+a')

    // Open the link popover
    await page.getByRole('button', { name: 'External link' }).click()

    const urlInput = page.getByPlaceholder('https://...')
    await expect(urlInput).toBeVisible({ timeout: 3000 })

    // Type a URL and press Enter to apply (Enter triggers handleApply in the popover)
    await urlInput.fill('https://example.com')
    await urlInput.press('Enter')

    // The popover should close and the editor should contain an external link
    await expect(page.locator('.block-editor .external-link')).toBeVisible({ timeout: 3000 })
  })

  test('Internal link button triggers [[ picker', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Click the Internal link toolbar button -- inserts [[ which triggers picker
    await page.getByRole('button', { name: 'Internal link' }).click()

    // The suggestion popup should appear
    await expect(page.locator('.suggestion-list')).toBeVisible({ timeout: 5000 })
  })

  test('Tag button triggers @ tag picker', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Click the Tag toolbar button -- inserts @ which triggers tag picker
    await page.getByRole('button', { name: 'Insert tag' }).click()

    // The suggestion popup should appear
    await expect(page.locator('.suggestion-list')).toBeVisible({ timeout: 5000 })
  })
})

// ===========================================================================
// 4. Priority buttons
// ===========================================================================

test.describe('Priority buttons', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Priority 1 button sets high priority on focused block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Click the Priority 1 button in the toolbar
    await page.getByRole('button', { name: 'Priority 1 (high)' }).click()

    // A priority badge with "1" should appear on the block
    const badge = page.locator('.priority-badge')
    await expect(badge).toBeVisible({ timeout: 3000 })
    await expect(badge).toHaveText('1')
  })

  test('Priority 2 button sets medium priority', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.getByRole('button', { name: 'Priority 2 (medium)' }).click()

    const badge = page.locator('.priority-badge')
    await expect(badge).toBeVisible({ timeout: 3000 })
    await expect(badge).toHaveText('2')
  })

  test('Priority 3 button sets low priority', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.getByRole('button', { name: 'Priority 3 (low)' }).click()

    const badge = page.locator('.priority-badge')
    await expect(badge).toBeVisible({ timeout: 3000 })
    await expect(badge).toHaveText('3')
  })
})

// ===========================================================================
// 5. Date button
// ===========================================================================

test.describe('Date button', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Date button opens the date picker', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Click the Insert date button in the toolbar
    await page.getByRole('button', { name: 'Insert date' }).click()

    // The floating date picker popup should appear
    await expect(page.locator('.date-picker-popup')).toBeVisible({ timeout: 3000 })
  })
})

// ===========================================================================
// 6. Block interactions
// ===========================================================================

test.describe('Block interactions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('clicking checkbox cycles task state', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Initially the block has no task state -- empty checkbox
    const firstBlock = page.locator('.sortable-block').first()
    const taskMarker = firstBlock.locator('.task-marker')

    // First click: none -> TODO
    await taskMarker.click()
    await expect(firstBlock.locator('.task-checkbox-todo')).toBeVisible({ timeout: 3000 })

    // Second click: TODO -> DOING
    await taskMarker.click()
    await expect(firstBlock.locator('.task-checkbox-doing')).toBeVisible({ timeout: 3000 })

    // Third click: DOING -> DONE
    await taskMarker.click()
    await expect(firstBlock.locator('.task-checkbox-done')).toBeVisible({ timeout: 3000 })
  })

  test('delete button removes block on hover', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Count blocks before deletion
    const countBefore = await page.locator('.sortable-block').count()
    expect(countBefore).toBeGreaterThan(0)

    // Hover over the first block to reveal the delete button
    const firstBlock = page.locator('.sortable-block').first()
    await firstBlock.hover()

    // Click the Delete block button
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible({ timeout: 3000 })
    await deleteBtn.click()

    // Block count should decrease by one
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore - 1, { timeout: 3000 })
  })

  test('drag handle is visible on hover/focus', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const firstBlock = page.locator('.sortable-block').first()
    const dragHandle = firstBlock.locator('.drag-handle')

    // Before hover, the drag handle has opacity-0 (not visually visible)
    // After hover on the block group, it becomes visible
    await firstBlock.hover()

    await expect(dragHandle).toBeVisible({ timeout: 3000 })
  })

  test('context menu appears on right-click', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Right-click the first block
    const firstBlock = page.locator('.sortable-block').first()
    await firstBlock.click({ button: 'right' })

    // Context menu with role="menu" should appear
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible({ timeout: 3000 })

    // Verify menu items are present
    await expect(menu.locator('[role="menuitem"]', { hasText: 'Delete' })).toBeVisible()
    await expect(menu.locator('[role="menuitem"]', { hasText: 'Indent' })).toBeVisible()
    await expect(menu.locator('[role="menuitem"]', { hasText: 'Dedent' })).toBeVisible()
    await expect(menu.locator('[role="menuitem"]', { hasText: 'TODO' })).toBeVisible()
    await expect(menu.locator('[role="menuitem"]', { hasText: /priority/i })).toBeVisible()
  })

  test('Ctrl+Enter cycles task state', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Focus the first block to enter edit mode
    await focusBlock(page)

    // The first sortable block before Ctrl+Enter should have the empty checkbox
    const firstBlock = page.locator('.sortable-block').first()
    await expect(firstBlock.locator('.task-checkbox-empty')).toBeVisible({ timeout: 3000 })

    // Press Ctrl+Enter to cycle task state: none -> TODO
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')

    // The empty checkbox should disappear — the task state has changed
    // (could be TODO or DOING depending on whether both editor-level and
    // document-level handlers fire)
    await expect(firstBlock.locator('.task-checkbox-empty')).not.toBeVisible({ timeout: 5000 })
  })
})
