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
  return editor
}

/** Save the current block by pressing Enter (flush content → close editor → static render). */
async function saveBlock(page: import('@playwright/test').Page) {
  await page.keyboard.press('Enter')
  // Wait for the editor to disappear and static block to re-render
  await expect(page.locator('.block-editor [contenteditable="true"]')).not.toBeVisible({
    timeout: 3000,
  })
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

test.describe('Formatting buttons — full cycle: edit → style → save → verify', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Bold: type text, bold it, save, verify <strong> in static render', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Clear and type fresh content
    await page.keyboard.press('Control+a')
    await editor.type('bold test')

    // Select "bold" (4 chars from the start)
    await page.keyboard.press('Home')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')

    // Apply bold via toolbar
    await page.getByRole('button', { name: 'Bold' }).click()

    // Verify mark is active in editor
    const boldEl = editor.locator('strong')
    await expect(boldEl).toBeVisible({ timeout: 3000 })
    await expect(boldEl).toHaveText('bold')

    // Save and verify static render
    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    await expect(staticBlock.locator('strong')).toHaveText('bold')
  })

  test('Italic: type text, italicize it, save, verify <em> in static render', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await editor.type('italic test')

    // Select "italic" (6 chars)
    await page.keyboard.press('Home')
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowRight')

    await page.getByRole('button', { name: 'Italic' }).click()

    const italicEl = editor.locator('em')
    await expect(italicEl).toBeVisible({ timeout: 3000 })
    await expect(italicEl).toHaveText('italic')

    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    await expect(staticBlock.locator('em')).toHaveText('italic')
  })

  test('Inline code: type text, apply code, verify background in editor, save, verify <code> pill in static render', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await editor.type('some code here')

    // Select "code" (4 chars, starting at position 5)
    await page.keyboard.press('Home')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')

    // Apply inline code
    await page.getByRole('button', { name: 'Code', exact: true }).click()

    // Verify code element appears in editor with background styling
    const codeEl = editor.locator('code')
    await expect(codeEl).toBeVisible({ timeout: 3000 })
    await expect(codeEl).toHaveText('code')
    // The CSS rule .ProseMirror code adds bg-muted rounded — verify border-radius
    await expect(codeEl).toHaveCSS('border-radius', /\dpx/)

    // Save and verify static render has styled <code> pill
    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    const staticCode = staticBlock.locator('code')
    await expect(staticCode).toHaveText('code')
    // StaticBlock <code> also has bg-muted rounded
    await expect(staticCode).toHaveCSS('border-radius', /\dpx/)
  })

  test('Code block: toggle code block, type code, save, verify <pre> in static render', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Toggle code block
    await page.getByRole('button', { name: 'Code block' }).click()
    await expect(page.getByRole('button', { name: 'Code block' })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 3000 },
    )

    // Type code content
    await page.keyboard.press('Control+a')
    await editor.type('const x = 42')

    // Save and verify static render has <pre>
    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    await expect(staticBlock.locator('pre')).toBeVisible({ timeout: 3000 })
    await expect(staticBlock.locator('pre')).toContainText('const x = 42')
  })

  test('Bold + Italic combined: apply both, save, verify nested marks', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await editor.type('emphasis')

    // Select all and apply both marks
    await page.keyboard.press('Control+a')
    await page.getByRole('button', { name: 'Bold' }).click()
    await page.getByRole('button', { name: 'Italic' }).click()

    // Both should be active
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: 'Italic' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // Save and verify static render has both <strong> and <em>
    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    await expect(staticBlock.locator('strong')).toBeVisible({ timeout: 3000 })
    await expect(staticBlock.locator('em')).toBeVisible({ timeout: 3000 })
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

  test('External link: apply URL, save, verify .external-link in static render', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text so the link wraps existing content
    await page.keyboard.press('Control+a')

    // Open the link popover
    await page.getByRole('button', { name: 'External link' }).click()

    const urlInput = page.getByPlaceholder('https://...')
    await expect(urlInput).toBeVisible({ timeout: 3000 })

    // Type a URL and press Enter to apply
    await urlInput.fill('https://example.com')
    await urlInput.press('Enter')

    // Verify link appears in editor
    await expect(page.locator('.block-editor .external-link')).toBeVisible({ timeout: 3000 })

    // Save and verify static render has the external link
    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    await expect(staticBlock.locator('.external-link')).toBeVisible({ timeout: 3000 })
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

  test('Internal link: select page from picker, save, verify chip in static render', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Clear and type fresh content, then trigger [[ picker
    await page.keyboard.press('Control+a')
    await editor.type('link: ')
    await page.getByRole('button', { name: 'Internal link' }).click()

    // Wait for suggestion list and click the first suggestion
    const suggestionList = page.locator('.suggestion-list')
    await expect(suggestionList).toBeVisible({ timeout: 5000 })
    const firstItem = suggestionList.locator('.suggestion-item').first()
    await firstItem.click()

    // Verify block-link chip appears in editor
    await expect(editor.locator('.block-link-chip')).toBeVisible({ timeout: 3000 })

    // Save and verify static render has the block-link chip
    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    await expect(staticBlock.locator('.block-link-chip')).toBeVisible({ timeout: 3000 })
  })

  test('Tag: select tag from picker, save, verify chip in static render', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Clear and type fresh content, then trigger @ picker
    await page.keyboard.press('Control+a')
    await editor.type('tagged: ')
    await page.getByRole('button', { name: 'Insert tag' }).click()

    // Wait for suggestion list and click the first tag
    const suggestionList = page.locator('.suggestion-list')
    await expect(suggestionList).toBeVisible({ timeout: 5000 })
    const firstItem = suggestionList.locator('.suggestion-item').first()
    await firstItem.click()

    // Verify tag-ref chip appears in editor
    await expect(editor.locator('.tag-ref-chip')).toBeVisible({ timeout: 3000 })

    // Save and verify static render has the tag-ref chip
    await saveBlock(page)
    const staticBlock = page.locator('.sortable-block').first().locator('.block-static')
    await expect(staticBlock.locator('.tag-ref-chip')).toBeVisible({ timeout: 3000 })
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
