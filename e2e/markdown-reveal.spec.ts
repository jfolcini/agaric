/**
 * #5689 — "Show Markdown syntax around the cursor": turned on in Settings ›
 * Editor, the block editor shows the markers of the mark the caret is in, a
 * marker is deleted or crossed as one unit, the stored block and the clipboard
 * never carry a marker, and an IME composition leaves the markers in place
 * until it ends.
 */

import type { Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  navigateToView,
  openPage,
  openSettingsTab,
  reopenPage,
  replaceEditorText,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

async function setReveal(page: Page, on: boolean): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  const toggle = page.getByRole('switch', { name: 'Show Markdown syntax around the cursor' })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
}

/** Retype block 2 as `text`, through the keyboard so the input rules make the marks. */
async function typeBlock(page: Page, text: string): Promise<void> {
  await focusBlock(page, 2)
  await replaceEditorText(page, '')
  await page.keyboard.type(text)
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await setReveal(page, true)
  await openPage(page, 'Getting Started')
})

test('the caret in bold text reveals its markers, and they never reach the clipboard or the stored block', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold** end')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)

  // `Make bo|ld end`: inside the bold text.
  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])
  await expect(editor).toHaveText('Make **bold** end')

  // A selection across both markers copies the text and its formatting, not the markers.
  await page.evaluate(() => {
    document.addEventListener('copy', (e) => {
      document.body.dataset['copied'] = e.clipboardData?.getData('text/plain') ?? ''
    })
  })
  // `Make **bold** end`, selected from drawn offset 3 to 15, markers counted.
  await selectEditorRange(page, 3, 15)
  await page.keyboard.press('Control+c')
  await expect(page.locator('body')).toHaveAttribute('data-copied', 'e bold e')

  await page.keyboard.press('Escape')
  const stored = page.locator('[data-testid="block-static"]').nth(2)
  await expect(stored).toHaveText('Make bold end')
  await expect(stored.locator('strong')).toHaveText('bold')
  await reopenPage(page, 'Getting Started')
  await expect(page.locator('[data-testid="block-static"]').nth(2)).toHaveText('Make bold end')
})

test('Delete before a revealed marker removes the bold from its whole range', async ({ page }) => {
  await typeBlock(page, 'Make **bold** end')
  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])

  // `Make |**bold**`: the end of `Make ` is the bold start, outside its markers.
  await selectEditorRange(page, 5, 5)
  await page.keyboard.press('Delete')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('strong')).toHaveCount(0)
  await expect(editor).toHaveText('Make bold end')
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
})

test('Backspace after the opening marker at the block start removes the bold in one undo step, without a merge', async ({
  page,
}) => {
  await typeBlock(page, '**bold** rest')
  const editor = page.locator(EDITOR)
  const blocks = page.locator('[data-testid="block-static"]')
  const staticCount = await blocks.count()
  // The block start types bold, so the caret is inside the markers: `**|bold** rest`.
  await editor.evaluate((el) =>
    (
      el as HTMLElement & { editor: { commands: { setTextSelection: (pos: number) => boolean } } }
    ).editor.commands.setTextSelection(1),
  )
  await expect(editor).toHaveText('**bold** rest')

  await page.keyboard.press('Backspace')
  await expect(editor.locator('strong')).toHaveCount(0)
  await expect(editor).toHaveText('bold rest')
  await expect(blocks).toHaveCount(staticCount)

  await page.keyboard.press('Control+z')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor).toHaveText('**bold** rest')
})

test('a click past a marker types outside the bold, and a click on its near half inside', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold** rest')
  const editor = page.locator(EDITOR)
  const opening = page.getByTestId('md-reveal-marker').nth(0)
  const closing = page.getByTestId('md-reveal-marker').nth(1)

  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  let box = await closing.boundingBox()
  if (!box) throw new Error('the closing marker has no layout box')
  await page.mouse.click(box.x + box.width + 1, box.y + box.height / 2)
  await page.keyboard.type('X')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor).toHaveText('Make boldX rest')

  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  box = await closing.boundingBox()
  if (!box) throw new Error('the closing marker has no layout box')
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
  await page.keyboard.type('Y')
  await expect(editor.locator('strong')).toHaveText('boldY')

  // The near half of the opening marker is outside the bold. `Make **b|oldY**X rest`, markers drawn.
  await selectEditorRange(page, 8, 8)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  box = await opening.boundingBox()
  if (!box) throw new Error('the opening marker has no layout box')
  await page.mouse.click(box.x + 1, box.y + box.height / 2)
  await page.keyboard.type('Z')
  await expect(editor.locator('strong')).toHaveText('boldY')
  await expect(editor).toHaveText('Make Z**boldY**X rest')
})

test('ArrowRight at the end of a block steps past the closing marker before it leaves the block', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold**')
  const editor = page.locator(EDITOR)
  // The input rule leaves the caret past the closing marker; step back inside, then out again.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowRight')
  await expect(editor).toBeFocused()
  await page.keyboard.type('X')
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(editor).toHaveText('Make boldX')
})

test('an IME composition beside a marker leaves the markers in place until it ends', async ({
  page,
}) => {
  await typeBlock(page, 'Make **bold** rest')
  const editor = page.locator(EDITOR)
  const markers = page.getByTestId('md-reveal-marker')
  await selectEditorRange(page, 7, 7)
  await expect(markers).toHaveText(['**', '**'])
  // `Make **bold|** rest` with the markers drawn, then past the closing marker.
  await selectEditorRange(page, 11, 11)
  await page.keyboard.press('ArrowRight')

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 })
  await cdp.send('Input.imeSetComposition', { text: 'ka', selectionStart: 2, selectionEnd: 2 })
  // The caret has left the bold run, but a composition keeps the markers where they were.
  await expect(markers).toHaveText(['**', '**'])
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 })
  await expect(markers).toHaveText(['**', '**'])

  await cdp.send('Input.insertText', { text: 'か' })
  await expect(markers).toHaveCount(0)
  await expect(editor).toHaveText('Make boldか rest')
  await expect(editor.locator('strong')).toHaveText('bold')
})

test('turning the preference off removes the markers', async ({ page }) => {
  await typeBlock(page, 'Make **bold** rest')
  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(2)
  await page.keyboard.press('Escape')

  await setReveal(page, false)
  await openPage(page, 'Getting Started')
  await focusBlock(page, 2)
  await selectEditorRange(page, 7, 7)
  await expect(page.locator(EDITOR).locator('strong')).toHaveText('bold')
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)
})
