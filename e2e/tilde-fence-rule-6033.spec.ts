/**
 * #6033 — stored content holding a `~~~` fence, or a `***` / `___` line, is a
 * code block and a rule in the editor, as Rust's grammar reads it, and stays so
 * when the page is opened again.
 */

import {
  expect,
  ipc,
  openPage,
  reopenPage,
  test,
  waitForBoot,
  waitForStableBlockRows,
} from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const TITLE = 'Tilde fences and rules'
const CONTENTS = ['~~~js\nconst tilde = 1\n~~~', '***', 'above\n___\nbelow'] as const

test.describe('stored tilde fences and star or underscore rules @editor @markdown', () => {
  test('render as a code block and as rules, again after reopening the page', async ({ page }) => {
    await waitForBoot(page)
    const pageId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: TITLE,
      spaceId: SCOPE.space_id,
    })
    const ids: string[] = []
    for (const content of CONTENTS) {
      const row = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content,
        parentId: pageId,
        index: null,
        scope: SCOPE,
      })
      ids.push(row.id)
    }

    const expectRendered = async () => {
      await waitForStableBlockRows(page, CONTENTS.length)
      const blocks = page.getByTestId('sortable-block')
      await expect(blocks.nth(0).locator('pre code')).toHaveText('const tilde = 1')
      await expect(blocks.nth(1).getByTestId('horizontal-rule')).toHaveCount(1)
      await expect(blocks.nth(2).getByTestId('horizontal-rule')).toHaveCount(1)
      await expect(blocks.nth(2)).toContainText('above')
      await expect(blocks.nth(2)).toContainText('below')
    }

    await openPage(page, TITLE)
    await expectRendered()
    await reopenPage(page, TITLE)
    await expectRendered()

    const stored = await Promise.all(
      ids.map(
        async (blockId) => (await ipc<{ content: string }>(page, 'get_block', { blockId })).content,
      ),
    )
    expect(stored).toEqual([...CONTENTS])
  })
})
