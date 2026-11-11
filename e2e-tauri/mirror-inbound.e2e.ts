// ---------------------------------------------------------------------------
// Real-backend inbound Markdown mirror (#5363 slice 2, #6277 H2).
//
// The mirror's task (src-tauri/src/mirror/mod.rs) reads a page's file, edited
// outside Agaric, back into the page once two of its ticks read the same
// bytes; the mock has no such task, so only this lane can show it. The file
// is written from Node, as another editor would save it, with `*` bullets the
// app does not write: the page takes the edit, the file keeps its own bytes,
// and Ctrl+Z on the page reverts the edit, which the mirror then writes back.
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
  invoke,
  navigateTo,
  openNewPage,
  reopenPageHolding,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

interface MirrorStatus {
  last_pass_ms: number | null
  diverged: { page_id: string; path: string }[]
  failed: { page_id: string; path: string; message: string }[]
}

const TITLE = runScopedMarker('wdio-inbound-page')
const MARKER = runScopedMarker('wdio-inbound-block')
const OUTSIDE = runScopedMarker('wdio-inbound-outside')

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-in-'))

function pageFile(): string | undefined {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === `${TITLE}.md`)
    .map((entry) => path.join(entry.parentPath, entry.name))[0]
}

async function blockContent(id: string): Promise<string> {
  return (await invoke<{ content: string }>('get_block', { blockId: id })).content
}

describe('Agaric real-backend inbound Markdown mirror (#5363) @markdown', () => {
  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('reads a file edited outside into its page, keeps the file, and one Ctrl+Z reverts it', async () => {
    await waitForAppReady()
    await invoke('set_mirror_folder', { path: folder, readBack: true })
    await browser.waitUntil(
      async () => (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms !== null,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the mirror never finished a pass in the new folder' },
    )

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

    // Another editor's save: a `*` bullet, a word added.
    const outside = `* ${MARKER} ${OUTSIDE}\n`
    writeFileSync(written, outside)
    await browser.waitUntil(async () => (await blockContent(blockId)).includes(OUTSIDE), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the edit made outside never reached the block',
    })
    const status = await invoke<MirrorStatus>('get_mirror_status')
    expect(status.diverged).toEqual([])
    expect(status.failed).toEqual([])
    expect(readFileSync(written, 'utf8')).toBe(outside)

    // The open page shows it, and one Ctrl+Z there reverts the ingest.
    await blockStaticByMarker(OUTSIDE).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Control', 'z'])
    await browser.waitUntil(async () => !(await blockContent(blockId)).includes(OUTSIDE), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Ctrl+Z did not revert the ingested edit',
    })
    expect(await blockContent(blockId)).toBe(MARKER)

    // Durable: away and back the page holds the reverted text, and the file
    // follows it.
    await navigateTo('Journal')
    await reopenPageHolding(TITLE, MARKER)
    expect(await blockContent(blockId)).toBe(MARKER)
    await browser.waitUntil(
      () => Promise.resolve(!readFileSync(written, 'utf8').includes(OUTSIDE)),
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the reverted text never reached the file' },
    )
  })
})
