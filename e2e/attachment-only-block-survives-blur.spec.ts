import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  ipc,
  openPage,
  pasteFile,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5412 — a blank block whose only content is an attachment is not an empty block.
 *
 * Leaving a blank block runs the empty-block cleanup (`empty-block-cleanup.ts`), which deletes it
 * unless something marks it as content. A non-image file pasted into a fresh block adds an
 * `attachments` row and no text, so before #5412 the attachment went to Trash with its block the
 * moment the user clicked away.
 *
 * The control leaves a blank block holding nothing and sees the cleanup remove it, so the second
 * test cannot pass by the cleanup never running. Both leave the blank block by clicking the line
 * above it, and re-read the page after leaving it.
 */

const PAGE = 'Attachment holder page'
const MARKED = 'the line above'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

interface ChildRow {
  id: string
}

/** Create the page with its one marked line, open it, and return the line's id. */
async function seedMarkedLine(page: Page): Promise<{ pageId: string; markedId: string }> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: PAGE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const { id: markedId } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content: MARKED,
    parentId: pageId,
    index: null,
    scope: SCOPE,
    blockId: null,
  })
  await openPage(page, PAGE)
  return { pageId, markedId }
}

/** Open the marked line, press Enter at its end, and return the blank block Enter made. */
async function blankBlockBelow(page: Page, markedId: string): Promise<string> {
  await focusBlockById(page, markedId)
  await page.keyboard.press('Enter')
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toHaveText('')
  const id = await editor.evaluate(
    (el) => el.closest('[data-block-id]')?.getAttribute('data-block-id') ?? null,
  )
  expect(id).not.toBe(markedId)
  return id ?? ''
}

/** Leave the blank block for the marked line, which runs the cleanup on the block left. */
async function leaveFor(page: Page, markedId: string): Promise<void> {
  await focusBlockById(page, markedId)
  await page.keyboard.press('Escape')
}

/** The page's child block ids, as the backend reads them now. */
async function childIds(page: Page, pageId: string): Promise<string[]> {
  const { items } = await ipc<{ items: ChildRow[] }>(page, 'list_blocks', {
    request: {
      parentId: pageId,
      blockType: null,
      tagId: null,
      date: null,
      dateRange: null,
      source: null,
      excludeTodoStates: null,
      cursor: null,
      limit: 100,
    },
    scope: SCOPE,
  })
  return items.map((row) => row.id)
}

test.describe('An attachment-only block (#5412) @editor @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('control: leaving a blank block holding nothing cleans it up', async ({ page }) => {
    const { pageId, markedId } = await seedMarkedLine(page)
    const blankId = await blankBlockBelow(page, markedId)
    await leaveFor(page, markedId)

    await expect(page.locator(`[data-block-id="${blankId}"]`)).toHaveCount(0)
    await reopenPage(page, PAGE)
    await expect(page.locator(`[data-block-id="${markedId}"]`).first()).toBeVisible()
    await expect(page.locator(`[data-block-id="${blankId}"]`)).toHaveCount(0)
    await expect.poll(() => childIds(page, pageId)).toEqual([markedId])
  })

  test('keeps a blank block holding an attachment after focus leaves it', async ({ page }) => {
    const { pageId, markedId } = await seedMarkedLine(page)
    const blankId = await blankBlockBelow(page, markedId)
    // "agaric" — a text file stays a block attachment; an image would go into the text.
    await pasteFile(page.locator('[data-testid="block-editor"]'), {
      name: 'note.txt',
      type: 'text/plain',
      base64: 'YWdhcmlj',
    })
    await expect(page.getByText('Attached "note.txt"')).toBeVisible()
    await leaveFor(page, markedId)

    const badge = page.locator(`[data-block-id="${blankId}"] [data-testid="attachment-badge"]`)
    await expect(badge).toHaveAttribute('aria-label', '1 attachment')
    await reopenPage(page, PAGE)
    await expect(badge).toHaveAttribute('aria-label', '1 attachment')
    expect(await childIds(page, pageId)).toEqual([markedId, blankId])
    const attachments = await ipc<Array<{ filename: string }>>(page, 'list_attachments', {
      blockId: blankId,
    })
    expect(attachments.map((row) => row.filename)).toEqual(['note.txt'])
  })
})
