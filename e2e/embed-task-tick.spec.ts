import type { Page } from '@playwright/test'

import { expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * An embedded task is ticked where it is embedded (#6747): its row draws the
 * checkbox and the read-only chips the block has, and the tick lands on the
 * page that owns the block.
 *
 * In `e2e/` because the mock models every read and write involved
 * (`load_page_subtree`, `get_batch_properties`, `set_todo_state`). Seed
 * (src/lib/tauri-mock/seed.ts, `SEED_IDS`): Getting Started holds GS_3;
 * Quick Notes holds QN_2, the host row.
 */

const BLOCK_GS_3 = '0000000000000000000B10CK03'
const BLOCK_QN_2 = '0000000000000000000B10CK09'

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

test.describe('embedded task rows @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('ticking an embedded task marks it done on its own page', async ({ page }) => {
    await ipc(page, 'set_todo_state', { blockId: BLOCK_GS_3, state: 'DOING' })
    await ipc(page, 'set_priority', { blockId: BLOCK_GS_3, level: '1' })
    await ipc(page, 'edit_block', { blockId: BLOCK_QN_2, toText: `{{embed ((${BLOCK_GS_3}))}}` })

    await openPage(page, 'Quick Notes')
    const row = page.getByTestId('embed-container').locator(`[data-embed-block-id="${BLOCK_GS_3}"]`)
    await expect(row.getByTestId('task-checkbox-doing')).toBeVisible()
    await expect(row.getByTestId('priority-badge')).toHaveText('P1')

    await row.getByTestId('task-marker').click()
    await expect(row.getByTestId('task-checkbox-done')).toBeVisible()

    await navigateToView(page, 'Pages')
    await page.locator('[data-page-item]').getByText('Getting Started', { exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
    const source = page.locator('[data-testid="sortable-block"]').filter({
      has: page.locator(`[data-block-id="${BLOCK_GS_3}"]`),
    })
    await expect(source.getByTestId('task-checkbox-done')).toBeVisible()
  })
})
