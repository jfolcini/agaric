// ---------------------------------------------------------------------------
// Real-backend two-device sync (#5365).
//
// The app pairs with a second device through its own pairing dialog, and one
// edit crosses in each direction, then a property and a move. The second
// device is `e2e_sync_peer`, a headless vault on the app's sync daemon
// (sync-peer.ts). It reads the dialog's QR as a phone's camera would; the QR
// carries the address that mDNS, which a CI runner cannot be relied on for,
// would otherwise have to find.
//
// A session is a pull by the device that dials (#610), so the app has to dial
// the peer too. Paired by the peer's dial, the app holds no address for it
// until one is typed into the device list, as a user without mDNS would.
//
// Three tests in one vault: the third works on the pairing and the page the
// second leaves.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  enterBlankSibling,
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
// A key no definition spells or folds to is a custom text property.
const KEY = 'wdiosync'
const APP_VALUE = runScopedMarker('wdio-sync-app-prop')
const PEER_VALUE = runScopedMarker('wdio-sync-remote-prop')

/** Settings › Sync & devices. */
async function openSyncSettings(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-sync')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await $('[data-testid="settings-panel-sync"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Open the pairing dialog from the sync settings; resolves to the passphrase it shows. */
async function openPairing(): Promise<string> {
  const pairButton = $('button*=Pair new device')
  await pairButton.waitForClickable({ timeout: ACTION_TIMEOUT })
  await pairButton.click()
  await $('[data-testid="pairing-qr-code"] svg path').waitForExist({ timeout: ACTION_TIMEOUT })
  return $('.pairing-passphrase').getText()
}

/** Close the open pairing dialog through its "Cancel pairing?" guard. */
async function cancelPairing(): Promise<void> {
  // A passphrase on screen makes a close ask first (`handleAttemptClose`).
  await browser.keys(['Escape'])
  const cancel = $('[role="alertdialog"]').$('button=Cancel pairing')
  await cancel.waitForClickable({ timeout: ACTION_TIMEOUT })
  await cancel.click()
  await $('[data-testid="pairing-qr-code"]').waitForExist({
    reverse: true,
    timeout: ACTION_TIMEOUT,
  })
}

/** The device list's row for a peer that sent no name, so shows its id. */
function peerRow(deviceId: string) {
  return $(`//div[contains(@class, "device-peer-item")][contains(., "${deviceId.slice(0, 12)}")]`)
}

/** Press the open device list's "Sync now" for `deviceId`. */
async function clickSyncNow(deviceId: string): Promise<void> {
  const syncNow = peerRow(deviceId).$('button[aria-label^="Sync now with device"]')
  await syncNow.waitForClickable({ timeout: ACTION_TIMEOUT })
  await syncNow.click()
}

/** Leave the shared page and come back, so the rows are the backend's. */
async function reopenSharedPage(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
}

/** Put the editor in block `id` by clicking its static row. */
async function editBlock(id: string): Promise<void> {
  const row = $(`[data-testid="block-static"][data-block-id="${id}"]`)
  await row.waitForClickable({ timeout: ACTION_TIMEOUT })
  await row.click()
  await browser.waitUntil(
    () =>
      browser.execute(
        (blockId: string) =>
          document.activeElement
            ?.closest('[data-testid="block-editor"]')
            ?.getAttribute('data-block-id') === blockId,
        id,
      ),
    { timeout: ACTION_TIMEOUT, timeoutMsg: `the editor never opened in block ${id}` },
  )
}

/**
 * Wait until the rows of `expected`'s blocks show in that order and at those
 * levels. A row's level is the `aria-level` of its `<li>`
 * (SortableBlockWrapper, depth + 1); rows of other blocks are ignored.
 */
async function waitForOutline(expected: [string, number][], what: string): Promise<void> {
  const ids = expected.map(([id]) => id)
  const want = JSON.stringify(expected.map(([id, level]) => `${id}@${level}`))
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(
          (wanted: string[]) =>
            [...document.querySelectorAll('[data-testid="sortable-block"]')]
              .map((row) => ({
                id: row.getAttribute('data-block-id') ?? '',
                level: row.closest('li[aria-level]')?.getAttribute('aria-level') ?? null,
              }))
              .filter((row) => wanted.includes(row.id))
              .map((row) => `${row.id}@${row.level}`),
          ids,
        )
        return JSON.stringify(seen) === want
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: expected ${want}, saw ${JSON.stringify(seen)}`)
    })
}

/** Block `id`'s property chip holding `value`; chips render in its row, outside its text. */
function chipIn(id: string, value: string) {
  return $(`[data-testid="sortable-block"][data-block-id="${id}"]`).$(
    `[data-testid="property-chip"]*=${value}`,
  )
}

/** What the pairing test leaves for the property-and-move test. */
interface Paired {
  deviceId: string
  pageId: string
  appBlockId: string
  peerBlockId: string
}

describe('Agaric real-backend two-device sync (#5365)', () => {
  let peer: SyncPeer | undefined
  let paired: Paired | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it('cancelling a pairing and reopening it mints a new passphrase', async () => {
    await waitForAppReady()
    await openSyncSettings()
    const first = await openPairing()
    await cancelPairing()

    const second = await openPairing()
    expect(second).not.toBe(first)
    // What the dialog shows is the new session's, the one its QR carries.
    expect((await readPairingQr()).passphrase).toBe(second)
    await cancelPairing()
  })

  it('pairs with a second device and syncs one edit each way', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()

    // This device shows the code; the peer scans it.
    await openSyncSettings()
    const passphrase = await openPairing()
    const qr = await readPairingQr()
    expect(passphrase).toBe(qr.passphrase)
    const remote = await peer.pair(qr)
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })

    // App → peer: a block written here is in the peer's vault after its pull.
    await openNewPage()
    await typeMarkerVerified(APP_EDIT)
    await reopenSharedPage()
    const appBlock = blockStaticByMarker(APP_EDIT)
    await appBlock.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const appBlockId = await appBlock.getAttribute('data-block-id')
    if (appBlockId === null) throw new Error('the app block row carries no data-block-id')
    await peer.sync()
    const copy = await peer.getBlock(appBlockId)
    expect(copy.content).toBe(APP_EDIT)
    if (copy.parentId === null) throw new Error(`the peer holds ${copy.id} with no page`)

    // Peer → app: the peer writes on the same page, then the app dials it.
    const peerBlockId = await peer.createBlock(copy.parentId, PEER_EDIT)
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
    await peerRow(remote.deviceId)
      .$(`span=${remote.address}`)
      .waitForDisplayed({ timeout: NAV_TIMEOUT })
    await clickSyncNow(remote.deviceId)
    await peer.waitPulled()

    await reopenSharedPage()
    await blockStaticByMarker(PEER_EDIT).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await blockStaticByMarker(APP_EDIT).waitForDisplayed({ timeout: NAV_TIMEOUT })
    paired = { deviceId: remote.deviceId, pageId: copy.parentId, appBlockId, peerBlockId }
  })

  it('syncs a property and a move each way', async () => {
    if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
    const { deviceId, pageId, appBlockId, peerBlockId } = paired
    await reopenSharedPage()
    await waitForOutline(
      [
        [appBlockId, 1],
        [peerBlockId, 1],
      ],
      'the shared page does not open as the pairing test left it',
    )

    // App → peer: Tab nests the peer's block under the app's, and a new block
    // below it whose only text is a property line stores it as the property.
    await editBlock(peerBlockId)
    await browser.keys(['Tab'])
    await waitForOutline(
      [
        [appBlockId, 1],
        [peerBlockId, 2],
      ],
      'Tab did not nest the block',
    )
    const propBlockId = await enterBlankSibling()
    await typeMarkerVerified(`${KEY}:: ${APP_VALUE}`)
    await browser.keys(['Escape'])
    await chipIn(propBlockId, APP_VALUE).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await reopenSharedPage()
    await waitForOutline(
      [
        [appBlockId, 1],
        [peerBlockId, 2],
        [propBlockId, 2],
      ],
      'the re-opened page lost the indent or the new block',
    )
    await chipIn(propBlockId, APP_VALUE).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await peer.sync()
    expect((await peer.getBlock(peerBlockId)).parentId).toBe(appBlockId)
    expect(await peer.getProperty(propBlockId, KEY)).toBe(APP_VALUE)

    // Peer → app: the peer sets a property on the app's block and moves its
    // own block back out, to the top of the page.
    await peer.setProperty(appBlockId, KEY, PEER_VALUE)
    await peer.moveBlock(peerBlockId, pageId, 0)
    await openSyncSettings()
    await clickSyncNow(deviceId)
    await peer.waitPulled()

    await reopenSharedPage()
    await waitForOutline(
      [
        [peerBlockId, 1],
        [appBlockId, 1],
        [propBlockId, 2],
      ],
      "the app does not show the peer's move",
    )
    await chipIn(appBlockId, PEER_VALUE).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })
})
