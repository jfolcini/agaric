// ---------------------------------------------------------------------------
// Real-backend Markdown mirror: reading changes back turned off and on again
// (#5363 slice 4, setting 1).
//
// With reading back off the mirror still writes the page but reads nothing
// back: a file edited from Node, as another editor would, leaves the page as
// it was and is not written over. Turning reading back on in Settings › Data
// asks first, listing that file, and only "Read them in" reads it. A
// checkout that rewrites every file while it is off changes no page. The
// mock has no mirror task, so only this lane can show it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  confirmDialog,
  invoke,
  openDataTab,
  openNewPage,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

interface MirrorStatus {
  last_pass_ms: number | null
  read_back: boolean
  pending: string[]
  diverged: { path: string }[]
}

const TITLE = runScopedMarker('wdio-readback-page')
const MARKER = runScopedMarker('wdio-readback-block')
const OUTSIDE = runScopedMarker('wdio-readback-outside')
const CHECKOUT = runScopedMarker('wdio-readback-checkout')

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-readback-'))

function pageFile(): string | undefined {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === `${TITLE}.md`)
    .map((entry) => path.join(entry.parentPath, entry.name))[0]
}

async function blockContent(id: string): Promise<string> {
  return (await invoke<{ content: string }>('get_block', { blockId: id })).content
}

const status = () => invoke<MirrorStatus>('get_mirror_status')

describe('Agaric real-backend Markdown mirror, reading changes back (#5363) @markdown @settings', () => {
  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('reads nothing back while off, and reads the changed file in only once asked', async () => {
    await waitForAppReady()
    await invoke('set_mirror_folder', { path: folder, readBack: false })
    await browser.waitUntil(async () => (await status()).last_pass_ms !== null, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the mirror never finished a pass in the new folder',
    })

    await openNewPage(TITLE)
    await typeMarkerVerified(MARKER)
    await browser.keys(['Escape'])
    const block = blockStaticByMarker(MARKER)
    await block.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const blockId = (await block.getAttribute('data-block-id')) ?? ''
    expect(blockId).not.toBe('')
    let file: string | undefined
    await browser.waitUntil(
      () => {
        file = pageFile()
        return Promise.resolve(file !== undefined && readFileSync(file, 'utf8').includes(MARKER))
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: `${TITLE}.md never held ${MARKER}` },
    )
    const written = file as string

    // Another editor's save, while reading back is off.
    const outside = `${MARKER} ${OUTSIDE}\n`
    writeFileSync(written, outside)
    await browser.waitUntil(
      async () => (await status()).pending.some((p) => p.endsWith(`${TITLE}.md`)),
      { timeout: NAV_TIMEOUT, timeoutMsg: 'the edited file was never listed as pending' },
    )
    expect(await blockContent(blockId)).toBe(MARKER)
    expect(readFileSync(written, 'utf8')).toBe(outside)

    // Turning it on asks, listing the file; only "Read them in" reads it.
    await openDataTab()
    const label = $('//label[normalize-space(.)="Read changes back"]')
    await label.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const toggle = $(`[id="${(await label.getAttribute('for')) ?? ''}"]`)
    await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await toggle.click()
    const dialog = $('[role="alertdialog"]')
    await dialog.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    expect(await dialog.getText()).toContain(`${TITLE}.md`)
    await confirmDialog('Read them in')

    await browser.waitUntil(async () => (await blockContent(blockId)).includes(OUTSIDE), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the file changed while reading back was off was never read in',
    })
    expect((await status()).read_back).toBe(true)
  })

  it('changes no page when a checkout rewrites every file while reading back is off', async () => {
    await invoke('set_mirror_read_back', { on: false, confirmed: [] })
    const pages = async (): Promise<Map<string, string>> => {
      const texts = new Map<string, string>()
      for (const space of await invoke<{ id: string }[]>('list_spaces')) {
        const listed = await invoke<{ id: string }[]>('list_all_pages_in_space', {
          scope: { kind: 'active', space_id: space.id },
          tagIds: null,
        })
        for (const page of listed) {
          texts.set(
            page.id,
            (await invoke<{ text: string }>('get_page_buffer', { pageId: page.id })).text,
          )
        }
      }
      return texts
    }
    const before = await pages()
    const files = readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(entry.parentPath, entry.name))
    expect(files.length).toBeGreaterThan(0)

    // Every file at once, as a checkout of another branch writes them.
    const checkout = (file: string) => `${CHECKOUT} ${path.basename(file, '.md')}\n`
    for (const file of files) writeFileSync(file, checkout(file))
    // Listed once a pass has seen each rewritten file; a file is first left
    // to settle, which lists it too, so a read-in would come a tick later.
    await browser.waitUntil(
      async () => {
        const now = await status()
        return files.every(
          (file) =>
            now.diverged.some((d) => file.endsWith(d.path)) &&
            now.pending.some((p) => file.endsWith(p)),
        )
      },
      {
        timeout: NAV_TIMEOUT,
        timeoutMsg: 'the rewritten files were never all seen and listed as pending',
      },
    )
    // Two later passes, each shown by a new page's file: the second began
    // after the first ended, so any read-in has run.
    const [space] = await invoke<{ id: string }[]>('list_spaces')
    for (const n of [1, 2]) {
      const title = `${CHECKOUT}-after-${n}`
      await invoke('create_page_in_space', { parentId: null, content: title, spaceId: space?.id })
      await browser.waitUntil(
        () =>
          Promise.resolve(
            readdirSync(folder, { recursive: true }).some((entry) =>
              String(entry).endsWith(`${title}.md`),
            ),
          ),
        { timeout: NAV_TIMEOUT, timeoutMsg: `${title}.md was never written` },
      )
    }

    const after = await pages()
    expect(new Map([...after].filter(([id]) => before.has(id)))).toEqual(before)
    for (const file of files) expect(readFileSync(file, 'utf8')).toBe(checkout(file))
  })
})
