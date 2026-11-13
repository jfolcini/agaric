// ---------------------------------------------------------------------------
// Real-backend Markdown mirror: copying attachments into the folder (#5363
// slice 4, setting 3).
//
// Turned on with its switch in Settings › Data, the mirror copies the image a
// page links into `<space>/assets/<id>/<name>` and the page's file links the
// copy. A copy deleted while the app is down is written again by the next
// start's pass, and the switch is still on. The mock has no mirror task, so
// only this lane can show the bytes on disk.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  invoke,
  openDataTab,
  openNewPage,
  restartApp,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

/** The fields of `MirrorStatus` (src-tauri/src/mirror/mod.rs) read here. */
interface MirrorStatus {
  last_pass_ms: number | null
  copy_files: boolean
  diverged: { path: string }[]
  failed: { path: string }[]
}

const TITLE = runScopedMarker('wdio-copy-page')
const MARKER = runScopedMarker('wdio-copy-block')
const FILENAME = 'pixel.png'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-copy-'))
const status = () => invoke<MirrorStatus>('get_mirror_status')

/** Every file below the folder named `name`, as absolute paths. */
function filesNamed(name: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/** The switch labelled `label` in Settings › Data. */
async function settingSwitch(label: string) {
  const labelled = $(`//label[normalize-space(.)="${label}"]`)
  await labelled.waitForDisplayed({ timeout: ACTION_TIMEOUT })
  const toggle = $(`[id="${(await labelled.getAttribute('for')) ?? ''}"]`)
  await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
  return toggle
}

/** Wait for the image's copy and a page file linking it; returns the copy. */
async function waitForCopyLinked(attachment: string, when: string): Promise<string> {
  const link = `assets/${attachment}/${FILENAME})`
  let copy = ''
  await browser.waitUntil(
    () => {
      copy = filesNamed(FILENAME).find((file) => file.includes(attachment)) ?? ''
      const page = filesNamed(`${TITLE}.md`)[0]
      return Promise.resolve(
        copy !== '' &&
          readFileSync(copy).equals(PNG) &&
          page !== undefined &&
          readFileSync(page, 'utf8').includes(link),
      )
    },
    { timeout: NAV_TIMEOUT, timeoutMsg: `no copy of ${FILENAME} linked from ${TITLE}.md ${when}` },
  )
  return copy
}

describe('Agaric real-backend Markdown mirror, copying attachments (#5363) @markdown @settings @attachments', () => {
  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('copies a linked image beside the pages, links it, and copies it again after a restart', async () => {
    await waitForAppReady()
    await invoke('set_mirror_folder', { path: folder, readBack: true })
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
    const { id: attachment } = await invoke<{ id: string }>('add_attachment_with_bytes', {
      blockId,
      filename: FILENAME,
      mimeType: 'image/png',
      bytes: PNG.toString('base64'),
    })
    await invoke('edit_block', {
      blockId,
      toText: `${MARKER} ![a pixel](attachment:${attachment})`,
    })
    await browser.waitUntil(
      () => {
        const page = filesNamed(`${TITLE}.md`)[0]
        return Promise.resolve(
          page !== undefined && readFileSync(page, 'utf8').includes(`attachment:${attachment}`),
        )
      },
      { timeout: NAV_TIMEOUT, timeoutMsg: `${TITLE}.md never linked the attachment` },
    )
    expect(filesNamed(FILENAME)).toEqual([])

    // The switch, as a user turns it on.
    await openDataTab()
    const copying = await settingSwitch('Copy attachments into the folder')
    expect(await copying.getAttribute('aria-checked')).toBe('false')
    await copying.click()
    const copy = await waitForCopyLinked(attachment, 'once copying was turned on')
    expect((await status()).copy_files).toBe(true)

    // Deleted while the app is down: only the next start's pass can copy it.
    unlinkSync(copy)
    await restartApp('kill')
    expect(await waitForCopyLinked(attachment, 'after the restart')).toBe(copy)
    expect(existsSync(copy)).toBe(true)

    await openDataTab()
    expect(
      await (await settingSwitch('Copy attachments into the folder')).getAttribute('aria-checked'),
    ).toBe('true')
    const settled = await status()
    expect(settled.diverged).toEqual([])
    expect(settled.failed).toEqual([])
  })
})
