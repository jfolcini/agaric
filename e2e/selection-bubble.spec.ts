import {
  expect,
  focusBlock,
  openPage,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for the selection BubbleMenu (#924, finding f4).
 *
 * The only prior coverage was a unit test mocking TipTap's `BubbleMenu`. This
 * exercises the real drag-select → click-Bold flow end to end: a non-empty
 * TEXT selection makes `[data-testid="selection-bubble-menu"]` visible (its
 * `shouldShow` predicate, see src/components/editor-toolbar/SelectionBubbleMenu.tsx),
 * clicking the Bold mark toggle (`aria-label="Bold"`, from the `toolbar.bold`
 * i18n key → "Bold") applies the bold mark, and the saved static render
 * carries a `<strong>`.
 *
 * `selectEditorRange` is the proven proxy for a mouse drag-select used across
 * markdown-syntax.spec.ts — it sets a DOM Range and dispatches `selectionchange`
 * so ProseMirror (and therefore the BubbleMenu plugin) observes the selection.
 */

test.describe('Selection bubble menu (#924)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('selecting a word shows the bubble menu and Bold applies the mark', async ({ page }) => {
    const editor = await focusBlock(page)

    // Clear and type fresh content.
    await page.keyboard.press('Control+a')
    await page.keyboard.type('hello world')

    // Select "world" — chars 6..11 ("hello " prefix is 6 chars).
    await selectEditorRange(page, 6, 11)

    // The bubble menu shows over a non-empty text selection.
    const bubble = page.locator('[data-testid="selection-bubble-menu"]')
    await expect(bubble).toBeVisible({ timeout: 5000 })

    // Click the Bold mark toggle inside the bubble. The button's accessible
    // name is the translated `toolbar.bold` label → "Bold".
    await bubble.getByRole('button', { name: 'Bold' }).click()

    // The selected word now carries the bold mark in the live editor.
    const boldEl = editor.locator('strong')
    await expect(boldEl).toBeVisible()
    await expect(boldEl).toHaveText('world')

    // Save and verify the bold survives into the static render. Re-focus the
    // editor first so the Enter keystroke reaches TipTap (the Bold click landed
    // on the bubble button, which sits outside the contenteditable).
    await editor.click()
    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toHaveText('world')
  })

  test('bubble menu does NOT show when the selection is empty (caret only)', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Control+a')
    await page.keyboard.type('hello world')

    // Collapse to a caret (no range). `shouldShow` requires a non-empty
    // selection, so the bubble stays hidden.
    await selectEditorRange(page, 5, 5)

    await expect(page.locator('[data-testid="selection-bubble-menu"]')).not.toBeVisible()
  })

  test('bubble menu does NOT show over a selected chip (atom node)', async ({ page }) => {
    // GS_2 contains a [[Quick Notes]] block-link chip. Focus it (editor mode)
    // and select EXACTLY the chip span via the DOM Selection API. ProseMirror
    // resolves a selection wrapping an atom inline node as a NodeSelection,
    // which the bubble's `shouldShow` excludes (mark toggles are meaningless
    // over a chip/atom — #924). This duck-types via the DOM rather than an
    // editor handle (no test-only editor global exists).
    const editor = await focusBlock(page, 1)
    const chip = editor.locator('[data-testid="block-link-chip"]')
    await expect(chip).toBeVisible()

    // Wrap the selection tightly around the chip node, then notify ProseMirror.
    const wrapped = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="block-editor"] [data-testid="block-link-chip"]',
      )
      if (!el) return false
      const range = document.createRange()
      range.selectNode(el)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return true
    })
    expect(wrapped).toBe(true)

    // The bubble must never appear while a chip atom is the selection.
    await expect(page.locator('[data-testid="selection-bubble-menu"]')).not.toBeVisible()
  })
})
