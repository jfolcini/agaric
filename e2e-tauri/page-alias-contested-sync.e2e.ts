// ---------------------------------------------------------------------------
// Real-backend: an alias two devices gave to different pages moves to the
// other page when the page holding it drops it (#6229).
//
// The app gives its page an alias. The peer (`e2e_sync_peer`, sync-peer.ts),
// which has not pulled that page, gives its own, newer page the same alias and
// then renames the page, and the app pulls. Seeing the new title proves the
// claim before it arrived too. Both claims are now in the Personal space's
// doc, and the older page, the app's, holds the alias (#5387). The user removes
// the alias from the app's page in its header; after a round-trip the peer's
// page shows it. Before #6229 neither page held it.
//
// The pages and the alias on the app's page are written through the real IPC:
// the setup is not under test.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  aliasBadge,
  clickUncovered,
  expectAbsent,
  invoke,
  navigateTo,
  openPageTitled,
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

const ALIAS = runScopedMarker('wdio-contested-alias')
/** The app's page, the older one, which holds the alias first. */
const HOLDER = runScopedMarker('wdio-alias-holder')
/** The peer's page, before and after the rename that follows its claim. */
const CLAIMANT_DRAFT = runScopedMarker('wdio-alias-draft')
const CLAIMANT = runScopedMarker('wdio-alias-claimant')
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'

async function syncIdle(): Promise<boolean> {
  return (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false'
}

describe('Agaric real-backend contested alias handoff (#6229) @pages @sync', () => {
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

  it("gives the alias to the peer's page once the app's page drops it", async () => {
    const device = pairedPeer()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')?.id
    if (personal === undefined) throw new Error('no Personal space')
    // The app writes first: it pulls on its own every minute, and a claim it
    // pulled before its own write would refuse that write.
    const holder = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: HOLDER,
      spaceId: personal,
    })
    await invoke('set_page_aliases', { pageId: holder, aliases: [ALIAS] })
    const claimant = await device.createInSpace('page', CLAIMANT_DRAFT)
    expect(await device.setPageAliases(claimant, [ALIAS])).toEqual([ALIAS])
    await device.editBlock(claimant, CLAIMANT)
    await browser.waitUntil(syncIdle, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the app never finished the sync it was running',
    })
    await $(SYNC_BUTTON).click()
    await device.waitPulled()
    await browser.waitUntil(
      async () => {
        await navigateTo('Pages')
        if (await pageEntryTitled(CLAIMANT).isExisting()) return true
        if (await syncIdle()) await $(SYNC_BUTTON).click()
        return false
      },
      {
        timeout: NAV_TIMEOUT,
        interval: 1_000,
        timeoutMsg: "the peer's renamed page never arrived",
      },
    )
    expect({
      holder: await invoke<string[]>('get_page_aliases', { pageId: holder }),
      claimant: await invoke<string[]>('get_page_aliases', { pageId: claimant }),
    }).toEqual({ holder: [ALIAS], claimant: [] })

    await openPageTitled(HOLDER)
    const kebab = $('button[aria-label="Page actions"]')
    await kebab.waitForClickable({ timeout: ACTION_TIMEOUT })
    await kebab.click()
    await clickUncovered($('[role="menuitem"]*=Add alias'), 'Add alias')
    const remove = $(`button[aria-label="Remove alias ${ALIAS}"]`)
    await remove.waitForClickable({ timeout: ACTION_TIMEOUT })
    await remove.click()
    await expectAbsent(aliasBadge(ALIAS), "the removed alias, on the app's page")
    const done = $('button=Done')
    await done.waitForClickable({ timeout: ACTION_TIMEOUT })
    await done.click()
    await browser.waitUntil(
      async () => (await invoke<string[]>('get_page_aliases', { pageId: holder })).length === 0,
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the removal never reached the backend' },
    )

    // The durable read: the peer's page, opened from the Pages view, loads
    // the aliases the backend holds.
    await navigateTo('Journal')
    await openPageTitled(CLAIMANT)
    await $(aliasBadge(ALIAS)).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: "the peer's page never showed the alias the app's page dropped",
    })
  })
})
