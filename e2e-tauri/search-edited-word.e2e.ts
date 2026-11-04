// ---------------------------------------------------------------------------
// Real-backend search after an edit (#5366).
//
// Editing a block replaces its row in the FTS index (`fts_blocks`), which the
// materializer's background queue writes after the edit commits
// (`UpdateFtsBlock`). The mock indexes on the spot, so only this lane shows an
// index that kept the old word or never took the new one: after the edit the
// new word finds the block and the old word does not. A second block keeps
// the old word, so the old word's results are known to have arrived when the
// edited block is missing from them.
//
// The old word is searched before the edit too, so the Search view holds an
// answer listing the block when the same query is asked again: an edit fires
// no event its query key folds in, and that cached answer once stood in for
// the backend's (`staleTime: 0` in `useSearchResults`).
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  navigateTo,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForResults,
} from './helpers'

// Plain words with no letter doubled (see `runScopedMarker`), in no marker.
const OLD = 'quartz'
const NEW = 'violet'
const EDITED = runScopedMarker('wdio-edited-word')
const KEPT = runScopedMarker('wdio-kept-word')

describe('Agaric real-backend search after an edit (#5366) @editor @search', () => {
  it('finds an edited block by its new word and not by its old one', async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await addBlockWithMarker(`${KEPT} ${OLD}`)
    await addBlockWithMarker(`${EDITED} ${OLD}`)
    const keptId = (await blockStaticByMarker(KEPT).getAttribute('data-block-id')) ?? ''
    const editedId = (await blockStaticByMarker(EDITED).getAttribute('data-block-id')) ?? ''
    if (keptId === '' || editedId === '') throw new Error('a seeded block has no data-block-id')

    await navigateTo('Search')
    await waitForResults(
      OLD,
      (ids) => ids.includes(keptId) && ids.includes(editedId),
      'the old word never found both blocks before the edit',
    )
    await navigateTo('Journal')

    await blockStaticByMarker(EDITED).click()
    const editor = $('[data-testid="block-editor"] [contenteditable="true"]')
    await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await editor.click()
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeMarkerVerified(`${EDITED} ${NEW}`)
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await blockStaticByMarker(`${EDITED} ${NEW}`).waitForDisplayed({ timeout: ACTION_TIMEOUT })

    await navigateTo('Search')
    await waitForResults(
      NEW,
      (ids) => ids.includes(editedId),
      'the new word never found the edited block',
    )
    await waitForResults(
      OLD,
      (ids) => ids.includes(keptId) && !ids.includes(editedId),
      'the old word still finds the edited block',
    )
  })
})
