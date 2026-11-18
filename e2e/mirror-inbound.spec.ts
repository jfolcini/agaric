import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  ipc,
  mirrorFile,
  mirrorPassAfter,
  mirrorText,
  navigateToView,
  openPage,
  startMirror,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5363 slice 2, #6277 H2 — a page's file edited outside Agaric is read back into the page.
 *
 * The mirror's task reads a page's file back once two of its ticks read the same bytes; the mock
 * has no such task, so the test is `@real-only`. The file is written from Node, as another editor
 * would save it, with a `*` bullet the app does not write: the page takes the edit, the file keeps
 * its own bytes, and Ctrl+Z on the page reverts the edit, which the mirror then writes back.
 */

const TITLE = 'Inbound page'
const LINE = 'inbound line'

test(
  'reads a file edited outside into its page, keeps the file, and one Ctrl+Z reverts it @markdown',
  {
    tag: '@real-only',
  },
  async ({ page }) => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'agaric-mirror-in-'))
    try {
      await waitForBoot(page)
      await startMirror(page, folder)
      const pageId = await ipc<string>(page, 'create_page_in_space', {
        parentId: null,
        content: TITLE,
        spaceId: SEED_IDS.SPACE_PERSONAL,
      })
      const { id: blockId } = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content: LINE,
        parentId: pageId,
        index: null,
        scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
        blockId: null,
      })
      const blockContent = async () =>
        (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
      await openPage(page, TITLE)
      await expect.poll(() => mirrorText(folder, TITLE)).toContain(LINE)
      const file = mirrorFile(folder, TITLE) ?? ''

      // Another editor's save: a `*` bullet, a word added.
      const outside = `* ${LINE} from outside\n`
      writeFileSync(file, outside)
      await expect.poll(blockContent, { timeout: 30_000 }).toBe(`${LINE} from outside`)
      // The page leaves `diverged`, where the settling tick listed it, once the ingest's pass ends.
      const status = await mirrorPassAfter(page)
      expect({ diverged: status.diverged, failed: status.failed }).toEqual({
        diverged: [],
        failed: [],
      })
      expect(readFileSync(file, 'utf8')).toBe(outside)

      // The open page shows it, and one Ctrl+Z there reverts the ingest.
      await expect(page.getByText(`${LINE} from outside`, { exact: true })).toBeVisible()
      await page.keyboard.press('Control+z')
      await expect.poll(blockContent).toBe(LINE)

      // Away and back the page holds the reverted text, and the file follows it.
      await navigateToView(page, 'Journal')
      await openPage(page, TITLE)
      await expect(page.getByText(LINE, { exact: true })).toBeVisible()
      await expect.poll(() => readFileSync(file, 'utf8')).not.toContain('from outside')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  },
)
