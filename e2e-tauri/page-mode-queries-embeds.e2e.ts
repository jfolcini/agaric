// ---------------------------------------------------------------------------
// Real-backend: a query and an embed in page mode (#5743).
//
// A page holding a `{{query …}}` or an `{{embed …}}` used to stay in block
// mode. Now page mode draws block mode's own `StaticBlock` for it, the results
// or the embedded block in place of the text while the caret is elsewhere
// (`src/editor/page-mode/page-rendered.ts`). This spec tags a block by a
// `#name` typed in page mode, whose inline tag the materializer indexes, writes
// `{{query tag:<name>}}` and an embed of the tagged block into the blocks after
// it as another surface would, opens the page in page mode, and reads the
// tagged block among the query's results and in the embed; then again after
// navigating away and back.
// `e2e/page-mode.spec.ts` is the per-PR pair against the mock.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  enterBlankSibling,
  navigateTo,
  openNewPage,
  reopenPageByTitle,
  runScopedMarker,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'
import {
  PAGE_MODE,
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

const TAGGED = runScopedMarker('wdio-pm-query-hit')
const HOLDER = runScopedMarker('wdio-pm-query-holder')
const EMBEDDER = runScopedMarker('wdio-pm-embed-holder')
// Letters, digits and `-` only, so the bare `#name` is the whole tag.
const TAG = runScopedMarker('wdio-pm-query-tag')

interface Internals {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
}

/** Call the real backend as another surface does. */
function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (c: string, a: Record<string, unknown>) =>
      (window as unknown as Internals).__TAURI_INTERNALS__.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>
}

/** The text of the embed block `blockId` draws, or null. */
function embedOf(blockId: string): Promise<string | null> {
  return browser.execute(
    (css: string) => document.querySelector(css)?.textContent ?? null,
    `${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="embed-container"]`,
  )
}

/** The text of each result the query of block `blockId` draws. */
function resultsOf(blockId: string): Promise<string[]> {
  return browser.execute(
    (css: string) => [...document.querySelectorAll(css)].map((el) => el.textContent ?? ''),
    `${PAGE_MODE} [data-page-block-id="${blockId}"] [data-testid="query-result-item"]`,
  )
}

async function reopenInPageMode(): Promise<void> {
  await navigateTo('Journal')
  await reopenPageByTitle('Untitled')
  await chooseEditMode('Page')
}

/**
 * Wait for the query of block `holderId` to list the tagged block, reopening
 * the page each time while `reopen`: the materializer indexes the tag after its
 * write, and a query reads as it is drawn.
 */
async function waitForHit(holderId: string, when: string, reopen: boolean): Promise<void> {
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        if (reopen) await reopenInPageMode()
        seen = await resultsOf(holderId)
        return seen.some((text) => text.includes(TAGGED))
      },
      { timeout: NAV_TIMEOUT * 2, interval: 3_000 },
    )
    .catch(() => {
      throw new Error(`${when}, the query's results read ${JSON.stringify(seen)}`)
    })
}

describe('Agaric real-backend queries in page mode (#5743) @editor @pages', () => {
  it('a query over a tag typed in page mode, and an embed, show the tagged block, and again after navigating back', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(TAGGED)
    await enterBlankSibling()
    await typeMarkerVerified(HOLDER)
    await enterBlankSibling()
    await typeMarkerVerified(EMBEDDER)
    await reopenInPageMode()

    const at = await pageModeIndexOf(TAGGED)
    const blocks = await pageModeBlocks()
    const taggedId = blocks[at]?.id as string
    const holderId = blocks[await pageModeIndexOf(HOLDER)]?.id as string
    const embedderId = blocks[await pageModeIndexOf(EMBEDDER)]?.id as string
    await pageModeCaret(at, 'end')
    await typeInPageMode(` #${TAG}`, at, `${TAGGED} #${TAG}`)
    // The picker opens on `#`; Escape closes it, so ArrowDown moves the caret and commits the tag.
    await $('[data-testid="suggestion-item"]').waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await browser.keys(['Escape'])
    await $('[data-testid="suggestion-item"]').waitForExist({
      reverse: true,
      timeout: ACTION_TIMEOUT,
    })
    // Closing the picker redraws the text the caret is in; a native arrow pressed
    // before that frame is taken back by ProseMirror's own selection.
    await browser.execute(() => new Promise((resolve) => requestAnimationFrame(resolve)))
    await browser.keys(['ArrowDown'])
    await $(`${PAGE_MODE} [data-testid="tag-ref-chip"]`).waitForDisplayed({ timeout: NAV_TIMEOUT })

    // Written elsewhere: the page reads it on opening.
    await invoke('edit_block', { blockId: holderId, toText: `{{query tag:${TAG}}}` })
    await invoke('edit_block', { blockId: embedderId, toText: `{{embed ((${taggedId}))}}` })
    await waitForHit(holderId, 'on opening', true)
    await browser.waitUntil(async () => (await embedOf(embedderId))?.includes(TAGGED) === true, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'the embed never showed the tagged block',
    })
    const shown = await pageModeBlocks()
    expect(shown.find((block) => block.id === holderId)?.text).toBe(`{{query tag:${TAG}}}`)

    // Away and back: the results and the embed are read again from what the backend holds.
    await reopenInPageMode()
    await waitForHit(holderId, 'after navigating away and back', false)
    await browser.waitUntil(async () => (await embedOf(embedderId))?.includes(TAGGED) === true, {
      timeout: NAV_TIMEOUT,
      timeoutMsg: 'after navigating away and back, the embed never showed the tagged block',
    })
  })
})
