import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  activeMenu,
  blurEditors,
  expect,
  navigateToView,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * Multi-select batch actions other than TODO (#5733): the batch toolbar's
 * Delete and Cycle priority, and Indent from the bulk context menu (the
 * toolbar has no indent button). `batch-operations.spec.ts` covers selection
 * and the TODO buttons. Each test re-reads the page after navigating away, so
 * the effect is the mock's stored state, not the optimistic render.
 */

const PAGE = 'Getting Started'
// SEED_IDS in src/lib/tauri-mock/seed.ts
const GS_1 = '0000000000000000000BLOCK01'
const GS_2 = '0000000000000000000BLOCK02'
const GS_3 = '0000000000000000000BLOCK03'
const GS_5 = '0000000000000000000BLOCK05'

const row = (page: Page, id: string) =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)

/** Ctrl+Click each block's padding corner, which a chip or link never covers. */
async function selectBlocks(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    await row(page, id)
      .locator('[data-testid="block-static"]')
      .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
  }
  await expect(page.getByTestId('batch-toolbar')).toContainText(`${ids.length} selected`)
}

test.describe('Batch actions beyond TODO', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(5)
  })

  test('batch delete moves three blocks to Trash and undo brings them back', async ({ page }) => {
    const ids = [GS_1, GS_3, GS_5]
    await selectBlocks(page, ids)

    await page.getByTestId('batch-toolbar').getByRole('button', { name: 'Delete' }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Yes, delete', exact: true }).click()

    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(2)
    for (const id of ids) await expect(row(page, id)).toHaveCount(0)

    await navigateToView(page, 'Trash')
    await expect(page.locator('[data-testid="trash-item"]')).toHaveCount(3)
    for (const id of ids) await expect(page.locator(`#trash-item-${id}`)).toBeVisible()

    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(2)
    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect(
      page.getByLabel('Notifications alt+T').getByText('Undid delete', { exact: true }),
    ).toBeVisible()

    await reopenPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(5)
    for (const id of ids) await expect(row(page, id)).toBeVisible()
  })

  test('batch Cycle priority sets P1 on every selected block', async ({ page }) => {
    await selectBlocks(page, [GS_1, GS_3])

    await page.getByTestId('batch-toolbar').getByRole('button', { name: 'Cycle priority' }).click()
    await expect(page.getByTestId('batch-toolbar')).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect(row(page, GS_1).getByTestId('priority-badge')).toHaveText('P1')
    await expect(row(page, GS_3).getByTestId('priority-badge')).toHaveText('P1')
    await expect(row(page, GS_2).getByTestId('priority-badge')).toHaveCount(0)
  })

  test('bulk Indent from the context menu nests every selected block', async ({ page }) => {
    await selectBlocks(page, [GS_2, GS_3])

    await row(page, GS_3).locator('[data-testid="block-static"]').click({ button: 'right' })
    const menu = activeMenu(page)
    await menu.getByRole('menuitem', { name: 'Move & arrange' }).click()
    await menu.getByRole('menuitem', { name: /^Indent/ }).click()
    await expect(menu).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect(page.locator(`li[data-block-id="${GS_2}"]`)).toHaveAttribute('aria-level', '2')
    await expect(page.locator(`li[data-block-id="${GS_3}"]`)).toHaveAttribute('aria-level', '2')
  })
})
