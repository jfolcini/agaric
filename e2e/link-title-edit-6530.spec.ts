import { expect, focusBlockById, ipc, reopenPage, saveBlock, test, waitForBoot } from './helpers'

/**
 * #6530: the first edit of an imported block keeps a link's title. The editor
 * used to drop `"Docs"` from `[the docs](https://e.com "Docs")` once one
 * character was typed anywhere in the block.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const IMPORTED = 'Read [the docs](https://e.com "Docs") now'

async function storedContent(page: import('@playwright/test').Page): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })).content
}

test.describe('A link title survives an edit (#6530) @editor', () => {
  test('typing one character keeps the title of a link in the block', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'edit_block', { blockId: GS1, toText: IMPORTED })
    await reopenPage(page, PAGE)

    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type('!')
    await expect(editor).toHaveText('Read the docs now!')
    await saveBlock(page, 'Escape')

    await expect.poll(() => storedContent(page)).toBe(`${IMPORTED}!`)
    await reopenPage(page, PAGE)
    await expect(
      page.locator(`[data-testid="block-static"][data-block-id="${GS1}"]`).getByRole('link', {
        name: 'the docs',
      }),
    ).toBeVisible()
    expect(await storedContent(page)).toBe(`${IMPORTED}!`)
  })
})
