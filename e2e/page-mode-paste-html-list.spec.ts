/**
 * A list pasted into page mode as HTML (#6727), against the mock backend: each
 * item is a block with its list style, a nested item one deeper, as block
 * mode's paste makes them (`html-paste-1439.spec.ts`, #6277 E5), read back from
 * the backend and again after leaving the page and coming back.
 */

import type { Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'
import {
  PAGE_EDITOR,
  backendBlocks,
  caret,
  openInPageMode,
  openPageByTitle,
  seedPage,
} from './page-mode'

async function pasteHtml(page: Page, html: string, plain: string): Promise<void> {
  await page.locator(PAGE_EDITOR).evaluate(
    (dom, { html: markup, plain: text }) => {
      const data = new DataTransfer()
      data.setData('text/html', markup)
      data.setData('text/plain', text)
      dom.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { html, plain },
  )
}

/** The page's blocks as stored, in document order: `[depth, text, list style]`. */
async function storedList(
  page: Page,
  pageId: string,
): Promise<Array<[number, string, string | null]>> {
  const blocks = await backendBlocks(page, pageId)
  return Promise.all(
    blocks.map(async ({ id, depth, text }): Promise<[number, string, string | null]> => {
      const props = await ipc<Array<{ key: string; value_text: string | null }>>(
        page,
        'get_properties',
        { blockId: id },
      )
      return [depth, text, props.find((p) => p.key === 'listStyle')?.value_text ?? null]
    }),
  )
}

test.describe('page mode makes a block of each item of a list pasted as HTML (#6727) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a pasted <ul> and <ol> land as bulleted and numbered blocks holding only their text', async ({
    page,
  }) => {
    const title = 'HTML lists pasted'
    const { pageId } = await seedPage(page, title, [
      [0, 'alpha'],
      [0, ''],
    ])
    await openInPageMode(page, title, 2)
    await caret(page, 1, 'end')

    await pasteHtml(
      page,
      '<ul><li>html bullet one</li><li>html bullet two</li></ul>' +
        '<ol><li>html step one</li><li>html step two</li></ol>',
      'html bullet one\nhtml bullet two\nhtml step one\nhtml step two',
    )

    const stored: Array<[number, string, string | null]> = [
      [0, 'alpha', null],
      [0, 'html bullet one', 'bullet'],
      [0, 'html bullet two', 'bullet'],
      [0, 'html step one', 'ordered'],
      [0, 'html step two', 'ordered'],
    ]
    await expect.poll(() => storedList(page, pageId)).toEqual(stored)
    const markers = page.locator(`${PAGE_EDITOR} [data-page-block] > [data-testid="list-marker"]`)
    await expect(markers).toHaveCount(4)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, title, 5)
    expect(await storedList(page, pageId)).toEqual(stored)
    await expect(markers).toHaveCount(4)
  })

  test('a nested item is a block one deeper than its item, with its marks', async ({ page }) => {
    const title = 'Nested HTML list pasted'
    const { pageId } = await seedPage(page, title, [[0, '']])
    await openInPageMode(page, title, 1)
    await caret(page, 0, 'end')

    await pasteHtml(
      page,
      '<ul><li>parent<ul><li>child with <b>bold</b></li></ul></li><li>sibling</li></ul>',
      'parent\nchild with bold\nsibling',
    )

    const stored: Array<[number, string, string | null]> = [
      [0, 'parent', 'bullet'],
      [1, 'child with **bold**', 'bullet'],
      [0, 'sibling', 'bullet'],
    ]
    await expect.poll(() => storedList(page, pageId)).toEqual(stored)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, title, 3)
    expect(await storedList(page, pageId)).toEqual(stored)
  })
})
