import type { Page } from '@playwright/test'

import { expect, navigateToView, openPage, openSearchView, test, waitForBoot } from './helpers'

/**
 * E2E — what an out-of-band write refreshes once it lands (#5256, #5258,
 * #5242, #5255).
 *
 * A "peer" here is the mock backend written to directly through
 * `__TAURI_INTERNALS__.invoke`, the way a synced device's ops land in the real
 * database without any local command, followed by the `sync:complete` event
 * `useSyncEvents` reconciles on. No local surface announces the change, so each
 * assertion holds only if that reconciliation refreshes the surface.
 *
 * Seed ids: src/lib/tauri-mock/seed.ts `SEED_IDS`.
 */

const SPACE = 'SPACE_PERSONAL'
const PAGE_PROJECTS = '00000000000000000000PAGE04'
const PAGE_MEETINGS = '00000000000000000000PAGE05'
/** "Fix login bug" — DOING, due today, on Projects. */
const BLOCK_PROJ_2 = '0000000000000000000BLOCK14'
/** "Submit report" — TODO, due yesterday, on Projects. */
const BLOCK_OVERDUE_1 = '0000000000000000000BLOCK19'
/** "Weekly standup notes" — on Meetings. */
const BLOCK_MTG_1 = '0000000000000000000BLOCK17'

interface PeerWindow {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

/** Write to the backend as a synced peer would: no local command, no event. */
function peerWrite<T>(page: Page, cmd: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ({ cmd: c, args: a }) => (window as unknown as PeerWindow).__TAURI_INTERNALS__.invoke(c, a),
    { cmd, args },
  ) as Promise<T>
}

/** Deliver the `sync:complete` that follows the peer's ops, and wait for its toast. */
async function peerSyncComplete(page: Page, changedPageIds: string[], changedBlocks: number) {
  await page.evaluate(
    (payload) => (window as unknown as PeerWindow).__emitMockEvent?.('sync:complete', payload),
    {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 1,
      ops_sent: 0,
      changed_blocks: changedBlocks,
      changed_page_ids: changedPageIds,
    },
  )
  await expect(
    page.getByText(
      changedBlocks === 1
        ? 'Synced 1 change from device'
        : `Synced ${changedBlocks} changes from device`,
    ),
  ).toBeVisible()
}

// ===========================================================================
// #5256 — task panels
// ===========================================================================

test.describe('task panels after a peer completes a task (#5256)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a task the peer marks DONE leaves the Due panel and joins the Done panel', async ({
    page,
  }) => {
    // Journal boots on today's daily view, which mounts both panels.
    const duePanel = page.getByTestId('due-panel')
    const donePanel = page.locator('.done-panel')
    await expect(duePanel.getByText('Fix login bug')).toBeVisible()
    await expect(donePanel.getByText('Update dependencies')).toBeVisible()
    await expect(donePanel.getByText('Fix login bug')).toHaveCount(0)

    await peerWrite(page, 'set_todo_state', { blockId: BLOCK_PROJ_2, state: 'DONE' })
    await peerSyncComplete(page, [PAGE_PROJECTS], 1)

    await expect(duePanel.getByText('Fix login bug')).toHaveCount(0)
    await expect(donePanel.getByText('Fix login bug')).toBeVisible()
  })

  test('an overdue task the peer marks DONE leaves Unfinished tasks', async ({ page }) => {
    const section = page.getByTestId('unfinished-tasks')
    await section.getByRole('button').first().click()
    await expect(section.getByText('Submit report')).toBeVisible()

    await peerWrite(page, 'set_todo_state', { blockId: BLOCK_OVERDUE_1, state: 'DONE' })
    await peerSyncComplete(page, [PAGE_PROJECTS], 1)

    // It was the only unfinished task, so the section goes with it.
    await expect(section).toHaveCount(0)
  })
})

// ===========================================================================
// #5258 — Pages list and journal days
// ===========================================================================

test.describe('page lists after a peer creates or renames pages (#5258)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the Pages list shows a page the peer created and one it renamed', async ({ page }) => {
    await navigateToView(page, 'Pages')
    await expect(page.getByText('Meetings', { exact: true })).toBeVisible()

    const created = await peerWrite<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Peer Page',
      spaceId: SPACE,
    })
    await peerWrite(page, 'edit_block', { blockId: PAGE_MEETINGS, toText: 'Standups' })
    await peerSyncComplete(page, [created, PAGE_MEETINGS], 2)

    await expect(page.getByText('Peer Page', { exact: true })).toBeVisible()
    await expect(page.getByText('Standups', { exact: true })).toBeVisible()
    await expect(page.getByText('Meetings', { exact: true })).toHaveCount(0)
  })

  test('a journal day the peer wrote stops offering an empty day', async ({ page }) => {
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const emptyDay = page
      .locator('section[id^="journal-2"]')
      .filter({ hasText: 'No blocks for' })
      .first()
    await expect(emptyDay).toBeVisible()
    const dateStr = ((await emptyDay.getAttribute('id')) ?? '').replace('journal-', '')
    const day = page.locator(`section[id="journal-${dateStr}"]`)

    const dayPageId = await peerWrite<string>(page, 'create_page_in_space', {
      parentId: null,
      content: dateStr,
      spaceId: SPACE,
    })
    await peerWrite(page, 'create_block', {
      blockType: 'content',
      content: 'Written on the other device',
      parentId: dayPageId,
      index: null,
      scope: { kind: 'active', space_id: SPACE },
      blockId: null,
    })
    await peerSyncComplete(page, [dayPageId], 2)

    // The day now resolves to the peer's page: its "open in editor" control
    // appears and the empty-day state, whose "Add block" ran the create-page
    // path (journal template included) against the existing page, is gone.
    await expect(day.getByRole('button', { name: `Open ${dateStr} in editor` })).toBeVisible()
    await expect(day.getByText('No blocks for', { exact: false })).toHaveCount(0)
  })
})

// ===========================================================================
// #5242 — the open page's title copies
// ===========================================================================

test.describe('open page after a peer renames it (#5242)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the page title and tabs show the peer’s new title', async ({ page }) => {
    await openPage(page, 'Meetings')
    // A second tab on the same page makes the (otherwise autohidden) tab bar render.
    await page.keyboard.press('Control+t')
    const tabList = page.getByRole('tablist')
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(tabList).toContainText('Meetings')

    await peerWrite(page, 'edit_block', { blockId: PAGE_MEETINGS, toText: 'Standups' })
    await peerSyncComplete(page, [PAGE_MEETINGS], 1)

    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Standups')
    await expect(tabList).toContainText('Standups')
    await expect(tabList).not.toContainText('Meetings')
  })
})

// ===========================================================================
// #5255 — a tag filter naming a tag that did not exist yet
// ===========================================================================

test.describe('tag search after a peer creates the tag (#5255)', () => {
  test('tag:#foo finds the block once the peer creates and applies foo', async ({ page }) => {
    const input = await openSearchView(page)
    await input.fill('tag:#foo')
    await input.press('Enter')
    await expect(page.getByTestId('search-results-count')).toHaveText('No results')

    const tag = await peerWrite<{ id: string }>(page, 'create_block', {
      blockType: 'tag',
      content: 'foo',
      parentId: null,
      index: null,
      scope: { kind: 'active', space_id: SPACE },
      blockId: null,
    })
    await peerWrite(page, 'add_tag', { blockId: BLOCK_MTG_1, tagId: tag.id })
    await peerSyncComplete(page, [PAGE_MEETINGS], 2)

    await expect(page.getByText('Weekly standup notes')).toBeVisible()
    await expect(page.getByTestId('search-results-count')).toHaveText('1 result found')
  })
})
