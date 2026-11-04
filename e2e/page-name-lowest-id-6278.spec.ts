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
 * #6278 — when two live pages of one space share a name, the one with the
 * lowest id (the older page) holds it: a pasted `[[Foo]]` links that page
 * rather than staying text. The assertions read the mock backend after
 * navigating away and back.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

interface Row {
  id: string
  content: string | null
}

async function storedContent(page: Page, blockId: string): Promise<string | null> {
  return (await ipc<Row>(page, 'get_block', { blockId })).content
}

/** The ids of the pages titled `title`. */
async function pagesTitled(page: Page, title: string): Promise<string[]> {
  const pages = await ipc<Row[]>(page, 'list_all_pages_in_space', { scope: SCOPE, tagIds: null })
  return pages.filter((p) => p.content === title).map((p) => p.id)
}

/**
 * Two pages titled `title`: the first made as the app makes one, the second
 * as sync or data from before the name check leaves it, through a raw create
 * that runs no name check. Returns `[older, newer]`.
 */
async function twoPagesTitled(page: Page, title: string): Promise<[string, string]> {
  const older = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const { id: newer } = await ipc<Row>(page, 'create_block', {
    blockType: 'page',
    content: title,
    parentId: null,
    index: null,
    scope: SCOPE,
    blockId: null,
  })
  return [older, newer]
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

test.describe('A name two pages share links the older page (#6278) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a pasted [[Foo]] links the page with the lowest id', async ({ page }) => {
    const [older, newer] = await twoPagesTitled(page, 'Foo')
    expect(older < newer, `${older} is the older id`).toBe(true)
    expect((await pagesTitled(page, 'Foo')).toSorted()).toEqual([older, newer])

    await ipc(page, 'edit_block', { blockId: GS1, toText: 'Hello world' })
    await openPage(page, PAGE)
    const editor = await focusBlockById(page, GS1)
    await selectEditorRange(page, 'Hello '.length, 'Hello '.length)
    await pasteText(editor, 'see [[Foo]] ')

    await reopenPage(page, PAGE)
    await expect.poll(() => storedContent(page, GS1)).toBe(`Hello see [[${older}]] world`)
    expect((await pagesTitled(page, 'Foo')).toSorted()).toEqual([older, newer])
  })
})
