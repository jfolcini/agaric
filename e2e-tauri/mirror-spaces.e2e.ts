// ---------------------------------------------------------------------------
// Real-backend Markdown mirror: which spaces are mirrored (#5363 slice 4,
// setting 2).
//
// A space turned off in Settings › Data is no longer written: its unchanged
// files are removed from the folder, the other spaces' stay, and a page added
// to it gets no file. The mock has no mirror task, so only this lane can
// show it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  createSpace,
  invoke,
  openDataTab,
  openNewPage,
  openSpacesSettings,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

interface MirrorStatus {
  last_pass_ms: number | null
  unmirrored_spaces: string[]
}

const KEPT = runScopedMarker('wdio-spaces-kept')
const KEPT_BLOCK = runScopedMarker('wdio-spaces-kept-block')
const OTHER_SPACE = runScopedMarker('wdio-spaces-other')
const OTHER_PAGE = runScopedMarker('wdio-spaces-other-page')
const NEW_PAGE = runScopedMarker('wdio-spaces-new-page')

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-spaces-'))

/** The path of `file` below the mirror's folder, once a pass wrote it. */
async function writtenFile(file: string): Promise<string> {
  let found: string | undefined
  await browser.waitUntil(
    () => {
      found = readdirSync(folder, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name === file)
        .map((entry) => path.join(entry.parentPath, entry.name))[0]
      return Promise.resolve(found !== undefined)
    },
    { timeout: ACTION_TIMEOUT, timeoutMsg: `${file} never reached the mirror` },
  )
  return found as string
}

describe('Agaric real-backend Markdown mirror, which spaces are mirrored (#5363) @markdown @settings', () => {
  after(() => {
    rmSync(folder, { recursive: true, force: true })
  })

  it('removes a space turned off from the folder and keeps mirroring the others', async () => {
    await waitForAppReady()
    await invoke('set_mirror_folder', { path: folder, readBack: true })
    await browser.waitUntil(
      async () => (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms !== null,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the mirror never finished a pass in the new folder' },
    )

    // A page in the current space, and one in another space.
    await openNewPage(KEPT)
    await typeMarkerVerified(KEPT_BLOCK)
    await browser.keys(['Escape'])
    await blockStaticByMarker(KEPT_BLOCK).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const kept = await writtenFile(`${KEPT}.md`)
    // Through Settings › Spaces, so the app's list of spaces knows it.
    await openSpacesSettings()
    await createSpace(OTHER_SPACE)
    const spaces = await invoke<{ id: string; name: string }[]>('list_spaces')
    const other = spaces.find((space) => space.name === OTHER_SPACE)?.id ?? ''
    expect(other).not.toBe('')
    await invoke('create_page_in_space', { parentId: null, content: OTHER_PAGE, spaceId: other })
    const otherFile = await writtenFile(`${OTHER_PAGE}.md`)

    // Turned off from Settings › Data, by its switch.
    await openDataTab()
    const label = $(`//label[normalize-space(.)="${OTHER_SPACE}"]`)
    await label.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const toggle = $(`[id="${(await label.getAttribute('for')) ?? ''}"]`)
    await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
    await toggle.click()

    await browser.waitUntil(() => Promise.resolve(!existsSync(otherFile)), {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `${OTHER_PAGE}.md was never removed with its space`,
    })
    expect((await invoke<MirrorStatus>('get_mirror_status')).unmirrored_spaces).toEqual([other])
    expect(existsSync(kept)).toBe(true)

    // A page added to the space while it is off gets no file.
    await invoke('create_page_in_space', { parentId: null, content: NEW_PAGE, spaceId: other })
    // Two passes ending after it, so one began after it.
    let since = Date.now()
    for (const pass of ['first', 'second']) {
      await browser.waitUntil(
        async () => {
          const ended = (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms ?? 0
          if (ended <= since) return false
          since = ended
          return true
        },
        { timeout: NAV_TIMEOUT, timeoutMsg: `no ${pass} pass after the page was added` },
      )
    }
    expect(
      readdirSync(folder, { recursive: true, withFileTypes: true }).filter(
        (entry) => entry.name === `${NEW_PAGE}.md`,
      ),
    ).toEqual([])
  })
})
