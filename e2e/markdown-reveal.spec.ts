/**
 * #5689 spike — "Show Markdown syntax around the cursor": turned on in
 * Settings › Editor, the block editor shows the markers of the mark the caret
 * is in, Delete beside a marker removes the mark, and the stored block never
 * carries a marker.
 */

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

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  const toggle = page.getByRole('switch', { name: 'Show Markdown syntax around the cursor' })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await openPage(page, 'Getting Started')
})

test('the caret in bold text reveals its markers, and they never reach the stored block', async ({
  page,
}) => {
  await focusBlock(page, 2)
  await replaceEditorText(page, '')
  await page.keyboard.type('Make **bold** end')
  const editor = page.locator(EDITOR)
  await expect(editor.locator('strong')).toHaveText('bold')
  await expect(page.getByTestId('md-reveal-marker')).toHaveCount(0)

  // `Make bo|ld end`: inside the bold text.
  await selectEditorRange(page, 7, 7)
  await expect(page.getByTestId('md-reveal-marker')).toHaveText(['**', '**'])
  await expect(editor).toHaveText('Make **bold** end')

  await page.keyboard.press('Escape')
  const stored = page.locator('[data-testid="block-static"]').nth(2)
  await expect(stored).toHaveText('Make bold end')
  await expect(stored.locator('strong')).toHaveText('bold')
  await reopenPage(page, 'Getting Started')
  await expect(page.locator('[data-testid="block-static"]').nth(2)).toHaveText('Make bold end')
})

test('Delete before a revealed marker removes the bold from its whole range', async ({ page }) => {
  await focusBlock(page, 2)
  await replaceEditorText(page, '')
  await page.keyboard.type('Make **bold** end')
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
