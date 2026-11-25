import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  ipc,
  openPage,
  readClipboard,
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
 * stays inline, so the table is not cut in two. Every assertion reads the
 * backend after navigating away and back.
 */

const PAGE = 'Getting Started'
const PAGE_ID = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000B10CK01'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

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

/** Empty GS1 and open it in the editor. */
async function emptyEditor(page: Page): Promise<Locator> {
  await ipc(page, 'edit_block', { blockId: GS1, toText: '' })
  await openPage(page, PAGE)
  return focusBlockById(page, GS1)
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
    await expect.poll(() => storedContent(page, GS1)).toBe(`Hello see [[${id}]] nowworld`)
    expect(await childIds(page)).toEqual(before)
  })

  test('[[Name|label]] and Logseq [label]([[Name]]) keep their labels', async ({ page }) => {
    const editor = await caretAt(page, 'Hello world', 'Hello '.length)

    await pasteText(editor, '[alias]([[Fresh page]]) or [[Fresh page|other]] ')

    await expect.poll(() => pagesTitled(page, 'Fresh page')).toHaveLength(1)
    await reopenPage(page, PAGE)
    const [id] = await pagesTitled(page, 'Fresh page')
    await expect
      .poll(() => storedContent(page, GS1))
      .toBe(`Hello [[${id}|alias]] or [[${id}|other]] world`)
  })

  test('a #tag pasted alone becomes the tag', async ({ page }) => {
    const editor = await caretAt(page, 'Hello world', 'Hello '.length)

    await pasteText(editor, '#freshtag ')

    await reopenPage(page, PAGE)
    // `tags_cache` lists a tag made by the paste once its rebuild has run.
    const freshTagId = async () => {
      const tags = await ipc<Array<{ tag_id: string; name: string }>>(
        page,
        'list_all_tags_in_space',
        { scope: SCOPE },
      )
      return tags.find((t) => t.name === 'freshtag')?.tag_id
    }
    await expect.poll(freshTagId).toBeDefined()
    await expect.poll(() => storedContent(page, GS1)).toBe(`Hello #[${await freshTagId()}] world`)
  })

  // The splice would cut the table in two, so the line goes in at the caret,
  // its brackets escaped as typed text is.
  test('a line pasted into a table cell stays inline: its name stays text', async ({ page }) => {
    const table = '| A | B |\n| --- | --- |\n| one | two |'
    // After "A", "B" and "one": the end of the first body cell.
    const editor = await caretAt(page, table, 'ABone'.length)

    await pasteText(editor, ' see [[Fresh page]]')

    await expect(editor).toContainText('one see [[Fresh page]]')
    await expect(editor.locator('table')).toHaveCount(1)
    await reopenPage(page, PAGE)
    await expect
      .poll(() => storedContent(page, GS1))
      .toBe('| A | B |\n| --- | --- |\n| one see \\[\\[Fresh page\\]\\] | two |')
    expect(await pagesTitled(page, 'Fresh page')).toEqual([])
  })

  // #6033 S4, S5b: Logseq's highlight and Obsidian's embed, which the backend
  // normalises as it stores them.
  test('a pasted line holding ^^x^^ is stored as Agaric’s ==x== @real-only', async ({ page }) => {
    const editor = await caretAt(page, 'Hello world', 'Hello '.length)

    await pasteText(editor, 'x ^^y^^')

    await expect(editor).toContainText('Hello x ')
    await reopenPage(page, PAGE)
    await expect.poll(() => storedContent(page, GS1)).toBe('Hello x ==y==world')
  })

  test('a copy of text holding ^^ literally pastes back byte for byte', async ({ page }) => {
    const escaped = 'a \\^\\^b\\^\\^ c'
    const before = await childIds(page)
    await emptyEditor(page)
    await page.keyboard.type('a ^^b^^ c')
    // Escape commits the block and leaves it selected (#5160 D17); the second
    // clears that selection so the Ctrl+click below starts from none.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // The editor stores the text escaped, so no paste reads it as a highlight.
    await expect.poll(() => storedContent(page, GS1)).toBe(escaped)

    await page
      .locator(`[data-testid="block-static"][data-block-id="${GS1}"]`)
      .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain('a ')
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await childIds(page)).length).toBe(before.length + 1)

    await reopenPage(page, PAGE)
    const copy = (await childIds(page)).filter((id) => !before.includes(id))
    expect(copy).toHaveLength(1)
    await expect.poll(() => storedContent(page, GS1)).toBe(escaped)
    expect(await storedContent(page, copy[0] as string)).toBe(escaped)
  })

  test('a pasted ![[Note]] is stored as an embed of the page @real-only', async ({ page }) => {
    const note = await ipc<Row>(page, 'create_block', {
      blockType: 'page',
      content: 'Embedded note',
      parentId: null,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: 'the note body',
      parentId: note.id,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
    const editor = await emptyEditor(page)

    await pasteText(editor, '![[Embedded note]]')

    const embed = `{{embed [[${note.id}]]}}`
    await expect.poll(() => storedContent(page, GS1)).toBe(embed)
    await reopenPage(page, PAGE)
    await expect(
      page.locator(`li[data-block-id="${GS1}"] [data-testid="embed-container"]`),
    ).toContainText('the note body')
    await expect.poll(() => storedContent(page, GS1)).toBe(embed)
  })
})
