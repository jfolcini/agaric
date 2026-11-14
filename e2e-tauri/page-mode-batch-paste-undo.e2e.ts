// ---------------------------------------------------------------------------
// Real-backend page mode: one Ctrl+Z takes back a 300-line paste (#6559).
//
// Page mode saves the paste's blocks as one `create_blocks_batch` under the
// ids its document gave them, and the undo's save deletes them as one
// `delete_blocks_by_ids`. Both batches run in the real backend here, which the
// mock lanes stand in for: a batch that minted its own ids, placed a block one
// slot off, or answered without the `deleted_at` page mode keeps would leave
// the page short of or past the one block it held before. The re-opened page
// holds that block alone, and a pasted block is gone.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  NAV_TIMEOUT,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import { PAGE_MODE, chooseEditMode, pageModeBlocks, pageModeCaret } from './page-mode'

const FIRST = runScopedMarker('wdio-pm-batch-first')
const LINES = 300

interface Internals {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
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

/** Paste `text` as plain text at the page-mode cursor, as ProseMirror takes a paste. */
async function pasteInPageMode(text: string): Promise<void> {
  await browser.execute(
    (selector: string, value: string) => {
      const dom = document.querySelector<
        HTMLElement & { editor?: { view: { pasteText: (text: string) => boolean } } }
      >(selector)
      if (dom?.editor === undefined) throw new Error('pasteInPageMode: no page-mode editor')
      dom.editor.view.pasteText(value)
    },
    PAGE_MODE,
    text,
  )
}

describe('Agaric real-backend page mode, one Ctrl+Z takes back a 300-line paste (#6559) @editor @pages', () => {
  it('saves the paste, takes all of it back with one Ctrl+Z, and the re-opened page holds the one block', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await chooseEditMode('Page')
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'page mode never showed the one block',
    })

    await pageModeCaret(0, 'end')
    await pasteInPageMode(Array.from({ length: LINES }, (_, i) => `line ${i}`).join('\n'))
    await browser.waitUntil(async () => (await pageModeBlocks()).length === LINES, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: `page mode never showed the ${LINES} blocks pasted`,
    })
    const lastId = (await pageModeBlocks()).at(-1)?.id as string
    // The undo must take back a saved paste, or it writes nothing.
    await browser.waitUntil(async () => (await getBlockAnswer(lastId)) === 'live', {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the last pasted block never reached the backend under its own id',
    })

    await browser.keys(['Control', 'z'])

    await browser.waitUntil(async () => (await pageModeBlocks()).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'one Ctrl+Z did not take back the whole paste',
    })
    await browser.waitUntil(async () => (await getBlockAnswer(lastId)) === 'not_found', {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the undo never deleted the pasted blocks in the backend',
    })

    // Read back from the backend: leave the page and open it again.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 1, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the re-opened page does not hold the one block',
    })
    expect((await pageModeBlocks()).map((block) => block.text)).toEqual([FIRST])
  })
})
