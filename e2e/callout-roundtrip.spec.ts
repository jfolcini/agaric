/**
 * E2E regression for #258 — callouts must keep their type through the editor
 * round-trip. Before the fix, `/callout` produced a plain blockquote (the
 * editor's stock Blockquote dropped `calloutType`), so no `callout-block`
 * rendered after save.
 */
import {
  expect,
  focusBlock,
  focusBlockById,
  ipc,
  openPage,
  reopenPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

test.describe('Callout round-trip (#258) @editor @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('/callout renders a callout-block after save (type survives round-trip)', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.type('important note')
    // trigger the slash menu: a trailing "/callout" query, then select it
    await editor.type(' /callout')
    // Wait for the suggestion popup to render the filtered `/callout` item
    // before committing it with Enter, instead of a fixed sleep.
    const calloutItem = page.locator('#suggestion-callout')
    await expect(calloutItem).toBeVisible()
    await page.keyboard.press('Enter')

    // saveBlock waits for the editor to leave this block (persist committed);
    // the callout assertion below auto-retries until the view-mode render lands.
    await saveBlock(page)

    const callout = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="callout-block"]')
    await expect(callout).toBeVisible()
    await expect(callout).toContainText('important note')
  })

  // #6033: a callout's fold marker. Its open/closed state is the reader's,
  // never stored; the `-` is the block's text and survives an edit.
  test.describe('a folded callout (#6033)', () => {
    const PAGE = 'Getting Started'
    const GS1 = '0000000000000000000B10CK01'
    const FOLDED = '> [!FAQ]- Why fold?\n> Because it is long.'

    const calloutOf = (page: import('@playwright/test').Page) =>
      page.locator(
        `[data-testid="sortable-block"][data-block-id="${GS1}"] [data-testid="callout-block"]`,
      )

    test.beforeEach(async ({ page }) => {
      await ipc(page, 'edit_block', { blockId: GS1, toText: FOLDED })
      await openPage(page, PAGE)
    })

    test('shows its title folded and opens on its toggle, without editing the block', async ({
      page,
    }) => {
      const callout = calloutOf(page)
      await expect(callout).toContainText('Why fold?')
      await expect(callout).not.toContainText('Because it is long.')
      const toggle = callout.getByTestId('callout-fold-toggle')
      await expect(toggle).toHaveAccessibleName('Expand Warning callout')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')

      await toggle.click()

      await expect(callout).toContainText('Because it is long.')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(toggle).toHaveAccessibleName('Collapse Warning callout')
      await expect(page.getByTestId('block-editor')).toHaveCount(0)
    })

    test('keeps its `-` through an edit, and opens folded again after navigating back', async ({
      page,
    }) => {
      const editor = await focusBlockById(page, GS1)
      // The edited block shows the callout whole.
      await expect(editor).toContainText('Because it is long.')
      await page.keyboard.type(' Edited')
      await saveBlock(page, 'Escape')

      await reopenPage(page, PAGE)
      const { content } = await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })
      expect(content).toMatch(/^> \[!FAQ\]- Why fold\?/)
      expect(content).toContain('Edited')
      await expect(calloutOf(page)).not.toContainText('Because it is long.')
      await expect(
        calloutOf(page).getByRole('button', { name: 'Expand Warning callout' }),
      ).toHaveAttribute('aria-expanded', 'false')
    })
  })
})
