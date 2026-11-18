import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  ipc,
  mirrorFile,
  mirrorText,
  navigateToView,
  openSettingsTab,
  startMirror,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5363 slice 4, setting 2 — which spaces are mirrored.
 *
 * A space turned off in Settings › Data is no longer written: its unchanged files are removed from
 * the folder, the other spaces' stay, and a page added to it gets no file. The mock has no mirror
 * task, so the test is `@real-only`.
 */

test(
  'removes a space turned off from the folder and keeps mirroring the others @markdown @settings',
  {
    tag: '@real-only',
  },
  async ({ page }) => {
    const folder = mkdtempSync(path.join(os.tmpdir(), 'agaric-mirror-spaces-'))
    try {
      await waitForBoot(page)
      await startMirror(page, folder)
      const keptId = await ipc<string>(page, 'create_page_in_space', {
        parentId: null,
        content: 'Kept page',
        spaceId: SEED_IDS.SPACE_PERSONAL,
      })
      const { id: keptBlock } = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content: 'kept line',
        parentId: keptId,
        index: null,
        scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
        blockId: null,
      })
      await ipc(page, 'create_page_in_space', {
        parentId: null,
        content: 'Work page',
        spaceId: SEED_IDS.SPACE_WORK,
      })
      await expect.poll(() => mirrorText(folder, 'Kept page')).toContain('kept line')
      await expect.poll(() => mirrorFile(folder, 'Work page')).toBeDefined()
      const kept = mirrorFile(folder, 'Kept page') ?? ''
      const workFile = mirrorFile(folder, 'Work page') ?? ''

      // Turned off from Settings › Data, by its switch.
      await navigateToView(page, 'Settings')
      await openSettingsTab(page, 'Data')
      await page.locator(`[id="mirror-space-${SEED_IDS.SPACE_WORK}"]`).click()
      await expect.poll(() => existsSync(workFile), { timeout: 30_000 }).toBe(false)
      expect(
        (await ipc<{ unmirrored_spaces: string[] }>(page, 'get_mirror_status', {}))
          .unmirrored_spaces,
      ).toEqual([SEED_IDS.SPACE_WORK])
      expect(existsSync(kept)).toBe(true)

      // A page added to the space while it is off gets no file. An edit made after it, in a space
      // still mirrored, shows a pass read past it.
      await ipc(page, 'create_page_in_space', {
        parentId: null,
        content: 'Added while off',
        spaceId: SEED_IDS.SPACE_WORK,
      })
      await ipc(page, 'edit_block', {
        blockId: keptBlock,
        toText: 'kept line edited',
        baseText: null,
      })
      await expect.poll(() => readFileSync(kept, 'utf8'), { timeout: 30_000 }).toContain('edited')
      expect(
        readdirSync(folder, { recursive: true }).filter((name) =>
          String(name).endsWith('Added while off.md'),
        ),
      ).toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  },
)
