import type { Locator, Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  ipc,
  openPage,
  reopenPage,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6033 — one line of plain text pasted into a block reads its names as a
 * block paste reads them: `[[Name]]`, `[[Name|label]]` and Logseq's
 * `[label]([[Name]])` link the page of that name, created when none exists,
 * and the line joins the block at the cursor. Inside a table cell the line
 * stays inline, so the table is not cut in two. Every assertion reads the mock
 * backend after navigating away and back.
 */

const PAGE = 'Getting Started'
const PAGE_ID = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000BLOCK01'
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

interface Row {
  id: string
  content: string | null
}

async function storedContent(page: Page, blockId: string): Promise<string | null> {
  return (await ipc<Row>(page, 'get_block', { blockId })).content
}

async function childIds(page: Page): Promise<string[]> {
  const resp = await ipc<{ items: Row[] }>(page, 'list_blocks', {
    request: { parentId: PAGE_ID, limit: 100 },
    scope: SCOPE,
  })
  return resp.items.map((r) => r.id)
}

/** The ids of the pages titled `title`. */
async function pagesTitled(page: Page, title: string): Promise<string[]> {
  const pages = await ipc<Row[]>(page, 'list_all_pages_in_space', { scope: SCOPE, tagIds: null })
  return pages.filter((p) => p.content === title).map((p) => p.id)
}

/** Dispatch a native paste of `text/plain` onto the live editor. */
async function pasteText(editor: Locator, text: string): Promise<void> {
  await editor.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

/** Give GS1 `content`, open it, and put the caret `offset` characters into its text. */
async function caretAt(page: Page, content: string, offset: number): Promise<Locator> {
  await ipc(page, 'edit_block', { blockId: GS1, toText: content })
  await openPage(page, PAGE)
  const editor = await focusBlockById(page, GS1)
  await selectEditorRange(page, offset, offset)
  return editor
}

test.describe('One pasted line reads its names as a block paste does (#6033) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('[[Name]] pasted mid-block links a new page, spliced in place', async ({ page }) => {
    const before = await childIds(page)
    const editor = await caretAt(page, 'Hello world', 'Hello '.length)

    await pasteText(editor, 'see [[Fresh page]] now')

    await expect.poll(() => pagesTitled(page, 'Fresh page')).toHaveLength(1)
    await reopenPage(page, PAGE)
    const [id] = await pagesTitled(page, 'Fresh page')
    expect(await storedContent(page, GS1)).toBe(`Hello see [[${id}]] nowworld`)
    expect(await childIds(page)).toEqual(before)
  })

  test('[[Name|label]] and Logseq [label]([[Name]]) keep their labels', async ({ page }) => {
    const editor = await caretAt(page, 'Hello world', 'Hello '.length)

    await pasteText(editor, '[alias]([[Fresh page]]) or [[Fresh page|other]] ')

    await expect.poll(() => pagesTitled(page, 'Fresh page')).toHaveLength(1)
    await reopenPage(page, PAGE)
    const [id] = await pagesTitled(page, 'Fresh page')
    expect(await storedContent(page, GS1)).toBe(`Hello [[${id}|alias]] or [[${id}|other]] world`)
  })

  test('a #tag pasted alone becomes the tag', async ({ page }) => {
    const editor = await caretAt(page, 'Hello world', 'Hello '.length)

    await pasteText(editor, '#freshtag ')

    await reopenPage(page, PAGE)
    const tags = await ipc<Array<{ tag_id: string; name: string }>>(
      page,
      'list_all_tags_in_space',
      { scope: SCOPE },
    )
    const tag = tags.find((t) => t.name === 'freshtag')
    expect(tag).toBeDefined()
    expect(await storedContent(page, GS1)).toBe(`Hello #[${tag?.tag_id}] world`)
  })

  // The splice would cut the table in two, so the line goes in at the caret,
  // its brackets escaped as typed text is.
  test('a line pasted into a table cell stays inline: its name stays text', async ({ page }) => {
    const table = '| A | B |\n| --- | --- |\n| one | two |'
    // After "A", "B" and "one": the end of the first body cell.
    const editor = await caretAt(page, table, 'ABone'.length)

    await pasteText(editor, ' see [[Fresh page]]')

    await expect(editor.locator('table')).toHaveCount(1)
    await reopenPage(page, PAGE)
    expect(await storedContent(page, GS1)).toBe(
      '| A | B |\n| --- | --- |\n| one see \\[\\[Fresh page\\]\\] | two |',
    )
    expect(await pagesTitled(page, 'Fresh page')).toEqual([])
  })
})
