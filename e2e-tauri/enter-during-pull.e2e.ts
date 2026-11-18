// ---------------------------------------------------------------------------
// A key typed right after Enter while a peer's edits are pulled in (#6814).
//
// A pull ends in `reloadChangedPageStores` (useSyncEvents.ts), which reloads
// the open page. A reload whose snapshot was read before an Enter's create,
// and answered after it, dropped the block Enter had just made, and the roving
// editor with it: the next key went to `<body>`. In #6559's measurement that
// happened while `e2e_sync_peer` rewrote its page and the app pulled; here the
// window is held open instead of hit by chance. The app's next read of the
// open page is answered late, its snapshot taken when it was asked for, and
// Enter is pressed while it is on its way.
//
// The pull is started by a script click on the sidebar's Sync button, which
// leaves the focus in the editor: a WebDriver click would take it.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
  caretToEnd,
  enterBlankSibling,
  navigateTo,
  reopenPageByTitle,
  reopenPageHolding,
  runScopedMarker,
  typeMarkerVerified,
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

const TITLE = 'peer pulled page'
const KEPT = runScopedMarker('wdio-pull-kept')
const PEER_BEFORE = runScopedMarker('wdio-pull-before')
const PEER_AFTER = runScopedMarker('wdio-pull-after')
const TYPED = runScopedMarker('wdio-pull-typed')
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'
/** Longer than an Enter's create takes to answer, so the snapshot lands after it. */
const LATE_MS = 3_000

/** Whether the sidebar's Sync button takes a click: it is `aria-disabled` while a sync runs. */
async function syncIdle(): Promise<boolean> {
  return (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false'
}

/** Press Sync without moving the focus, once the sync running has ended. */
async function pressSyncKeepingFocus(): Promise<void> {
  await browser.waitUntil(syncIdle, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'the app never finished the sync it was running',
  })
  await browser.execute(
    (sel: string) => document.querySelector<HTMLElement>(sel)?.click(),
    SYNC_BUTTON,
  )
}

/**
 * Answer the app's next `load_page_subtree` of `pageId` LATE_MS late, with the
 * snapshot the backend read when it was asked. `window.__lateRead` says when
 * it was asked and when it answered.
 */
async function answerNextReadLate(pageId: string): Promise<void> {
  await browser.execute(
    (id: string, lateMs: number) => {
      type Invoke = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>
      const w = window as unknown as {
        __TAURI_INTERNALS__: { invoke: Invoke }
        __lateRead: { asked: boolean; answered: boolean }
      }
      const internals = w.__TAURI_INTERNALS__
      const original = internals.invoke
      const state = { asked: false, answered: false }
      w.__lateRead = state
      internals.invoke = (cmd, args, options) => {
        const root = (args as { rootBlockId?: string } | undefined)?.rootBlockId
        if (cmd !== 'load_page_subtree' || root !== id) return original(cmd, args, options)
        internals.invoke = original
        state.asked = true
        const snapshot = original(cmd, args, options)
        return new Promise((resolve) => setTimeout(resolve, lateMs))
          .then(() => snapshot)
          .finally(() => {
            state.answered = true
          })
      }
    },
    pageId,
    LATE_MS,
  )
}

const lateRead = (key: 'asked' | 'answered') =>
  browser.execute(
    (k: string) =>
      (window as unknown as { __lateRead?: Record<string, boolean> }).__lateRead?.[k] === true,
    key,
  )

describe('Agaric real-backend key typed after Enter while a pull reloads the page (#6814) @sync @editor', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it('lands the key in the block Enter made while the pulled page is read again', async () => {
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

    const pageId = await peer.createInSpace('page', TITLE)
    await peer.createBlock(pageId, KEPT)
    const edited = await peer.createBlock(pageId, PEER_BEFORE)
    // The seed's arrival is not under test: remount the page between pulls.
    await navigateTo('Journal')
    await browser.waitUntil(
      async () => {
        await pressSyncKeepingFocus()
        await peer?.waitPulled()
        await navigateTo('Journal')
        await navigateTo('Pages')
        const listed = $(
          `.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${TITLE}"]`,
        )
        if (!(await listed.isExisting())) return false
        await reopenPageByTitle(TITLE)
        return blockStaticByMarker(KEPT).isExisting()
      },
      {
        timeout: NAV_TIMEOUT,
        interval: 1_000,
        timeoutMsg: "the peer's page never reached the app",
      },
    )

    await blockStaticByMarker(KEPT).click()
    await caretToEnd()
    await answerNextReadLate(pageId)
    await peer.editBlock(edited, PEER_AFTER)
    await browser.waitUntil(
      async () => {
        if (await lateRead('asked')) return true
        if (await syncIdle()) await pressSyncKeepingFocus()
        return false
      },
      {
        timeout: NAV_TIMEOUT,
        interval: 1_000,
        timeoutMsg: 'no pull ever read the open page again',
      },
    )

    await enterBlankSibling()
    await browser.waitUntil(() => lateRead('answered'), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the late read never answered',
    })
    await blockStaticByMarker(PEER_AFTER).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    const focus = await browser.execute(() => {
      const el = document.activeElement
      return el?.closest('[data-testid="block-editor"]') ? 'editor' : (el?.tagName ?? 'none')
    })
    expect(focus).toBe('editor')
    await typeMarkerVerified(TYPED)
    await browser.keys(['Escape'])

    await reopenPageHolding(TITLE, TYPED)
    const order = await browser.execute(() =>
      [...document.querySelectorAll('[data-testid="block-static"]')].map(
        (el) => el.textContent ?? '',
      ),
    )
    const kept = order.findIndex((text) => text.includes(KEPT))
    expect(order[kept + 1]).toContain(TYPED)
  })
})
