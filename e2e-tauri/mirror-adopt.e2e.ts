// #6540 — *Open a folder of notes*: a folder of Markdown notes, picked once in
// Settings › Data, is imported into a new space through the folder import
// (the backend serving each file from disk), previewed, and adopted in place
// as that space's mirror folder. Bytes on disk are the point, so this runs on
// the real backend: adopting rewrites, moves and adds no file, and a block
// edited in Agaric then rewrites only its own lines of its file.
//
// The folder dialog is the OS's, which WebDriver cannot drive, so the one
// command that opens it, `pick_mirror_folder`, answers with this spec's folder;
// every other command reaches the real backend.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ACTION_TIMEOUT, NAV_TIMEOUT, invoke, navigateTo, waitForAppReady } from './helpers'

interface MirrorStatus {
  folder: string | null
  adopted_space: string | null
  last_pass_ms: number | null
}

/** A note as another editor writes it: front matter in its own order, `*` bullets. */
const PLAN = '---\ntags: [work]\naliases: [Roadmap]\n---\n* First step\n* Second step\n'

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-adopt-'))
const NOTES: Record<string, string> = {
  'Inbox.md': 'A loose thought\n',
  'Projects/Plan.md': PLAN,
  'diagram.png': 'not really a png',
}

/** Every file below the folder but the hidden ones, with its text. */
function filesOnDisk(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name)
        return [path.relative(folder, file).split(path.sep).join('/'), readFileSync(file, 'utf8')]
      }),
  )
}

describe('Agaric real-backend Markdown mirror, opening a folder of notes in place (#6540) @markdown @settings', () => {
  before(() => {
    for (const [file, text] of Object.entries(NOTES)) {
      mkdirSync(path.dirname(path.join(folder, file)), { recursive: true })
      writeFileSync(path.join(folder, file), text)
    }
  })

  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('imports the folder, adopts it without touching a file, and writes only an edited block', async () => {
    await waitForAppReady()
    await browser.execute((picked: string) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const real = internals.invoke.bind(internals)
      internals.invoke = (cmd, args) =>
        cmd === 'pick_mirror_folder' ? Promise.resolve(picked) : real(cmd, args)
    }, folder)

    await navigateTo('Settings')
    const dataTab = $('#settings-tab-data')
    await dataTab.waitForClickable({ timeout: NAV_TIMEOUT })
    await dataTab.click()
    const open = $('button=Open a folder of notes…')
    await open.waitForClickable({ timeout: NAV_TIMEOUT })
    await open.click()

    const dialog = $('[data-testid="mirror-adopt-dialog"]')
    await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    expect(await $('[data-testid="mirror-adopt-left-alone"]').getText()).toContain('diagram.png')
    await $('[data-testid="mirror-adopt-confirm"]').click()

    await browser.waitUntil(
      async () => {
        const status = await invoke<MirrorStatus>('get_mirror_status')
        return status.adopted_space !== null && status.last_pass_ms !== null
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the folder was never adopted and passed over' },
    )
    // Adopting rewrote, moved and added nothing: no space folder, no file
    // for a page with none.
    expect(filesOnDisk()).toEqual(NOTES)

    // The first block of the plan, edited through the real backend: its own
    // line takes Agaric's form, and every other line stays as written.
    const spaceId = (await invoke<MirrorStatus>('get_mirror_status')).adopted_space
    const scope = { kind: 'active', space_id: spaceId }
    const pages = await invoke<{ id: string; content: string | null }[]>(
      'list_all_pages_in_space',
      { scope, tagIds: null },
    )
    const plan = pages.find((page) => page.content === 'Projects/Plan')
    expect(plan).toBeDefined()
    const blocks = await invoke<{ items: { id: string; content: string | null }[] }>(
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
    const first = blocks.items.find((block) => block.content === 'First step')
    expect(first).toBeDefined()
    await invoke('edit_block', { blockId: first?.id, toText: 'First step, done', baseText: null })

    await browser.waitUntil(
      () =>
        readFileSync(path.join(folder, 'Projects/Plan.md'), 'utf8').includes('First step, done'),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the edit never reached the adopted file' },
    )
    expect(readFileSync(path.join(folder, 'Projects/Plan.md'), 'utf8')).toBe(
      PLAN.replace('* First step\n', '- First step, done\n'),
    )
  })
})
