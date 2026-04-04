import { expect, test } from '@playwright/test'
import { focusBlock, openPage, waitForBoot } from './helpers'

/**
 * E2E tests for keyboard shortcuts.
 *
 * Covers formatting shortcuts, block navigation, block organization,
 * task/priority shortcuts, global shortcuts, and link shortcuts.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") -- 5 child blocks:
 *     GS_1: "Welcome to Agaric! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *   PAGE_QUICK_NOTES ("Quick Notes") -- 2 child blocks:
 *     QN_1: contains [[PAGE_GETTING_STARTED]] backlink
 *     QN_2: contains *italic* text
 */

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
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'true')
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
    await expect(italicBtn).toHaveAttribute('aria-pressed', 'true')
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
    await expect(codeBlockBtn).toHaveAttribute('aria-pressed', 'true')
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
    await expect(editor).toBeVisible()

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
    await expect(editor).toBeVisible()
    const secondBlockId = await page.locator('.block-editor').getAttribute('data-block-id')

    // Ensure editor is focused and interactive (React keydown listener attached)
    await editor.focus()
    await expect(editor).toBeFocused()

    // Navigate to previous block via Home+ArrowUp
    // Retry until the React useEffect keydown handler is ready
    await expect(async () => {
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowUp')
      await expect(
        page.locator(`.block-editor:not([data-block-id="${secondBlockId}"])`),
      ).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 5000 })
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

    // Wait for indent to apply and verify the block now has increased paddingLeft
    await expect
      .poll(
        async () => {
          const p = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
          return Number.parseInt(p, 10)
        },
        ,
      )
      .toBeGreaterThan(Number.parseInt(initialPadding, 10))
  })

  test('Shift+Tab dedents block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Capture pre-indent padding for the third block
    const targetBlock = page.locator('.sortable-block').nth(2)
    const basePadding = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)

    // Focus the third block (index 2, GS_3) and indent it first
    await focusBlock(page, 2)
    await page.keyboard.press('Tab')

    // Wait for indent to apply (padding increases from base)
    await expect
      .poll(
        async () => {
          const p = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
          return Number.parseInt(p, 10)
        },
        ,
      )
      .toBeGreaterThan(Number.parseInt(basePadding, 10))

    // Get the indented paddingLeft
    const indentedPadding = await targetBlock.evaluate(
      (el) => window.getComputedStyle(el).paddingLeft,
    )

    // Now press Shift+Tab to dedent (editor should still be open)
    await page.keyboard.press('Shift+Tab')

    // Wait for dedent to apply and verify paddingLeft decreased
    await expect
      .poll(
        async () => {
          const p = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
          return Number.parseInt(p, 10)
        },
        ,
      )
      .toBeLessThan(Number.parseInt(indentedPadding, 10))
  })

  test('Ctrl+Shift+ArrowUp moves block up', async ({ page }) => {
    // Use Quick Notes (2 blocks — simpler and more reliable)
    await openPage(page, 'Quick Notes')

    // Capture original block order via data-block-id
    const blocks = page.locator('.sortable-block')
    const _originalFirstId = await blocks.nth(0).getAttribute('data-block-id')
    const originalSecondId = (await blocks.nth(1).getAttribute('data-block-id')) ?? ''

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

    // Wait for the reorder to settle — auto-retrying attribute assertion
    // After MoveUp, the second block should now be first
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalSecondId, {
      timeout: 5000,
    })
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

    // Wait for the reorder to take effect, then press Escape to leave editing mode
    await page.keyboard.press('Escape')

    // Wait for reorder to settle and verify blocks swapped: old second block is now first
    await expect(page.locator('.block-static').nth(0)).toHaveText(secondBlockText, {
      timeout: 5000,
    })
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
    await expect(firstBlock.locator('.task-checkbox-empty')).toBeVisible()

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

    // Close the editor so only the document-level Ctrl+. handler fires
    // (Avoids double-toggle: both editor-level and document-level handlers
    //  call toggleCollapse, which would net to zero change.)
    await page.keyboard.press('Escape')

    // Wait for editor to close after Escape
    await expect(page.locator('.block-editor')).not.toBeVisible()

    // The third block (GS_3) should now have a collapse chevron (hasChildren)
    const parentBlock = page.locator('.sortable-block').nth(2)
    const chevron = parentBlock.locator('.collapse-toggle')
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')

    // Click the collapse chevron to toggle collapse
    await chevron.click()

    // Verify the chevron now shows collapsed (aria-expanded=false)
    await expect(chevron).toHaveAttribute('aria-expanded', 'false')
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
    await expect(page.locator('[data-testid="header-label"]', { hasText: 'Search' })).toBeVisible()
  })

  test('Ctrl+N creates new page', async ({ page }) => {
    // Press Ctrl+N to create a new page
    await page.keyboard.down('Control')
    await page.keyboard.press('n')
    await page.keyboard.up('Control')

    // Verify navigation to the new page (page editor with "Untitled" title)
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
    await expect(page.locator('[aria-label="Page title"]')).toContainText('Untitled')
  })

  test('Alt+Left navigates journal back', async ({ page }) => {
    // We start on the journal view, get the current date display
    const initialDate = await page.locator('[data-testid="date-display"]').innerText()

    // Press Alt+Left to go to previous day
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')

    // Wait for the date display to change
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(initialDate)
  })

  test('Alt+Right navigates journal forward', async ({ page }) => {
    // Capture today's date before navigating
    const todayDate = await page.locator('[data-testid="date-display"]').innerText()

    // First go back a day so we can go forward
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')

    // Wait for the date to change from today
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(todayDate)

    const backDate = await page.locator('[data-testid="date-display"]').innerText()

    // Press Alt+Right to go forward
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Alt')

    // Wait for the date display to change from the back date
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(backDate)
  })

  test('Alt+T goes to today', async ({ page }) => {
    // Get today's date display
    const todayDate = await page.locator('[data-testid="date-display"]').innerText()

    // Navigate back a day first
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')

    // Wait for the date to change from today
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(todayDate)

    // Press Alt+T to go to today
    await page.keyboard.down('Alt')
    await page.keyboard.press('t')
    await page.keyboard.up('Alt')

    // Wait for the date to return to today
    await expect(page.locator('[data-testid="date-display"]')).toHaveText(todayDate)
  })

  test('? opens keyboard shortcuts panel', async ({ page }) => {
    // Click on the header to ensure no input/textarea/contenteditable is focused
    await page.locator('header').click()

    // Type ? using keyboard.type which dispatches keydown with key='?'
    await page.keyboard.type('?')

    // Verify the shortcuts sheet is visible (it has a data-testid="shortcuts-table")
    await expect(page.locator('[data-testid="shortcuts-table"]')).toBeVisible()

    // Also verify the heading title (use role to avoid ambiguity with body text)
    await expect(page.getByRole('heading', { name: 'Keyboard Shortcuts' })).toBeVisible()
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
    await expect(page.getByTestId('link-edit-popover')).toBeVisible()
    await expect(page.getByPlaceholder('https://...')).toBeVisible()
  })
})
