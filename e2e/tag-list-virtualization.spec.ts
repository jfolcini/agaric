import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * #5366 — `TagList` mounts only the rows near its viewport. Tab still walks
 * every tag: focusing a control in an overscan row scrolls the list, which
 * moves the window. jsdom does not scroll on focus, so this runs here.
 */

const TAGS = 200

test('Tab walks the tag list past its initial window', async ({ page }) => {
  await waitForBoot(page)
  await page.evaluate(async (count) => {
    const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
      invoke: (cmd: string, args: unknown) => Promise<unknown>
    }
    for (let i = 0; i < count; i++) {
      await internals.invoke('create_block', {
        blockType: 'tag',
        content: `kb-tag-${String(i).padStart(3, '0')}`,
        parentId: null,
        index: null,
        scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
        blockId: null,
      })
    }
  }, TAGS)
  await navigateToView(page, 'Tags')

  const first = page.getByTestId('tag-item-kb-tag-000')
  const target = page.getByTestId('tag-item-kb-tag-030')
  await expect(first).toBeVisible()
  await expect(target).toHaveCount(0)

  await first.focus()
  // Four tab stops per row: the tag, its color, rename and delete.
  for (let i = 0; i < 30 * 4; i++) await page.keyboard.press('Tab')

  await expect(target).toBeFocused()
  await expect(target).toBeInViewport()
  // The window moved with focus instead of growing to hold every row.
  await expect(first).toHaveCount(0)
})
