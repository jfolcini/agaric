import { expect, focusBlockById, ipc, reopenPage, saveBlock, test, waitForBoot } from './helpers'

/**
 * #6530: the first edit of an imported block keeps the number its ordered
 * list starts at. The editor used to write `5. five / 6. six` back as
 * `1. / 2.` once one character was typed anywhere in the block.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const IMPORTED = '5. five\n6. six'

async function storedContent(page: import('@playwright/test').Page): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })).content
}

test.describe('An ordered list keeps its start number through an edit (#6530) @editor', () => {
  test('typing one character keeps a list starting at 5 numbered from 5', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'edit_block', { blockId: GS1, toText: IMPORTED })
    await reopenPage(page, PAGE)

    const editor = await focusBlockById(page, GS1)
    await expect(editor.locator('ol')).toHaveAttribute('start', '5')
    await editor.locator('li').last().click()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await saveBlock(page, 'Escape')

    await expect.poll(() => storedContent(page)).toBe(`${IMPORTED}!`)
    await reopenPage(page, PAGE)
    await expect(
      page.locator(`[data-testid="block-static"][data-block-id="${GS1}"] ol`),
    ).toHaveAttribute('start', '5')
    expect(await storedContent(page)).toBe(`${IMPORTED}!`)
  })
})
