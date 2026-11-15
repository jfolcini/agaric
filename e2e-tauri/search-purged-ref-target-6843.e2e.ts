// ---------------------------------------------------------------------------
// Real-backend search of a block ref after its target is purged (#6843).
//
// The index holds a `((ULID))` block ref as its target's first line (#6277
// B3), and a purged target has none, so purging it from Trash must re-strip
// every referrer. The purge cascade deletes the `block_links` rows that name
// the referrers, so it reads them first and re-strips them once it commits.
// The mock strips at query time, so only this lane shows a referrer still
// found by a purged block's text. A second block keeps the word, so the
// word's results are known to have arrived when the referrer is missing.
//
// The referrer is written and the target deleted through IPC, as
// `search-shown-text-6277.e2e.ts` writes its referrer; the purge goes through
// Trash.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  confirmDialog,
  invoke,
  navigateTo,
  openTrash,
  runScopedMarker,
  waitForAppReady,
  waitForResults,
} from './helpers'

// A plain word with no letter doubled (see `runScopedMarker`), in no marker.
const WORD = 'harbor'
const TARGET = runScopedMarker('wdio-purged-target')
const REFERRER = runScopedMarker('wdio-purged-referrer')
const KEPT = runScopedMarker('wdio-purged-kept')

async function idOf(marker: string): Promise<string> {
  const id = await blockStaticByMarker(marker).getAttribute('data-block-id')
  if (!id) throw new Error(`the block ${marker} has no data-block-id`)
  return id
}

describe('Agaric real-backend search of a block ref after its target is purged (#6843) @search @pages', () => {
  it("no longer finds the referrer by the purged target's first line", async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await addBlockWithMarker(`${KEPT} ${WORD}`)
    await addBlockWithMarker(`${TARGET} ${WORD}`)
    await addBlockWithMarker(REFERRER)
    const keptId = await idOf(KEPT)
    const targetId = await idOf(TARGET)
    const refId = await idOf(REFERRER)
    await invoke('edit_block', { blockId: refId, toText: `${REFERRER} see ((${targetId}))` })

    await navigateTo('Search')
    await waitForResults(
      WORD,
      (ids) => ids.includes(keptId) && ids.includes(refId),
      "the target's first line never found the referrer",
    )

    await invoke('delete_block', { blockId: targetId })
    await openTrash()
    const row = $(
      `//*[@data-testid="trash-item"][.//*[contains(@class, "trash-item-text")][contains(., "${TARGET}")]]`,
    )
    await row.waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'Trash does not list the target',
    })
    const purge = row.$('[data-testid="trash-purge-btn"]')
    await purge.waitForClickable({ timeout: ACTION_TIMEOUT })
    await purge.click()
    await confirmDialog('Yes, delete')
    await row.waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the purged target is still listed in Trash',
    })

    await navigateTo('Search')
    await waitForResults(
      WORD,
      (ids) => ids.includes(keptId) && !ids.includes(refId),
      "the purged target's first line still finds the referrer",
    )
  })
})
