/**
 * Pastes page mode takes from outside the app (#5691), against the mock
 * backend, each read back from it: HTML from a web page with its unsafe link
 * taken off, a task line into an empty block and into text, and a
 * URL over selected text. Markdown text, list items and names of pages are in
 * `page-mode-input.spec.ts` and `page-mode-paste-names-6033.spec.ts`.
 */

import type { Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'
import {
  PAGE_EDITOR,
  backendBlocks,
  backendTexts,
  caret,
  openInPageMode,
  openPageByTitle,
  seedPage,
} from './page-mode'

/** Paste from outside the app: a clipboard holding `plain`, and `html` beside it when given. */
async function pasteFromOutside(page: Page, plain: string, html?: string): Promise<void> {
  await page.locator(PAGE_EDITOR).evaluate(
    (dom, { plain: text, html: markup }) => {
      const data = new DataTransfer()
      if (markup !== undefined) data.setData('text/html', markup)
      data.setData('text/plain', text)
      dom.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    },
    { plain, html },
  )
}

/** The page's blocks as stored: text and task state. */
async function storedTasks(page: Page, pageId: string): Promise<Array<[string, string | null]>> {
  const rows: Array<[string, string | null]> = []
  for (const { id } of await backendBlocks(page, pageId)) {
    const row = await ipc<{ content: string; todo_state: string | null }>(page, 'get_block', {
      blockId: id,
    })
    rows.push([row.content, row.todo_state])
  }
  return rows
}

test.describe('page mode takes pastes from outside (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('HTML from a web page becomes a heading block and a paragraph block with its marks, and they stay', async ({
    page,
  }) => {
    const { pageId } = await seedPage(page, 'HTML pasted', [
      [0, 'alpha'],
      [0, ''],
    ])
    await openInPageMode(page, 'HTML pasted', 2)
    await caret(page, 1, 'end')

    await pasteFromOutside(
      page,
      'My Heading\nA paragraph with bold text and a link.',
      '<h2>My Heading</h2>' +
        '<p>A paragraph with <b>bold</b> text and a <a href="https://example.com">link</a>.</p>',
    )

    const stored = [
      'alpha',
      '## My Heading',
      'A paragraph with **bold** text and a [link](https://example.com).',
    ]
    await expect.poll(() => backendTexts(page, pageId)).toEqual(stored)
    const blocks = page.locator(`${PAGE_EDITOR} [data-page-block]`)
    await expect(blocks.nth(1).locator('h2')).toHaveText('My Heading')

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'HTML pasted', 3)
    expect(await backendTexts(page, pageId)).toEqual(stored)
    await expect(blocks.nth(2).locator('strong')).toHaveText('bold')
    await expect(blocks.nth(2).locator('a')).toHaveText('link')
  })

  test('a javascript: link pasted as HTML keeps its text and makes no link', async ({ page }) => {
    const { pageId } = await seedPage(page, 'Unsafe link pasted', [
      [0, 'alpha'],
      [0, ''],
    ])
    await openInPageMode(page, 'Unsafe link pasted', 2)
    await caret(page, 1, 'end')

    await pasteFromOutside(
      page,
      'danger click me end',
      '<p>danger <a href="javascript:alert(1)">click me</a> end</p>',
    )

    await expect.poll(() => backendTexts(page, pageId)).toEqual(['alpha', 'danger click me end'])
    await expect(page.locator(`${PAGE_EDITOR} a`)).toHaveCount(0)
  })

  test('a task line pasted into an empty block is the block’s task once left, and into text it stays text', async ({
    page,
  }) => {
    const { pageId } = await seedPage(page, 'Task lines pasted', [
      [0, ''],
      [0, ''],
      [0, 'hello world'],
      [0, 'last'],
    ])
    await openInPageMode(page, 'Task lines pasted', 4)

    await caret(page, 0, 'end')
    await pasteFromOutside(page, '- [ ] open task')
    await caret(page, 1, 'end')
    await pasteFromOutside(page, '- [x] finished task')
    await caret(page, 2, 'hello'.length)
    await pasteFromOutside(page, '- [x] done')
    await caret(page, 3, 'end')

    const stored: Array<[string, string | null]> = [
      ['open task', 'TODO'],
      ['finished task', 'DONE'],
      // Text, as block mode keeps it (#1514): the block is not taken over as a task.
      ['hello- \\[x\\] done world', null],
      ['last', null],
    ]
    await expect.poll(() => storedTasks(page, pageId)).toEqual(stored)

    await openPageByTitle(page, 'Getting Started')
    await openInPageMode(page, 'Task lines pasted', 4)
    expect(await storedTasks(page, pageId)).toEqual(stored)
    await expect(page.locator(`${PAGE_EDITOR} [data-testid^="task-checkbox"]`)).toHaveCount(2)
  })

  test('a URL pasted over selected text links that text, stored as a Markdown link', async ({
    page,
  }) => {
    const { pageId, ids } = await seedPage(page, 'URL pasted', [
      [0, 'see the docs'],
      [0, 'next'],
    ])
    await openInPageMode(page, 'URL pasted', 2)

    await caret(page, 0, 'see the '.length, { index: 0, offset: 'end' })
    await pasteFromOutside(page, 'https://example.com/docs')
    await expect(page.locator(`[data-page-block-id="${ids[0]}"] a`)).toHaveText('docs')
    await page.keyboard.press('Escape')

    await expect
      .poll(() => backendTexts(page, pageId))
      .toEqual(['see the [docs](https://example.com/docs)', 'next'])
  })
})
