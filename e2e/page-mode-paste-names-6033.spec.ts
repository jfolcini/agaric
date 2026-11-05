/**
 * #6033 — page mode's paste reads names as block mode's does: a `[[Name]]`
 * pasted in one line or in several goes through block mode's `paste_blocks`,
 * which links the page of that name, created when none exists, and leaves the
 * caret after the paste. The page's undo takes the paste back. Text dropped
 * from outside is no paste: it goes in where it is dropped, as text. Every
 * assertion of what is stored reads the mock backend after navigating away and
 * back.
 */

import type { Locator, Page } from '@playwright/test'

import { blurEditors, expect, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

interface Row {
  id: string
  content: string | null
}

/** A page titled `title` holding one top-level block per text; resolves its id and theirs. */
async function seedRows(
  page: Page,
  title: string,
  texts: readonly string[],
): Promise<{ pageId: string; ids: string[] }> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of texts) {
    const row = await ipc<Row>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids.push(row.id)
  }
  return { pageId, ids }
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

/** Drop `text` from outside the app, which holds only plain text, at the end of block `index`'s text. */
async function dropFromOutside(page: Page, text: string, index: number): Promise<void> {
  const box = await page.locator(`${EDITOR} [data-page-block] p`).nth(index).boundingBox()
  if (box === null) throw new Error(`block ${index} has no box`)
  await page.locator(EDITOR).evaluate(
    (dom, { plain, x, y }) => {
      const data = new DataTransfer()
      data.setData('text/plain', plain)
      dom.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: data,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    { plain: text, x: box.x + box.width - 4, y: box.y + box.height / 2 },
  )
}

/** The texts of the page's top-level blocks as the backend holds them, in order. */
async function storedTexts(page: Page, pageId: string): Promise<Array<string | null>> {
  const { blocks } = await ipc<{ blocks: Array<Row & { parent_id: string; position: number }> }>(
    page,
    'load_page_subtree',
    { rootBlockId: pageId, scope: SCOPE },
  )
  return blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((x, y) => x.position - y.position)
    .map((b) => b.content)
}

/** The ids of the pages titled `title`. */
async function pagesTitled(page: Page, title: string): Promise<string[]> {
  const pages = await ipc<Row[]>(page, 'list_all_pages_in_space', { scope: SCOPE, tagIds: null })
  return pages.filter((p) => p.content === title).map((p) => p.id)
}

test.describe('page mode’s paste reads names as block mode’s does (#6033) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('one pasted line links a new page, spliced where it was pasted', async ({ page }) => {
    const title = 'Names pasted in one line'
    const { pageId } = await seedRows(page, title, ['Hello ', 'next'])
    await openInPageMode(page, title, 2)
    await caretAtEnd(page, 0)

    await pasteFromOutside(page, 'see [[Fresh page]]')

    await expect(page.locator(`${EDITOR} [data-testid="block-link-chip"]`)).toHaveText('Fresh page')
    await openViaPalette(page, 'Getting Started')
    await openInPageMode(page, title, 2)
    const [id] = await pagesTitled(page, 'Fresh page')
    expect(await storedTexts(page, pageId)).toEqual([`Hello see [[${id}]]`, 'next'])
  })

  test('lines pasted as blocks link their pages, and typing goes on after the last', async ({
    page,
  }) => {
    const title = 'Names pasted in lines'
    const { pageId } = await seedRows(page, title, ['Hello ', 'next'])
    await openInPageMode(page, title, 2)
    await caretAtEnd(page, 0)

    await pasteFromOutside(page, 'see [[Fresh page]]\n\nand [[Other page|other]]')
    await expect(page.locator(`${EDITOR} [data-testid="block-link-chip"]`)).toHaveText([
      'Fresh page',
      'other',
    ])
    await page.keyboard.type('!')

    const [fresh] = await pagesTitled(page, 'Fresh page')
    const [other] = await pagesTitled(page, 'Other page')
    const stored = [`Hello see [[${fresh}]]`, `and [[${other}|other]]!`, 'next']
    await expect.poll(() => storedTexts(page, pageId)).toEqual(stored)
    await openViaPalette(page, 'Getting Started')
    await openInPageMode(page, title, 3)
    expect(await storedTexts(page, pageId)).toEqual(stored)
  })

  test('the page’s undo takes the paste back, the page it made with it', async ({ page }) => {
    const title = 'Names pasted, then undone'
    const { pageId } = await seedRows(page, title, ['Hello ', 'next'])
    await openInPageMode(page, title, 2)
    await caretAtEnd(page, 0)
    await pasteFromOutside(page, 'see [[Fresh page]]')
    await expect(page.locator(`${EDITOR} [data-testid="block-link-chip"]`)).toHaveText('Fresh page')

    await blurEditors(page)
    await page.keyboard.press('Control+z')

    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()
    await openViaPalette(page, 'Getting Started')
    await openInPageMode(page, title, 2)
    expect(await storedTexts(page, pageId)).toEqual(['Hello ', 'next'])
    expect(await pagesTitled(page, 'Fresh page')).toEqual([])
  })

  test('text dropped from outside goes in where it is dropped, as text, not as a paste', async ({
    page,
  }) => {
    const title = 'Names dropped'
    const { pageId } = await seedRows(page, title, ['Hello ', 'next'])
    await openInPageMode(page, title, 2)
    await caretAtEnd(page, 0)

    await dropFromOutside(page, 'see [[Fresh page]]', 1)

    await expect(page.locator(`${EDITOR} [data-page-block]`).nth(1)).toHaveText(
      'nextsee [[Fresh page]]',
    )
    await openViaPalette(page, 'Getting Started')
    await openInPageMode(page, title, 2)
    expect(await storedTexts(page, pageId)).toEqual(['Hello ', 'nextsee \\[\\[Fresh page\\]\\]'])
    expect(await pagesTitled(page, 'Fresh page')).toEqual([])
  })
})
