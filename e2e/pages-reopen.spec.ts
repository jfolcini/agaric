import type { Locator, Page } from '@playwright/test'

import {
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  navigateToView,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5446 — returning to the Pages view refetches the pages it had loaded only
 * when something was written since: a local write through the app's commands,
 * or an out-of-band one announced by `sync:complete`.
 */

const QUICK_NOTES = '00000000000000000000PAGE02'
const BLOCK_QN_1 = '0000000000000000000BLOCK08'

interface MockWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

const grid = (page: Page): Locator => page.getByRole('grid')

/**
 * The Pages view's own list calls, which carry a sort; an open page's
 * descendant tree sends the same command without one.
 */
const listCalls = async (page: Page): Promise<number> =>
  (await getInvokeCalls(page, 'list_pages_with_metadata')).filter(
    (args) => 'sort' in (args['filter'] as object),
  ).length

/** Open `title` from the Pages list and wait for its blocks. */
async function openFromPages(page: Page, title: string): Promise<void> {
  await grid(page).getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
}

/** Go back to Pages, once its mount has dispatched its IPC (`count_trash`). */
async function returnToPages(page: Page): Promise<void> {
  await clearInvokeCalls(page)
  await navigateToView(page, 'Pages')
  await expect(grid(page)).toBeVisible()
  await expect
    .poll(async () => (await getInvokeCalls(page, 'count_trash')).length)
    .toBeGreaterThan(0)
}

test('returning to Pages after only reading sends no list call', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('__mockExtraPages', '120'))
  await waitForBoot(page)
  await installIpcRecorder(page)
  await navigateToView(page, 'Pages')
  // Load every page of the list: 120 bulk pages + the seed is three of 50.
  await expect
    .poll(async () => {
      await grid(page).evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      return listCalls(page)
    })
    .toBe(3)
  await grid(page).evaluate((el) => {
    el.scrollTop = 0
  })
  await openFromPages(page, 'Bulk Page 001')
  // Switching away from the app flushes drafts, which writes nothing here.
  for (const state of ['hidden', 'visible']) {
    await page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
  }
  await expect
    .poll(async () => (await getInvokeCalls(page, 'flush_all_drafts')).length)
    .toBeGreaterThan(0)

  await returnToPages(page)

  await expect(grid(page).locator('[data-page-item]').first()).toBeVisible()
  expect(await listCalls(page)).toBe(0)
})

test('returning to Pages after setting a TODO shows the new badge', async ({ page }) => {
  await waitForBoot(page)
  await installIpcRecorder(page)
  await navigateToView(page, 'Pages')
  const row = page.locator(`#page-row-${QUICK_NOTES}`)
  await expect(row.locator('[data-metadata-children]')).toBeVisible()
  await expect(row.locator('[data-page-flag]')).toHaveCount(0)
  await openFromPages(page, 'Quick Notes')

  await focusBlock(page, 0)
  await page.keyboard.press('Control+Enter')
  const firstBlock = page.locator('[data-testid="sortable-block"]').first()
  await expect(firstBlock.locator('[data-testid="task-checkbox-empty"]')).toBeHidden()
  await page.keyboard.press('Escape')
  await returnToPages(page)

  await expect(row.locator('[data-page-flag="todos"]')).toBeVisible()
  expect(await listCalls(page)).toBe(1)
})

test('returning to Pages after a synced edit shows it', async ({ page }) => {
  await waitForBoot(page)
  await installIpcRecorder(page)
  await navigateToView(page, 'Pages')
  const row = page.locator(`#page-row-${QUICK_NOTES}`)
  await expect(row.locator('[data-metadata-children]')).toBeVisible()
  await expect(row.locator('[data-page-flag]')).toHaveCount(0)
  await openFromPages(page, 'Quick Notes')

  // A peer's write: straight to the backend, past the app's commands.
  await page.evaluate(
    async ({ blockId, pageId }) => {
      const w = window as unknown as MockWindow
      await w.__TAURI_INTERNALS__.invoke('set_todo_state', { blockId, state: 'TODO' })
      await w.__emitMockEvent?.('sync:complete', {
        type: 'complete',
        remote_device_id: 'device-b',
        ops_received: 1,
        ops_sent: 0,
        changed_blocks: 1,
        changed_page_ids: [pageId],
      })
    },
    { blockId: BLOCK_QN_1, pageId: QUICK_NOTES },
  )
  await returnToPages(page)

  await expect(row.locator('[data-page-flag="todos"]')).toBeVisible()
  expect(await listCalls(page)).toBe(1)
})
