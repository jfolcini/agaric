import { expect, test } from '@playwright/test'
import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

/**
 * E2E tests for markdown syntax rendering.
 *
 * Validates that users can type raw markdown syntax (headings via TipTap
 * inputRules) and apply formatting via keyboard shortcuts (Ctrl+B, Ctrl+I,
 * Ctrl+E), then save and see the correct HTML in the static view.
 *
 * Also tests round-trip persistence: type/format -> save -> re-open -> verify
 * marks are still applied.
 *
 * Supported markdown subset (from markdown-serializer.ts):
 *   blocks: # heading (h1-h6), ```code```
 *   marks:  **bold**  *italic*  `code`  [text](url)
 *   tokens: #[ULID]  [[ULID]]
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") -- 5 child blocks:
 *     GS_1: "Welcome to Agaric! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 */

// ===========================================================================
// 1. Heading syntax — TipTap inputRules convert "# " at start of line
// ===========================================================================

test.describe('Heading syntax (typed # prefix)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('# heading renders as <h1> after save', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('# My Heading')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h1')).toBeVisible()
    await expect(staticBlock.locator('h1')).toContainText('My Heading')
  })

  test('## heading renders as <h2> after save', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('## Second Level')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h2')).toBeVisible()
    await expect(staticBlock.locator('h2')).toContainText('Second Level')
  })

  test('### heading renders as <h3> after save', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('### Third Level')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h3')).toBeVisible()
    await expect(staticBlock.locator('h3')).toContainText('Third Level')
  })

  test('#### heading renders as <h4> after save', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('#### Fourth Level')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h4')).toBeVisible()
    await expect(staticBlock.locator('h4')).toContainText('Fourth Level')
  })

  test('##### heading renders as <h5> after save', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('##### Fifth Level')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h5')).toBeVisible()
    await expect(staticBlock.locator('h5')).toContainText('Fifth Level')
  })

  test('###### heading renders as <h6> after save', async ({ page }) => {
    await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('###### Sixth Level')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h6')).toBeVisible()
    await expect(staticBlock.locator('h6')).toContainText('Sixth Level')
  })
})

// ===========================================================================
// 2. Keyboard shortcut formatting — Ctrl+B (bold), Ctrl+I (italic), Ctrl+E (code)
// ===========================================================================

test.describe('Keyboard shortcut formatting', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('Ctrl+B applies bold, save, verify <strong> in static render', async ({ page }) => {
    const editor = await focusBlock(page)

    // Clear and type fresh content
    await page.keyboard.press('Control+a')
    await page.keyboard.type('hello world')

    // Select "world" (5 chars from the end)
    await page.keyboard.press('End')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')

    // Apply bold via keyboard shortcut
    await page.keyboard.press('Control+b')

    // Verify mark is active in editor
    const boldEl = editor.locator('strong')
    await expect(boldEl).toBeVisible()
    await expect(boldEl).toHaveText('world')

    // Save and verify static render
    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toHaveText('world')
  })

  test('Ctrl+I applies italic, save, verify <em> in static render', async ({ page }) => {
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('hello world')

    // Select "world"
    await page.keyboard.press('End')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')

    // Apply italic via keyboard shortcut
    await page.keyboard.press('Control+i')

    const italicEl = editor.locator('em')
    await expect(italicEl).toBeVisible()
    await expect(italicEl).toHaveText('world')

    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('em')).toHaveText('world')
  })

  test('Ctrl+E applies inline code, save, verify <code> in static render', async ({ page }) => {
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('run npm install now')

    // Select "npm install" (11 chars, starting 4 from the beginning)
    await page.keyboard.press('Home')
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight')
    for (let i = 0; i < 11; i++) await page.keyboard.press('Shift+ArrowRight')

    // Apply inline code via keyboard shortcut
    await page.keyboard.press('Control+e')

    const codeEl = editor.locator('code')
    await expect(codeEl).toBeVisible()
    await expect(codeEl).toHaveText('npm install')

    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    const staticCode = staticBlock.locator('code')
    await expect(staticCode).toHaveText('npm install')
    // Verify the code pill has border-radius (bg-muted rounded styling)
    await expect(staticCode).toHaveCSS('border-radius', /\dpx/)
  })
})

// ===========================================================================
// 3. Combined marks
// ===========================================================================

test.describe('Combined marks', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('Bold + Italic combined via shortcuts, save, verify nested marks', async ({ page }) => {
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('important text')

    // Select "important" (9 chars from start)
    await page.keyboard.press('Home')
    for (let i = 0; i < 9; i++) await page.keyboard.press('Shift+ArrowRight')

    // Apply both bold and italic
    await page.keyboard.press('Control+b')
    await page.keyboard.press('Control+i')

    // Verify both marks in editor
    await expect(editor.locator('strong')).toBeVisible()
    await expect(editor.locator('em')).toBeVisible()

    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toBeVisible()
    await expect(staticBlock.locator('em')).toBeVisible()
  })

  test('Bold + Code combined via shortcuts, save, verify nested marks', async ({ page }) => {
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('use the flag here')

    // Select "flag" (4 chars, starting at position 8)
    await page.keyboard.press('Home')
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight')

    // Apply bold then code
    await page.keyboard.press('Control+b')
    await page.keyboard.press('Control+e')

    // Verify both marks in editor
    await expect(editor.locator('strong')).toBeVisible()
    await expect(editor.locator('code')).toBeVisible()

    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toBeVisible()
    await expect(staticBlock.locator('code')).toBeVisible()
  })
})

// ===========================================================================
// 4. Round-trip persistence — format, save, re-open, verify marks survive
// ===========================================================================

test.describe('Round-trip persistence', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('Ctrl+B bold survives save and re-open', async ({ page }) => {
    const editor = await focusBlock(page)

    // Clear and type, then bold a word
    await page.keyboard.press('Control+a')
    await page.keyboard.type('persistent bold')

    // Select "bold" (4 chars from end)
    await page.keyboard.press('End')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+b')

    // Verify bold in editor
    await expect(editor.locator('strong')).toHaveText('bold')

    // Save (Enter closes editor)
    await saveBlock(page)

    // Verify bold in static view
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toHaveText('bold')

    // Re-open the block by clicking it
    await staticBlock.click()
    const reopenedEditor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(reopenedEditor).toBeVisible()

    // Verify bold is still applied after re-opening
    await expect(reopenedEditor.locator('strong')).toHaveText('bold')
  })

  test('Ctrl+I italic survives save and re-open', async ({ page }) => {
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('persistent italic')

    // Select "italic" (6 chars from end)
    await page.keyboard.press('End')
    for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+i')

    await expect(editor.locator('em')).toHaveText('italic')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('em')).toHaveText('italic')

    // Re-open
    await staticBlock.click()
    const reopenedEditor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(reopenedEditor).toBeVisible()
    await expect(reopenedEditor.locator('em')).toHaveText('italic')
  })

  test('Ctrl+E inline code survives save and re-open', async ({ page }) => {
    const editor = await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('persistent code')

    // Select "code" (4 chars from end)
    await page.keyboard.press('End')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+e')

    await expect(editor.locator('code')).toHaveText('code')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('code')).toHaveText('code')

    // Re-open
    await staticBlock.click()
    const reopenedEditor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(reopenedEditor).toBeVisible()
    await expect(reopenedEditor.locator('code')).toHaveText('code')
  })

  test('# heading survives save and re-open', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('# Persistent Heading')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h1')).toBeVisible()
    await expect(staticBlock.locator('h1')).toContainText('Persistent Heading')

    // Re-open the block
    await staticBlock.click()
    const reopenedEditor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(reopenedEditor).toBeVisible()

    // TipTap renders headings as <h1> in the editor too
    await expect(reopenedEditor.locator('h1')).toBeVisible()
    await expect(reopenedEditor.locator('h1')).toContainText('Persistent Heading')
  })
})
