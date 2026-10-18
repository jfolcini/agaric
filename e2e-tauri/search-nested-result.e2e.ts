// ---------------------------------------------------------------------------
// Real-backend: a search hit on an indented block opens its page (#5738).
//
// An indented block's `parent_id` is the block above it, not the page, so a
// result click that opened `parent_id` asked `load_page_subtree` for a content
// block. The real backend answers that with an empty subtree, so the user got
// a "page" titled with the parent's text, and the editor seeded a first block
// under the parent. Here the click must open the page that holds the hit with
// the hit focused, and the page re-opened afterwards must hold exactly the two
// blocks it was given.
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
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
} from './helpers'

const PAGE = runScopedMarker('wdio-nest-page')
const PARENT = runScopedMarker('wdio-nest-parent')
const CHILD = runScopedMarker('wdio-nest-child')
// A plain word with no letter doubled (see `runScopedMarker`), only in CHILD.
const WORD = 'zircon'
const INPUT = '[aria-label="Search blocks"]'

/**
 * Every block row in document order as `<id>@<level>`, the level being its
 * `aria-level` (SortableBlockWrapper, depth + 1).
 */
function rows(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="sortable-block"]')].map(
      (row) =>
        `${row.getAttribute('data-block-id')}@${row.closest('li[aria-level]')?.getAttribute('aria-level')}`,
    ),
  )
}

/** Wait until the open page is `PAGE` and its rows are exactly `expected`. */
async function waitForPage(expected: string[], what: string): Promise<void> {
  let seen: { title: string; rows: string[] } = { title: '', rows: [] }
  await browser
    .waitUntil(
      async () => {
        const title = $('[aria-label="Page title"]')
        seen = {
          title: (await title.isExisting()) ? await title.getText() : '',
          rows: await rows(),
        }
        return seen.title === PAGE && JSON.stringify(seen.rows) === JSON.stringify(expected)
      },
      { timeout: NAV_TIMEOUT },
    )
    .catch(() => {
      throw new Error(
        `${what}: expected page ${PAGE} with rows ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`,
      )
    })
}

describe('Agaric real-backend search result for an indented block (#5738) @search', () => {
  it('opens the page holding the block, with the block focused', async () => {
    await waitForAppReady()
    await openNewPage(PAGE)
    const parentId = (await $('[data-testid="sortable-block"]').getAttribute('data-block-id')) ?? ''
    await typeMarkerVerified(PARENT)
    const childId = await enterBlankSibling()
    await typeMarkerVerified(`${CHILD} ${WORD}`)
    await browser.keys(['Tab'])
    const outline = [`${parentId}@1`, `${childId}@2`]
    await waitForPage(outline, 'Tab did not indent the child block')
    await browser.keys(['Escape'])
    await $(`[data-testid="block-static"][data-block-id="${childId}"]`).waitForDisplayed({
      timeout: ACTION_TIMEOUT,
    })

    await navigateTo('Search')
    const row = $(`[data-testid="search-result-row-${childId}"]`)
    await typeInputVerified(INPUT, WORD)
    await browser.keys(['Enter'])
    // The FTS row is written by the background materializer after the
    // commit, so ask again until the child is listed.
    await browser.waitUntil(
      async () => {
        if (await row.isExisting()) return true
        await $(INPUT).click()
        await browser.keys(['Enter'])
        return false
      },
      { timeout: ACTION_TIMEOUT, interval: 3_000, timeoutMsg: 'the child never appeared' },
    )
    await row.click()
    await waitForPage(outline, 'the result click did not open the page')
    await $(`[data-testid="block-editor"][data-block-id="${childId}"]`).waitForExist({
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the result click did not focus the child block',
    })

    await navigateTo('Journal')
    await reopenPageByTitle(PAGE)
    await waitForPage(outline, 'the re-opened page does not hold exactly the parent and child')
  })
})
