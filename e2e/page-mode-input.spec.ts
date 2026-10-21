/**
 * Page mode (#5691) takes in what block mode does, against the mock backend:
 * Markdown text pasted from outside comes in as blocks at their depths, with
 * their marks, read back from the backend and again after leaving the page and
 * coming back; `:` opens the emoji picker, whose Enter inserts the emoji, and
 * which its setting turns off; and the `{{query` hint, whose Tab takes it
 * rather than indenting the block.
 */

import type { Locator, Page } from '@playwright/test'

import { activeSuggestionPopup, expect, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'
const JOY = '\u{1F602}'

type Row = [depth: number, text: string]

async function seedRows(page: Page, title: string, rows: readonly Row[]) {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const atDepth: string[] = [pageId]
  for (const [depth, content] of rows) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: atDepth[depth],
      index: null,
      scope: SCOPE,
    })
    atDepth[depth + 1] = row.id
  }
  return pageId
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  // Escape leaves page mode's editor for the box around it; a Ctrl+K in the editor is its link's.
  await expect
    .poll(() => page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, EDITOR))
    .toBe(false)
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

function modeSwitch(page: Page, name: 'Blocks' | 'Page'): Locator {
  return page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', { name })
}

async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, title)
  await modeSwitch(page, 'Page').click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

/** The page as the backend holds it: live blocks in document order, as `[text, depth]`. */
async function backend(page: Page, pageId: string): Promise<Array<[string, number]>> {
  const { blocks } = await ipc<{
    blocks: Array<{ id: string; parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  const out: Array<[string, number]> = []
  const walk = (parent: string, depth: number): void => {
    for (const b of blocks
      .filter((x) => x.parent_id === parent)
      .toSorted((x, y) => x.position - y.position)) {
      out.push([b.content ?? '', depth])
      walk(b.id, depth + 1)
    }
  }
  walk(pageId, 0)
  return out
}

/** The document as shown: each block's text and depth. */
const shown = (page: Page) =>
  page
    .locator(`${EDITOR} [data-page-block]`)
    .evaluateAll((els) =>
      els.map((el) => [
        el.querySelector('.page-block-content')?.textContent ?? '',
        Number(el.getAttribute('data-depth')),
      ]),
    )

/** Put the cursor at the end of block `index`'s text, and focus the document. */
async function caretAtEnd(page: Page, index: number): Promise<void> {
  await page.evaluate(
    ({ selector, index: i }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: {
            doc: {
              child: (n: number) => { nodeSize: number; firstChild: { content: { size: number } } }
            }
          }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let pos = 0
      for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
      editor.commands.setTextSelection(pos + 2 + editor.state.doc.child(i).firstChild.content.size)
      editor.view.focus()
      // ProseMirror puts its own selection back 20 ms after a focus; keys wait for that.
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector: EDITOR, index },
  )
  await expect(page.locator(EDITOR)).toBeFocused()
}

/** Paste `text` from outside the app: a clipboard holding only plain text. */
async function pasteFromOutside(page: Page, text: string): Promise<void> {
  await page.locator(EDITOR).evaluate((dom, plain) => {
    const data = new DataTransfer()
    data.setData('text/plain', plain)
    dom.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

test.describe('page mode takes in what block mode does (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Markdown text pasted from outside becomes blocks at their depths, with their marks, and stays', async ({
    page,
  }) => {
    const title = 'Markdown pasted'
    const pageId = await seedRows(page, title, [
      [0, 'alpha'],
      [0, ''],
    ])
    await openInPageMode(page, title, 2)
    await caretAtEnd(page, 1)

    await pasteFromOutside(page, '- one\n  - two **bold**\n- [link](https://example.com)\n\nend')

    const expected: Array<[string, number]> = [
      ['alpha', 0],
      ['one', 0],
      ['two **bold**', 1],
      ['[link](https://example.com)', 0],
      ['end', 0],
    ]
    await expect.poll(() => backend(page, pageId)).toEqual(expected)
    await expect(page.locator(`${EDITOR} [data-page-block] strong`)).toHaveText('bold')
    await expect(page.locator(`${EDITOR} [data-page-block] a`)).toHaveText('link')

    await openViaPalette(page, 'Getting Started')
    await openInPageMode(page, title, 5)
    expect(await backend(page, pageId)).toEqual(expected)
    await expect
      .poll(() => shown(page))
      .toEqual([
        ['alpha', 0],
        ['one', 0],
        ['two bold', 1],
        ['link', 0],
        ['end', 0],
      ])
  })

  test('`:` opens the emoji picker, whose Enter inserts the emoji and leaves the block whole, as saved', async ({
    page,
  }) => {
    const title = 'Emoji typed'
    const pageId = await seedRows(page, title, [[0, 'feeling']])
    await openInPageMode(page, title, 1)
    await caretAtEnd(page, 0)

    await page.keyboard.type(' :joy', { delay: 30 })
    await expect(
      activeSuggestionPopup(page).locator('[data-testid="suggestion-item"]', { hasText: 'joy' }),
    ).not.toHaveCount(0)
    await page.keyboard.press('Enter')

    await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(1)
    await expect.poll(() => backend(page, pageId)).toEqual([[`feeling ${JOY}`, 0]])
  })

  test('with the emoji picker turned off in Settings, `:` opens nothing', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('agaric-emoji-picker-enabled', 'false'))
    const title = 'Emoji off'
    await seedRows(page, title, [[0, 'feeling']])
    await openInPageMode(page, title, 1)
    await caretAtEnd(page, 0)

    await page.keyboard.type(' :joy', { delay: 30 })

    await expect(page.locator(`${EDITOR} [data-page-block] .page-block-content`)).toHaveText(
      'feeling :joy',
    )
    await expect(page.locator('[data-testid="suggestion-popup"]')).toHaveCount(0)
  })

  test('the `{{query` hint shows its next word, and Tab takes it rather than indenting the block', async ({
    page,
  }) => {
    const title = 'Query hint'
    const pageId = await seedRows(page, title, [
      [0, 'first'],
      [0, ''],
    ])
    await openInPageMode(page, title, 2)
    await caretAtEnd(page, 1)

    await page.keyboard.type('{{query ta', { delay: 20 })
    await expect(page.locator(`${EDITOR} [data-testid="query-hint"]`)).toBeVisible()
    await page.keyboard.press('Tab')

    await expect
      .poll(() => backend(page, pageId))
      .toEqual([
        ['first', 0],
        ['{{query tag:', 0],
      ])
  })
})
