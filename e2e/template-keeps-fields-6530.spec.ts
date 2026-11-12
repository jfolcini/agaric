import type { Page } from '@playwright/test'

import {
  activeRoleDialog,
  blurEditors,
  expect,
  focusBlock,
  ipc,
  openPage,
  reopenPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * #6530: `/template` copies a template block's task state, priority, due date
 * and properties, not its text alone, and one Ctrl+Z takes the whole insert
 * back. Every assertion reads the mock backend back.
 */

const PAGE = 'Getting Started'
const PAGE_ID = '00000000000000000000PAGE01'
const TEMPLATE_ID = '00000000000000000000PAGE06'
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

interface Row {
  id: string
  content: string | null
  todo_state: string | null
  priority: string | null
  due_date: string | null
}

async function children(page: Page): Promise<Row[]> {
  return (
    await ipc<{ items: Row[] }>(page, 'list_blocks', {
      request: { parentId: PAGE_ID, limit: 100 },
      scope: SCOPE,
    })
  ).items
}

test.describe('/template keeps task state, priority, dates and properties (#6530) @editor @pages', () => {
  test('a TODO with a priority, a due date and a property arrives whole, and one undo removes the insert', async ({
    page,
  }) => {
    await waitForBoot(page)
    const todo = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: 'Prepare slides{{cursor}}',
      parentId: TEMPLATE_ID,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
    await ipc(page, 'set_todo_state', { blockId: todo.id, state: 'TODO' })
    await ipc(page, 'set_priority', { blockId: todo.id, level: '1' })
    await ipc(page, 'set_due_date', { blockId: todo.id, date: '2026-12-01' })
    await ipc(page, 'set_property', {
      blockId: todo.id,
      key: 'owner',
      value: { value_text: 'alice' },
    })

    await openPage(page, PAGE)
    const before = (await children(page)).map((r) => r.id)
    await focusBlock(page)
    await typeSlashCommand(page, 'template')
    await page.keyboard.press('Enter')
    await activeRoleDialog(page).getByText('Meeting Notes Template').click()
    await expect(page.getByText('Template inserted')).toBeVisible()

    await expect.poll(async () => (await children(page)).length).toBe(before.length + 4)
    const copy = (await children(page)).find((r) => r.content === 'Prepare slides')
    expect([copy?.todo_state, copy?.priority, copy?.due_date]).toEqual(['TODO', '1', '2026-12-01'])
    const props = await ipc<Array<{ key: string; value_text: string | null }>>(
      page,
      'get_properties',
      { blockId: copy?.id },
    )
    expect(props.find((p) => p.key === 'owner')?.value_text).toBe('alice')
    // The caret lands in the `{{cursor}}` block.
    await expect(
      page.locator(
        `[data-testid="sortable-block"][data-block-id="${copy?.id}"] [data-testid="block-editor"]`,
      ),
    ).toBeVisible()

    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await children(page)).map((r) => r.id)).toEqual(before)
    await reopenPage(page, PAGE)
    await expect(page.getByText('Prepare slides')).toHaveCount(0)
  })
})
