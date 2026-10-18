// ---------------------------------------------------------------------------
// Real-backend: a page another device moves to another space keeps what the
// app holds on it, whichever space's doc a pull imports first (#5712).
//
// The peer (`e2e_sync_peer`, sync-peer.ts) makes two spaces. In each, a page
// that will move, and a referrer page whose block links to it; the app gives
// that block a ref property pointing at the page and opens the page, which
// writes its "Last opened" entry (`page_opens`, device-local). The peer then
// moves each page to the other space, and back, and the app pulls after each
// round. A pull carries both spaces' docs in the responder's `HashMap` order,
// and each round moves one page each way, so every pull imports one page's
// old doc before its new one: the order in which, before the session-end
// sweep, the import deleted the page's rows, and with them the rows that no
// doc brings back (the open, the link, the ref).
//
// Each page ends in its referrer's space, where the Pages list shows both
// facts the app must still hold: sorted by Last opened, the opened page comes
// before its never-opened (and newer) referrer, and carries the referrer's
// link as its `1 ↗` inbound count. The referrer's other block holds the ref,
// which shows only in its property drawer: a ref-only property has no inline
// chip (`useExtraBlockProperties`).
//
// The ref property is set through the real IPC: the setup is not under test,
// and the app needs the `related` definition as a ref to store the value as
// one.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  chooseSelectOption,
  navigateTo,
  reopenPageByTitle,
  runScopedMarker,
  switchToSpace,
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

const ALPHA = runScopedMarker('wdio-alpha-space')
const BETA = runScopedMarker('wdio-beta-space')
/** Starts in Beta, ends in Beta after a round in Alpha. */
const MOVER_ONE = runScopedMarker('wdio-mover-one')
/** Starts in Alpha, ends in Alpha after a round in Beta. */
const MOVER_TWO = runScopedMarker('wdio-mover-two')
const REFERRER_ONE = runScopedMarker('wdio-referrer-one')
const REFERRER_TWO = runScopedMarker('wdio-referrer-two')
/** The referrers' blocks that hold the ref; plain text, so a click opens the editor. */
const REF_NOTE_ONE = runScopedMarker('wdio-ref-note-one')
const REF_NOTE_TWO = runScopedMarker('wdio-ref-note-two')

const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'
const EDITOR = '[data-testid="block-editor"] [contenteditable="true"]'

interface Internals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
}

async function invoke(cmd: string, args: unknown): Promise<void> {
  await browser.execute(
    (c: string, a: unknown) =>
      (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  )
}

/** Whether the sidebar's Sync button takes a click: it is `aria-disabled` while a sync runs. */
async function syncIdle(): Promise<boolean> {
  return (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false'
}

/** Write on the peer, then pull it with the sidebar's Sync and wait for the pull. */
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

interface ListedPage {
  title: string
  inbound: string
}

/** The Pages list's rows in order: title and the `N ↗` inbound count (PageRow.tsx). */
function listedPages(): Promise<ListedPage[]> {
  return browser.execute(() => {
    const rows = [...document.querySelectorAll('[data-page-item]')]
    rows.sort((a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')))
    return rows.map((row) => ({
      title: row.querySelector('.page-browser-item-title')?.getAttribute('title') ?? '',
      inbound: row.querySelector('[data-metadata-inbound] [aria-hidden="true"]')?.textContent ?? '',
    }))
  })
}

/** Wait until the Pages list of `space` holds `holds`, re-opening it between reads. */
async function waitForPagesList(
  space: string,
  holds: (pages: ListedPage[]) => boolean,
  what: string,
): Promise<void> {
  let seen: ListedPage[] = []
  await switchToSpace(space)
  await browser
    .waitUntil(
      async () => {
        await navigateTo('Pages')
        await chooseSelectOption('[aria-label="Sort order"]', 'Last opened')
        seen = await listedPages()
        if (holds(seen)) return true
        await navigateTo('Journal')
        return false
      },
      { timeout: NAV_TIMEOUT, interval: 2_000 },
    )
    .catch(() => {
      throw new Error(`${what}: the ${space} Pages list reads ${JSON.stringify(seen)}`)
    })
}

/** The page of `space` titled `title`, opened from the Pages list (which records the open). */
async function openPage(space: string, title: string): Promise<void> {
  await waitForPagesList(
    space,
    (pages) => pages.some((page) => page.title === title),
    `the page ${title} never reached the app`,
  )
  await reopenPageByTitle(title)
}

describe('Agaric real-backend cross-space moves keep what the app holds (#5712) @sync @spaces', () => {
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

  it('keeps the open, the link and the ref of pages moved both ways in one pull, twice', async () => {
    const device = pairedPeer()
    const ids = await pullPeerWrites(device, async () => {
      const alpha = await device.createSpace(ALPHA)
      const beta = await device.createSpace(BETA)
      // Each page gets a block of its own, so opening it here writes nothing
      // into it; each referrer is newer than its page.
      const page = async (title: string, space: string) => {
        const id = await device.createInSpace('page', title, space)
        await device.createBlock(id, `${title} body`)
        return id
      }
      const moverOne = await page(MOVER_ONE, beta)
      const moverTwo = await page(MOVER_TWO, alpha)
      const referrerOne = await device.createInSpace('page', REFERRER_ONE, beta)
      const referrerTwo = await device.createInSpace('page', REFERRER_TWO, alpha)
      await device.createBlock(referrerOne, `see [[${moverOne}]]`)
      await device.createBlock(referrerTwo, `see [[${moverTwo}]]`)
      return {
        alpha,
        beta,
        moverOne,
        moverTwo,
        noteOne: await device.createBlock(referrerOne, REF_NOTE_ONE),
        noteTwo: await device.createBlock(referrerTwo, REF_NOTE_TWO),
      }
    })

    await openPage(BETA, MOVER_ONE)
    await openPage(ALPHA, MOVER_TWO)
    await invoke('create_property_def', { key: 'related', valueType: 'ref', options: null })
    for (const [note, target] of [
      [ids.noteOne, ids.moverOne],
      [ids.noteTwo, ids.moverTwo],
    ] as const) {
      await invoke('set_property', { blockId: note, key: 'related', value: { value_ref: target } })
    }

    await pullPeerWrites(device, async () => {
      await device.moveToSpace(ids.moverOne, ids.alpha)
      await device.moveToSpace(ids.moverTwo, ids.beta)
    })
    await pullPeerWrites(device, async () => {
      await device.moveToSpace(ids.moverOne, ids.beta)
      await device.moveToSpace(ids.moverTwo, ids.alpha)
    })

    for (const [space, mover, referrer, refNote] of [
      [BETA, MOVER_ONE, REFERRER_ONE, REF_NOTE_ONE],
      [ALPHA, MOVER_TWO, REFERRER_TWO, REF_NOTE_TWO],
    ] as const) {
      await waitForPagesList(
        space,
        (pages) =>
          pages[0]?.title === mover && pages[0].inbound === '1 ↗' && pages[1]?.title === referrer,
        `${mover} is not listed first, last opened and linked once, ahead of ${referrer}`,
      )
      await reopenPageByTitle(referrer)
      await blockStaticByMarker(refNote).waitForClickable({ timeout: NAV_TIMEOUT })
      await blockStaticByMarker(refNote).click()
      await $(EDITOR).waitForDisplayed({ timeout: ACTION_TIMEOUT })
      await browser.keys(['Control', 'Shift', 'p'])
      await browser.waitUntil(
        async () => {
          const buttons = await browser.execute(() =>
            [...document.querySelectorAll('[role="dialog"] button')].map(
              (button) => button.textContent ?? '',
            ),
          )
          return buttons.includes(mover)
        },
        {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: `${referrer}'s property drawer shows no ref to ${mover}`,
        },
      )
      await browser.keys(['Escape'])
      await $('[role="dialog"]').waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
    }
  })
})
