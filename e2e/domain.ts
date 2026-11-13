import type { Locator, Page } from '@playwright/test'

import {
  activeDialog,
  emitMockEvent,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  streamSyncProgress,
  typeSlashCommand,
} from './helpers'

/**
 * Domain operations: what a user does or sees, named by intent and built on the mechanics in
 * `helpers.ts`, so a spec reads as behaviour and a UI change is fixed here once.
 */

/** The block's row in the open page's tree, found by its id. */
export function blockRow(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

/** The Pages list row for the page titled `title`. */
export function pageRow(page: Page, title: string): Locator {
  return page
    .getByRole('grid')
    .locator('[data-page-item]')
    .filter({ has: page.locator(`.page-browser-item-title[title="${title}"]`) })
}

/** Open the page titled `pageTitle` and put block `blockId` in edit mode; returns its editor. */
export async function startEditing(page: Page, pageTitle: string, blockId: string) {
  await openPage(page, pageTitle)
  return focusBlockById(page, blockId)
}

/** In the block being edited, open the `/` menu on `query` and pick the command named `option`. */
export async function runSlashCommand(page: Page, query: string, option: string): Promise<void> {
  const list = await typeSlashCommand(page, query)
  await list.getByRole('option', { name: option }).click()
}

/** Pick the ISO day `isoDay` in the open date picker and wait for the picker to close. */
export async function pickDate(page: Page, isoDay: string): Promise<void> {
  const picker = activeDialog(page)
  await expect(picker).toHaveAttribute('data-testid', 'date-picker-popup')
  await picker.locator(`[role="gridcell"][data-day="${isoDay}"]`).getByRole('button').click()
  await expect(picker).toBeHidden()
}

/**
 * Leave the open page `pageTitle` and come back (`reopenPage`), then expect `effect` on it: visible,
 * or with exactly `text`. The tree is fetched again on the way back, so this reads the stored state.
 * The title is passed in: the rendered title is chip text for a page whose title holds a link or
 * tag, which `reopenPage` could not find in the Pages list.
 */
export async function expectPersisted(
  page: Page,
  pageTitle: string,
  effect: Locator,
  text?: string,
): Promise<void> {
  await reopenPage(page, pageTitle)
  if (text === undefined) await expect(effect).toBeVisible()
  else await expect(effect).toHaveText(text)
}

/**
 * The peer answered and the session the latest `start_sync` queued finished, moving nothing:
 * the backend's `sync:complete`, then the terminal update on that call's channel (needs
 * `keepSyncChannels`).
 */
export async function finishSyncSession(page: Page): Promise<void> {
  const counts = { remote_device_id: 'device-b', ops_received: 1, ops_sent: 1 }
  await emitMockEvent(page, 'sync:complete', { type: 'complete', ...counts, changed_blocks: 0 })
  await streamSyncProgress(page, { kind: 'sync', state: 'complete', ...counts })
}
