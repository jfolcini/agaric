// ---------------------------------------------------------------------------
// Real-backend FTS5 ranking order (#4671).
//
// The mock's search ranks by term density (`docLength / occurrences`,
// src/lib/tauri-mock/handlers/search.ts `approximateFtsRank`), the backend by
// FTS5 `rank` = bm25 over a trigram index (`ORDER BY fts.rank, b.id`,
// agaric-store/src/fts/search/fetch.rs; migration 0006). The two disagree on
// this pair: for the query `zap`,
//   A = "zap of ink"                                        (tf 1, 8 tokens)
//   B = "zap fig zap owl zap bun zap kit zap hen jam pod ivy" (tf 5, 49 tokens)
// density puts A first (10 < 10.2); bm25's saturated term frequency puts B
// first for any corpus whose average block is longer than ~8 tokens, which a
// vault holding these two rows already is. So a green here proves the results
// came from the real ranker, and the Search view is a fresh backend query
// after leaving the Journal where the rows were created.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  navigateTo,
  typeInputVerified,
  waitForAppReady,
} from './helpers'

// Plain lowercase words, no adjacent repeated characters (WebKit coalesces
// them — see `runScopedMarker`), no markdown metacharacters. Not run-scoped:
// every spec file boots its own vault, so nothing else here contains `zap`.
const SPARSE = 'zap of ink'
const DENSE = 'zap fig zap owl zap bun zap kit zap hen jam pod ivy'
const QUERY = 'zap'

describe('Agaric real-backend search ranking (#4671)', () => {
  it('orders results by bm25, not by term density', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    await addBlockWithMarker(SPARSE)
    // The longer sentence gets a longer read-back budget: ProseMirror settles
    // fifty keystrokes of transactions on the CI runner more slowly than the
    // ~20-character markers the default budget was measured against.
    await addBlockWithMarker(DENSE, 10_000)
    const sparseId = await blockStaticByMarker(SPARSE).getAttribute('data-block-id')
    const denseId = await blockStaticByMarker(DENSE).getAttribute('data-block-id')

    await navigateTo('Search')
    const input = '[aria-label="Search blocks"]'
    await typeInputVerified(input, QUERY)
    await browser.keys(['Enter'])

    // The FTS row is written by the background materializer after the block
    // commit, so poll: re-submit the query until both rows are listed.
    const rowSelector = (id: string | null) => `[data-testid="search-result-row-${id}"]`
    await browser.waitUntil(
      async () => {
        const both =
          (await $(rowSelector(sparseId)).isExisting()) &&
          (await $(rowSelector(denseId)).isExisting())
        if (both) return true
        await $(input).click()
        await browser.keys(['Enter'])
        return false
      },
      { timeout: ACTION_TIMEOUT, interval: 3_000, timeoutMsg: 'both seeded rows never appeared' },
    )

    const rows = await $$('[data-testid^="search-result-row-"]').getElements()
    // `getElements()` yields WDIO's ElementArray, whose `map` is already async.
    const order = await rows.map((row) => row.getAttribute('data-testid'))
    expect(order).toEqual([`search-result-row-${denseId}`, `search-result-row-${sparseId}`])
    await expect($('[data-testid="search-results-count"]')).toBeDisplayed()
    await $(rowSelector(denseId)).waitForDisplayed({ timeout: NAV_TIMEOUT })
  })
})
