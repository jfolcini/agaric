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
    // #3001 — Turn into → Code block is a single-step disclosure: opening it
    // expands the language picker in place, so the block is turned into a code
    // block AND given the `mermaid` language in one interaction (custom-language
    // path, since mermaid is not a built-in language).
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.pressSequentially('graph TD; A-->B;')

    const blockEditor = page.locator('[data-testid="block-editor"]')
    await blockEditor.getByRole('button', { name: 'Turn into', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Code block', exact: true }).click()
    const langInput = page.getByRole('textbox', { name: 'Code block language' })
    await expect(langInput).toBeVisible()
    await langInput.fill('mermaid')
    await page.getByTestId('use-custom-language').click()

    // #2449 (audit finding 45): with the caret INSIDE the block, the node
    // view opens in SOURCE mode — keystrokes must land in visible text, never
    // in a display:none <pre> behind the rendered diagram. The old behavior
    // (diagram shown while editing) was exactly the invisible-typing hazard.
    const nodeView = page.locator('[data-testid="mermaid-node-view"]')
    await expect(nodeView).toBeVisible()
    const toggle = nodeView.getByTestId('mermaid-toggle-source')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(nodeView.getByTestId('mermaid-rendered')).toBeHidden()
    await expect(nodeView.locator('pre.mermaid-source')).toBeVisible()
    await expect(nodeView.locator('pre.mermaid-source')).toContainText('graph TD')

    // Manually toggling back shows the rendered diagram even while the caret
    // stays inside (the selection flip is transition-triggered, so the user's
    // explicit choice sticks until the selection re-enters the node).
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await expect(nodeView.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible({
      timeout: 10_000,
    })

    // And toggling to source again still carries the editable text.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(nodeView.locator('pre.mermaid-source')).toBeVisible()
    await expect(nodeView.locator('pre.mermaid-source')).toContainText('graph TD')
    // Leave the node view in diagram mode before the blur/round-trip leg.
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

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
