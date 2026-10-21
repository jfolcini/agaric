// ---------------------------------------------------------------------------
// Real-backend two-device sync (#5365).
//
// The app pairs with a second device through its own pairing dialog, and one
// edit crosses in each direction, then a property and a move, then two
// concurrent edits to one block, then an image each way, then a sync cancelled
// while the peer does not answer, and last an unpair.
// The second device is `e2e_sync_peer`, a headless vault on the app's sync daemon
// (sync-peer.ts). It reads the dialog's QR as a phone's camera would; the QR
// carries the address that mDNS, which a CI runner cannot be relied on for,
// would otherwise have to find.
//
// A session is a pull by the device that dials (#610), so the app has to dial
// the peer too. Paired by the peer's dial, the app holds no address for it
// until one is typed into the device list, as a user without mDNS would.
//
// The tests share one vault: each after the second works on the pairing and
// the page the second leaves. Unpair ends the pairing, so it runs last.
//
// An image's row and block arrive in a session's op phase, and its bytes in the
// file phase after it, so neither side's sync wait covers the bytes: each image
// test waits on the receiving side's `read_attachment` instead.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  enterBlankSibling,
  expectAbsent,
  expectImageRendered,
  navigateTo,
  openNewPage,
  pasteFileIntoFocusedBlock,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'
import {
  type SyncPeer,
  openPairing,
  openSyncSettings,
  peerRow,
  readPairingQr,
  setPeerAddress,
  startSyncPeer,
} from './sync-peer'

const APP_EDIT = runScopedMarker('wdio-sync-app-edit')
const PEER_EDIT = runScopedMarker('wdio-sync-remote-edit')
// A key no definition spells or folds to is a custom text property.
const KEY = 'wdiosync'
const APP_VALUE = runScopedMarker('wdio-sync-app-prop')
const PEER_VALUE = runScopedMarker('wdio-sync-remote-prop')
const APP_TAIL = runScopedMarker('wdio-sync-app-tail')
const PEER_HEAD = runScopedMarker('wdio-sync-remote-head')
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'
const BEFORE_PAUSE = runScopedMarker('wdio-sync-before-pause')
const AFTER_CANCEL = runScopedMarker('wdio-sync-after-cancel')
const APP_IMAGE = runScopedMarker('wdio-sync-app-image')
const PEER_IMAGE = runScopedMarker('wdio-sync-remote-image')
const FILENAME = 'wdio-sync-image.png'
// A 1x1 transparent PNG, and a 2x1 red and blue one. The peer's image must not
// be the app's: the peer would store bytes it already holds at the path of the
// copy it pulled, which the app holds too, and nothing would cross.
const APP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const PEER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR42mP4z8AAQv8BD/kD/Zh51wAAAAAASUVORK5CYII=',
  'base64',
)

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

/** Press the open device list's "Sync now" for `deviceId`. */
async function clickSyncNow(deviceId: string): Promise<void> {
  const syncNow = peerRow(deviceId).$('button[aria-label^="Sync now with device"]')
  await syncNow.waitForClickable({ timeout: ACTION_TIMEOUT })
  await syncNow.click()
}

/**
 * The device row of `deviceId` as one read: whether it shows a running session
 * (its progress or its Cancel), the sync state card's label, and the open toasts.
 */
function readSyncSurface(deviceId: string) {
  return browser.execute(
    (idPrefix: string) => {
      const row = [...document.querySelectorAll('.device-peer-item')].find((item) =>
        (item.textContent ?? '').includes(idPrefix),
      )
      return {
        rowFound: row !== undefined,
        sessionShown: row?.querySelector('.device-peer-progress, .device-cancel-sync-btn') != null,
        state: document.querySelector('.sync-state-label')?.textContent ?? '',
        toasts: [...document.querySelectorAll('[data-sonner-toast]')].map(
          (toast) => toast.textContent ?? '',
        ),
      }
    },
    deviceId.slice(0, 12),
  )
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

/**
 * Wait until block `id`'s static row reads exactly `text`. Read in one
 * `execute`: a row resolved by one command can be re-rendered away by a sync
 * before the next reads it.
 */
async function waitForStaticText(id: string, text: string, what: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(
          (blockId: string) =>
            document
              .querySelector(`[data-testid="block-static"][data-block-id="${blockId}"]`)
              ?.textContent?.trim() ?? '(no row)',
          id,
        )
        return seen === text
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}: expected ${JSON.stringify(text)}, saw ${JSON.stringify(seen)}`)
    })
}

/** Wait until the peer's copy of block `id` reads exactly `text`. */
async function waitForPeerText(device: SyncPeer, id: string, text: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = (await device.getBlock(id)).content
        return seen === text
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `the peer did not converge: expected ${JSON.stringify(text)}, saw ${JSON.stringify(seen)}`,
      )
    })
}

/** Wait until the peer's file for attachment `id` holds exactly `bytes`. */
async function waitForPeerBytes(device: SyncPeer, id: string, bytes: Buffer): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        try {
          const held = await device.readAttachment(id)
          seen = held.toString('base64')
          return held.equals(bytes)
        } catch (error) {
          seen = String(error)
          return false
        }
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`the peer does not hold the image's bytes: ${seen}`)
    })
}

/** Wait until the app's `read_attachment` serves attachment `id` as exactly `bytes`. */
async function waitForAppBytes(id: string, bytes: Buffer): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute(async (attachmentId: string) => {
          const internals = (
            window as unknown as {
              __TAURI_INTERNALS__: {
                invoke: (cmd: string, args: unknown) => Promise<ArrayBuffer>
              }
            }
          ).__TAURI_INTERNALS__
          try {
            const held = new Uint8Array(await internals.invoke('read_attachment', { attachmentId }))
            return btoa(String.fromCharCode(...held))
          } catch (error) {
            return JSON.stringify(error)
          }
        }, id)
        return seen === bytes.toString('base64')
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`the app does not hold the image's bytes: ${seen}`)
    })
}

/** Block `id`'s property chip holding `value`; chips render in its row, outside its text. */
function chipIn(id: string, value: string) {
  return $(`[data-testid="sortable-block"][data-block-id="${id}"]`).$(
    `[data-testid="property-chip"]*=${value}`,
  )
}

/** What the pairing test leaves for the tests after it. */
interface Paired {
  deviceId: string
  appDeviceId: string
  pageId: string
  appBlockId: string
  peerBlockId: string
}

describe('Agaric real-backend two-device sync (#5365) @sync', () => {
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
    await setPeerAddress(remote.deviceId, remote.address)

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
    paired = {
      deviceId: remote.deviceId,
      appDeviceId: qr.device_id,
      pageId: copy.parentId,
      appBlockId,
      peerBlockId,
    }
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

  it('converges concurrent edits to one block on both devices', async () => {
    if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
    const { deviceId, peerBlockId } = paired
    const appText = `${PEER_EDIT} ${APP_TAIL}`
    const merged = `${PEER_HEAD} ${appText}`

    // The app appends first. It can pull at any moment (useSyncTrigger runs
    // every 60 s), so its editor must close before the peer writes: a pull
    // under an open editor would save the stale text over the peer's edit.
    await reopenSharedPage()
    await editBlock(peerBlockId)
    await browser.keys(['Control', 'End'])
    // One key per call: WebKit coalesces identical adjacent keys sent together.
    for (const ch of ` ${APP_TAIL}`) {
      await browser.keys([ch])
      await browser.pause(40)
    }
    await browser.waitUntil(async () => (await $(EDITOR).getText()) === appText, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the appended text never landed intact in the editor; expected ${appText}`,
    })
    await browser.keys(['Escape'])

    // The peer prepends to the copy it holds, which must still lack the app's
    // edit: neither edit has seen the other. The peer dials unprompted only on
    // an mDNS sighting inside its pairing window.
    const held = (await peer.getBlock(peerBlockId)).content
    if (held !== PEER_EDIT) {
      throw new Error(
        `the peer pulled the app's edit before writing its own, so the edits were not concurrent: it holds ${JSON.stringify(held)}`,
      )
    }
    await peer.editBlock(peerBlockId, `${PEER_HEAD} ${PEER_EDIT}`)

    // Each pulls the other's edit, and the two splices merge into one text.
    await peer.sync()
    await waitForPeerText(peer, peerBlockId, merged)
    await openSyncSettings()
    await clickSyncNow(deviceId)
    await peer.waitPulled()
    await reopenSharedPage()
    await waitForStaticText(peerBlockId, merged, 'the app did not converge')
  })

  it('an image pasted in the app reaches the peer, bytes included', async () => {
    if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
    await reopenSharedPage()
    await editBlock(paired.peerBlockId)
    await enterBlankSibling()
    await typeMarkerVerified(APP_IMAGE)
    await pasteFileIntoFocusedBlock(APP_PNG.toString('base64'), FILENAME, 'image/png')
    await waitForToast(`Attached "${FILENAME}"`)
    await reopenSharedPage()
    const imageBlock = blockStaticByMarker(APP_IMAGE)
    await imageBlock.waitForDisplayed({ timeout: NAV_TIMEOUT })
    const imageBlockId = await imageBlock.getAttribute('data-block-id')
    if (imageBlockId === null) throw new Error('the image block row carries no data-block-id')

    await peer.sync()
    const attachments = await peer.listAttachments(imageBlockId)
    expect(attachments).toEqual([
      {
        id: expect.any(String),
        filename: FILENAME,
        mime_type: 'image/png',
        size_bytes: APP_PNG.length,
      },
    ])
    const [attachment] = attachments
    if (attachment === undefined) throw new Error('the peer holds no attachment row')
    expect((await peer.getBlock(imageBlockId)).content).toContain(`](attachment:${attachment.id})`)
    await waitForPeerBytes(peer, attachment.id, APP_PNG)
  })

  it('an image the peer attaches renders in the app from its bytes', async () => {
    if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
    const { deviceId, pageId } = paired
    // What a paste there writes: the attachment, then its ref in the block's text.
    const imageBlockId = await peer.createBlock(pageId, PEER_IMAGE)
    const attachmentId = await peer.addAttachment(imageBlockId, FILENAME, 'image/png', PEER_PNG)
    await peer.editBlock(imageBlockId, `${PEER_IMAGE}![${FILENAME}](attachment:${attachmentId})`)

    await openSyncSettings()
    await clickSyncNow(deviceId)
    await peer.waitPulled()
    await waitForAppBytes(attachmentId, PEER_PNG)
    await reopenSharedPage()
    await blockStaticByMarker(PEER_IMAGE).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectImageRendered(imageBlockId, "after the app's pull")
  })

  it('the Settings state card shows Idle, a last-sync time and one peer after the syncs', async () => {
    await openSyncSettings()
    // Read in one `execute`: the card re-renders as the sync store refreshes.
    const readCard = () =>
      browser.execute(() => {
        const text = (selector: string) => document.querySelector(selector)?.textContent ?? ''
        return {
          state: text('.sync-state-label'),
          peers: text('.sync-peer-count'),
          lastSynced: text('.sync-last-synced'),
        }
      })
    let seen = await readCard()
    await browser
      .waitUntil(
        async () => {
          seen = await readCard()
          return (
            seen.state === 'Idle' && seen.peers === '1' && /^just now$|ago$/.test(seen.lastSynced)
          )
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        throw new Error(
          `the state card did not settle on Idle, 1 peer and a time: ${JSON.stringify(seen)}`,
        )
      })
  })

  // #5739 — the peer freezes, so the app's dial gets no answer. Cancel must end
  // it at once and as idle: without the cancel the dial runs out its budget into
  // an uncoded failure, which sets the state card to Error and raises a "Sync
  // failed" toast in the same moment it clears the row.
  it('a sync cancelled while the peer does not answer ends idle, and the pair syncs after', async () => {
    if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
    const { deviceId, pageId } = paired

    // A pull first, so the daemon's own resync leaves this peer alone for a
    // minute: the one dial to the frozen peer is the one this test starts.
    await peer.createBlock(pageId, BEFORE_PAUSE)
    await openSyncSettings()
    await clickSyncNow(deviceId)
    await peer.waitPulled()

    peer.pause()
    try {
      await clickSyncNow(deviceId)
      const cancel = peerRow(deviceId).$('button[aria-label^="Cancel sync:"]')
      await cancel.waitForClickable({ timeout: ACTION_TIMEOUT })
      await cancel.click()

      let seen = await readSyncSurface(deviceId)
      await browser
        .waitUntil(
          async () => {
            seen = await readSyncSurface(deviceId)
            return seen.rowFound && !seen.sessionShown
          },
          { timeout: ACTION_TIMEOUT },
        )
        .catch(() => {
          throw new Error(`the row never left the cancelled sync: ${JSON.stringify(seen)}`)
        })
      seen = await readSyncSurface(deviceId)
      expect(seen.state).toBe('Idle')
      expect(seen.toasts.filter((toast) => toast.includes('Sync failed'))).toEqual([])
    } finally {
      peer.resume()
    }

    // The pair still works: the peer's next write reaches the app.
    await peer.createBlock(pageId, AFTER_CANCEL)
    await clickSyncNow(deviceId)
    await peer.waitPulled()
    await reopenSharedPage()
    await blockStaticByMarker(AFTER_CANCEL).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })

  it("unpairing refuses the peer's next sync and drops only this device's row", async () => {
    if (peer === undefined || paired === undefined) throw new Error('the pairing test failed')
    const { deviceId, appDeviceId } = paired
    await openSyncSettings()
    const unpair = peerRow(deviceId).$('button[aria-label^="Unpair device"]')
    await unpair.waitForClickable({ timeout: ACTION_TIMEOUT })
    await unpair.click()
    const confirm = $('[role="alertdialog"]').$('button=Yes, unpair')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()
    await $('[data-testid="device-no-peers"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })

    // The row is gone from the backend, read back after a round trip.
    await navigateTo('Journal')
    await openSyncSettings()
    await $('[data-testid="device-no-peers"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent('.device-peer-item', 'the unpaired device')

    // Unpairing sends nothing (`delete_peer_ref`), so the peer still holds the
    // pairing; the app's unpaired-device gate turns its next dial away.
    expect(await peer.syncRefused()).toBe('peer not paired with this device')
    expect(await peer.listPeers()).toEqual([appDeviceId])
  })
})
