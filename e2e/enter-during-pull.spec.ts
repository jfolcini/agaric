import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  emitMockEvent,
  expect,
  focusBlockById,
  ipc,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6814 — a key typed right after Enter while a peer's edits are pulled in.
 *
 * A pull ends in `reloadChangedPageStores`, which reloads the open page. A reload whose snapshot
 * was read before an Enter's create, and answered after it, dropped the block Enter had just made,
 * and the roving editor with it: the next key went to `<body>`. Here the window is held open: the
 * page's next read is answered late, its snapshot taken when it was asked for, and Enter is
 * pressed while it is on its way. The peer's edit is written as a command and announced with the
 * `sync:complete` a pull ends in.
 */

const PAGE = 'Peer pulled page'
const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
/** Longer than an Enter's create takes to answer, so the snapshot lands after it. */
const LATE_MS = 3000

interface LateReads {
  late: boolean
  asked: number
  answered: number
}

/**
 * Answer every `load_page_subtree` of `pageId` asked until `stopLateReads` LATE_MS late, with the
 * snapshot the backend read when it was asked.
 */
async function answerReadsLate(page: Page, pageId: string): Promise<void> {
  await page.evaluate(
    ({ id, lateMs }) => {
      type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
        .__TAURI_INTERNALS__
      const state: LateReads = { late: true, asked: 0, answered: 0 }
      ;(window as unknown as { __lateReads: LateReads }).__lateReads = state
      const original = internals.invoke
      internals.invoke = (cmd, args, options) => {
        const read =
          state.late &&
          cmd === 'load_page_subtree' &&
          (args as { rootBlockId?: unknown } | undefined)?.rootBlockId === id
        if (!read) return original(cmd, args, options)
        state.asked++
        const snapshot = original(cmd, args, options)
        return new Promise((resolve) => setTimeout(resolve, lateMs))
          .then(() => snapshot)
          .finally(() => {
            state.answered++
          })
      }
    },
    { id: pageId, lateMs: LATE_MS },
  )
}

const lateReads = (page: Page) =>
  page.evaluate(() => ({ ...(window as unknown as { __lateReads: LateReads }).__lateReads }))

test('a key typed after Enter lands in the block Enter made while a pull reads the page again @sync @editor', async ({
  page,
}) => {
  await waitForBoot(page)
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: PAGE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const create = (content: string) =>
    ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
      blockId: null,
    })
  const { id: keptId } = await create('kept line')
  const { id: editedId } = await create('peer line before')
  await openPage(page, PAGE)
  await focusBlockById(page, keptId)

  await answerReadsLate(page, pageId)
  await ipc(page, 'edit_block', { blockId: editedId, toText: 'peer line after', baseText: null })
  await emitMockEvent(page, 'sync:complete', {
    type: 'complete',
    remote_device_id: 'device-b',
    ops_received: 1,
    ops_sent: 0,
    changed_blocks: 1,
    changed_page_ids: [pageId],
  })
  await expect.poll(async () => (await lateReads(page)).asked).toBeGreaterThan(0)

  await page.keyboard.press('Enter')
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toHaveText('')
  const asked = await page.evaluate(() => {
    const state = (window as unknown as { __lateReads: LateReads }).__lateReads
    state.late = false
    return state.asked
  })
  await expect.poll(async () => (await lateReads(page)).answered).toBe(asked)
  await expect(page.getByText('peer line after', { exact: true })).toBeVisible()

  // The focus stayed in the block Enter made, so the key lands there.
  await page.keyboard.type('typed after enter')
  await page.keyboard.press('Escape')
  await reopenPage(page, PAGE)
  await expect(page.getByTestId('block-static')).toHaveText([
    'kept line',
    'typed after enter',
    'peer line after',
  ])
})
