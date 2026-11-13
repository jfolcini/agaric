/**
 * Math and Mermaid in page mode (#5691), against the mock backend: typed
 * `$…$` renders through KaTeX and is stored as typed, the math source field
 * edits a formula in place, and a Mermaid
 * fence draws its diagram, shows its source to the caret, and saves an edit of
 * it. KaTeX and Mermaid build DOM only a browser has.
 */

import { expect, test, waitForBoot } from './helpers'
import {
  PAGE_EDITOR,
  backendTexts,
  caret,
  openInPageMode,
  openPageByTitle,
  seedPage,
} from './page-mode'

test.describe('math and diagrams in page mode (#5691) @editor @pages @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('typed $…$ renders as math, a price does not, and both are stored as typed and stay', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Math typed', [
      [0, 'energy'],
      [0, 'cost is'],
      [0, 'last'],
    ])
    await openInPageMode(page, 'Math typed', 3)
    const block = (index: number) => page.locator(`[data-page-block-id="${ids[index]}"]`)

    await caret(page, 0, 'end')
    await page.keyboard.type(' $a^2$ done')
    await caret(page, 1, 'end')
    await page.keyboard.type(' $5 and $10')
    await caret(page, 2, 'end')

    await expect(block(0).locator('.katex').first()).toBeVisible()
    await expect(block(1).locator('.katex')).toHaveCount(0)
    const stored = ['energy $a^2$ done', 'cost is $5 and $10', 'last']
    await expect.poll(() => backendTexts(page, pageId)).toEqual(stored)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Math typed', 3)
    await expect(block(0).locator('.katex').first()).toBeVisible()
    await expect(block(1).locator('.katex')).toHaveCount(0)
    expect(await backendTexts(page, pageId)).toEqual(stored)
  })

  test('the math source field edits a formula at its block’s start, and the edit is saved', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Math source', [
      [0, 'above'],
      [0, '$x+y$ tail'],
    ])
    await openInPageMode(page, 'Math source', 2)
    const block = page.locator(`[data-page-block-id="${ids[1]}"]`)
    await expect(block.locator('.katex').first()).toBeVisible()
    // The caret where Backspace in the text would join the block to the one above.
    await caret(page, 1, 0)

    await block.getByTestId('math-rendered').click()
    const source = page.getByTestId('math-source-input')
    await expect(source).toBeFocused()
    await expect(source).toHaveValue('x+y')
    await page.keyboard.press('Backspace')
    await expect(source).toHaveValue('x+')
    await page.keyboard.press('Enter')

    await expect(page.locator(PAGE_EDITOR)).toBeFocused()
    await expect.poll(() => backendTexts(page, pageId)).toEqual(['above', '$x+$ tail'])
  })

  test('a Mermaid fence draws its diagram, shows its source to the caret, and saves an edit of it', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'Diagram', [
      [0, 'above'],
      [0, '```mermaid\ngraph TD; A-->B;\n```'],
    ])
    await openInPageMode(page, 'Diagram', 2)
    const view = page.locator(`[data-page-block-id="${ids[1]}"] [data-testid="mermaid-node-view"]`)
    const toggle = view.getByTestId('mermaid-toggle-source')

    await expect(view.locator('[data-testid="mermaid-diagram"] svg')).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // The caret in the block opens its source: keys must land in text that shows.
    await caret(page, 1, 'end')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(view.locator('pre.mermaid-source')).toContainText('graph TD')
    await page.keyboard.type(' B-->C;')
    await expect(page.locator(PAGE_EDITOR)).toBeFocused()
    await caret(page, 0, 'end')

    await expect
      .poll(() => backendTexts(page, pageId))
      .toEqual(['above', '```mermaid\ngraph TD; A-->B; B-->C;\n```'])
    await expect(view.locator('[data-testid="mermaid-diagram"] svg')).toContainText('C')
  })
})
