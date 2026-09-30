import { expect, focusBlock, openPage, saveBlock, test, waitForBoot } from './helpers'

/**
 * E2E for #5160 N11 — a link written as markdown becomes a link, whether it
 * is typed (`ExternalLink`'s `markdownLinks` input rule) or pasted as one
 * line of plain text (`HtmlPaste`'s one-line paste, which reads the whole
 * line as inline markdown). Each test asserts the rendered link and the
 * content the block stored, read back over IPC.
 */

const PAGE = 'Getting Started'

type Page = import('@playwright/test').Page
type Editor = import('@playwright/test').Locator

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

/** Empty the first block and return its live editor locator. */
async function emptyFirstBlock(page: Page): Promise<Editor> {
  const editor = await focusBlock(page, 0)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await expect(editor.locator('p.is-editor-empty')).toBeVisible()
  return editor
}

/** Dispatch a native paste of `text/plain` only (no HTML). */
async function pasteText(editor: Editor, text: string): Promise<void> {
  await editor.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

/** The stored content of the block whose text holds `token`, read over IPC. */
async function storedContent(page: Page, token: string): Promise<string> {
  const row = page.locator('[data-testid="sortable-block"]').filter({ hasText: token }).first()
  const blockId = await row.getAttribute('data-block-id')
  expect(blockId).not.toBeNull()
  return page.evaluate(async (id) => {
    const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
    const block = (await invoke('get_block', { blockId: id })) as { content: string }
    return block.content
  }, blockId)
}

test.describe('markdown links typed or pasted (#5160 N11)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('typing [text](url) makes a link, stored as the markdown link', async ({ page }) => {
    const editor = await emptyFirstBlock(page)
    await editor.pressSequentially('see [docs](https://example.com) typed')

    await expect(editor.locator('a[href="https://example.com"]', { hasText: 'docs' })).toBeVisible()
    await saveBlock(page)

    await expect(
      page.locator('[data-testid="external-link"][data-href="https://example.com"]', {
        hasText: 'docs',
      }),
    ).toBeVisible()
    expect(await storedContent(page, 'typed')).toBe('see [docs](https://example.com) typed')
  })

  // The link and the bold alone would also convert through TipTap's own paste
  // rules; the underline tag is read only by the editor's parser, so it is
  // what shows the whole line was read as markdown.
  test('pasting one line holding a link inserts it at the caret, read as markdown', async ({
    page,
  }) => {
    const editor = await emptyFirstBlock(page)
    const line = 'read **the** [guide](https://example.com/guide) and <u>this</u> pasted'
    await pasteText(editor, line)

    await expect(
      editor.locator('a[href="https://example.com/guide"]', { hasText: 'guide' }),
    ).toBeVisible()
    await expect(editor.locator('strong', { hasText: 'the' })).toBeVisible()
    await expect(editor.locator('u', { hasText: 'this' })).toBeVisible()
    await saveBlock(page)

    await expect(
      page.locator('[data-testid="external-link"][data-href="https://example.com/guide"]', {
        hasText: 'guide',
      }),
    ).toBeVisible()
    expect(await storedContent(page, 'pasted')).toBe(line)
  })
})
