// ---------------------------------------------------------------------------
// Real-backend smoke test of the Loro wire framing (#5761).
//
// Every `LoroSync` travels as a header frame and then its raw bytes. This spec
// runs that framing in the real app: the peer (`e2e_sync_peer`, sync-peer.ts)
// writes a page of 16 blocks, the app pairs with it and pulls, and every block's
// text comes back whole from the app's backend. It is not the control for
// #5761: a payload this size fits the old JSON frame too. The control, a
// snapshot past 64 MiB of Loro state over real QUIC, is
// `a_snapshot_past_the_old_frame_cap_syncs_over_quic_5761` in agaric-sync's
// `sync_daemon/tests.rs`.
//
// Each block holds 20,000 characters. Loro's import of text written
// concurrently with the receiver's own ops grows with the square of a block's
// length, and the app's debug build pays it: 200,000-character blocks outlast
// the pull's wait.
//
// The text is read back through the real IPC (`get_block`), a re-query of the
// backend: the page's off-screen rows render as placeholders, not text. The pull
// is started from the sidebar's Sync button, as in sync-cross-space-move.e2e.ts.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  navigateTo,
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

const TITLE = runScopedMarker('wdio-raw-loro-bytes-page')
const BLOCKS = 16
const BLOCK_CHARS = 20_000
const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

interface Internals {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
}

/** `length` alphanumerics from an LCG seeded with `seed`: plain text to the renderer. */
function filler(seed: number, length: number): string {
  let x = seed
  let text = ''
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0
    text += ALNUM[(x >>> 24) % ALNUM.length]
  }
  return text
}

/** The content the app's backend serves for each of `ids`, in order. */
function backendContents(ids: string[]): Promise<string[]> {
  return browser.execute(async (wanted: string[]) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__
    const rows = await Promise.all(
      wanted.map(async (blockId) => {
        try {
          return ((await invoke('get_block', { blockId })) as { content: string | null }).content
        } catch {
          return null
        }
      }),
    )
    return rows.map((content) => content ?? '')
  }, ids)
}

/** Whether the Pages list, opened afresh, lists `title`. */
async function pagesListHolds(title: string): Promise<boolean> {
  await navigateTo('Journal')
  await navigateTo('Pages')
  return $(
    `.//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`,
  ).isExisting()
}

describe('Agaric real-backend sync of Loro bytes sent raw after a header frame (#5761)', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it("pairs, pulls the peer's page, and serves every block back whole", async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()

    const pageId = await peer.createInSpace('page', TITLE)
    const blocks: { id: string; content: string }[] = []
    for (let i = 0; i < BLOCKS; i++) {
      const content = filler(i + 1, BLOCK_CHARS)
      blocks.push({ id: await peer.createBlock(pageId, content), content })
    }

    await openSyncSettings()
    await openPairing()
    const remote = await peer.pair(await readPairingQr())
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })
    await setPeerAddress(remote.deviceId, remote.address)

    // A session is a pull by the device that dials (#610): the app pulls.
    await browser.waitUntil(
      async () => (await $(SYNC_BUTTON).getAttribute('aria-disabled')) === 'false',
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the app never finished the sync it was running' },
    )
    await $(SYNC_BUTTON).click()
    await peer.waitPulled()

    await browser.waitUntil(() => pagesListHolds(TITLE), {
      timeout: NAV_TIMEOUT,
      interval: 2_000,
      timeoutMsg: `the page ${TITLE} never reached the app's Pages list`,
    })
    const ids = blocks.map((block) => block.id)
    let served: string[] = []
    await browser
      .waitUntil(
        async () => {
          served = await backendContents(ids)
          return served.every((content, i) => content === blocks[i]?.content)
        },
        { timeout: NAV_TIMEOUT },
      )
      .catch(() => {
        const lengths = JSON.stringify(served.map((content) => content.length))
        throw new Error(
          `the app serves ${lengths} characters for the blocks; the peer wrote ${BLOCK_CHARS} each`,
        )
      })
  })
})
