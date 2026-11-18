import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  ipc,
  mirrorFile,
  mirrorText,
  type MirrorStatus,
  navigateToView,
  openPage,
  startMirror,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5363 slice 3, #6887 — a file renamed, moved or deleted outside Agaric.
 *
 * The mirror's task holds a page whose file vanished for two ticks, and takes a new file that holds
 * the bytes it last wrote as that file renamed: the page takes the title the new path names, or
 * moves to the space whose folder holds it. A file moved out of every space's folder is no page's
 * place: its page is held as it was, never trashed. A page renamed or trashed from the folder is
 * said in a toast, whose button opens the Trash for a trashed one. Files are renamed from Node, as
 * a file manager would. The mock has no mirror task, so the tests are `@real-only`.
 */

interface PageHeading {
  content: string | null
}

const PERSONAL = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

/** A Personal page titled `title` holding `line`, once its file holds the line; returns the file. */
async function mirroredPage(page: Page, folder: string, title: string, line: string) {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  await ipc(page, 'create_block', {
    blockType: 'content',
    content: line,
    parentId: pageId,
    index: null,
    scope: PERSONAL,
    blockId: null,
  })
  await expect.poll(() => mirrorText(folder, title)).toContain(line)
  return mirrorFile(folder, title) ?? ''
}

/** The titles of space `spaceId`'s pages, as the backend lists them now. */
async function titlesIn(page: Page, spaceId: string): Promise<Array<string | null>> {
  const rows = await ipc<PageHeading[]>(page, 'list_all_pages_in_space', {
    scope: { kind: 'active', space_id: spaceId },
    tagIds: null,
  })
  return rows.map((row) => row.content)
}

/** How many Personal pages are titled `title`. */
async function personalPagesTitled(page: Page, title: string): Promise<number> {
  return (await titlesIn(page, SEED_IDS.SPACE_PERSONAL)).filter((t) => t === title).length
}

const status = (page: Page) =>
  ipc<MirrorStatus & { paused: string | null }>(page, 'get_mirror_status', {})

test.describe('Markdown mirror, renamed and moved files (#5363) @markdown @pages', () => {
  let folder = ''

  test.beforeEach(async ({ page }) => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'agaric-mirror-structure-'))
    await waitForBoot(page)
    await startMirror(page, folder)
  })

  test.afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
    rmSync(`${folder}-away`, { recursive: true, force: true })
  })

  test(
    'renames the page of a file renamed outside Agaric, keeping one page',
    { tag: '@real-only' },
    async ({ page }) => {
      const before = await mirroredPage(page, folder, 'Before rename', 'renamed line')
      const after = path.join(path.dirname(before), 'After rename.md')
      renameSync(before, after)
      await expect(
        page.getByText('After rename.md was renamed or moved in the mirror folder'),
      ).toBeVisible({
        timeout: 30_000,
      })

      expect({
        after: await personalPagesTitled(page, 'After rename'),
        before: await personalPagesTitled(page, 'Before rename'),
      }).toEqual({ after: 1, before: 0 })
      await openPage(page, 'After rename')
      await expect(page.getByText('renamed line', { exact: true })).toBeVisible()
      expect({ before: existsSync(before), after: existsSync(after) }).toEqual({
        before: false,
        after: true,
      })
      expect((await status(page)).failed).toEqual([])
    },
  )

  test(
    "moves the page of a file moved into another space's folder",
    { tag: '@real-only' },
    async ({ page }) => {
      const before = await mirroredPage(page, folder, 'Moving file', 'moved line')
      const other = await ipc<string>(page, 'create_space', {
        name: 'Elsewhere',
        accentColor: null,
      })
      const otherFolder = path.join(folder, 'Elsewhere')
      mkdirSync(otherFolder)
      const after = path.join(otherFolder, 'Moving file.md')
      renameSync(before, after)

      await expect.poll(() => titlesIn(page, other), { timeout: 30_000 }).toContain('Moving file')
      // One page in the whole vault, in the space it moved to.
      const holding: string[] = []
      for (const spaceId of [SEED_IDS.SPACE_PERSONAL, SEED_IDS.SPACE_WORK, other]) {
        for (const title of await titlesIn(page, spaceId)) {
          if (title === 'Moving file') holding.push(spaceId)
        }
      }
      expect(holding).toEqual([other])
      expect({ before: existsSync(before), after: existsSync(after) }).toEqual({
        before: false,
        after: true,
      })
      expect((await status(page)).failed).toEqual([])
    },
  )

  test(
    'trashes the page of a file deleted outside Agaric, says so, and Restore brings both back',
    { tag: '@real-only' },
    async ({ page }) => {
      const file = await mirroredPage(page, folder, 'Deleted file', 'deleted line')
      unlinkSync(file)

      // The toast names the file, and its button opens the Trash holding the page.
      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Deleted file.md was deleted from the mirror folder' })
      await toast
        .getByRole('button', { name: 'Open Trash', exact: true })
        .click({ timeout: 30_000 })
      const row = page.getByTestId('trash-item').filter({ hasText: 'Deleted file' })
      await expect(row).toHaveCount(1)
      // Away and back, the Trash still lists it.
      await navigateToView(page, 'Journal')
      await navigateToView(page, 'Trash')
      await expect(row).toHaveCount(1)
      await row.getByTestId('trash-restore-btn').click()
      await expect(row).toHaveCount(0)

      await openPage(page, 'Deleted file')
      await expect(page.getByText('deleted line', { exact: true })).toBeVisible()
      await expect.poll(() => existsSync(file), { timeout: 30_000 }).toBe(true)
    },
  )

  test(
    'holds the page of a file moved out of every space folder, trashing nothing',
    { tag: '@real-only' },
    async ({ page }) => {
      const before = await mirroredPage(page, folder, 'Strayed file', 'strayed line')
      const outside = 'Strayed file.md'
      renameSync(before, path.join(folder, outside))

      await expect
        .poll(
          async () =>
            (await status(page)).failed.some(
              (f) => f.path === outside && f.message.includes('outside the space folders'),
            ),
          { timeout: 30_000 },
        )
        .toBe(true)
      // Past the passes a vanished file is held for before its page is trashed: one runs every two
      // seconds while a page's file is missing.
      const listedAt = (await status(page)).last_pass_ms ?? 0
      await expect
        .poll(async () => ((await status(page)).last_pass_ms ?? 0) >= listedAt + 10_000, {
          timeout: 30_000,
        })
        .toBe(true)

      const trashed = await ipc<{ items: Array<{ content: string | null }> }>(page, 'list_trash', {
        cursor: null,
        limit: 100,
        scope: PERSONAL,
      })
      expect(trashed.items.map((row) => row.content)).not.toContain('Strayed file')
      await openPage(page, 'Strayed file')
      await expect(page.getByText('strayed line', { exact: true })).toBeVisible()

      // Moved back, the file is the page's again and nothing stays listed.
      renameSync(path.join(folder, outside), before)
      await expect.poll(async () => (await status(page)).failed, { timeout: 30_000 }).toEqual([])
      expect(await personalPagesTitled(page, 'Strayed file')).toBe(1)
    },
  )

  test(
    'pauses, trashing nothing, while the folder is unmounted',
    { tag: '@real-only' },
    async ({ page }) => {
      const file = await mirroredPage(page, folder, 'Kept file', 'kept line')
      const away = `${folder}-away`
      renameSync(folder, away)
      try {
        await expect
          .poll(async () => (await status(page)).paused, { timeout: 30_000 })
          .not.toBeNull()
        expect(await personalPagesTitled(page, 'Kept file')).toBe(1)
      } finally {
        renameSync(away, folder)
      }

      const back = (await status(page)).last_pass_ms ?? 0
      await expect
        .poll(
          async () => {
            const now = await status(page)
            return now.paused === null && (now.last_pass_ms ?? 0) > back
          },
          { timeout: 30_000 },
        )
        .toBe(true)
      expect(await personalPagesTitled(page, 'Kept file')).toBe(1)
      expect(existsSync(file)).toBe(true)
    },
  )
})
