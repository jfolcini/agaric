/**
 * E2E for #4712 — resizing an inline image in the editor.
 *
 * Three things only a real browser shows: pressing the handle must leave focus
 * and the caret in the text, so typing carries on after a drag; the handle's
 * keys must beat the block keyboard handler, which listens on the editor's DOM
 * above the node view's React portal and would take ArrowRight to the next
 * block; and Tab, when it moves focus, must reach the image's controls and come
 * back to the text without unmounting the editor.
 */
import { expect, focusBlock, openPage, saveBlock, test, waitForBoot } from './helpers'

// Same-origin, so it loads, and 100×100, so the widths below are exact.
const IMG_URL = '/agaric.svg'

test.describe('inline image resize (#4712)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('drag and arrow keys resize the image, and the width survives the save', async ({
    page,
  }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.type(`pic ![a cat](${IMG_URL}) done`)

    const img = page.getByTestId('image-node-view').locator('img[alt="a cat"]')
    await expect(img).toHaveCSS('width', '100px')
    await img.hover()
    const handle = page.getByRole('slider', { name: 'Resize image a cat' })
    const box = await handle.boundingBox()
    if (!box) throw new Error('the resize handle has no layout box')

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect(img).toHaveCSS('width', '200px')
    // The caret never left the text: typing carries on where it was.
    await page.keyboard.type('!')
    await expect(editor).toContainText('done!')
    await expect(img).toBeVisible()

    await handle.focus()
    await page.keyboard.press('ArrowRight')
    await expect(img).toHaveCSS('width', '210px')
    await expect(page.getByTestId('image-node-view')).toBeVisible()

    await saveBlock(page, 'Escape')
    await expect(page.locator('[data-testid="block-static"] img[alt="a cat"]')).toHaveCSS(
      'width',
      '210px',
    )
  })

  test('with Tab-indent off, Tab to the collapse toggle and back keeps the editor', async ({
    page,
  }) => {
    // Read on every keystroke, so it applies without a reload.
    await page.evaluate(() => localStorage.setItem('agaric-tab-indents-blocks', 'false'))
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await editor.type(`![a cat](${IMG_URL}) done`)
    const nodeView = page.getByTestId('image-node-view')
    await expect(nodeView.locator('img[alt="a cat"]')).toBeVisible()

    await page.keyboard.press('Tab')
    const toggle = nodeView.getByTestId('image-collapse-toggle')
    await expect(toggle).toBeFocused()
    await expect(editor).toBeVisible()

    // Enter presses the toggle instead of saving the block and opening the next.
    await page.keyboard.press('Enter')
    await expect(nodeView.getByTestId('image-collapsed-label')).toHaveText('a cat')
    await expect(toggle).toBeFocused()

    // Shift+Tab returns to the text, and typing lands in the block.
    await page.keyboard.press('Shift+Tab')
    await expect(editor).toBeFocused()
    await page.keyboard.type('!')
    await expect(editor).toContainText('done!')

    await saveBlock(page, 'Escape')
    const saved = page
      .locator('[data-testid="block-static"]')
      .filter({ has: page.getByTestId('image-collapsed-label') })
    await expect(saved.getByTestId('image-collapsed-label')).toHaveText('a cat')
    await expect(saved).toContainText('done!')
  })
})
