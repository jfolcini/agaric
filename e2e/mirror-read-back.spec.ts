import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeAlertDialog,
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
 * #5363 slice 4, setting 1 — reading changes back turned off and on again.
 *
 * With reading back off the mirror still writes the page but reads nothing back: a file edited
 * from Node, as another editor would, leaves the page as it was and is not written over. Turning
 * reading back on in Settings › Data asks first, listing that file, and only "Read them in" reads
 * it. A checkout that rewrites every file while it is off changes no page, and a folder chosen
 * again after Turn off, with reading back asked for, reads in nothing changed there meanwhile
 * until asked. More files of one space deleted at once than the mirror reads in unasked hold
 * reading back, and a notice says so and opens Settings › Data (#6964). The mock has no mirror
 * task, so the tests are `@real-only`.
 */

interface MirrorStatus {
  read_back: boolean
  pending: Array<{ path: string; kind: 'edited' | 'new' | 'gone' }>
  diverged: Array<{ path: string }>
  held: string[]
}

const TITLE = 'Read back page'
const LINE = 'read back line'
const PERSONAL = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

const status = (page: Page) => ipc<MirrorStatus>(page, 'get_mirror_status', {})

/** The page with its one line, once its file in `folder` holds the line; returns the line's id. */
async function seedMirroredPage(page: Page, folder: string): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: TITLE,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const { id } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content: LINE,
    parentId: pageId,
    index: null,
    scope: PERSONAL,
    blockId: null,
  })
  await expect.poll(() => mirrorText(folder, TITLE)).toContain(LINE)
  return id
}

const contentOf = async (page: Page, blockId: string) =>
  (await ipc<{ content: string }>(page, 'get_block', { blockId })).content

/**
 * Two passes after this call, each shown by a new page's file: the second began after the first
 * ended. A changed file is first left to settle, which lists it as pending a tick before any
 * read-in, so a check that nothing was read in waits on this.
 */
async function twoLaterPasses(page: Page, folder: string, label: string): Promise<void> {
  for (const n of [1, 2]) {
    const title = `Pass ${label} ${n}`
    await ipc(page, 'create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: SEED_IDS.SPACE_PERSONAL,
    })
    await expect.poll(() => mirrorFile(folder, title), { timeout: 30_000 }).toBeDefined()
  }
}

/** Settings › Data's "Read changes back" switch, on a freshly opened tab. */
async function readBackSwitch(page: Page) {
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Data')
  return page.getByRole('switch', { name: 'Read changes back' })
}

test.describe('Markdown mirror, reading changes back (#5363) @markdown @settings', () => {
  let folder = ''

  test.beforeEach(async ({ page }) => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'agaric-mirror-readback-'))
    await waitForBoot(page)
  })

  test.afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  test(
    'reads nothing back while off, and reads the changed file in only once asked',
    { tag: '@real-only' },
    async ({ page }) => {
      await startMirror(page, folder, false)
      const blockId = await seedMirroredPage(page, folder)
      const file = mirrorFile(folder, TITLE) ?? ''

      // Another editor's save, while reading back is off.
      const outside = `${LINE} from outside\n`
      writeFileSync(file, outside)
      await expect
        .poll(async () => (await status(page)).pending.some((p) => p.path.endsWith(`${TITLE}.md`)))
        .toBe(true)
      await twoLaterPasses(page, folder, 'save')
      expect(await contentOf(page, blockId)).toBe(LINE)
      expect(readFileSync(file, 'utf8')).toBe(outside)

      // Turning it on asks, listing the file; only "Read them in" reads it.
      const toggle = await readBackSwitch(page)
      await expect(toggle).not.toBeChecked()
      await toggle.click()
      const dialog = activeAlertDialog(page)
      await expect(dialog).toContainText(`${TITLE}.md`)
      await dialog.getByRole('button', { name: 'Read them in', exact: true }).click()
      await expect
        .poll(() => contentOf(page, blockId), { timeout: 30_000 })
        .toBe(`${LINE} from outside`)
      expect((await status(page)).read_back).toBe(true)
    },
  )

  test(
    'changes no page when a checkout rewrites every file while reading back is off',
    { tag: '@real-only' },
    async ({ page }) => {
      await startMirror(page, folder, false)
      await seedMirroredPage(page, folder)
      const pages = async (): Promise<Map<string, string>> => {
        const texts = new Map<string, string>()
        for (const spaceId of [SEED_IDS.SPACE_PERSONAL, SEED_IDS.SPACE_WORK]) {
          const listed = await ipc<Array<{ id: string }>>(page, 'list_all_pages_in_space', {
            scope: { kind: 'active', space_id: spaceId },
            tagIds: null,
          })
          for (const { id } of listed) {
            texts.set(
              id,
              (await ipc<{ text: string }>(page, 'get_page_buffer', { pageId: id })).text,
            )
          }
        }
        return texts
      }
      const before = await pages()
      const files = readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => path.join(entry.parentPath, entry.name))
      expect(files).toContain(mirrorFile(folder, TITLE))

      // Every file at once, as a checkout of another branch writes them.
      const checkout = (file: string) => `checked out ${path.basename(file, '.md')}\n`
      for (const file of files) writeFileSync(file, checkout(file))
      // Listed once a pass has seen each rewritten file; a file is first left to settle, which
      // lists it too, so a read-in would come a tick later.
      await expect
        .poll(
          async () => {
            const now = await status(page)
            return files.every(
              (file) =>
                now.diverged.some((d) => file.endsWith(d.path)) &&
                now.pending.some((p) => file.endsWith(p.path)),
            )
          },
          { timeout: 30_000 },
        )
        .toBe(true)
      await twoLaterPasses(page, folder, 'checkout')

      const after = await pages()
      expect(new Map([...after].filter(([id]) => before.has(id)))).toEqual(before)
      for (const file of files) expect(readFileSync(file, 'utf8')).toBe(checkout(file))
    },
  )

  test(
    'reads in nothing changed while off when the folder is chosen again',
    { tag: '@real-only' },
    async ({ page }) => {
      await startMirror(page, folder, true)
      const blockId = await seedMirroredPage(page, folder)
      const file = mirrorFile(folder, TITLE) ?? ''

      // Turn off, another editor's save, and the folder chosen again.
      await ipc(page, 'set_mirror_folder', { path: null, readBack: true })
      writeFileSync(file, `${LINE} changed while off\n`)
      const again = await ipc<MirrorStatus>(page, 'set_mirror_folder', {
        path: folder,
        readBack: true,
      })
      expect({
        readBack: again.read_back,
        pending: again.pending.some((p) => p.path.endsWith(`${TITLE}.md`)),
      }).toEqual({ readBack: false, pending: true })

      await twoLaterPasses(page, folder, 'again')
      expect(await contentOf(page, blockId)).toBe(LINE)
      expect((await status(page)).pending.some((p) => p.path.endsWith(`${TITLE}.md`))).toBe(true)
      await expect(await readBackSwitch(page)).not.toBeChecked()
    },
  )

  test(
    'says a mass change holds reading back, in a notice that opens Settings › Data',
    { tag: '@real-only' },
    async ({ page }) => {
      await startMirror(page, folder, true)
      // One more file of one space's folder than `read_back::MASS_CHANGE`.
      const titles = [1, 2, 3, 4, 5, 6].map((n) => `Held page ${n}`)
      for (const title of titles) {
        await ipc(page, 'create_page_in_space', {
          parentId: null,
          content: title,
          spaceId: SEED_IDS.SPACE_PERSONAL,
        })
      }
      for (const title of titles) {
        await expect.poll(() => mirrorFile(folder, title), { timeout: 30_000 }).toBeDefined()
      }
      for (const title of titles) rmSync(mirrorFile(folder, title) ?? '')

      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'changed or vanished outside Agaric at once' })
      await toast.getByRole('button', { name: 'Review', exact: true }).click({ timeout: 30_000 })
      await expect(page.getByTestId('settings-panel-data')).toBeVisible()
      await expect(page.getByRole('switch', { name: 'Read changes back' })).not.toBeChecked()
      const held = await status(page)
      expect({ readBack: held.read_back, held: held.held.length }).toEqual({
        readBack: false,
        held: 1,
      })

      // Away and back, reading back is still off, and every page is still live.
      await expect(await readBackSwitch(page)).not.toBeChecked()
      const live = await ipc<Array<{ content: string }>>(page, 'list_all_pages_in_space', {
        scope: PERSONAL,
        tagIds: null,
      })
      expect(titles.filter((title) => live.some((p) => p.content === title))).toEqual(titles)
    },
  )
})
