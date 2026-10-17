// ---------------------------------------------------------------------------
// Real-backend page mode across an app restart (#5691).
//
// Text typed in page mode reaches the backend through the block commands, under
// ids the client mints for new blocks. A restart is the strongest read-back:
// the app process ends and a new one opens the same vault, so nothing the
// webview held survives. The blocks must come back with their text, their
// depth and the same ids, the ids every `((ref))` and `[[link]]` points at.
//
// The restart ends the WebDriver session and starts another: `tauri-driver`
// keeps the sandbox's `AGARIC_DATA_DIR`, so the new app opens the same vault.
// The old app must be gone first, or the new one hands its launch to it over
// the single-instance D-Bus name and the session never starts (see
// `reapSessionApp` in wdio.conf.ts).
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { readdirSync, readlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'

import {
  NAV_TIMEOUT,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import {
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

const FIRST = runScopedMarker('wdio-page-mode-first')
const SECOND = runScopedMarker('wdio-page-mode-second')

const APP =
  process.env['TAURI_APP_BINARY'] ??
  path.resolve(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'agaric')

/** PIDs of the app binary under test; the lane runs one spec file at a time. */
function appPids(): number[] {
  const binary = realpathSync(APP)
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .filter((entry) => {
      try {
        return readlinkSync(`/proc/${entry}/exe`) === binary
      } catch {
        return false
      }
    })
    .map(Number)
}

/** End the app and open it again on the same vault. */
async function restartApp(): Promise<void> {
  await browser.deleteSession()
  await browser.waitUntil(() => Promise.resolve(appPids().length === 0), {
    timeout: NAV_TIMEOUT,
    interval: 200,
    timeoutMsg: `the app (pid ${appPids().join(', ')}) outlived its session`,
  })
  await browser.reloadSession()
  await waitForAppReady()
}

describe('Agaric real-backend page mode across a restart (#5691)', () => {
  it('keeps the text, depth and ids of blocks edited in page mode', async () => {
    await waitForAppReady()
    await openNewPage()
    // Typed in block mode: an empty first block would be the empty-block
    // cleanup's to delete as the switch takes focus.
    await typeMarkerVerified(FIRST)
    await chooseEditMode('Page')

    // Edit the block page mode opened on, then split off a new one and indent it.
    await pageModeCaret(0, 'end')
    await typeInPageMode(' page', 0, `${FIRST} page`)
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Enter never split off a second block',
    })
    await typeInPageMode(SECOND, 1, SECOND)
    await browser.keys(['Tab'])
    await browser.waitUntil(async () => (await pageModeBlocks())[1]?.depth === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Tab never moved the second block under the first',
    })
    const before = await pageModeBlocks()
    expect(before.map((block) => block.text)).toEqual([`${FIRST} page`, SECOND])
    // Switching back to blocks saves what page mode has not saved yet.
    await chooseEditMode('Blocks')

    await restartApp()
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')

    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'page mode never showed the two blocks after the restart',
    })
    expect(await pageModeBlocks()).toEqual(before)
    expect(await pageModeIndexOf(SECOND)).toBe(1)
  })
})
