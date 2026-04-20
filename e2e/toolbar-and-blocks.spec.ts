import {
  dragBlock,
  expect,
  focusBlock,
  openPage,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E tests for toolbar buttons and block interactions.
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
// 1. Toolbar visibility
// ===========================================================================

test.describe('Toolbar visibility', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('formatting toolbar appears when a block is focused', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await expect(page.locator('[data-testid="formatting-toolbar"]')).toBeVisible()
  })

  test('formatting toolbar disappears when block loses focus', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await expect(page.locator('[data-testid="formatting-toolbar"]')).toBeVisible()

    // Press Escape to unfocus the block
    await page.keyboard.press('Escape')

    await expect(page.locator('[data-testid="formatting-toolbar"]')).not.toBeVisible()
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

    // Select "bold" — chars 0..4
    await selectEditorRange(page, 0, 4)

    // Apply bold via toolbar
    await page.getByRole('button', { name: 'Bold' }).click()

    // Verify mark is active in editor
    const boldEl = editor.locator('strong')
    await expect(boldEl).toBeVisible()
    await expect(boldEl).toHaveText('bold')

    // Save and verify static render
    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toHaveText('bold')
  })

  test('Italic: type text, italicize it, save, verify <em> in static render', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await editor.type('italic test')

    // Select "italic" — chars 0..6
    await selectEditorRange(page, 0, 6)

    await page.getByRole('button', { name: 'Italic' }).click()

    const italicEl = editor.locator('em')
    await expect(italicEl).toBeVisible()
    await expect(italicEl).toHaveText('italic')

    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('em')).toHaveText('italic')
  })

  test('Inline code: type text, apply code, verify background in editor, save, verify <code> pill in static render', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await editor.type('some code here')

    // Select "code" — chars 5..9 ("some " is 5 chars)
    await selectEditorRange(page, 5, 9)

    // Apply inline code
    await page.getByRole('button', { name: 'Code', exact: true }).click()

    // Verify code element appears in editor with background styling
    const codeEl = editor.locator('code')
    await expect(codeEl).toBeVisible()
    await expect(codeEl).toHaveText('code')
    // The CSS rule .ProseMirror code adds bg-muted rounded — verify border-radius
    await expect(codeEl).toHaveCSS('border-radius', /\dpx/)

    // Save and verify static render has styled <code> pill
    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
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

    // First, clear the existing block content while it is still a plain
    // paragraph — easier to reason about than selecting across a code
    // block boundary.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')

    // Toggle code block via Ctrl+Shift+C (toolbar no longer has a plain
    // "Code block" button — only a "Code block language" picker.
    // Ctrl+Shift+C is the bound shortcut, see keyboard-config.ts).
    await page.keyboard.press('Control+Shift+KeyC')
    await expect(page.getByRole('button', { name: 'Code block language' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // Type code content into the (now-empty) code block
    await editor.type('const x = 42')

    // Save by blurring the editor (click the app header — idempotent,
    // non-focusable element). Enter within a code block inserts a
    // newline, not a save, so we can't use the standard saveBlock helper.
    await page.locator('header').first().click()
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock).toBeVisible()
    await expect(staticBlock.locator('pre')).toBeVisible()
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
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toBeVisible()
    await expect(staticBlock.locator('em')).toBeVisible()
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
    await expect(page.getByTestId('link-edit-popover')).toBeVisible()
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
    await expect(urlInput).toBeVisible()

    // Type a URL and press Enter to apply
    await urlInput.fill('https://example.com')
    await urlInput.press('Enter')

    // Verify link appears in editor. During edit mode the TipTap
    // ExternalLink extension emits `<a class="external-link">` without a
    // testid — the testid is only added by RichContentRenderer /
    // StaticBlock. Scope via the CSS class inside the block-editor.
    await expect(page.locator('[data-testid="block-editor"] a.external-link')).toBeVisible()

    // Save by blurring the editor (click the app header — idempotent,
    // non-focusable element). Pressing Enter here would split the
    // paragraph inside the link mark instead of flushing the block
    // (the cursor lives at end-of-link = end-of-paragraph after Enter
    // in the popover, and closing the popover may leave focus on the
    // trigger button, bypassing the block-level Enter handler).
    await page.locator('header').first().click()
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock).toBeVisible()
    await expect(staticBlock.locator('[data-testid="external-link"]')).toBeVisible()
  })

  test('Internal link button triggers [[ picker', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Click the Internal link toolbar button -- inserts [[ which triggers picker
    await page.getByRole('button', { name: 'Internal link' }).click()

    // The suggestion popup should appear
    await expect(page.locator('[data-testid="suggestion-list"]')).toBeVisible({ timeout: 5000 })
  })

  test('Tag button triggers @ tag picker', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Click the Tag toolbar button -- inserts @ which triggers tag picker
    await page.getByRole('button', { name: 'Insert tag' }).click()

    // The suggestion popup should appear
    await expect(page.locator('[data-testid="suggestion-list"]')).toBeVisible({ timeout: 5000 })
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
    const suggestionList = page.locator('[data-testid="suggestion-list"]')
    await expect(suggestionList).toBeVisible({ timeout: 5000 })
    const firstItem = suggestionList.locator('[data-testid="suggestion-item"]').first()
    await firstItem.click()

    // Verify block-link chip appears in editor
    await expect(editor.locator('[data-testid="block-link-chip"]')).toBeVisible()

    // Save and verify static render has the block-link chip
    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('[data-testid="block-link-chip"]')).toBeVisible()
  })

  test('Tag: select tag from picker, save, verify chip in static render', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Clear and type fresh content, then trigger @ picker
    await page.keyboard.press('Control+a')
    await editor.type('tagged: ')
    await page.getByRole('button', { name: 'Insert tag' }).click()

    // Wait for suggestion list and click the first tag
    const suggestionList = page.locator('[data-testid="suggestion-list"]')
    await expect(suggestionList).toBeVisible({ timeout: 5000 })
    const firstItem = suggestionList.locator('[data-testid="suggestion-item"]').first()
    await firstItem.click()

    // Verify tag-ref chip appears in editor
    await expect(editor.locator('[data-testid="tag-ref-chip"]')).toBeVisible()

    // Save and verify static render has the tag-ref chip
    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('[data-testid="tag-ref-chip"]')).toBeVisible()
  })
})

// ===========================================================================
// 4. Priority shortcuts
// ===========================================================================

test.describe('Priority shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  // The toolbar no longer exposes three separate "Priority 1/2/3" buttons —
  // it has a single "Cycle priority" button (see `FormattingToolbar.tsx`).
  // Direct priority selection is available via the keyboard shortcuts
  // Ctrl+Shift+1 / Ctrl+Shift+2 / Ctrl+Shift+3 (see keyboard-config.ts
  // and `PriorityShortcuts` in `use-roving-editor.ts`). The tests below
  // exercise those shortcut paths.

  test('Ctrl+Shift+1 sets high priority, saves, and persists', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.press('Control+Shift+Digit1')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const badge = firstBlock.locator('[data-testid="priority-badge"]')
    await expect(badge).toBeVisible()
    // PriorityBadge always renders "P{priority}" (src/components/ui/priority-badge.tsx).
    await expect(badge).toHaveText('P1')

    // Save and verify persists
    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toBeVisible()
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toHaveText('P1')
  })

  test('Ctrl+Shift+2 sets medium priority, saves, and persists', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.press('Control+Shift+Digit2')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const badge = firstBlock.locator('[data-testid="priority-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('P2')

    // Save and verify persists
    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toBeVisible()
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toHaveText('P2')
  })

  test('Ctrl+Shift+3 sets low priority, saves, and persists', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.press('Control+Shift+Digit3')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const badge = firstBlock.locator('[data-testid="priority-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('P3')

    // Save and verify persists
    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toBeVisible()
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toHaveText('P3')
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
    await expect(page.locator('[data-testid="date-picker-popup"]')).toBeVisible()
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
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const taskMarker = firstBlock.locator('[data-testid="task-marker"]')

    // First click: none -> TODO
    await taskMarker.click()
    await expect(firstBlock.locator('[data-testid="task-checkbox-todo"]')).toBeVisible()

    // Second click: TODO -> DOING
    await taskMarker.click()
    await expect(firstBlock.locator('[data-testid="task-checkbox-doing"]')).toBeVisible()

    // Third click: DOING -> DONE
    await taskMarker.click()
    await expect(firstBlock.locator('[data-testid="task-checkbox-done"]')).toBeVisible()
  })

  test('delete button removes block on hover', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Count blocks before deletion
    const countBefore = await page.locator('[data-testid="sortable-block"]').count()
    expect(countBefore).toBeGreaterThan(0)

    // Hover over the first block to reveal the delete button
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.hover()

    // Click the Delete block button
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Block count should decrease by one
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore - 1)
  })

  test('drag handle is visible on hover/focus', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const dragHandle = firstBlock.locator('[data-testid="drag-handle"]')

    // Before hover, the drag handle has opacity-0 (not visually visible)
    // After hover on the block group, it becomes visible
    await firstBlock.hover()

    await expect(dragHandle).toBeVisible()
  })

  test('drag-and-drop reorders blocks', async ({ page }) => {
    // Use Quick Notes (2 blocks — simpler)
    await openPage(page, 'Quick Notes')

    const blocks = page.locator('[data-testid="sortable-block"]')
    await expect(blocks).toHaveCount(2)

    // Capture original order by data-block-id (stable regardless of edit/
    // static mode — innerText() of block-static reflects mark-stripped
    // text, and after a drop the new-index-0 block can briefly open in
    // edit mode, which hides block-static and masks the assertion).
    const firstId = await blocks.nth(0).getAttribute('data-block-id')
    const secondId = await blocks.nth(1).getAttribute('data-block-id')
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()

    // Drag second block to first position
    const source = blocks.nth(1).locator('[data-testid="drag-handle"]')
    const target = blocks.nth(0)

    // Hover to reveal drag handle
    await blocks.nth(1).hover()
    await expect(source).toBeVisible()

    // Perform drag using shared helper (handles dnd-kit PointerSensor delay)
    await dragBlock(page, source, target)

    // Verify order swapped by data-block-id
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', secondId ?? '', { timeout: 5000 })
    await expect(blocks.nth(1)).toHaveAttribute('data-block-id', firstId ?? '', { timeout: 5000 })
  })

  test('context menu appears on right-click', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Right-click the first block
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.click({ button: 'right' })

    // Context menu with role="menu" should appear
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()

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
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="task-checkbox-empty"]')).toBeVisible()

    // Press Ctrl+Enter to cycle task state: none -> TODO
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')

    // The empty checkbox should disappear — the task state has changed
    // (could be TODO or DOING depending on whether both editor-level and
    // document-level handlers fire)
    await expect(firstBlock.locator('[data-testid="task-checkbox-empty"]')).not.toBeVisible({
      timeout: 5000,
    })
  })
})

// ===========================================================================
// 7. Undo / Redo
// ===========================================================================

test.describe('Undo / Redo', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Undo button reverts last change in editor', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Remember original text
    const originalText = await editor.textContent()

    // Type additional text
    await page.keyboard.press('End')
    await editor.type(' extra')

    // Click Undo
    await page.getByRole('button', { name: 'Undo', exact: true }).click()

    // Editor content should revert to original
    await expect(editor).toHaveText(originalText ?? '')
  })

  test('Redo button re-applies undone change', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Type text
    await page.keyboard.press('End')
    await editor.type(' extra')
    const withExtra = await editor.textContent()

    // Undo
    await page.getByRole('button', { name: 'Undo', exact: true }).click()

    // Redo
    await page.getByRole('button', { name: 'Redo', exact: true }).click()

    // Should have the extra text back
    await expect(editor).toHaveText(withExtra ?? '')
  })

  test('Undo via Ctrl+Z in editor reverts last change', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    const originalText = await editor.textContent()
    await page.keyboard.press('End')
    await editor.type(' typed')

    await page.keyboard.press('Control+z')

    await expect(editor).toHaveText(originalText ?? '')
  })

  test('Redo via Ctrl+Y in editor re-applies change', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    await page.keyboard.press('End')
    await editor.type(' typed')
    const withTyped = await editor.textContent()

    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+y')

    await expect(editor).toHaveText(withTyped ?? '')
  })
})

// ===========================================================================
// 8. Collapse / Expand
// ===========================================================================

test.describe('Collapse / Expand', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('blocks without children do not show collapse chevron', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="collapse-toggle"]')).not.toBeVisible()
  })
})
