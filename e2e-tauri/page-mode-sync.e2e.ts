// ---------------------------------------------------------------------------
// Real-backend page mode while a sync peer edits the page (#5691).
//
// The page stays open in page mode. The app types into one block and saves it;
// the peer, `e2e_sync_peer` (sync-peer.ts), edits another, and the app pulls
// that edit. Page mode must show it in place without remounting, keep the
// app's own text, and never write the peer's block back over with the old
// text when it next saves (the risk in #5691: a save that compares against
// anything but each block's own last-saved state reverts a peer's edit). Then
// the peer creates a block and moves another, and page mode shows both where
// the peer put them, again without remounting and without writing them back.
//
// As in sync-refresh.e2e.ts, the pull is started from the sidebar's Sync
// button, which leaves the page mounted. The app writes and closes its editor
// before the peer writes (e2e-tauri/AGENTS.md, two-device specs).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  waitForAppReady,
  waitForToast,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  typeInPageMode,
} from './page-mode'
import {
  type SyncPeer,
  openPairing,
  openSyncSettings,
  readPairingQr,
  setPeerAddress,
  startSyncPeer,
} from './sync-peer'

const TITLE = 'peer page mode'
const FIRST = runScopedMarker('wdio-pm-first')
const SECOND = runScopedMarker('wdio-pm-second')
const THIRD = runScopedMarker('wdio-pm-third')
const FROM_PEER = runScopedMarker('wdio-pm-from-peer')
const FOURTH = runScopedMarker('wdio-pm-fourth')
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'

async function syncIdle(): Promise<boolean> {
  return (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false'
}

/** Write on the peer, then press the sidebar's Sync, which leaves the open view mounted. */
async function pullPeerWrites<T>(peer: SyncPeer, writes: () => Promise<T>): Promise<T> {
  const written = await writes()
  await browser.waitUntil(syncIdle, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'the app never finished the sync it was running',
  })
  await $(SYNC_BUTTON).click()
  await peer.waitPulled()
  return written
}

/** Wait until `holds`, pressing Sync between reads; a pull never remounts the view. */
async function waitInOpenView(holds: () => Promise<boolean>, what: () => string): Promise<void> {
  await browser
    .waitUntil(
      async () => {
        if (await holds()) return true
        if (await syncIdle()) await $(SYNC_BUTTON).click()
        return false
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(what())
    })
}

/** Wait until the peer, pulling from the app, holds `content` in block `id`. */
async function waitPeerHolds(peer: SyncPeer, id: string, content: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        await peer.sync()
        seen = (await peer.getBlock(id)).content
        return seen === content
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(
        `the peer holds ${JSON.stringify(seen)} in ${id}, not ${JSON.stringify(content)}`,
      )
    })
}

describe('Agaric real-backend page mode while a peer edits (#5691)', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it('shows a peer’s edit in place, keeps its own, and never writes the peer’s block back', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    const device = peer
    await waitForAppReady()
    await openSyncSettings()
    await openPairing()
    const remote = await device.pair(await readPairingQr())
    await waitForToast('Device paired successfully')
    await setPeerAddress(remote.deviceId, remote.address)

    const [pageId, firstId, secondId, thirdId] = await pullPeerWrites(device, async () => {
      const page = await device.createInSpace('page', TITLE)
      return [
        page,
        await device.createBlock(page, FIRST),
        await device.createBlock(page, SECOND),
        await device.createBlock(page, THIRD),
      ] as const
    })
    // The page's arrival is not under test: re-open it until it shows.
    await browser.waitUntil(
      async () => {
        await navigateTo('Pages')
        if (!(await $(`.//span[normalize-space(.)="${TITLE}"]`).isExisting())) {
          if (await syncIdle()) await $(SYNC_BUTTON).click()
          return false
        }
        await reopenPageByTitle(TITLE)
        return await $(`[data-testid="sortable-block"]*=${THIRD}`).isExisting()
      },
      { timeout: NAV_TIMEOUT, interval: 1_000, timeoutMsg: "the peer's page never arrived" },
    )
    await chooseEditMode('Page')
    expect((await pageModeBlocks()).map((block) => block.id)).toEqual([firstId, secondId, thirdId])
    // Marks this page-mode editor, so a remount, which would re-read the page, shows.
    await browser.execute((selector: string) => {
      document.querySelector(selector)?.setAttribute('data-wdio-mounted', 'once')
    }, PAGE_MODE)

    // The app's edit, saved and closed before the peer writes.
    await pageModeCaret(0, 'end')
    await typeInPageMode(' app', 0, `${FIRST} app`)
    await $('[aria-label="Page title"]').click()
    await waitPeerHolds(device, firstId, `${FIRST} app`)

    await pullPeerWrites(device, () => device.editBlock(thirdId, FROM_PEER))
    let seen: string[] = []
    await waitInOpenView(
      async () => {
        seen = (await pageModeBlocks()).map((block) => block.text)
        return seen[2] === FROM_PEER
      },
      () => `page mode never showed the peer's edit: ${JSON.stringify(seen)}`,
    )
    expect(seen[0]).toBe(`${FIRST} app`)
    expect(await $(`${PAGE_MODE}[data-wdio-mounted="once"]`).isExisting()).toBe(true)

    // The app saves again; the peer's block must come through it unchanged.
    await pageModeCaret(0, 'end')
    await typeInPageMode(' more', 0, `${FIRST} app more`)
    await $('[aria-label="Page title"]').click()
    await waitPeerHolds(device, firstId, `${FIRST} app more`)
    expect((await device.getBlock(thirdId)).content).toBe(FROM_PEER)

    // The peer creates a block (last) and moves the third to the top.
    const fourthId = await pullPeerWrites(device, async () => {
      const id = await device.createBlock(pageId, FOURTH)
      await device.moveBlock(thirdId, pageId, 0)
      return id
    })
    let ids: string[] = []
    await waitInOpenView(
      async () => {
        ids = (await pageModeBlocks()).map((block) => block.id)
        return ids.length === 4 && ids[0] === thirdId
      },
      () => `page mode never showed the peer's new and moved blocks: ${JSON.stringify(ids)}`,
    )
    expect(ids).toEqual([thirdId, firstId, secondId, fourthId])
    expect(await $(`${PAGE_MODE}[data-wdio-mounted="once"]`).isExisting()).toBe(true)

    // The app saves again: the peer's block stays where the peer put it.
    await pageModeCaret(1, 'end')
    await typeInPageMode(' last', 1, `${FIRST} app more last`)
    await $('[aria-label="Page title"]').click()
    await waitPeerHolds(device, firstId, `${FIRST} app more last`)
    expect((await device.getBlock(fourthId)).content).toBe(FOURTH)
    expect((await pageModeBlocks()).map((block) => block.id)).toEqual(ids)
  })
})
