// ---------------------------------------------------------------------------
// Real-backend: property definitions sync between devices, and a definition
// change can be undone from its toast (#5841 S1).
//
// The app holds a value under a key no definition declares, so it is stored as
// text: today's date, on a page of its own (the journal's Due panel leaves out
// the day's own blocks). The peer (`e2e_sync_peer`, sync-peer.ts) then declares
// the key a `date` in the Personal space, which both vaults share, and the app
// pulls. Settings › Properties then lists the definition as `date`, where it
// listed none before, and the held value, re-read under the new type, is a
// date: today's Due panel lists the block. The last test deletes a definition
// in Settings › Properties and presses Undo on the toast; after a round-trip
// the definition is listed again.
//
// The value is set through the real IPC: the setup is not under test.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  expectAbsent,
  invoke,
  navigateTo,
  openSettingsTab,
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

/** Declared by the peer as a date, held by the app as text first. */
const SYNCED_KEY = runScopedMarker('wdio-due')
/** Declared on the app, deleted and brought back by the toast's Undo. */
const UNDONE_KEY = runScopedMarker('wdio-undo')
const PAGE = runScopedMarker('wdio-defs-page')
const HOLDER = runScopedMarker('wdio-defs-holder')
const DUE_PANEL = '[data-testid="due-panel"]'
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'

/** The Delete button of `key`'s row in Settings › Properties. */
const deleteButton = (key: string) => `button[aria-label="Delete property ${key}"]`

/** The value type badge of `key`'s row in Settings › Properties, or null when it is not listed. */
function listedType(key: string): Promise<string | null> {
  return browser.execute((selector: string) => {
    const row = document.querySelector(selector)?.closest('[data-slot="list-item"]')
    return row?.querySelector('[data-slot="badge"]')?.textContent ?? null
  }, deleteButton(key))
}

/**
 * Write on the peer, then pull it into the app with the sidebar's Sync, which
 * leaves the open view mounted, and wait for the pull. The button is
 * `aria-disabled` while a sync runs.
 */
async function pullPeerWrites(peer: SyncPeer, writes: () => Promise<void>): Promise<void> {
  await writes()
  await browser.waitUntil(
    async () => (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false',
    { timeout: ACTION_TIMEOUT, timeoutMsg: 'the app never finished the sync it was running' },
  )
  await $(SYNC_BUTTON).click()
  await peer.waitPulled()
}

/** Settings › Properties, opened from another view so it lists afresh. */
async function reopenProperties(): Promise<void> {
  await navigateTo('Pages')
  await openSettingsTab('properties')
}

/** The DOM text of `selector`, or '' when it is not rendered. */
function textOf(selector: string): Promise<string> {
  return browser.execute((sel: string) => document.querySelector(sel)?.textContent ?? '', selector)
}

/** Today's daily journal, where the Due panel mounts, opened from another view. */
async function openTodaysJournal(): Promise<void> {
  await navigateTo('Pages')
  await navigateTo('Journal')
  const tab = $('#journal-tab-daily')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await browser.waitUntil(async () => (await tab.getAttribute('aria-selected')) === 'true', {
    timeout: NAV_TIMEOUT,
    timeoutMsg: 'the daily journal tab never became selected',
  })
}

/** The local `YYYY-MM-DD` of today, as the app's views compute it. */
function today(): Promise<string> {
  return browser.execute(() => {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })
}

describe('Agaric real-backend property definitions sync (#5841) @settings @sync', () => {
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

  it("lists the peer's definition, and reads the value the app held as a date", async () => {
    const device = pairedPeer()
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')?.id
    if (personal === undefined) throw new Error('no Personal space')
    const page = await invoke<string>('create_page_in_space', {
      parentId: null,
      content: PAGE,
      spaceId: personal,
    })
    const holder = await invoke<{ id: string }>('create_block', {
      blockType: 'content',
      content: HOLDER,
      parentId: page,
      index: null,
      scope: { kind: 'active', space_id: personal },
      blockId: null,
    })
    await invoke('set_property', {
      blockId: holder.id,
      key: SYNCED_KEY,
      value: { value_text: await today() },
    })

    await reopenProperties()
    await expectAbsent(deleteButton(SYNCED_KEY), 'a definition before the peer declared one')

    await pullPeerWrites(device, () => device.createPropertyDef(SYNCED_KEY, 'date'))

    let seen: string | null = null
    await browser
      .waitUntil(
        async () => {
          await reopenProperties()
          seen = await listedType(SYNCED_KEY)
          return seen === 'date'
        },
        { timeout: NAV_TIMEOUT, interval: 2_000 },
      )
      .catch(() => {
        throw new Error(`Settings › Properties lists ${SYNCED_KEY} as ${String(seen)}, not date`)
      })
    await browser.waitUntil(
      async () => {
        await openTodaysJournal()
        return (await textOf(DUE_PANEL)).includes(HOLDER)
      },
      {
        timeout: NAV_TIMEOUT,
        interval: 2_000,
        timeoutMsg: "today's Due panel never listed the block holding the now-date value",
      },
    )
  })

  it('brings a deleted definition back with Undo on its toast', async () => {
    const spaces = await invoke<Array<{ id: string; name: string }>>('list_spaces')
    const personal = spaces.find((space) => space.name === 'Personal')?.id
    await invoke('create_property_def', {
      spaceId: personal,
      key: UNDONE_KEY,
      valueType: 'text',
      options: null,
    })
    await reopenProperties()
    const remove = $(deleteButton(UNDONE_KEY))
    await remove.waitForClickable({ timeout: NAV_TIMEOUT })
    await remove.click()
    const confirm = $('[role="alertdialog"]').$('button=Delete')
    await confirm.waitForClickable({ timeout: ACTION_TIMEOUT })
    await confirm.click()
    // The toast says the backend deleted it; Undo before the toast times out.
    await waitForToast('Property definition deleted')
    const undo = $(
      '//*[@data-sonner-toast][contains(., "Property definition deleted")]//button[normalize-space()="Undo"]',
    )
    await undo.waitForClickable({ timeout: ACTION_TIMEOUT })
    await undo.click()

    await reopenProperties()
    await $(deleteButton(UNDONE_KEY)).waitForExist({ timeout: NAV_TIMEOUT })
    expect(await listedType(UNDONE_KEY)).toBe('text')
  })
})
