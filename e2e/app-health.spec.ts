import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  openSettingsTab,
  pasteFile,
  settleBackend,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5741, #5740 — Settings › App health on a real vault.
 *
 * The mock answers `get_status` with fixed numbers and the integrity check with "Everything
 * matches" whatever the vault holds, so both tests are `@real-only`. Here the materializer counts
 * real work, and the reconciliation oracle rebuilds every derived table of a real vault. The
 * integrity result lives in the Settings view, so each check runs on a freshly opened App health.
 */

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

/** Settings › App health, freshly mounted. */
async function openAppHealth(page: Page): Promise<void> {
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'App health')
  await expect(page.getByTestId('settings-panel-status')).toBeVisible()
}

/** The Materializer status cards, label to number, once all six have loaded. */
async function readMetrics(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.status-metric')].map((card) => [
        card.querySelector('.status-metric-label')?.textContent.trim() ?? '',
        Number(card.querySelector('.status-metric-value')?.textContent),
      ]),
    ),
  )
}

/** Press Run check and resolve to the block count and date the backend rebuilt from. */
async function runIntegrityCheck(page: Page): Promise<{ blocks: number; date: string }> {
  await openAppHealth(page)
  const result = page.locator('output[aria-label="Integrity check result"]')
  await expect(result).toHaveText('')
  await page.getByTestId('integrity-run-button').click()
  await expect(result).toContainText('Everything matches')
  const text = (await result.textContent()) ?? ''
  const match = /from (\d+) blocks? on (\d{4}-\d{2}-\d{2})/.exec(text)
  expect(match, `the integrity result names no block count: ${text}`).not.toBeNull()
  return { blocks: Number(match?.[1]), date: match?.[2] ?? '' }
}

test.describe('App health on a real vault (#5741, #5740) @boot @settings', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test(
    'counts the ops an edit burst dispatched, and the queues drain to 0',
    { tag: '@real-only' },
    async ({ page }) => {
      await settleBackend(page)
      await openAppHealth(page)
      await expect.poll(async () => Object.keys(await readMetrics(page)).length).toBe(6)
      const before = await readMetrics(page)
      expect([before['Foreground queue'], before['Background queue']]).toEqual([0, 0])

      // Each edit queues a link and a tag-ref reindex of its own.
      const pageId = await ipc<string>(page, 'create_page_in_space', {
        parentId: null,
        content: 'Burst page',
        spaceId: SEED_IDS.SPACE_PERSONAL,
      })
      const words = ['one', 'two', 'six']
      for (const word of words) {
        const { id } = await ipc<{ id: string }>(page, 'create_block', {
          blockType: 'content',
          content: '',
          parentId: pageId,
          index: null,
          scope: SCOPE,
          blockId: null,
        })
        await ipc(page, 'edit_block', { blockId: id, toText: word, baseText: '' })
      }
      await settleBackend(page)

      await openAppHealth(page)
      const rise = (m: Record<string, number>, card: string) => (m[card] ?? 0) - (before[card] ?? 0)
      // A floor, not an exact rise: the maintenance tick can dispatch on its own meanwhile.
      await expect
        .poll(async () => {
          const m = await readMetrics(page)
          return {
            idle: m['Foreground queue'] === 0 && m['Background queue'] === 0,
            opsRose: rise(m, 'Ops processed') >= 2 * words.length,
            backgroundRose: rise(m, 'Background dispatched') >= 2 * words.length,
          }
        })
        .toEqual({ idle: true, opsRose: true, backgroundRose: true })
      // A boot and ordinary edits take the sync engine's path for every write (#6047).
      const after = await readMetrics(page)
      expect([
        after['Writes the sync engine missed'],
        after['Cascades the sync engine missed'],
      ]).toEqual([0, 0])
    },
  )

  test(
    'rebuilds every derived table of a vault with a task, a tag, links that create pages, properties and an attachment, and finds no difference',
    { tag: '@real-only' },
    async ({ page }) => {
      const empty = await runIntegrityCheck(page)

      await navigateToView(page, 'Settings')
      await openSettingsTab(page, 'Data')
      await page.getByTestId('import-file-input').setInputFiles({
        name: 'health.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(
          [
            '- [ ] health task #healthtag [[health target]]',
            '  repeat:: weekly',
            '  assignee:: carol',
            '- health parent',
            '  - health child',
            '',
          ].join('\n'),
        ),
      })
      await expect(page.getByTestId('import-result')).toContainText('health')

      const pageId = await ipc<string>(page, 'create_page_in_space', {
        parentId: null,
        content: 'Health linker',
        spaceId: SEED_IDS.SPACE_PERSONAL,
      })
      const { id } = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content: '',
        parentId: pageId,
        index: null,
        scope: SCOPE,
        blockId: null,
      })
      await openPage(page, 'Health linker')
      const editor = await focusBlockById(page, id)
      // The closing `]]` creates the page.
      await page.keyboard.type('[[health typed]]')
      await expect(editor.getByTestId('block-link-chip')).toHaveText('health typed')
      // A text file stays a block attachment and adds no block.
      await pasteFile(page.getByTestId('block-editor'), {
        name: 'health.txt',
        type: 'text/plain',
        base64: 'YWdhcmlj',
      })
      await expect(page.getByText('Attached "health.txt"')).toBeVisible()
      await page.keyboard.press('Escape')
      await settleBackend(page)

      const seeded = await runIntegrityCheck(page)
      // The imported page, its three blocks, the new tag and the page its link created; the
      // linker page, its block and the page the typed link created.
      expect(seeded.blocks - empty.blocks).toBe(9)
    },
  )
})
