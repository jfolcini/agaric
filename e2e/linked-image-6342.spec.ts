import {
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  reopenPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for #6342: an image inside a link, the README badge shape
 * `[![alt](src)](href)`, keeps its link through an edit of the block, and opens
 * it from the editor (Ctrl+Click) and from the static view (click). The badge is
 * pasted as one line of plain text, which the editor reads as markdown.
 */

const PAGE = 'Getting Started'
// A 40×20 badge, local so it loads without the external-image prompt.
const SVG =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2240%22%20height%3D%2220%22%2F%3E'
const HREF = 'https://example.com/actions'
const BADGE = `[![CI](${SVG})](${HREF})`

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

test.describe('linked image (#6342) @editor @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('a pasted badge keeps its link through an edit and opens it', async ({ page }) => {
    const editor = await focusBlock(page, 0)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.evaluate((el, value) => {
      const data = new DataTransfer()
      data.setData('text/plain', value)
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    }, BADGE)
    await page.keyboard.type(' badge')

    const editorImage = editor.locator(`a[href="${HREF}"] img[alt="CI"]`)
    await expect(editorImage).toBeVisible()
    await installIpcRecorder(page)
    await editorImage.click({ modifiers: ['Control'] })
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:opener|open_url')).length)
      .toBe(1)

    await saveBlock(page)
    await reopenPage(page, PAGE)

    const row = page.locator('[data-testid="sortable-block"]').filter({ hasText: 'badge' }).first()
    const blockId = await row.getAttribute('data-block-id')
    const stored = await page.evaluate(async (id) => {
      const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
      return ((await invoke('get_block', { blockId: id })) as { content: string }).content
    }, blockId)
    expect(stored).toBe(`${BADGE} badge`)

    const staticLink = row.getByRole('link', { name: /CI/ })
    await expect(staticLink.locator('img[alt="CI"]')).toBeVisible()
    await installIpcRecorder(page)
    await staticLink.click()
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:opener|open_url')).length)
      .toBe(1)
  })
})
