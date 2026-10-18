// ---------------------------------------------------------------------------
// Real-backend page mode: a block deleted elsewhere while typed in (#5691).
//
// Another surface (an agent, another view) deletes a block through the real
// IPC while the page is open in page mode, and nothing reloads the page. Text
// typed into that block then reaches a save whose `edit_block` the real
// backend refuses, which the mock cannot do. Page mode reads the page again,
// keeps the text as a new block, says so, and saves it. The re-opened page
// holds the text once, under the new block's id, and the deleted block stays
// deleted. The Playwright twin, where a sync brings the delete in, is in
// `e2e/page-mode.spec.ts`.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  enterBlankSibling,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
  waitForToast,
} from './helpers'
import { chooseEditMode, pageModeBlocks, pageModeCaret, typeInPageMode } from './page-mode'

const FIRST = runScopedMarker('wdio-pm-kept-first')
const SECOND = runScopedMarker('wdio-pm-kept-second')
const TYPED = runScopedMarker('wdio-pm-kept-typed')

interface Internals {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
}

/** Another surface deletes block `id` through the real IPC; nothing reloads the page. */
async function deleteBlockElsewhere(id: string): Promise<void> {
  await browser.execute(async (blockId: string) => {
    await (window as unknown as Internals).__TAURI_INTERNALS__.invoke('delete_block', { blockId })
  }, id)
}

/** `get_block`'s answer for block `id`, which it serves only live: `live`, or its error kind. */
function getBlockAnswer(id: string): Promise<string> {
  return browser.execute(async (blockId: string) => {
    try {
      await (window as unknown as Internals).__TAURI_INTERNALS__.invoke('get_block', { blockId })
      return 'live'
    } catch (error) {
      return (error as { kind?: string }).kind ?? String(error)
    }
  }, id)
}

describe('Agaric real-backend page mode, a block deleted elsewhere while typed in (#5691) @editor @pages', () => {
  it('keeps the text as a new block, says so, and leaves the deleted block deleted', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await enterBlankSibling()
    await typeMarkerVerified(SECOND)
    await chooseEditMode('Page')
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'page mode never showed the two blocks',
    })
    const deletedId = (await pageModeBlocks())[1]?.id as string

    await deleteBlockElsewhere(deletedId)
    await pageModeCaret(1, 'end')
    await typeInPageMode(` ${TYPED}`, 1, `${SECOND} ${TYPED}`)
    // Leaving the text saves it; the backend refuses the edit of a deleted block.
    await $('[aria-label="Page title"]').click()

    await waitForToast('A block you were editing was deleted elsewhere.')
    await browser.waitUntil(async () => (await pageModeBlocks())[1]?.id !== deletedId, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the text typed into the deleted block never moved to a new one',
    })
    const keptId = (await pageModeBlocks())[1]?.id as string

    // Read back from the backend: leave the page and open it again.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold two blocks',
    })
    expect(await pageModeBlocks()).toEqual([
      { id: expect.any(String), depth: 0, text: FIRST },
      { id: keptId, depth: 0, text: `${SECOND} ${TYPED}` },
    ])
    expect(await getBlockAnswer(deletedId)).toBe('not_found')
  })
})
