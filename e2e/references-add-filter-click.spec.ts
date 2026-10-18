/**
 * One click on the References panel's Add filter opens the filter row while a
 * block is being edited. Blurring the roving editor unmounts its formatting
 * toolbar, which sits in the flow above the text, so everything below the block
 * moves up by the toolbar's height between the press and the release; the
 * button must keep the editor focused through the press, or the click is lost.
 */

import type { Page } from '@playwright/test'

import { expect, openPage, test, waitForBoot } from './helpers'

const TARGET = 'Refclick Target'

/** An empty page, and a block on Projects linking to it. */
function seed(page: Page): Promise<void> {
  return page.evaluate(async (target) => {
    const { invoke } = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const targetId = (await invoke('create_page_in_space', {
      parentId: null,
      content: target,
      spaceId: 'SPACE_PERSONAL',
    })) as string
    await invoke('create_blocks_batch', {
      specs: [
        {
          blockType: 'content',
          content: `See [[${targetId}]]`,
          parentId: '00000000000000000000PAGE04',
          position: null,
        },
      ],
    })
  }, TARGET)
}

test('one click on Add filter opens the filter row while a block is edited', async ({ page }) => {
  await waitForBoot(page)
  await seed(page)
  await openPage(page, TARGET)
  // The page's auto-created block is open in the editor, its toolbar in the flow above it.
  await expect(page.locator('[data-testid="block-editor"] [contenteditable="true"]')).toBeFocused()
  await expect(page.getByTestId('formatting-toolbar')).toBeVisible()

  const references = page.getByTestId('linked-references')
  await references.getByRole('button', { name: 'Add filter', exact: true }).click()
  await expect(references.getByRole('combobox', { name: 'Filter category' })).toBeVisible()
})
