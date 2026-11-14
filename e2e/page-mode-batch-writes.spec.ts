/**
 * Page mode sends a structural edit as one batch (#6559): the blocks a paste
 * makes go out as one `create_blocks_batch` under the ids page mode gave them,
 * and the blocks a delete across them takes as one `delete_blocks_by_ids`.
 * What landed is read back after leaving the page and coming back.
 */

import type { Page } from '@playwright/test'

import { expect, getInvokeCalls, installIpcRecorder, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const EDITOR = '[data-testid="page-mode-editor"]'

interface MockWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
}

/** A page titled `title` holding `texts`, one top-level block each; resolves its id. */
function seedPage(page: Page, title: string, texts: readonly string[]): Promise<string> {
  return page.evaluate(
    async ({ title: t, texts: rows, scope }) => {
      const call = (cmd: string, args: Record<string, unknown>) =>
        (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke(cmd, args)
      const pageId = (await call('create_page_in_space', {
        parentId: null,
        content: t,
        spaceId: scope.space_id,
      })) as string
      await call('create_blocks_batch', {
        specs: rows.map((content) => ({
          blockType: 'content',
          content,
          parentId: pageId,
          position: null,
        })),
      })
      return pageId
    },
    { title, texts, scope: SCOPE },
  )
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

async function openInPageMode(page: Page, title: string, count: number): Promise<void> {
  await openViaPalette(page, title)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${EDITOR} [data-page-block]`)).toHaveCount(count)
}

/** Leave the page for another and open it again. */
async function leaveAndReturn(page: Page, title: string): Promise<void> {
  await openViaPalette(page, 'Getting Started')
  await openViaPalette(page, title)
}

/** Select from the start of block `from` to the end of block `to`, and focus the document. */
async function selectBlocks(page: Page, from: number, to: number): Promise<void> {
  await page.evaluate(
    ({ selector, from: a, to: b }) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: {
            doc: {
              child: (n: number) => { nodeSize: number; firstChild: { content: { size: number } } }
            }
          }
          commands: { setTextSelection: (range: { from: number; to: number }) => boolean }
          view: { focus: () => void }
        }
      }
      const startOf = (i: number) => {
        let pos = 0
        for (let k = 0; k < i; k += 1) pos += editor.state.doc.child(k).nodeSize
        return pos + 2
      }
      editor.commands.setTextSelection({
        from: startOf(a),
        to: startOf(b) + editor.state.doc.child(b).firstChild.content.size,
      })
      editor.view.focus()
      // ProseMirror puts its own selection back 20 ms after a focus (`editHandlers.focus`).
      return new Promise((resolve) => setTimeout(resolve, 20))
    },
    { selector: EDITOR, from, to },
  )
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

/** The texts of the page's live blocks, as the backend holds them, in order. */
async function backendTexts(page: Page, pageId: string): Promise<string[]> {
  const { blocks } = await ipc<{
    blocks: Array<{ parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  return blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((x, y) => x.position - y.position)
    .map((b) => b.content ?? '')
}

test.describe('page mode sends a structural edit as one batch (#6559) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a paste of 20 list lines creates its blocks in one batch, and they stay', async ({
    page,
  }) => {
    const pageId = await seedPage(page, 'Batch paste', ['first'])
    await openInPageMode(page, 'Batch paste', 1)
    await installIpcRecorder(page)
    await selectBlocks(page, 0, 0)
    const lines = Array.from({ length: 20 }, (_, i) => `- line ${i}`)

    await pasteFromOutside(page, lines.join('\n'))

    const expected = Array.from({ length: 20 }, (_, i) => `line ${i}`)
    await expect.poll(() => backendTexts(page, pageId)).toEqual(expected)
    expect(await getInvokeCalls(page, 'create_blocks_batch')).toHaveLength(1)
    expect(await getInvokeCalls(page, 'create_block')).toEqual([])

    await leaveAndReturn(page, 'Batch paste')
    await expect(page.getByText('line 19', { exact: true })).toBeVisible()
    expect(await backendTexts(page, pageId)).toEqual(expected)
  })

  test('a delete across 21 blocks deletes them in one batch, and they stay gone', async ({
    page,
  }) => {
    const texts = Array.from({ length: 30 }, (_, i) => `row ${i}`)
    const pageId = await seedPage(page, 'Batch delete', texts)
    await openInPageMode(page, 'Batch delete', 30)
    await installIpcRecorder(page)
    await selectBlocks(page, 2, 22)

    await page.keyboard.press('Backspace')

    const expected = ['row 0', 'row 1', '', ...texts.slice(23)]
    await expect.poll(() => backendTexts(page, pageId)).toEqual(expected)
    expect(await getInvokeCalls(page, 'delete_blocks_by_ids')).toHaveLength(1)
    expect(await getInvokeCalls(page, 'delete_block')).toEqual([])

    await leaveAndReturn(page, 'Batch delete')
    await expect(page.getByText('row 23', { exact: true })).toBeVisible()
    await expect(page.getByText('row 22', { exact: true })).toHaveCount(0)
    expect(await backendTexts(page, pageId)).toEqual(expected)
  })
})
