// ---------------------------------------------------------------------------
// Real-backend: two devices that each gave a page one name keep both pages,
// and the device that made the newer one renames it `Name (2)` (#6278).
//
// The peer (`e2e_sync_peer`, sync-peer.ts) makes its page first, so the app's
// page is the newer one, the one the app renames. Both start under draft
// titles: the app pulls on its own every minute, and a page it pulled under
// the shared name would make its own create resolve to that page. The app
// titles its page, then the peer titles its own in another case, which folds
// to the same name; the peer never pulls unasked, so neither refuses. The app
// pulls, renames its page in the post-sync pass and says so in a toast; the
// peer pulls the rename. The peer's page keeps its title: one ` (2)`, on one
// page, on both devices.
//
// The pages are written through the real IPC: the setup is not under test.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  navigateTo,
  pageEntryTitled,
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

const NAME = runScopedMarker('wdio-name-tie')
/** The peer's title: another case of `NAME`, the same name under the fold. */
const PEER_TITLE = NAME.toUpperCase()
const RENAMED = `${NAME} (2)`
const APP_DRAFT = runScopedMarker('wdio-name-tie-app-draft')
const PEER_DRAFT = runScopedMarker('wdio-name-tie-peer-draft')
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'

async function syncIdle(): Promise<boolean> {
  return (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false'
}

async function titleOf(id: string): Promise<string> {
  return (await invoke<{ content: string | null }>('get_block', { blockId: id })).content ?? ''
}

describe('Agaric real-backend page name tie across devices (#6278) @pages @sync', () => {
  let peer: SyncPeer | undefined
  let paired = false

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  function pairedPeer(): SyncPeer {
    if (peer === undefined || !paired) throw new Error('the pairing test failed')
    return peer
  }

  it('pairs with the peer and gives the app its address', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()
    await openSyncSettings()
    await openPairing()
    const remote = await peer.pair(await readPairingQr())
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })
    await setPeerAddress(remote.deviceId, remote.address)
    paired = true
  })

  it('renames the newer page once, on the device that made it, and says so', async () => {
    const device = pairedPeer()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')?.id
    if (personal === undefined) throw new Error('no Personal space')
    const peerPage = await device.createInSpace('page', PEER_DRAFT)
    const appPage = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: APP_DRAFT,
      spaceId: personal,
    })
    expect(appPage > peerPage).toBe(true)
    await invoke('edit_block', { blockId: appPage, toText: NAME })
    await device.editBlock(peerPage, PEER_TITLE)

    await browser.waitUntil(syncIdle, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the app never finished the sync it was running',
    })
    await $(SYNC_BUTTON).click()
    await device.waitPulled()
    // The notice stays until dismissed, so a periodic pull that renamed first
    // still shows it here.
    await waitForToast(`Renamed “${NAME}” to “${RENAMED}”`)

    // The durable read: the Pages view, left and opened again, lists both.
    await navigateTo('Journal')
    await navigateTo('Pages')
    for (const title of [RENAMED, PEER_TITLE]) {
      await pageEntryTitled(title).waitForExist({
        timeout: NAV_TIMEOUT,
        timeoutMsg: `the Pages view never listed ${title}`,
      })
    }
    expect({ app: await titleOf(appPage), peer: await titleOf(peerPage) }).toEqual({
      app: RENAMED,
      peer: PEER_TITLE,
    })

    // The rename reaches the peer, and its own page is untouched.
    await device.sync()
    expect({
      app: (await device.getBlock(appPage)).content,
      peer: (await device.getBlock(peerPage)).content,
    }).toEqual({ app: RENAMED, peer: PEER_TITLE })
  })
})
