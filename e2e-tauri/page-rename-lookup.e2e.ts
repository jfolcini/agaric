// ---------------------------------------------------------------------------
// Real-backend page rename from the header (#5365).
//
// The title is the page block's content, renamed with `edit_block`; the Pages
// list and the `[[` picker each read a copy the materializer keeps (the pages
// list, and FTS for a query past two characters), not the block. The mock
// keeps no such copies, so only this lane shows a rename those copies missed:
// the page found by its old title, or not by its new one.
//
// The titles are plain words with no letter doubled (WebKit drops the second
// of two identical keys, see `typeVerified`) and no word in common, so the old
// title's query matches nothing but a copy that still holds it.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see
// helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  expectAbsent,
  navigateTo,
  openJournalBlockEditor,
  typeInputVerified,
  typeMarkerVerified,
  typeVerified,
  waitForAppReady,
  waitForToast,
  openNewPageDialog,
} from './helpers'

// Not run-scoped: every spec file boots its own vault (see search-bm25-order).
const OLD_TITLE = 'cobalt harbor'
const NEW_TITLE = 'velvet lantern'
const TITLE = '[aria-label="Page title"]'
const PAGES_FILTER = '[aria-label="Search pages..."]'

/** A Pages list row's title span (PageBrowser/PageRow.tsx), by exact title. */
function pageRow(title: string): string {
  return `//span[contains(@class, "page-browser-item-title")][normalize-space(.)="${title}"]`
}

interface Offered {
  text: string
  create: boolean
}

/** The open picker's items; the create-new-page item is `suggestion-__create__`. */
function offered(): Promise<Offered[]> {
  return browser.execute(() =>
    [...document.querySelectorAll('[data-testid="suggestion-item"]')].map((item) => ({
      text: item.textContent ?? '',
      create: item.id === 'suggestion-__create__',
    })),
  )
}

/** Wait until the open picker's items satisfy `test`. */
async function waitForOffered(test: (items: Offered[]) => boolean, what: string): Promise<void> {
  let seen: Offered[] = []
  await browser
    .waitUntil(
      async () => {
        seen = await offered()
        return test(seen)
      },
      { timeout: ACTION_TIMEOUT },
    )
    .catch(() => {
      throw new Error(`${what}; the picker offered ${JSON.stringify(seen)}`)
    })
}

/** Empty the focused text box or editor. */
async function clearFocused(): Promise<void> {
  await browser.keys(['Control', 'a'])
  await browser.keys(['Delete'])
}

describe('Agaric real-backend page rename (#5365)', () => {
  it('the Pages filter and the [[ picker find a renamed page by its new title only', async () => {
    await waitForAppReady()
    await openNewPageDialog()
    await typeInputVerified('#new-page-name', OLD_TITLE)
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await $(TITLE).getText()) === OLD_TITLE, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'the new page never opened under its title',
    })

    // The header's title commits on Enter, which blurs it (PageHeader).
    await $(TITLE).click()
    await clearFocused()
    await typeVerified(TITLE, NEW_TITLE, (sel) => $(sel).getText(), 'page title')
    await browser.keys(['Enter'])
    await waitForToast('Page renamed')

    await navigateTo('Journal')
    await navigateTo('Pages')
    await $(pageRow(NEW_TITLE)).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expectAbsent(pageRow(OLD_TITLE), 'the old title in the Pages list')

    await typeInputVerified(PAGES_FILTER, NEW_TITLE)
    await $(pageRow(NEW_TITLE)).waitForDisplayed({ timeout: ACTION_TIMEOUT })
    await $(PAGES_FILTER).click()
    await clearFocused()
    await typeInputVerified(PAGES_FILTER, OLD_TITLE)
    await expectAbsent(pageRow(NEW_TITLE), 'the renamed page under a filter by its old title')

    await navigateTo('Journal')
    await openJournalBlockEditor()
    await typeMarkerVerified(`[[${NEW_TITLE}`)
    await waitForOffered(
      (items) => items.some((item) => !item.create && item.text.includes(NEW_TITLE)),
      'the [[ picker never offered the page by its new title',
    )

    await clearFocused()
    await typeMarkerVerified(`[[${OLD_TITLE}`)
    // The create item is labelled with the query, so once it holds the whole
    // old title the items are that query's answer.
    await waitForOffered(
      (items) => items.some((item) => item.create && item.text.includes(OLD_TITLE)),
      'the [[ picker never answered the old title',
    )
    expect((await offered()).filter((item) => !item.create)).toEqual([])
  })
})
