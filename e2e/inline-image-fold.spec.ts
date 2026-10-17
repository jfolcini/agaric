import {
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  replaceEditorText,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * An inline image folds to a chip labelled with its alt text (#4711,
 * `src/components/rendering/CollapsibleImage.tsx`). The fold is a device
 * preference, not block content, so it has to hold when the page is opened
 * again and when the block becomes the editor, whose node view is the other
 * surface the same image renders on.
 *
 * In `e2e/` because the fold lives in the frontend's preference registry, which
 * this build runs unmocked. Search result rows draw the image unfolded on
 * purpose (`RichContentRenderer/marks/image.tsx`), so they are not asserted.
 */

/** `SEED_IDS.BLOCK_GS_1` in `src/lib/tauri-mock/seed.ts`. */
const BLOCK_GS_1 = '0000000000000000000BLOCK01'

/** A 1x1 GIF: a local image, so nothing touches the network. */
const DOT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

test('a folded inline image stays a chip after reopening the page and in the editor', async ({
  page,
}) => {
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  const block = page.locator(`[data-testid="sortable-block"][data-block-id="${BLOCK_GS_1}"]`)
  const image = block.getByRole('img', { name: 'a dot', exact: true })
  const chip = block.getByTestId('image-collapsed-label')

  await focusBlockById(page, BLOCK_GS_1)
  await replaceEditorText(page, `Logo ![a dot](${DOT_GIF}`)
  // The image input rule fires on a typed closing paren.
  await page.keyboard.type(')')
  await saveBlock(page, 'Escape')
  await expect(image).toBeVisible()

  await block.getByRole('button', { name: 'Collapse image a dot', exact: true }).click()
  await expect(chip).toHaveText('a dot')

  await reopenPage(page, 'Getting Started')
  await expect(chip).toHaveText('a dot')

  await focusBlockById(page, BLOCK_GS_1)
  const editor = block.getByTestId('block-editor')
  await expect(editor.getByTestId('image-collapsed-label')).toHaveText('a dot')
  await editor.getByRole('button', { name: 'Expand image a dot', exact: true }).click()
  await expect(editor.getByRole('img', { name: 'a dot', exact: true })).toBeVisible()

  await saveBlock(page, 'Escape')
  await expect(image).toBeVisible()
})
