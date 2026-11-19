import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { Page } from '@playwright/test'

import { expect, ipc, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * #6540 — *Open a folder of notes*: a folder of Markdown notes, picked once in Settings › Data, is
 * imported into a new space through the folder import (the backend serving each file from disk),
 * previewed, and adopted in place as that space's mirror folder. Bytes on disk are the point, so
 * the test is `@real-only`: adopting rewrites, moves and adds no file, and a block edited in
 * Agaric then rewrites only its own line of its file.
 *
 * The folder dialog is the OS's, so the one command that opens it, `pick_mirror_folder`, answers
 * with this spec's folder from an in-page stub; every other command reaches the real backend.
 * Only here can it be stubbed: in the Tauri app `__TAURI_INTERNALS__.invoke` is non-writable.
 */

interface MirrorStatus {
  folder: string | null
  adopted_space: string | null
  last_pass_ms: number | null
}

/** A note as another editor writes it: front matter in its own order, `*` bullets. */
const PLAN = '---\ntags: [work]\naliases: [Roadmap]\n---\n* First step\n* Second step\n'

const NOTES: Record<string, string> = {
  'Inbox.md': 'A loose thought\n',
  'Projects/Plan.md': PLAN,
  'diagram.png': 'not really a png',
}

/** Every file below `folder` but the hidden ones, with its text. */
function filesOnDisk(folder: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name)
        return [path.relative(folder, file).split(path.sep).join('/'), readFileSync(file, 'utf8')]
      }),
  )
}

/** Answer `pick_mirror_folder` with `folder`, passing every other command through. */
async function stubFolderPick(page: Page, folder: string): Promise<void> {
  await page.evaluate((picked) => {
    type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
      .__TAURI_INTERNALS__
    const real = internals.invoke
    internals.invoke = (cmd, args, options) =>
      cmd === 'pick_mirror_folder' ? Promise.resolve(picked) : real(cmd, args, options)
  }, folder)
}

const status = (page: Page) => ipc<MirrorStatus>(page, 'get_mirror_status', {})

test.describe('Markdown mirror, opening a folder of notes in place (#6540) @markdown @settings', () => {
  let folder = ''

  test.beforeEach(async ({ page }) => {
    folder = mkdtempSync(path.join(os.tmpdir(), 'agaric-mirror-adopt-'))
    for (const [file, text] of Object.entries(NOTES)) {
      mkdirSync(path.dirname(path.join(folder, file)), { recursive: true })
      writeFileSync(path.join(folder, file), text)
    }
    await waitForBoot(page)
  })

  test.afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  test(
    'imports the folder, adopts it without touching a file, and writes only an edited block',
    { tag: '@real-only' },
    async ({ page }) => {
      await stubFolderPick(page, folder)
      await navigateToView(page, 'Settings')
      await openSettingsTab(page, 'Data')
      await page.getByRole('button', { name: 'Open a folder of notes…', exact: true }).click()

      const dialog = page.getByTestId('mirror-adopt-dialog')
      await expect(dialog.getByTestId('mirror-adopt-left-alone')).toContainText('diagram.png')
      await dialog.getByTestId('mirror-adopt-confirm').click()

      await expect
        .poll(async () => {
          const now = await status(page)
          return now.adopted_space !== null && now.last_pass_ms !== null
        })
        .toBe(true)
      // Adopting rewrote, moved and added nothing: no space folder, no file for a page with none.
      expect(filesOnDisk(folder)).toEqual(NOTES)

      // The card, opened afresh, reads the folder back as the mirror's.
      await navigateToView(page, 'Journal')
      await navigateToView(page, 'Settings')
      await openSettingsTab(page, 'Data')
      await expect(page.getByTestId('mirror-folder')).toHaveText(folder)

      // The first block of the plan, edited through the real backend: its own line takes
      // Agaric's form, and every other line stays as written.
      const spaceId = (await status(page)).adopted_space
      const scope = { kind: 'active', space_id: spaceId }
      const pages = await ipc<Array<{ id: string; content: string | null }>>(
        page,
        'list_all_pages_in_space',
        { scope, tagIds: null },
      )
      const plan = pages.find((row) => row.content === 'Projects/Plan')
      expect(plan).toBeDefined()
      const { items } = await ipc<{ items: Array<{ id: string; content: string | null }> }>(
        page,
        'list_blocks',
        {
          request: {
            parentId: plan?.id,
            blockType: null,
            tagId: null,
            date: null,
            dateRange: null,
            source: null,
            excludeTodoStates: null,
            cursor: null,
            limit: 10,
            spaceId,
          },
          scope,
        },
      )
      const first = items.find((block) => block.content === 'First step')
      expect(first).toBeDefined()
      await ipc(page, 'edit_block', {
        blockId: first?.id,
        toText: 'First step, done',
        baseText: null,
      })

      const planFile = path.join(folder, 'Projects/Plan.md')
      await expect
        .poll(() => readFileSync(planFile, 'utf8'), { timeout: 30_000 })
        .toContain('First step, done')
      expect(readFileSync(planFile, 'utf8')).toBe(
        PLAN.replace('* First step\n', '- First step, done\n'),
      )
    },
  )
})
