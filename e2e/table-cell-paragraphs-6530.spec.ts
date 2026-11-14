import type { Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  ipc,
  reopenPage,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6530: a table cell holds paragraphs only, the one shape its Markdown row
 * can store. A quote, list or code-fence marker typed in a cell stays text,
 * so the table saves whole, no block is split off below it and no list style
 * lands on the table block. Read back from the mock backend, and the cell
 * after navigating away and back.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000B10CK01'
const TABLE = '| A | B |\n| --- | --- |\n| one | two |'

async function storedContent(page: Page): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })).content
}

async function listStyle(page: Page): Promise<string | null> {
  const props = await ipc<Array<{ key: string; value_text: string | null }>>(
    page,
    'get_properties',
    { blockId: GS1 },
  )
  return props.find((p) => p.key === 'listStyle')?.value_text ?? null
}

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')

test.describe('A table cell holds paragraphs only (#6530) @editor', () => {
  test('quote, list and code-fence markers typed in a cell stay text', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'edit_block', { blockId: GS1, toText: TABLE })
    await reopenPage(page, PAGE)
    const before = await rows(page).count()

    await focusBlockById(page, GS1)
    const editing = page.locator('[data-testid="block-editor"] table')
    // The end of `two`, after the header text `AB` and `one`.
    await selectEditorRange(page, 8, 8)
    for (const line of ['> quoted', '- pending', '``` code']) {
      await page.keyboard.press('Enter')
      await page.keyboard.type(line, { delay: 20 })
    }
    await expect(editing.locator('blockquote, ul, ol, pre')).toHaveCount(0)
    await expect(editing.getByRole('cell').last().locator('p')).toHaveText([
      'two',
      '> quoted',
      '- pending',
      '``` code',
    ])
    await saveBlock(page, 'Escape')

    // Each paragraph is escaped as the start of a line before the cell joins them.
    const cell = 'two \\> quoted \\- pending \\`\\`\\` code'
    await expect.poll(() => storedContent(page)).toBe(TABLE.replace('two', cell))
    expect(await listStyle(page)).toBeNull()
    await expect(rows(page)).toHaveCount(before)

    await reopenPage(page, PAGE)
    await expect(
      page.getByTestId('rich-table').getByRole('cell', { name: 'two > quoted - pending ``` code' }),
    ).toBeVisible()
  })

  test('a quote and a list pasted into a cell go in as its text', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'edit_block', { blockId: GS1, toText: TABLE })
    await reopenPage(page, PAGE)
    const before = await rows(page).count()

    const editor = await focusBlockById(page, GS1)
    await selectEditorRange(page, 8, 8)
    await editor.evaluate((el) => {
      const data = new DataTransfer()
      data.setData('text/html', '<blockquote><p>q</p></blockquote><ul><li>a</li><li>b</li></ul>')
      data.setData('text/plain', 'q\na\nb')
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    })
    await expect(
      page.locator('[data-testid="block-editor"] table').getByRole('cell').last(),
    ).toHaveText('twoqab')
    await saveBlock(page, 'Escape')

    await expect.poll(() => storedContent(page)).toBe(TABLE.replace('two', 'twoq a b'))
    await expect(rows(page)).toHaveCount(before)
  })
})
