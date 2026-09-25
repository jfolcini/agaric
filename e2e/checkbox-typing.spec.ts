import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for the typed checkbox (#5160 D6, P9, X11): typing `[/] ` at the start
 * of a block, or `- [-] ` before it, strips the marker and sets the block's
 * task state through `set_todo_state`, the way the Edit as Markdown buffer
 * reads the same text. What the browser proves that the vitest editor tests
 * cannot: the real keystroke path through TipTap's `handleTextInput`, with
 * BulletList's own `- ` rule and the picker plugins in the extension list, and
 * the state read back from the backend rather than from the editor.
 */

const PAGE = 'Getting Started'

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

/** Re-read the PERSISTED row for `blockId` straight from the backend. */
async function persistedBlock(
  page: import('@playwright/test').Page,
  blockId: string,
): Promise<{ content: string; todo_state: string | null }> {
  return page.evaluate(async (id) => {
    const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
    return (await invoke('get_block', { blockId: id })) as {
      content: string
      todo_state: string | null
    }
  }, blockId)
}

/** Open a fresh EMPTY block after block 0 and return its live editor and id. */
async function freshBlock(page: import('@playwright/test').Page) {
  const first = await focusBlock(page, 0)
  await first.press('End')
  await first.press('Enter')
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor.locator('p.is-editor-empty')).toBeVisible()
  const blockId = await page
    .locator('[data-testid="block-editor"]')
    .first()
    .getAttribute('data-block-id')
  expect(blockId).not.toBeNull()
  return { editor, blockId: blockId as string }
}

test.describe('Typed checkboxes (#5160 D6)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('typing "[/] " at the start of a block makes it DOING', async ({ page }) => {
    const { editor, blockId } = await freshBlock(page)

    await editor.pressSequentially('[/] ')

    // The marker is consumed and the state persisted, before any text follows.
    await expect.poll(async () => (await persistedBlock(page, blockId)).todo_state).toBe('DOING')
    await expect(editor).not.toContainText('[/]')
    await editor.pressSequentially('wip')
    await expect(editor).toHaveText('wip')
  })

  test('typing "- [-] " makes the block CANCELLED', async ({ page }) => {
    const { editor, blockId } = await freshBlock(page)

    await editor.pressSequentially('- [-] ')

    await expect
      .poll(async () => (await persistedBlock(page, blockId)).todo_state)
      .toBe('CANCELLED')
    await expect(editor).not.toContainText('[-]')
  })
})
