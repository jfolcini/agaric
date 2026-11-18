import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  ipc,
  mirrorFile,
  type MirrorStatus,
  navigateToView,
  startMirror,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5363 slice 3a, #6277 H3 — a new file in a space's folder becomes a page.
 *
 * The mirror's task reads a new `.md` file in a space's folder, once two of its ticks read the
 * same bytes, onto a new page of that space titled by the file's name; the mock has no such task,
 * so the test is `@real-only`. The file is written from Node, as another editor would create it:
 * the page appears in the Pages list with its blocks, and the file keeps its bytes.
 */

const PERSONAL = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

test(
  'reads a new file in a space folder onto a new page and keeps the file @markdown @pages',
  {
    tag: '@real-only',
  },
  async ({ page }) => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'agaric-mirror-new-'))
    try {
      await waitForBoot(page)
      await startMirror(page, folder)
      // A page of Personal, so its file shows which folder is the space's.
      const anchorId = await ipc<string>(page, 'create_page_in_space', {
        parentId: null,
        content: 'Anchor page',
        spaceId: SEED_IDS.SPACE_PERSONAL,
      })
      await ipc(page, 'create_block', {
        blockType: 'content',
        content: 'anchor line',
        parentId: anchorId,
        index: null,
        scope: PERSONAL,
        blockId: null,
      })
      await expect.poll(() => mirrorFile(folder, 'Anchor page')).toBeDefined()
      const spaceFolder = path.dirname(mirrorFile(folder, 'Anchor page') ?? '')

      // Another editor creates a note in that space's folder.
      const file = path.join(spaceFolder, 'Outside note.md')
      const written = '* first outside line\n\nsecond outside line\n'
      writeFileSync(file, written)
      const titles = async () =>
        (
          await ipc<Array<{ content: string | null }>>(page, 'list_all_pages_in_space', {
            scope: PERSONAL,
            tagIds: null,
          })
        ).map((row) => row.content)
      await expect.poll(titles, { timeout: 30_000 }).toContain('Outside note')
      expect((await titles()).filter((title) => title === 'Outside note')).toHaveLength(1)

      await navigateToView(page, 'Pages')
      await page.locator('[data-page-title="Outside note"]').click()
      await expect(page.getByTestId('block-static')).toHaveText([
        // The `*` line is a bulleted block.
        /^•first outside line$/,
        'second outside line',
      ])
      expect(readFileSync(file, 'utf8')).toBe(written)
      expect((await ipc<MirrorStatus>(page, 'get_mirror_status', {})).failed).toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  },
)
