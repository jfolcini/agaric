/**
 * E2E for #1438 — Mermaid diagram support.
 *
 * A code block with language `mermaid` (the editor representation of a
 * ```mermaid fence) must:
 *   1. render a diagram (SVG) in the editor's React node view (not raw text);
 *   2. expose a raw-source toggle that swaps between the rendered diagram and
 *      the editable Mermaid source;
 *   3. round-trip — after saving (blur) the at-rest static render shows the
 *      diagram too (the static path uses the same code-block representation
 *      that serializes to a ```mermaid fence).
 *
 * Node views need real-browser verification (mermaid renders SVG async via the
 * real mermaid.js), hence an e2e rather than only a unit test.
 *
 * The block's mermaid language is set through the toolbar's code-block language
 * picker ("Use «mermaid»" custom-language row) — the typed-fence input rule is
 * not how the roving editor authors code blocks.
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, waitForBoot } from './helpers'

test.describe('Mermaid diagram round-trip (#1438)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('renders a diagram in the editor node view, toggles source, and round-trips', async ({
    page,
  }) => {
    const editor = await focusBlock(page)
    // Author the Mermaid source, then turn the block into a mermaid code block.
    // #1960 — Turn into → Code block, then re-open Turn into; the contextual
    // language picker appears for code blocks. Use the custom-language path.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.pressSequentially('graph TD; A-->B;')

    const blockEditor = page.locator('[data-testid="block-editor"]')
    await blockEditor.getByRole('button', { name: 'Turn into', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'Code block' }).click()
    await expect(editor.locator('pre')).toBeVisible()

    // Caret into the code block so Turn into surfaces the language picker.
    // Active-state read is rAF-coalesced (#1489) — let it propagate.
    await editor.locator('pre').click()
    await page.waitForTimeout(250)
    await blockEditor.getByRole('button', { name: 'Turn into', exact: true }).click()
    const langInput = page.getByRole('textbox', { name: 'Code block language' })
    await expect(langInput).toBeVisible()
    await langInput.fill('mermaid')
    await page.getByTestId('use-custom-language').click()

    // The node view renders the diagram (SVG) while editing.
    const nodeView = page.locator('[data-testid="mermaid-node-view"]')
    await expect(nodeView).toBeVisible()
    await expect(nodeView.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible({
      timeout: 10_000,
    })

    // The raw-source toggle swaps to the editable source and back.
    const toggle = nodeView.getByTestId('mermaid-toggle-source')
    await expect(toggle).toBeVisible()
    await toggle.click()
    // Toggle flips to "source" mode: button reflects it, diagram is hidden, and
    // the editable source becomes visible carrying the Mermaid text.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(nodeView.getByTestId('mermaid-rendered')).toBeHidden()
    await expect(nodeView.locator('pre.mermaid-source')).toBeVisible()
    await expect(nodeView.locator('pre.mermaid-source')).toContainText('graph TD')
    // Toggle back to the diagram.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(nodeView.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible()

    // Commit by moving focus to another block (the natural blur+flush path —
    // Enter inside a code block inserts a newline rather than saving). The
    // mermaid block serializes to a ```mermaid fence and its at-rest static
    // render shows the diagram, proving the round-trip is lossless.
    await page.locator('[data-testid="block-static"]').nth(2).click()
    const staticDiagram = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="mermaid-diagram"] svg')
    await expect(staticDiagram).toBeVisible({ timeout: 10_000 })
  })
})
