// ---------------------------------------------------------------------------
// Real-backend search for a term under three characters (#6752).
//
// The trigram index holds no term that short, so the backend scans the
// indexed text for it. The mock matched a short query by substring before the
// backend did, so only this lane shows the search returning nothing. The
// Advanced Query box, which a `{{query …}}` block's free text also reaches,
// runs the same scan, and refused a query of only short terms before.
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

// No adjacent repeated characters (WebKit coalesces them). Every spec file
// boots its own vault, so nothing else here contains `qz`.
const WITH_TERM = 'ink qz pod'
const WITH_BOTH = 'owl qz hen'
const WITHOUT_TERM = 'owl fig hen'

describe('Agaric real-backend short search terms (#6752) @search', () => {
  it('finds a two-character term alone and beside a longer word', async () => {
    await waitForAppReady()
    await navigateTo('Journal')

    await addBlockWithMarker(WITH_TERM)
    await addBlockWithMarker(WITH_BOTH)
    await addBlockWithMarker(WITHOUT_TERM)
    const termId = await blockStaticByMarker(WITH_TERM).getAttribute('data-block-id')
    const bothId = await blockStaticByMarker(WITH_BOTH).getAttribute('data-block-id')

    await navigateTo('Search')
    const input = '[aria-label="Search blocks"]'
    const listed = async () => {
      const rows = await $$('[data-testid^="search-result-row-"]').getElements()
      const ids = await rows.map((row) => row.getAttribute('data-testid'))
      return new Set(ids)
    }
    const expectRows = async (query: string, ids: Array<string | null>) => {
      const expected = new Set<string | null>(ids.map((id) => `search-result-row-${id}`))
      await $(input).click()
      await browser.keys(['Control', 'a'])
      await browser.keys(['Delete'])
      await typeInputVerified(input, query)
      await browser.waitUntil(
        async () => {
          const shown = await listed()
          if (shown.size === expected.size && [...shown].every((id) => expected.has(id))) {
            return true
          }
          // `owl` waits on the materializer's index row: ask again.
          await $(input).click()
          await browser.keys(['Enter'])
          return false
        },
        {
          timeout: ACTION_TIMEOUT,
          interval: 3_000,
          timeoutMsg: `"${query}" never listed its rows`,
        },
      )
    }

    await expectRows('qz', [termId, bothId])
    await expectRows('owl qz', [bothId])
  })

  // Reads the blocks the first `it` wrote.
  it('finds a two-character term in the Advanced Query full-text box', async () => {
    await navigateTo('Pages')
    const open = $('.page-browser-header button[aria-label="Advanced Query"]')
    await open.waitForClickable({ timeout: NAV_TIMEOUT })
    await open.click()
    await $('[data-testid="advanced-query-view"]').waitForDisplayed({ timeout: NAV_TIMEOUT })

    const input = '[data-testid="advanced-query-fulltext"]'
    const total = $('[data-testid="advanced-query-total"]')
    for (const [query, shown] of [
      ['qz', '2 matching blocks'],
      ['owl qz', '1 matching block'],
    ] as const) {
      await $(input).click()
      await browser.keys(['Control', 'a'])
      await browser.keys(['Delete'])
      await typeInputVerified(input, query)
      await browser.waitUntil(
        async () => (await total.isExisting()) && (await total.getText()) === shown,
        {
          timeout: ACTION_TIMEOUT,
          timeoutMsg: `"${query}" never showed "${shown}"`,
        },
      )
    }
  })
})
