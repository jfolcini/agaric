/**
 * An image pasted as HTML in page mode (#6714), against the mock backend:
 * page mode keeps ProseMirror's own HTML paste, which reads `<img>` through
 * the image node's parse rule. A `src` the typed `![alt](src)` rule refuses
 * makes no image there either; a web image is kept. Block mode's paste drops
 * the same `<img>` while converting (`html-paste-1439.spec.ts`).
 */

import type { Page } from '@playwright/test'

import { expect, test, waitForBoot } from './helpers'
import { PAGE_EDITOR, backendTexts, caret, openInPageMode, seedPage } from './page-mode'

/** Paste from outside the app: a clipboard holding `html`, and `plain` beside it. */
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

test.describe('an image pasted as HTML in page mode (#6714) @editor @pages @attachments', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a javascript: image is dropped: its text lands, no image is stored or drawn', async ({
    page,
  }) => {
    const { pageId } = await seedPage(page, 'Unsafe image pasted', [
      [0, 'alpha'],
      [0, ''],
    ])
    await openInPageMode(page, 'Unsafe image pasted', 2)
    await caret(page, 1, 'end')

    await pasteHtml(
      page,
      '<p>before <img src="javascript:alert(1)" alt="evil"> after</p>',
      'before after',
    )

    await expect.poll(() => backendTexts(page, pageId)).toEqual(['alpha', 'before after'])
    await expect(page.locator(`${PAGE_EDITOR} img`)).toHaveCount(0)
  })

  test('a web image is kept, stored as its Markdown', async ({ page }) => {
    const { pageId } = await seedPage(page, 'Web image pasted', [
      [0, 'alpha'],
      [0, ''],
    ])
    await openInPageMode(page, 'Web image pasted', 2)
    await caret(page, 1, 'end')

    await pasteHtml(
      page,
      '<p>before <img src="https://example.com/a.png" alt="chart"> after</p>',
      'before after',
    )

    await expect
      .poll(() => backendTexts(page, pageId))
      .toEqual(['alpha', 'before ![chart](https://example.com/a.png) after'])
  })
})
