// ---------------------------------------------------------------------------
// Real-backend: a `#name` typed in page mode becomes the tag (#5743).
//
// Page mode saved a typed `#name` as text, so the block never got the tag.
// Now the caret leaving the block commits it through block mode's own commit
// (`commitTypedTags`, via `src/editor/page-mode/page-tags.ts`). This spec types
// `#name` in page mode, closes the picker, presses ArrowDown, and reads back
// what the real backend made of it: the tag in the Tags list (`tags_cache`),
// the tag's page listing the block, and the block's chip after navigating
// away and back. `e2e/page-mode.spec.ts` is the per-PR pair against the mock.
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
  chooseEditMode,
  pageModeBlocks,
  pageModeCaret,
  pageModeIndexOf,
  typeInPageMode,
} from './page-mode'

const MARKER = runScopedMarker('wdio-pm-tagged')
const NEXT = runScopedMarker('wdio-pm-next')
// Letters, digits and `-` only, so the bare `#name` is the whole tag.
const TAG = runScopedMarker('wdio-pm-tag')

/** The text of each tag chip in the block whose id is `blockId`, read as DOM text. */
function chipTexts(blockId: string): Promise<string[]> {
  return browser.execute(
    (selector: string) =>
      [...document.querySelectorAll(selector)].map((el) => (el.textContent ?? '').trim()),
    `[data-page-block-id="${blockId}"] [data-testid="tag-ref-chip"], [data-block-id="${blockId}"] [data-testid="tag-ref-chip"]`,
  )
}

async function waitForChip(blockId: string, when: string): Promise<void> {
  let seen: string[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await chipTexts(blockId)
        return seen.length === 1 && seen[0] === TAG
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${when}, the block's tag chips read ${JSON.stringify(seen)}`)
    })
}

describe('Agaric real-backend typed tags in page mode (#5743)', () => {
  it('a #name typed and left with ArrowDown is the tag, which lists the block', async () => {
    await waitForAppReady()
    await openNewPage()
    await typeMarkerVerified(MARKER)
    await enterBlankSibling()
    await typeMarkerVerified(NEXT)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')

    const at = await pageModeIndexOf(MARKER)
    const blockId = (await pageModeBlocks())[at]?.id as string
    await pageModeCaret(at, 'end')
    await typeInPageMode(` #${TAG}`, at, `${MARKER} #${TAG}`)
    // The picker opens on `#`; Escape closes it, so ArrowDown moves the caret.
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
    await waitForChip(blockId, 'after ArrowDown')
    expect((await pageModeBlocks())[at]?.id).toBe(blockId)

    // The tag as the backend lists it (`tags_cache`), and its page listing the block.
    const tagItem = $(`[data-testid="tag-item-${TAG}"]`)
    await browser.waitUntil(
      async () => {
        await navigateTo('Tags')
        return tagItem.isDisplayed()
      },
      { timeout: NAV_TIMEOUT, interval: 3_000, timeoutMsg: `the Tags list never listed ${TAG}` },
    )
    await tagItem.click()
    await $(`[data-backlink-item="${blockId}"]`).waitForDisplayed({
      timeout: NAV_TIMEOUT,
      timeoutMsg: `the page of ${TAG} never listed the block it was typed in`,
    })

    // Away and back: the chip is read from what the backend stored.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await waitForChip(blockId, 'after navigating away and back')
  })
})
