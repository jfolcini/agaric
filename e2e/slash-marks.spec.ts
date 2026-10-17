import {
  expect,
  focusBlock,
  openPage,
  reopenPage,
  replaceEditorText,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * The slash formatting marks (/bold /italic /code /strike /highlight). The
 * menu only opens at a collapsed caret, so a mark command must apply to the
 * text typed after it: `hello /bold⏎world` stores `world` bold and renders a
 * `<strong>`, not a literal `**world**`. In `e2e/` because the effect is the
 * editor's stored mark, the serializer and the static render, all of which the
 * mock-backed build runs for real.
 */

// `query` is what the user types after `/`; the label, not the id, is searched,
// so the inline-code mark ("CODE — Inline code") is reached by `inline`.
const MARKS = [
  { id: 'bold', query: 'bold', tag: 'strong' },
  { id: 'italic', query: 'italic', tag: 'em' },
  { id: 'code-mark', query: 'inline', tag: 'code' },
  { id: 'strike', query: 'strike', tag: 's' },
  { id: 'highlight', query: 'highlight', tag: 'mark' },
] as const

test.describe('Slash mark commands', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  for (const { id, query, tag } of MARKS) {
    test(`/${id} marks the text typed after it and persists`, async ({ page }) => {
      const editor = await focusBlock(page)
      await replaceEditorText(page, 'hello')
      await expect(editor).toHaveText('hello')

      const list = await typeSlashCommand(page, query)
      await expect(list.locator(`#suggestion-${id}`)).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.press('Enter')
      await expect(list).toBeHidden()
      await page.keyboard.type('world')
      await expect(editor.locator(tag)).toHaveText('world')

      await saveBlock(page, 'Escape')
      await reopenPage(page, 'Getting Started')

      const block = page
        .locator('[data-testid="sortable-block"]')
        .first()
        .locator('[data-testid="block-static"]')
      await expect(block.locator(tag)).toHaveText('world')
      // Exact text: no literal delimiters around `world`.
      await expect(block).toHaveText('hello world')
    })
  }
})
