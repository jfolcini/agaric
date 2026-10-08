/**
 * E2E for #1437 — KaTeX/LaTeX math.
 *
 * Inline `$…$` and block `$$…$$` math must round-trip through the editor and
 * render via KaTeX (a `.katex` element) in the at-rest static view. KaTeX runs
 * only in a real browser (it builds DOM from LaTeX, lazy-loaded), so this needs
 * an e2e rather than only a unit test.
 *
 * Authoring path: the roving editor parses a block's markdown on focus and
 * serializes it on blur, so typing the `$…$` / `$$…$$` markdown and then saving
 * (blur) drives the full parse→serialize→static-render round-trip. The static
 * block renders the math via the lazy `KatexMath` component (`.katex`).
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

test.describe('KaTeX math round-trip (#1437)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('inline `$a^2$` renders a .katex element after save', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    // Type the inline-math markdown. (Typed verbatim; the round-trip happens on
    // blur when the block serializes to `$a^2$` and the static view re-parses.)
    await editor.type('energy $a^2$ done')

    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()
    // KaTeX rendered the inline formula.
    await expect(block.locator('.katex').first()).toBeVisible({ timeout: 10_000 })
    // Surrounding text survived the round-trip.
    await expect(block).toContainText('energy')
    await expect(block).toContainText('done')
  })

  test('block `$$ E = mc^2 $$` renders a display .katex element after save', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    // Single-line block-math fence (one line so Enter-to-save still applies).
    await editor.type('$$ E = mc^2 $$')

    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()
    // Display math renders a KaTeX display block.
    await expect(block.locator('.katex').first()).toBeVisible({ timeout: 10_000 })
  })

  test('currency `$5 and $10` is NOT rendered as math', async ({ page }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.type('cost is $5 and $10')

    await saveBlock(page)

    const block = page.locator('[data-testid="sortable-block"]').first()
    await expect(block).toContainText('cost is $5 and $10')
    // No KaTeX rendering for currency text.
    await expect(block.locator('.katex')).toHaveCount(0)
  })

  // The source field sits inside the editor's DOM while the editor's caret
  // stays at the block start, where Backspace would merge into the block above.
  test('Backspace in the source field of math at a block start edits the source', async ({
    page,
  }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const count = await blocks.count()
    const editor = await focusBlock(page, 1)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.type('$x+y$ tail')
    // Home sometimes misses while KaTeX is still loading in.
    await expect(editor.locator('.katex')).toBeVisible()
    await page.keyboard.press('Home')
    // The editor reads the moved caret a moment later; open the source once it has.
    await page.waitForFunction(() => {
      const dom = document.querySelector(
        '[data-testid="block-editor"] [contenteditable="true"]',
      ) as HTMLElement & { editor: { state: { selection: { from: number } } } }
      return dom.editor.state.selection.from === 1
    })
    await editor.getByTestId('math-rendered').click()
    const source = page.getByTestId('math-source-input')
    await expect(source).toBeFocused()
    await expect(source).toHaveValue('x+y')

    await page.keyboard.press('Backspace')

    await expect(source).toHaveValue('x+')
    await expect(blocks).toHaveCount(count)
  })
})
