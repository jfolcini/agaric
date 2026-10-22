// ---------------------------------------------------------------------------
// Real-backend sync of a large vault to a fresh device (#5739).
//
// The peer (sync-peer.ts) seeds a vault whose op log spans several
// `OpLogBatch` messages, a fresh app pairs with it and pulls it, and the app
// must then hold every page and block the peer wrote. A fresh device takes the
// ordinary pull: one `LoroSync` per space carries the pages and blocks, and the
// op log follows in batches of `OP_LOG_BATCH_INLINE_MAX_BYTES`
// (`agaric-sync/src/sync_constants.rs`). Those batches are audit records the
// app never applies, so the counts cannot see a dropped one; the history of
// the last block written, whose op rides the last batch, can.
//
// The counts are the Pages view's own: its count of pages and each page row's
// count of blocks.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  invoke,
  navigateTo,
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

const MARKER = runScopedMarker('wdio-large-vault')
// Large in bytes rather than rows: each block holds a few kilobytes, so the op
// log spans at least `MIN_OP_BATCHES` batches while the peer's seeding and the
// app's indexing, both paid per block, stay short. `seedVault` reports the real
// number of batches.
const PAGES = 10
const BLOCKS_PER_PAGE = 100
const PADDING = 7_000
const MIN_OP_BATCHES = 3

const SYNC_BUTTON = '[data-slot="sidebar"] button[aria-label="Sync"]'

interface PagesView {
  /** The count beside the Pages section's heading. */
  pages: number
  /** The seeded pages listed, and the sum of their rows' block counts. */
  seededRows: number
  blocks: number
}

/**
 * Wait until the Pages view shows `expected`, leaving the view and coming back
 * between reads. Read in one `execute`: the rows re-render as caches refresh.
 */
async function waitForPagesView(expected: PagesView): Promise<void> {
  let seen: PagesView | undefined
  await browser
    .waitUntil(
      async () => {
        await navigateTo('Tags')
        await navigateTo('Pages')
        seen = await browser.execute((prefix: string) => {
          const count = (element: Element | null | undefined) => Number(element?.textContent ?? 0)
          const rows = [...document.querySelectorAll('.page-browser-item')].filter((row) =>
            row.querySelector('.page-browser-item-title')?.textContent?.startsWith(prefix),
          )
          return {
            pages: count(
              document.querySelector('[data-page-section="pages"] [role="gridcell"] > :last-child'),
            ),
            seededRows: rows.length,
            blocks: rows.reduce(
              (sum, row) =>
                sum + count(row.querySelector('[data-metadata-children] [aria-hidden="true"]')),
              0,
            ),
          }
        }, `${MARKER} page `)
        return JSON.stringify(seen) === JSON.stringify(expected)
      },
      { timeout: NAV_TIMEOUT, interval: 1_000 },
    )
    .catch(() => {
      throw new Error(
        `the Pages view shows ${JSON.stringify(seen)}, not the peer's ${JSON.stringify(expected)}`,
      )
    })
}

/**
 * Wait until block `id`'s row reads `text`. Scrolled to first: an off-screen
 * row renders as a placeholder without its text.
 */
async function waitForRowText(id: string, text: string): Promise<void> {
  let seen = ''
  await browser
    .waitUntil(
      async () => {
        seen = await browser.execute((blockId: string) => {
          document
            .querySelector(`li[data-block-id="${blockId}"]`)
            ?.scrollIntoView({ block: 'center' })
          return (
            document
              .querySelector(`[data-testid="block-static"][data-block-id="${blockId}"]`)
              ?.textContent?.trim() ?? '(no row)'
          )
        }, id)
        return seen === text
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `block ${id} reads ${JSON.stringify(seen.slice(0, 80))}…, not the peer's text`,
      )
    })
}

describe('Agaric real-backend sync of a large vault to a fresh device (#5739) @sync', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it('a fresh device pulls every page and block of a vault several op batches long', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()

    const seed = await peer.seedVault(MARKER, PAGES, BLOCKS_PER_PAGE, PADDING)
    if (seed.opBatches < MIN_OP_BATCHES) {
      throw new Error(
        `the seed's op log fits in ${seed.opBatches} batches; raise PADDING or PAGES to reach ${MIN_OP_BATCHES}`,
      )
    }
    const last = await peer.getBlock(seed.lastBlockId)
    if (last.parentId === null) throw new Error(`the peer holds ${last.id} with no page`)
    const lastPage = await peer.getBlock(last.parentId)

    await openSyncSettings()
    await openPairing()
    const remote = await peer.pair(await readPairingQr())
    await waitForToast('Device paired successfully')
    await $('[data-testid="pairing-qr-code"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })
    await setPeerAddress(remote.deviceId, remote.address)
    await navigateTo('Pages')
    const sync = $(SYNC_BUTTON)
    await browser.waitUntil(async () => (await sync.getAttribute('aria-disabled')) === 'false', {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the app never finished the sync it was running',
    })
    await sync.click()
    await peer.waitPulled()

    await waitForPagesView({ pages: PAGES, seededRows: PAGES, blocks: PAGES * BLOCKS_PER_PAGE })

    await reopenPageByTitle(lastPage.content)
    await waitForRowText(last.id, last.content.trim())
    const history = await invoke<{ items: { device_id: string; op_type: string }[] }>(
      'get_block_history',
      { blockId: last.id, opTypeFilter: null, cursor: null, limit: 50 },
    )
    expect(history.items.map(({ device_id, op_type }) => ({ device_id, op_type }))).toEqual([
      { device_id: remote.deviceId, op_type: 'create_block' },
    ])
  })
})
