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
 * rather than staying text, whichever of the two spells the name as typed.
 * The assertions read the mock backend after navigating away and back.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000B10CK01'
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
 * Two pages of one name, titled `olderTitle` and then `newerTitle`: the mock
 * imports a file under the title of a page that has content as a page of its
 * own, the way sync or old data comes to hold a name twice below the name
 * check that `create_block` and `create_page_in_space` apply. (The backend's
 * import merges into that page instead, #6277 G5.) Returns `[older, newer]`.
 */
async function twoPagesTitled(
  page: Page,
  olderTitle: string,
  newerTitle: string,
): Promise<[string, string]> {
  const importFile = async (title: string): Promise<string> =>
    (
      await ipc<{ page_id: string }>(page, 'import_markdown', {
        content: '- a body',
        filename: `${title}.md`,
        spaceId: SCOPE.space_id,
      })
    ).page_id
  return [await importFile(olderTitle), await importFile(newerTitle)]
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

/** Paste `see [[link]] ` into the middle of the seeded page's first block, then reopen the page. */
async function pasteLink(page: Page, link: string): Promise<void> {
  await ipc(page, 'edit_block', { blockId: GS1, toText: 'Hello world' })
  await openPage(page, PAGE)
  const editor = await focusBlockById(page, GS1)
  await selectEditorRange(page, 'Hello '.length, 'Hello '.length)
  await pasteText(editor, `see [[${link}]] `)
  await reopenPage(page, PAGE)
}

test.describe('A name two pages share links the older page (#6278) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a pasted [[Foo]] links the page with the lowest id', async ({ page }) => {
    const [older, newer] = await twoPagesTitled(page, 'Foo', 'Foo')
    expect(older < newer, `${older} is the older id`).toBe(true)
    expect((await pagesTitled(page, 'Foo')).toSorted()).toEqual([older, newer])

    await pasteLink(page, 'Foo')

    await expect.poll(() => storedContent(page, GS1)).toBe(`Hello see [[${older}]] world`)
    expect((await pagesTitled(page, 'Foo')).toSorted()).toEqual([older, newer])
  })

  test('a pasted [[Foo]] links the older foo, the page a create of Foo returns', async ({
    page,
  }) => {
    const [older, newer] = await twoPagesTitled(page, 'foo', 'Foo')
    expect(older < newer, `${older} is the older id`).toBe(true)

    await pasteLink(page, 'Foo')

    await expect.poll(() => storedContent(page, GS1)).toBe(`Hello see [[${older}]] world`)
    const created = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Foo',
      spaceId: SCOPE.space_id,
    })
    expect(created, 'a create and a paste of one name meet the same page').toBe(older)
    expect(await pagesTitled(page, 'Foo')).toEqual([newer])
    expect(await pagesTitled(page, 'foo')).toEqual([older])
  })
})
