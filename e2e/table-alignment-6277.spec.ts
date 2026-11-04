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
 * #6277 C2 — a stored GFM table keeps its column alignment through an edit.
 * The editor used to read `| :--- | ---: | :---: |` as plain `---` and write
 * that back on the first save, so fixing one typo left every column unaligned.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const DELIMITER = '| :--- | ---: | :---: | --- |'
const TABLE = `| Item | Qty | Note | Code |\n${DELIMITER}\n| tae | 2 | hot | x |`

test.describe('Table column alignment (#6277) @editor', () => {
  test('fixing a typo in an aligned table keeps its delimiter row', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'edit_block', { blockId: GS1, toText: TABLE })
    await reopenPage(page, PAGE)

    const rendered = page.getByTestId('rich-table')
    await expect(rendered.getByRole('cell', { name: '2', exact: true })).toHaveCSS(
      'text-align',
      'right',
    )

    await focusBlockById(page, GS1)
    const editing = page.locator('[data-testid="block-editor"] table')
    await expect(editing.getByRole('cell', { name: 'hot', exact: true })).toHaveCSS(
      'text-align',
      'center',
    )
    // `ae` of `tae`, after the header text `ItemQtyNoteCode`: an offset at a
    // cell edge resolves into the cell before it.
    await selectEditorRange(page, 16, 18)
    await page.keyboard.insertText('ea')
    await expect(editing.getByRole('cell', { name: 'tea', exact: true })).toBeVisible()
    await saveBlock(page, 'Escape')

    await reopenPage(page, PAGE)
    await expect
      .poll(
        async () => (await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })).content,
      )
      .toBe(TABLE.replace('tae', 'tea'))
  })
})
