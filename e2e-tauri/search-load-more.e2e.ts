// ---------------------------------------------------------------------------
// Real-backend search pagination: Load more (#5738).
//
// The Search view pages its results through `useInfiniteQuery`: each page's
// `next_cursor`, the backend's composite `(rank, id)` keyset
// (agaric-store/src/fts/search/cursor.rs), is the next request's cursor. The
// mock answers every search with one page, so only this lane shows a cursor
// that repeats page 1 or stops early. This spec imports more blocks sharing a
// word than one page holds, searches the word, presses Load more until it goes
// away, and reads every listed row: each block is listed exactly once.
//
// The result list is virtualized (VirtualizedResultListbox.tsx), so the rows
// are read by scrolling the listbox and keying each row by its `data-index`.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  importMarkdownPage,
  navigateTo,
  runScopedMarker,
  typeInputVerified,
  waitForAppReady,
} from './helpers'

// `PAGINATION_LIMIT` (src/lib/constants.ts), the `limit` every search page asks for.
const PAGE_SIZE = 50
const SEEDED = 60
const WORD = runScopedMarker('wdio-paged')
// Not containing WORD, so the page's own title row is not a result.
const TITLE = runScopedMarker('wdio-load-more')
const SEQS = Array.from({ length: SEEDED }, (_, i) => String(i + 1).padStart(2, '0'))

const INPUT = '[aria-label="Search blocks"]'
const SUMMARY = '[data-testid="search-result-count-summary"]'
const LOAD_MORE = '.search-load-more button'
const LISTBOX = '[data-testid="search-result-region"] [role="listbox"]'

/** The listed match count the summary above the groups reads ("N matches in …"), or 0. */
async function listedCount(): Promise<number> {
  const summary = $(SUMMARY)
  if (!(await summary.isExisting())) return 0
  return Number(/^(\d+) match/.exec(await summary.getText())?.[1] ?? 0)
}

/** Replace the search field's text with WORD and submit it, so the search starts at page 1. */
async function searchWord(): Promise<void> {
  await $(INPUT).click()
  await browser.keys(['Control', 'a'])
  await browser.keys(['Delete'])
  await typeInputVerified(INPUT, WORD)
  await browser.keys(['Enter'])
}

/**
 * Press Load more until it goes away and resolve to the listed count. A
 * cursor that repeats a page keeps Load more on screen, so the presses are
 * bounded by the page count the seeded rows need.
 */
async function loadEveryPage(): Promise<number> {
  const maxPresses = Math.ceil(SEEDED / PAGE_SIZE) - 1
  for (let press = 0; await $(LOAD_MORE).isDisplayed(); press++) {
    const before = await listedCount()
    if (press === maxPresses) {
      throw new Error(`Load more is still offered after ${press} presses, with ${before} listed`)
    }
    await $(LOAD_MORE).click()
    await browser.waitUntil(async () => (await listedCount()) > before, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: `Load more never added a page to the ${before} listed matches`,
    })
  }
  return listedCount()
}

/** Every row of the results listbox in list order, read by scrolling it end to end. */
function listedRows(): Promise<string[]> {
  return browser.execute(async (selector: string) => {
    const list = document.querySelector(selector)
    if (list === null) throw new Error('no search results listbox')
    const seen = new Map<number, string>()
    list.scrollTop = 0
    for (let step = 0; step < 500; step++) {
      // Two frames: the virtualizer remounts its window on the scroll event.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      for (const row of list.querySelectorAll('[data-index]')) {
        seen.set(Number(row.getAttribute('data-index')), row.textContent ?? '')
      }
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 1) break
      list.scrollTop += Math.max(1, list.clientHeight / 2)
    }
    return [...seen.entries()].toSorted(([a], [b]) => a - b).map(([, text]) => text)
  }, LISTBOX)
}

describe('Agaric real-backend search Load more (#5738) @search', () => {
  it('pages through every match with Load more and lists each block once', async () => {
    await waitForAppReady()
    const markdown = SEQS.map((seq) => `- ${WORD} seq-${seq}`).join('\n')
    expect(await importMarkdownPage(TITLE, `${markdown}\n`)).toContain(`${SEEDED} blocks`)

    await navigateTo('Search')
    // The FTS rows are written by the background materializer after the
    // import, so ask again until the first page is full and offers more.
    let first = 0
    await browser
      .waitUntil(
        async () => {
          await searchWord()
          return browser
            .waitUntil(
              async () => {
                first = await listedCount()
                return first >= PAGE_SIZE && (await $(LOAD_MORE).isDisplayed())
              },
              { timeout: 5_000 },
            )
            .then(
              () => true,
              () => false,
            )
        },
        { timeout: ACTION_TIMEOUT },
      )
      .catch(() => {
        throw new Error(`the first page never offered Load more; it listed ${first}`)
      })
    expect(first).toBe(PAGE_SIZE)
    expect(await loadEveryPage()).toBe(SEEDED)

    const rows = await listedRows()
    const listed = rows.map((text) => /seq-(\d{2})/.exec(text)?.[1] ?? `unmatched: ${text}`)
    expect(listed.toSorted()).toEqual(SEQS)
  })
})
