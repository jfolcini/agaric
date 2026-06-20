import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for #1514: pasting a single GFM task line over a NON-EMPTY block must NOT
 * wipe the existing content.
 *
 * Before the fix, `TaskPaste.handlePaste` guarded only on `selection.empty` (a
 * collapsed cursor) and then unconditionally replaced the ENTIRE enclosing
 * paragraph via `replaceRangeWith` — so a caret sitting inside non-empty text
 * (which is still a collapsed/empty selection) discarded the existing text.
 *
 * The fix adds an emptiness guard: the plugin only takes over the block when the
 * caret is in a genuinely empty, non-task paragraph. A paste into non-empty
 * content falls through to ProseMirror's default paste, which inserts the raw
 * marker at the caret — the pre-existing text survives.
 *
 * What the browser proves that unit tests cannot: a real `paste` ClipboardEvent
 * dispatched onto the live contenteditable, with a real caret offset inside
 * typed text, does not clobber that text.
 */

const PAGE = 'Getting Started'

type Editor = import('@playwright/test').Locator

/** Dispatch a native paste of `text/plain` onto the live editor element. */
async function pasteText(editor: Editor, text: string): Promise<void> {
  await editor.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

/** Open a fresh EMPTY block after block 0 and return its live editor locator. */
async function freshBlock(page: import('@playwright/test').Page): Promise<Editor> {
  const editor = await focusBlock(page, 0)
  await editor.press('End')
  await editor.press('Enter')
  const live = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(live.locator('p.is-editor-empty')).toBeVisible()
  return live
}

test.describe('Paste GFM task line over non-empty block (#1514)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('pasting "- [ ] todo" into typed text does NOT wipe the existing content', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    // Type real content into the block; the caret is now a collapsed cursor at
    // the end of non-empty text (the exact #1514 trigger).
    await editor.type('keep this text')
    await expect(editor).toContainText('keep this text')

    await pasteText(editor, '- [ ] todo')

    // The pre-existing text MUST survive — the block is not clobbered.
    await expect(editor).toContainText('keep this text')
    // The non-empty block is not taken over as a task by the plugin.
    await expect(editor.locator('p[data-todo-state]')).toHaveCount(0)
  })

  test('pasting "- [x] done" mid-text preserves the surrounding content', async ({ page }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    await editor.type('hello world')
    await expect(editor).toContainText('hello world')

    // Place the caret mid-text (after "hello"): five Left presses from the end.
    for (let i = 0; i < 6; i++) await editor.press('ArrowLeft')

    await pasteText(editor, '- [x] done')

    // Both original words survive — nothing was discarded.
    await expect(editor).toContainText('hello')
    await expect(editor).toContainText('world')
    await expect(editor.locator('p[data-todo-state]')).toHaveCount(0)
  })

  test('pasting "- [ ] todo" into a FRESH empty block still creates a task (no regression)', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    await pasteText(editor, '- [ ] todo')

    // The empty-block case is unchanged: the block becomes a TODO task.
    await expect(editor.locator('p[data-todo-state="TODO"]')).toBeVisible()
    await expect(editor).toContainText('todo')
    await expect(editor).not.toContainText('- [ ]')
  })
})
