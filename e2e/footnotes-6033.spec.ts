import { blockRow } from './domain'
import { expect, focusBlock, openPage, reopenPage, saveBlock, test, waitForBoot } from './helpers'

/**
 * E2E for #6033 S11 — footnotes. A typed `[^1]` becomes a superscript
 * reference, a block typed as `[^1]: note` defines it and shows the same number
 * as its marker, clicking the reference focuses the definition, and both blocks
 * store the text as typed.
 */

const PAGE = 'Getting Started'

type Page = import('@playwright/test').Page

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

/** A block's stored content, read back over IPC. */
function storedContent(page: Page, blockId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
    const block = (await invoke('get_block', { blockId: id })) as { content: string }
    return block.content
  }, blockId)
}

/** The id of the block the editor is in. */
async function editingBlockId(page: Page): Promise<string> {
  const row = page.locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
  const id = await row.getAttribute('data-block-id')
  if (id === null) throw new Error('no block is being edited')
  return id
}

test.describe('footnotes typed as [^label] (#6033) @editor @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('a reference shows its number and focuses its definition, both stored as typed', async ({
    page,
  }) => {
    const editor = await focusBlock(page, 0)
    const refId = await editingBlockId(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.pressSequentially('Claim[^1]')
    await expect(editor.locator('sup[data-type="footnote-ref"]')).toHaveText('1')

    await page.keyboard.press('Enter')
    const defId = await editingBlockId(page)
    expect(defId).not.toBe(refId)
    await page
      .locator('[data-testid="block-editor"] [contenteditable="true"]')
      .pressSequentially('[^1]: note')
    await saveBlock(page, 'Escape')

    const definition = blockRow(page, defId)
    await expect(definition.getByTestId('footnote-definition')).toHaveText('1')
    await expect(definition.getByTestId('block-static')).toHaveText('1note')

    await blockRow(page, refId).getByRole('link', { name: 'Footnote 1' }).click()
    await expect(
      definition.locator('[data-testid="block-editor"] [contenteditable="true"]'),
    ).toBeFocused()

    await reopenPage(page, PAGE)
    await expect(blockRow(page, refId).getByRole('link', { name: 'Footnote 1' })).toBeVisible()
    expect(await storedContent(page, refId)).toBe('Claim[^1]')
    expect(await storedContent(page, defId)).toBe('[^1]: note')
  })
})
