import type { Page } from '@playwright/test'

import { expect, focusBlock, ipc, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * Leaving a block in block mode commits every kind of metadata typed into it,
 * as page mode does: the task marker, the `key:: value` line and the `#name`
 * all on the one leave, not one kind per leave. Read back from the backend
 * after navigating away and back.
 */

const PAGE = 'Getting Started'
const TAG_REF = /^call mom #\[([0-9A-Z]{26})\]$/

interface BlockRow {
  content: string
  todo_state: string | null
}

interface PropertyRow {
  key: string
  value_text: string | null
}

interface TagRow {
  tag_id: string
  name: string
}

/** Paste `text/plain` onto the live editor, as a clipboard paste does. */
async function pasteText(page: Page, text: string): Promise<void> {
  await page
    .locator('[data-testid="block-editor"] [contenteditable="true"]')
    .evaluate((el, value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    }, text)
}

test('a task marker, a property line and a tag typed in a block all commit on one leave', async ({
  page,
}) => {
  await waitForBoot(page)
  await openPage(page, PAGE)
  const first = await focusBlock(page, 0)
  await first.press('End')
  await first.press('Enter')
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor.locator('p.is-editor-empty')).toBeVisible()
  const blockId = (await page
    .locator('[data-testid="block-editor"]')
    .getAttribute('data-block-id')) as string

  // A pasted task line keeps its marker in the text until the block is left.
  await pasteText(page, '- [ ] call mom')
  await expect(editor.locator('p[data-todo-state="TODO"]')).toBeVisible()
  await page.keyboard.type(' #work', { delay: 30 })
  await page.keyboard.press('Escape')
  await expect(editor.locator('[data-testid="tag-ref-chip"]')).toHaveCount(0)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('status:: done', { delay: 30 })
  await expect(editor).toContainText('status:: done')

  // Leave it for the block above.
  await focusBlock(page, 0)

  const block = () => ipc<BlockRow>(page, 'get_block', { blockId })
  await expect.poll(async () => (await block()).content).toMatch(TAG_REF)

  await reopenPage(page, PAGE)
  const row = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
  await expect(row.getByTestId('task-checkbox-todo')).toBeVisible()
  await expect(row.getByTestId('property-chip').filter({ hasText: 'done' })).toBeVisible()

  const stored = await block()
  expect(stored.todo_state).toBe('TODO')
  const [, tagId] = TAG_REF.exec(stored.content) as RegExpExecArray
  const tags = await ipc<TagRow[]>(page, 'list_all_tags_in_space', {
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
  })
  expect(tags.find((tag) => tag.tag_id === tagId)?.name).toBe('work')
  const properties = await ipc<PropertyRow[]>(page, 'get_properties', { blockId })
  expect(properties.find((prop) => prop.key === 'status')?.value_text).toBe('done')
})
