// ---------------------------------------------------------------------------
// Real-backend Markdown mirror: reading changes back turned off and on again
// (#5363 slice 4, setting 1).
//
// With reading back off the mirror still writes the page but reads nothing
// back: a file edited from Node, as another editor would, leaves the page as
// it was and is not written over. Turning reading back on in Settings › Data
// asks first, listing that file, and only "Read them in" reads it. The mock
// has no mirror task, so only this lane can show it.
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
}

const TITLE = runScopedMarker('wdio-readback-page')
const MARKER = runScopedMarker('wdio-readback-block')
const OUTSIDE = runScopedMarker('wdio-readback-outside')

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
})
