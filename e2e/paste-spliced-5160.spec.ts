import type { Locator, Page } from '@playwright/test'

import { expect, focusBlockById, openPage, test, waitForBoot } from './helpers'

/**
 * #5160 D4 — multi-line text pasted into a block is read as blocks and spliced
 * like a text editor: the first block joins the block at the cursor, the rest
 * follow, and the text after the cursor ends the last one. The toast then
 * offers Paste as text, which takes the blocks back and puts the lines into
 * the block as they are. Every structural assertion reads the mock backend.
 */

const PAGE = 'Getting Started'
const PAGE_ID = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000BLOCK01'

/** The shape of a chat answer: a lead-in, a heading, a numbered list, a sign-off. */
const LLM_ANSWER =
  'Here is a plan:\n\n## Plan\n\n1. First step\n   - detail\n2. Second step\n\nGood luck!'

interface Row {
  id: string
  content: string | null
}

function ipc<T>(page: Page, cmd: string, args: unknown): Promise<T> {
  return page.evaluate(
    ({ c, a }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke(c, a)
    },
    { c: cmd, a: args },
  ) as Promise<T>
}

async function childrenOf(page: Page, parentId: string): Promise<Row[]> {
  const resp = await ipc<{ items: Row[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
  })
  return resp.items
}

async function contentsOf(page: Page, parentId: string): Promise<Array<string | null>> {
  return (await childrenOf(page, parentId)).map((r) => r.content)
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

/** Focus GS_1 holding "Hello world" and put the caret after "Hello ". */
async function caretMidBlock(page: Page): Promise<Locator> {
  await ipc(page, 'edit_block', { blockId: GS1, toText: 'Hello world' })
  await openPage(page, PAGE)
  const editor = await focusBlockById(page, GS1)
  await editor.press('End')
  for (let i = 0; i < 'world'.length; i++) await editor.press('ArrowLeft')
  return editor
}

test.describe('Pasting text into a block splices blocks (#5160 D4)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('an LLM answer pasted mid-block becomes the tree, joined at the cursor', async ({
    page,
  }) => {
    const before = await childrenOf(page, PAGE_ID)
    const editor = await caretMidBlock(page)

    await pasteText(editor, LLM_ANSWER)

    await expect.poll(() => contentsOf(page, PAGE_ID)).toContain('## Plan')
    const top = await childrenOf(page, PAGE_ID)
    expect(top).toHaveLength(before.length + 1)
    expect(top[0]).toEqual(expect.objectContaining({ id: GS1, content: 'Hello Here is a plan:' }))
    const plan = top[1] as Row
    expect(plan.content).toBe('## Plan')
    expect(top[2]?.id).toBe(before[1]?.id)
    expect(await contentsOf(page, plan.id)).toEqual([
      'First step',
      'Second step',
      'Good luck!world',
    ])
    const first = (await childrenOf(page, plan.id))[0] as Row
    expect(await contentsOf(page, first.id)).toEqual(['detail'])
    await expect(page.getByText('Pasted 6 blocks')).toBeVisible()
    // The caret is where a text editor leaves it: in the last pasted block,
    // just before the text that followed the cursor.
    await expect(editor).toHaveText('Good luck!world')
    await page.keyboard.type('X')
    await expect(editor).toHaveText('Good luck!Xworld')
  })

  test('Paste as text from the toast takes the blocks back and pastes the lines as they are', async ({
    page,
  }) => {
    const before = await childrenOf(page, PAGE_ID)
    const editor = await caretMidBlock(page)
    await pasteText(editor, LLM_ANSWER)
    await expect(page.getByText('Pasted 6 blocks')).toBeVisible()

    await page.getByRole('button', { name: 'Paste as text' }).click()

    await expect.poll(() => contentsOf(page, PAGE_ID)).not.toContain('## Plan')
    const top = await childrenOf(page, PAGE_ID)
    expect(top.map((r) => r.id)).toEqual(before.map((r) => r.id))
    // The block holds the lines as they were pasted: one block, a line each.
    await expect(
      page.locator(`[data-testid="block-static"][data-block-id="${GS1}"]`),
    ).toContainText('## Plan')
    const reopened = await focusBlockById(page, GS1)
    await expect(reopened).toHaveText(
      'Hello Here is a plan:## Plan1. First step   - detail2. Second stepGood luck!world',
    )
    // One hard break per line break of the pasted text.
    await expect(reopened.locator('br')).toHaveCount(8)
    await expect(reopened.locator('h2')).toHaveCount(0)
  })
})
