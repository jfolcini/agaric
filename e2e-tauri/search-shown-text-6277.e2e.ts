// ---------------------------------------------------------------------------
// Real-backend search of a block ref after its target is edited (#6277 B3).
//
// The index holds a `((ULID))` block ref as its target's first line, so an
// edit to the target must re-strip every referrer (`ReindexFtsReferences`,
// queued by the materializer after the edit commits). The mock strips at query
// time, so only this lane shows a referrer still indexed under the target's old
// first line. A second block keeps the old word, so the old word's results are
// known to have arrived when the referrer is missing from them.
//
// The referrer is written through IPC, as Edit as Markdown or an import would:
// typed, `((` opens the block picker. The target is edited through the UI.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  addBlockWithMarker,
  blockStaticByMarker,
  invoke,
  navigateTo,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForResults,
} from './helpers'

// Plain words with no letter doubled (see `runScopedMarker`), in no marker.
const OLD = 'harbor'
const NEW = 'violet'
const TARGET = runScopedMarker('wdio-ref-target')
const REFERRER = runScopedMarker('wdio-ref-referrer')
const KEPT = runScopedMarker('wdio-ref-kept')

/** The committed row of block `id`: the referrer's chip also shows the target's text. */
const staticRow = (id: string) => $(`[data-testid="block-static"][data-block-id="${id}"]`)

async function idOf(marker: string): Promise<string> {
  const id = await blockStaticByMarker(marker).getAttribute('data-block-id')
  if (!id) throw new Error(`the block ${marker} has no data-block-id`)
  return id
}

describe('Agaric real-backend search of a block ref after its target is edited (#6277) @editor @search', () => {
  it("finds the referrer by the target's new first line and not by its old one", async () => {
    await waitForAppReady()
    await navigateTo('Journal')
    await addBlockWithMarker(`${KEPT} ${OLD}`)
    await addBlockWithMarker(`${TARGET} ${OLD}`)
    await addBlockWithMarker(REFERRER)
    const keptId = await idOf(KEPT)
    const targetId = await idOf(TARGET)
    const refId = await idOf(REFERRER)
    await invoke('edit_block', { blockId: refId, toText: `${REFERRER} see ((${targetId}))` })

    await navigateTo('Search')
    await waitForResults(
      OLD,
      (ids) => ids.includes(keptId) && ids.includes(refId),
      "the target's first line never found the referrer",
    )
    await navigateTo('Journal')

    await staticRow(targetId).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await staticRow(targetId).click()
    const editor = $('[data-testid="block-editor"] [contenteditable="true"]')
    await editor.waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await editor.click()
    await browser.keys(['Control', 'a'])
    await browser.keys(['Delete'])
    await typeMarkerVerified(`${TARGET} ${NEW}`)
    await browser.keys(['Enter'])
    await browser.keys(['Escape'])
    await browser.waitUntil(async () => (await staticRow(targetId).getText()).includes(NEW), {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the edited target never showed its new first line',
    })

    await navigateTo('Search')
    await waitForResults(
      NEW,
      (ids) => ids.includes(refId),
      "the target's new first line never found the referrer",
    )
    // The row shows the indexed text's snippet: the target's line, not the ref.
    const shown = await $(`[data-testid="search-result-row-${refId}"]`).getText()
    expect(shown).toContain(NEW)
    expect(shown).not.toMatch(/\(\(|[0-9A-Z]{26}/)
    await waitForResults(
      OLD,
      (ids) => ids.includes(keptId) && !ids.includes(refId),
      "the target's old first line still finds the referrer",
    )
  })
})
