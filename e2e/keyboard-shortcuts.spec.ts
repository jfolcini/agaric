import { expect, test } from '@playwright/test'

/**
 * E2E tests for keyboard shortcuts.
 *
 * Covers formatting shortcuts, block navigation, block organization,
 * task/priority shortcuts, global shortcuts, and link shortcuts.
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
  return editor
}

// ===========================================================================
// 1. Formatting shortcuts (in focused editor)
// ===========================================================================

test.describe('Formatting shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+B toggles bold on selected text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text in the editor
    await page.keyboard.press('Control+a')

    // Press Ctrl+B to toggle bold
    await page.keyboard.down('Control')
    await page.keyboard.press('b')
    await page.keyboard.up('Control')

    // Verify the Bold button shows aria-pressed="true"
    const boldBtn = page.getByRole('button', { name: 'Bold' })
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 })
  })

  test('Ctrl+I toggles italic on selected text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text in the editor
    await page.keyboard.press('Control+a')

    // Press Ctrl+I to toggle italic
    await page.keyboard.down('Control')
    await page.keyboard.press('i')
    await page.keyboard.up('Control')

    // Verify the Italic button shows aria-pressed="true"
    const italicBtn = page.getByRole('button', { name: 'Italic' })
    await expect(italicBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 })
  })

  test('Ctrl+Shift+C toggles code block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Press Ctrl+Shift+C to toggle code block
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('c')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // Verify Code block button shows aria-pressed="true"
    const codeBlockBtn = page.getByRole('button', { name: 'Code block' })
    await expect(codeBlockBtn).toHaveAttribute('aria-pressed', 'true', { timeout: 3000 })
  })
})

// ===========================================================================
// 2. Block navigation
// ===========================================================================

test.describe('Block navigation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Arrow Down at end moves to next block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Focus the first block
    await focusBlock(page, 0)

    // Get text of first block for comparison later
    const firstBlockText = await page.locator('.block-editor [contenteditable="true"]').innerText()

    // Move to end and press ArrowDown to navigate to next block
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowDown')

    // Wait for the editor to appear on the second block
    const editor = page.locator('.block-editor [contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 3000 })

    // The editor content should be different from the first block
    const newText = await editor.innerText()
    expect(newText).not.toBe(firstBlockText)
  })

  test('Arrow Up at start moves to previous block', async ({ page }) => {
    // Use Quick Notes page (2 blocks with simpler content)
    await openPage(page, 'Quick Notes')

    // Click the second block directly (skip the editor.focus() from focusBlock helper)
    await page.locator('.block-static').nth(1).click()
    const editor = page.locator('.block-editor [contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 3000 })
    const secondBlockId = await page.locator('.block-editor').getAttribute('data-block-id')

    // Wait for React effects to settle (useEffect keydown listener reattach)
    await page.waitForTimeout(300)

    // Move cursor to the very start with Home key
    await page.keyboard.press('Home')

    // Press ArrowUp — at position ≤ 1, the handler triggers onFocusPrev
    await page.keyboard.press('ArrowUp')

    // Wait for the editor to switch to a different block
    await expect(page.locator(`.block-editor:not([data-block-id="${secondBlockId}"])`)).toBeVisible(
      { timeout: 5000 },
    )
  })
})

// ===========================================================================
// 3. Block organization
// ===========================================================================

test.describe('Block organization', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Tab indents block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Use the third block (index 2, GS_3 — plain text, avoids link chips in GS_2)
    const targetBlock = page.locator('.sortable-block').nth(2)
    const initialPadding = await targetBlock.evaluate(
      (el) => window.getComputedStyle(el).paddingLeft,
    )

    // Focus the third block
    await focusBlock(page, 2)

    // Press Tab to indent
    await page.keyboard.press('Tab')

    // Wait a moment for the indent to apply
    await page.waitForTimeout(300)

    // Verify the block now has increased paddingLeft (indented)
    const newPadding = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
    expect(Number.parseInt(newPadding, 10)).toBeGreaterThan(Number.parseInt(initialPadding, 10))
  })

  test('Shift+Tab dedents block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Focus the third block (index 2, GS_3) and indent it first
    await focusBlock(page, 2)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)

    // Get the indented paddingLeft
    const targetBlock = page.locator('.sortable-block').nth(2)
    const indentedPadding = await targetBlock.evaluate(
      (el) => window.getComputedStyle(el).paddingLeft,
    )

    // Now press Shift+Tab to dedent (editor should still be open)
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(300)

    // Verify paddingLeft decreased
    const finalPadding = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
    expect(Number.parseInt(finalPadding, 10)).toBeLessThan(Number.parseInt(indentedPadding, 10))
  })

  test('Ctrl+Shift+ArrowUp moves block up', async ({ page }) => {
    // Use Quick Notes (2 blocks — simpler and more reliable)
    await openPage(page, 'Quick Notes')

    // Capture original block order via data-block-id
    const blocks = page.locator('.sortable-block')
    const _originalFirstId = await blocks.nth(0).getAttribute('data-block-id')
    const originalSecondId = await blocks.nth(1).getAttribute('data-block-id')

    // Focus the second block and move it up
    await focusBlock(page, 1)

    // Press Ctrl+Shift+ArrowUp to move block up
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // Press Escape to exit editor
    await page.keyboard.press('Escape')

    // Wait for the reorder to settle — use Playwright auto-retry
    // After MoveUp, the second block should now be first
    await expect(page.locator(`.sortable-block[data-block-id="${originalSecondId}"]`)).toBeVisible({
      timeout: 5000,
    })

    // Verify the order swapped: original second block is now first
    const newFirstId = await blocks.nth(0).getAttribute('data-block-id')
    expect(newFirstId).toBe(originalSecondId)
  })

  test('Ctrl+Shift+ArrowDown moves block down', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Get text of the first two blocks in static view
    const _firstBlockText = await page.locator('.block-static').nth(0).innerText()
    const secondBlockText = await page.locator('.block-static').nth(1).innerText()

    // Focus the first block
    await focusBlock(page, 0)

    // Press Ctrl+Shift+ArrowDown to move block down
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // Wait for the reorder to take effect
    await page.waitForTimeout(300)

    // Press Escape to leave editing mode
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)

    // Verify the blocks swapped: old second block is now first
    const newFirstBlockText = await page.locator('.block-static').nth(0).innerText()
    expect(newFirstBlockText).toBe(secondBlockText)
  })
})

// ===========================================================================
// 4. Task/Priority shortcuts
// ===========================================================================

test.describe('Task and priority shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Enter cycles task state', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Focus the first block
    await focusBlock(page)

    // The first sortable block before Ctrl+Enter should have the empty checkbox
    const firstBlock = page.locator('.sortable-block').first()
    await expect(firstBlock.locator('.task-checkbox-empty')).toBeVisible({ timeout: 3000 })

    // Press Ctrl+Enter to cycle task state: none -> TODO
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')

    // The empty checkbox should disappear (task state changed)
    await expect(firstBlock.locator('.task-checkbox-empty')).not.toBeVisible({ timeout: 5000 })
  })

  test('Ctrl+. toggles collapse on block with children', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Indent the fourth block (index 3, GS_4) under the third (index 2, GS_3 plain text)
    await focusBlock(page, 3)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)

    // Close the editor so only the document-level Ctrl+. handler fires
    // (Avoids double-toggle: both editor-level and document-level handlers
    //  call toggleCollapse, which would net to zero change.)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // The third block (GS_3) should now have a collapse chevron (hasChildren)
    const parentBlock = page.locator('.sortable-block').nth(2)
    const chevron = parentBlock.locator('.collapse-toggle')
    await expect(chevron).toBeVisible({ timeout: 3000 })
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')

    // Click the collapse chevron to toggle collapse
    await chevron.click()

    // Verify the chevron now shows collapsed (aria-expanded=false)
    await expect(chevron).toHaveAttribute('aria-expanded', 'false', { timeout: 3000 })
  })
})

// ===========================================================================
// 5. Global shortcuts
// ===========================================================================

test.describe('Global shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+F opens search view', async ({ page }) => {
    // Press Ctrl+F while on the journal view
    await page.keyboard.down('Control')
    await page.keyboard.press('f')
    await page.keyboard.up('Control')

    // Verify the search view is active (header shows Search label)
    await expect(page.locator('[data-testid="header-label"]', { hasText: 'Search' })).toBeVisible({
      timeout: 3000,
    })
  })

  test('Ctrl+N creates new page', async ({ page }) => {
    // Press Ctrl+N to create a new page
    await page.keyboard.down('Control')
    await page.keyboard.press('n')
    await page.keyboard.up('Control')

    // Verify navigation to the new page (page editor with "Untitled" title)
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible({ timeout: 3000 })
    await expect(page.locator('[aria-label="Page title"]')).toContainText('Untitled')
  })

  test('Alt+Left navigates journal back', async ({ page }) => {
    // We start on the journal view, get the current date display
    const initialDate = await page.locator('[data-testid="date-display"]').innerText()

    // Press Alt+Left to go to previous day
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')

    // Wait for the date to change
    await page.waitForTimeout(300)

    // Verify the date display changed
    const newDate = await page.locator('[data-testid="date-display"]').innerText()
    expect(newDate).not.toBe(initialDate)
  })

  test('Alt+Right navigates journal forward', async ({ page }) => {
    // First go back a day so we can go forward
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')
    await page.waitForTimeout(300)

    const backDate = await page.locator('[data-testid="date-display"]').innerText()

    // Press Alt+Right to go forward
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Alt')

    await page.waitForTimeout(300)

    // Verify the date display changed again
    const forwardDate = await page.locator('[data-testid="date-display"]').innerText()
    expect(forwardDate).not.toBe(backDate)
  })

  test('Alt+T goes to today', async ({ page }) => {
    // Get today's date display
    const todayDate = await page.locator('[data-testid="date-display"]').innerText()

    // Navigate back a day first
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')
    await page.waitForTimeout(300)

    // Verify we moved away
    const backDate = await page.locator('[data-testid="date-display"]').innerText()
    expect(backDate).not.toBe(todayDate)

    // Press Alt+T to go to today
    await page.keyboard.down('Alt')
    await page.keyboard.press('t')
    await page.keyboard.up('Alt')

    await page.waitForTimeout(300)

    // Verify date is back to today
    const currentDate = await page.locator('[data-testid="date-display"]').innerText()
    expect(currentDate).toBe(todayDate)
  })

  test('? opens keyboard shortcuts panel', async ({ page }) => {
    // Click on the header to ensure no input/textarea/contenteditable is focused
    await page.locator('header').click()
    await page.waitForTimeout(200)

    // Type ? using keyboard.type which dispatches keydown with key='?'
    await page.keyboard.type('?')

    // Verify the shortcuts sheet is visible (it has a data-testid="shortcuts-table")
    await expect(page.locator('[data-testid="shortcuts-table"]')).toBeVisible({ timeout: 3000 })

    // Also verify the heading title (use role to avoid ambiguity with body text)
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible({
      timeout: 3000,
    })
  })
})

// ===========================================================================
// 6. Link shortcuts
// ===========================================================================

test.describe('Link shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+K opens link popover', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Press Ctrl+K to open the link popover
    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')

    // Verify the link edit popover opens
    await expect(page.getByTestId('link-edit-popover')).toBeVisible({ timeout: 3000 })
    await expect(page.getByPlaceholder('https://...')).toBeVisible()
  })
})
