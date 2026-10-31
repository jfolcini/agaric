// ---------------------------------------------------------------------------
// Real-backend: a ref property arrives with the block it points at (#6232).
//
// The app declares `wdiolink` a ref in the Personal space, which both vaults
// share. The peer (`e2e_sync_peer`, sync-peer.ts) then writes a page, a block
// under it, and the page's `wdiolink` holding the block's id, and the app
// pulls all three in one import, which types the value a ref by the app's
// definition. The import projects the page before its child, and a ref whose
// target had no row yet was dropped, so the page showed no property. The page
// must list `wdiolink` in its property table, and the backend hold it as a ref
// to the block.
//
// The definition is set through the real IPC: the setup is not under test.
// The peer writes the value as text, which only an undeclared key takes there.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  navigateTo,
  pageEntryTitled,
  reopenPageByTitle,
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

const KEY = 'wdiolink'
const PAGE = runScopedMarker('wdio-ref-page')
const CHILD = runScopedMarker('wdio-ref-child')
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'

describe('Agaric real-backend ref to a block the same pull brings (#6232) @sync @editor', () => {
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

  it("shows a new page's ref to its new child after one pull", async () => {
    const device = pairedPeer()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')?.id
    if (personal === undefined) throw new Error('no Personal space')
    await invoke('create_property_def', {
      spaceId: personal,
      key: KEY,
      valueType: 'ref',
      options: null,
    })

    const page = await device.createInSpace('page', PAGE)
    const child = await device.createBlock(page, CHILD)
    await device.setProperty(page, KEY, child)
    // The button is `aria-disabled` while a sync runs.
    await browser.waitUntil(
      async () => (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false',
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the app never finished the sync it was running' },
    )
    await $(SYNC_BUTTON).click()
    await device.waitPulled()

    await browser.waitUntil(
      async () => {
        await navigateTo('Journal')
        await navigateTo('Pages')
        return pageEntryTitled(PAGE).isExisting()
      },
      {
        timeout: NAV_TIMEOUT,
        interval: 2_000,
        timeoutMsg: `the page ${PAGE} never reached the app`,
      },
    )
    await reopenPageByTitle(PAGE)
    const header = $('.page-property-table-header')
    await header.waitForClickable({
      timeout: NAV_TIMEOUT,
      timeoutMsg: `the page ${PAGE} shows no property table`,
    })
    await header.click()
    await $(`button[aria-label="${KEY} value"]`).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `the page ${PAGE} lists no ${KEY}`,
    })
    const rows = await invoke<Array<{ key: string; value_ref: string | null }>>('get_properties', {
      blockId: page,
    })
    expect(rows.find((row) => row.key === KEY)?.value_ref).toBe(child)
  })
})
