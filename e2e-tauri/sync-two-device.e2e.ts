// ---------------------------------------------------------------------------
// Real-backend two-device sync (#5365).
//
// The app pairs with a second device through its own pairing dialog, and one
// edit crosses in each direction. The second device is `e2e_sync_peer`, a
// headless vault on the app's sync daemon (sync-peer.ts). It reads the
// dialog's QR as a phone's camera would; the QR carries the address that mDNS,
// which a CI runner cannot be relied on for, would otherwise have to find.
//
// A session is a pull by the device that dials (#610), so the app has to dial
// the peer too. Paired by the peer's dial, the app holds no address for it
// until one is typed into the device list, as a user without mDNS would.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'
import { type SyncPeer, readPairingQr, startSyncPeer } from './sync-peer'

const APP_EDIT = runScopedMarker('wdio-sync-app-edit')
const PEER_EDIT = runScopedMarker('wdio-sync-remote-edit')

/** Settings › Sync & devices. */
async function openSyncSettings(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-sync')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await $('[data-testid="settings-panel-sync"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** The device list's row for a peer that sent no name, so shows its id. */
function peerRow(deviceId: string) {
  return $(`//div[contains(@class, "device-peer-item")][contains(., "${deviceId.slice(0, 12)}")]`)
}

describe('Agaric real-backend two-device sync (#5365)', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it('pairs with a second device and syncs one edit each way', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()

    // This device shows the code; the peer scans it.
    await openSyncSettings()
    const pairButton = $('button*=Pair new device')
    await pairButton.waitForClickable({ timeout: ACTION_TIMEOUT })
    await pairButton.click()
    const qr = await readPairingQr()
    expect(await $('.pairing-passphrase').getText()).toBe(qr.passphrase)
    const remote = await peer.pair(qr)
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })

    // App → peer: a block written here is in the peer's vault after its pull.
    await openNewPage()
    await typeMarkerVerified(APP_EDIT)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    const appBlock = blockStaticByMarker(APP_EDIT)
    await appBlock.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const appBlockId = await appBlock.getAttribute('data-block-id')
    if (appBlockId === null) throw new Error('the app block row carries no data-block-id')
    await peer.sync()
    const copy = await peer.getBlock(appBlockId)
    expect(copy.content).toBe(APP_EDIT)
    if (copy.parentId === null) throw new Error(`the peer holds ${copy.id} with no page`)

    // Peer → app: the peer writes on the same page, then the app dials it.
    await peer.createBlock(copy.parentId, PEER_EDIT)
    await openSyncSettings()
    const editAddress = peerRow(remote.deviceId).$('button[aria-label^="Edit address for"]')
    await editAddress.waitForClickable({ timeout: NAV_TIMEOUT })
    await editAddress.click()
    await typeInputVerified('input[aria-label="Address (host:port)"]', remote.address)
    const save = $('[role="dialog"]').$('button=Save')
    await save.waitForClickable({ timeout: ACTION_TIMEOUT })
    await save.click()
    await waitForToast('Address updated')

    // The pairing and the address are the backend's, read back after a round trip.
    await navigateTo('Journal')
    await openSyncSettings()
    const row = peerRow(remote.deviceId)
    await row.$(`span=${remote.address}`).waitForDisplayed({ timeout: NAV_TIMEOUT })
    const syncNow = row.$('button[aria-label^="Sync now with device"]')
    await syncNow.waitForClickable({ timeout: ACTION_TIMEOUT })
    await syncNow.click()
    await peer.waitPulled()

    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await blockStaticByMarker(PEER_EDIT).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await blockStaticByMarker(APP_EDIT).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })
})
