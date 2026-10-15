// ---------------------------------------------------------------------------
// Real-backend "Most linked" sort in the Pages view (#5366).
//
// The sort orders by `pages_cache.inbound_link_count` (`list_pages_with_metadata`,
// commands/pages/metadata.rs), the count of other pages' blocks linking to a
// page, which the backend keeps in step with every link it stores. The mock
// counts the links on every read, so only this lane shows the stored count the
// sort reads lifting a page linked from two others to the top.
//
// Every page is made through the Pages view's "New page" field. RIVAL is made
// first and TARGET after it, so with no counts the id tie-break would put RIVAL
// above TARGET; TARGET links RIVAL once, and two later pages link TARGET.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  chooseSelectOption,
  navigateTo,
  runScopedMarker,
  typeInputVerified,
  typeMarkerVerified,
  waitForAppReady,
  waitForPickerToOffer,
} from './helpers'

const RIVAL = runScopedMarker('wdio-rival')
const TARGET = runScopedMarker('wdio-target')
const SOURCES = [runScopedMarker('wdio-source-one'), runScopedMarker('wdio-source-two')]

/** Make a page from the Pages view; it opens with its first block in the editor. */
async function createPage(title: string): Promise<void> {
  await navigateTo('Pages')
  await typeInputVerified('#new-page-name', title)
  await browser.keys(['Enter'])
  await browser.waitUntil(async () => (await $('[aria-label="Page title"]').getText()) === title, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `the page ${title} never opened`,
  })
  await $('[data-testid="block-editor"] [contenteditable="true"]').waitForDisplayed({
    timeout: ACTION_TIMEOUT,
  })
}

/** Link `title` from the block in the editor; leaving the page commits it. */
async function linkTo(title: string): Promise<void> {
  await typeMarkerVerified(`[[${title}`)
  await waitForPickerToOffer(title)
  // WebKit coalesces two identical keys sent together (`typeVerified`).
  await browser.keys([']'])
  await browser.pause(40)
  await browser.keys([']'])
  await $('[data-testid="block-editor"]')
    .$(`[data-testid="block-link-chip"]=${title}`)
    .waitForDisplayed({ timeout: ACTION_TIMEOUT })
}

interface ListedPage {
  title: string
  inbound: string
}

/** The Pages list's first two rows: title and the `N ↗` inbound count (PageRow.tsx). */
function topTwo(): Promise<ListedPage[]> {
  return browser.execute(() => {
    const rows = [...document.querySelectorAll('[data-page-item]')]
    rows.sort((a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')))
    return rows.slice(0, 2).map((row) => ({
      title: row.querySelector('.page-browser-item-title')?.getAttribute('title') ?? '',
      inbound: row.querySelector('[data-metadata-inbound] [aria-hidden="true"]')?.textContent ?? '',
    }))
  })
}

describe('Agaric real-backend Most linked sort (#5366)', () => {
  it('puts a page linked from two others at the top of Most linked', async () => {
    await waitForAppReady()
    await createPage(RIVAL)
    await createPage(TARGET)
    await linkTo(RIVAL)
    for (const source of SOURCES) {
      await createPage(source)
      await linkTo(TARGET)
    }

    await navigateTo('Pages')
    await chooseSelectOption('[aria-label="Sort order"]', 'Most linked')
    const expected = [
      { title: TARGET, inbound: '2 ↗' },
      { title: RIVAL, inbound: '1 ↗' },
    ]
    let seen: ListedPage[] = []
    await browser
      .waitUntil(
        async () => {
          seen = await topTwo()
          if (JSON.stringify(seen) === JSON.stringify(expected)) return true
          await navigateTo('Journal')
          await navigateTo('Pages')
          return false
        },
        { timeout: NAV_TIMEOUT, interval: 3_000 },
      )
      .catch(() => {
        throw new Error(
          `Most linked does not start ${JSON.stringify(expected)}: ${JSON.stringify(seen)}`,
        )
      })
  })
})
