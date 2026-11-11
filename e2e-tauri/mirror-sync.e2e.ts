// ---------------------------------------------------------------------------
// Real-backend Markdown mirror after a sync (#5363).
//
// The mirror writes the pages this device's own ops touched, and those a sync
// names in `SyncEvent::Complete.changed_page_ids` (`MirrorState::note_sync`,
// fed by `mirror::on_sync_event`); its full pass otherwise runs only hourly.
// So a page the peer `e2e_sync_peer` creates and then edits reaches the app's
// mirror folder within the wait below only through a real pull's event.
//
// A snapshot catch-up, the sync that names no pages, cannot be produced from
// here (the peer has no way to make the app's pull end in `ResetRequired`);
// `note_sync` turning it into a full pass is pinned by the Rust test
// `a_sync_rewrites_the_pages_it_names_and_one_naming_none_rescans`.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  runScopedMarker,
  waitForAppReady,
  waitForToast,
} from './helpers'
import {
  type SyncPeer,
  openPairing,
  openSyncSettings,
  readPairingQr,
  setPeerAddress,
  startSyncPeer,
} from './sync-peer'

/** `MirrorStatus` (src-tauri/src/mirror/mod.rs) as the command serializes it. */
interface MirrorStatus {
  folder: string | null
  diverged: { page_id: string; path: string }[]
  failed: { page_id: string; path: string; message: string }[]
  last_pass_ms: number | null
}

const TITLE = runScopedMarker('wdio-mirror-peer-page')
const FIRST = runScopedMarker('wdio-mirror-peer-block')
const EDITED = runScopedMarker('wdio-mirror-peer-edit')

const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'

const folder = mkdtempSync(path.join(os.tmpdir(), 'wdio-mirror-sync-'))

/** The text of the peer page's file, under whatever space folder holds it; '' while there is none. */
function pageFile(): string {
  const file = readdirSync(folder, { recursive: true, withFileTypes: true }).find(
    (entry) => entry.isFile() && entry.name === `${TITLE}.md`,
  )
  if (file === undefined) return ''
  return readFileSync(path.join(file.parentPath, file.name), 'utf8')
}

/**
 * Wait until the page's file holds `text`, pressing the sidebar's Sync between
 * reads: a pull already running at the first press can end without the
 * peer's write, and a later one carries it.
 */
async function syncUntilFileHolds(text: string, absent?: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const onDisk = pageFile()
      if (onDisk.includes(text) && (absent === undefined || !onDisk.includes(absent))) return true
      if ((await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false') {
        await $(SYNC_BUTTON).click()
      }
      return false
    },
    {
      timeout: NAV_TIMEOUT,
      interval: 1_000,
      timeoutMsg: `${TITLE}.md never held ${text}; it holds ${JSON.stringify(pageFile())}`,
    },
  )
}

describe('Agaric real-backend Markdown mirror after a sync (#5363) @markdown @sync', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
    rmSync(folder, { recursive: true, force: true })
  })

  it("writes the page a peer creates, then rewrites it with the peer's edit", async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()

    const set = await invoke<MirrorStatus>('set_mirror_folder', { path: folder })
    expect(set.folder).toBe(folder)
    await browser.waitUntil(
      async () => (await invoke<MirrorStatus>('get_mirror_status')).last_pass_ms !== null,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the mirror never finished a pass in the new folder' },
    )

    await openSyncSettings()
    await openPairing()
    const remote = await peer.pair(await readPairingQr())
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })
    await setPeerAddress(remote.deviceId, remote.address)

    const page = await peer.createInSpace('page', TITLE)
    const block = await peer.createBlock(page, FIRST)
    await syncUntilFileHolds(FIRST)

    await peer.editBlock(block, EDITED)
    await syncUntilFileHolds(EDITED, FIRST)

    const status = await invoke<MirrorStatus>('get_mirror_status')
    expect(status.diverged).toEqual([])
    expect(status.failed).toEqual([])
  })
})
