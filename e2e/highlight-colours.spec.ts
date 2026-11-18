import type { Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  openPage,
  reopenPage,
  saveBlock,
  selectEditorRange,
  test,
  waitForBoot,
} from './helpers'

/**
 * Highlight colours (#6759): a colour picked from the selection bubble is
 * stored in Obsidian's form (`==🔴text==`) and drawn from its theme token in
 * blocks and in page mode.
 *
 * In `e2e/` because the mock stores a block's text as the backend does, and
 * the colour lives in that text. Seed (src/lib/tauri-mock/seed.ts): Getting
 * Started holds GS_1.
 */

const BLOCK_GS_1 = '0000000000000000000B10CK01'

function ipc<T>(page: Page, cmd: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ({ c, a }) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    { c: cmd, a: args },
  ) as Promise<T>
}

test.describe('highlight colours @editor @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('a colour picked in the bubble is saved as its emoji and survives a reopen', async ({
    page,
  }) => {
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('the claim here')
    await selectEditorRange(page, 4, 9)

    const bubble = page.getByTestId('selection-bubble-menu')
    await bubble.getByRole('button', { name: 'Highlight colour' }).click()
    await page.getByRole('button', { name: 'Red highlight' }).click()
    await expect(editor.locator('mark[data-highlight-color="red"]')).toHaveText('claim')

    await editor.click()
    await saveBlock(page)
    const stored = await ipc<{ content: string }>(page, 'get_block', { blockId: BLOCK_GS_1 })
    expect(stored.content).toBe('the ==🔴claim== here')

    await reopenPage(page, 'Getting Started')
    const mark = page
      .locator(`[data-testid="block-static"][data-block-id="${BLOCK_GS_1}"]`)
      .locator('mark[data-highlight-color="red"]')
    await expect(mark).toHaveText('claim')
    // Painted from its own token, not the default highlight's.
    const [red, fallback] = await mark.evaluate((el) => {
      const root = getComputedStyle(document.documentElement)
      const probe = document.createElement('span')
      probe.style.backgroundColor = root.getPropertyValue('--highlight')
      document.body.append(probe)
      const value = getComputedStyle(probe).backgroundColor
      probe.remove()
      return [getComputedStyle(el).backgroundColor, value]
    })
    expect(red).not.toBe(fallback)
  })

  test('page mode draws a stored coloured highlight in its colour', async ({ page }) => {
    await ipc(page, 'edit_block', { blockId: BLOCK_GS_1, toText: 'a ==🟢agreed== point' })
    await reopenPage(page, 'Getting Started')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    await expect(
      page.locator(`[data-page-block-id="${BLOCK_GS_1}"] mark[data-highlight-color="green"]`),
    ).toHaveText('agreed')
  })
})
