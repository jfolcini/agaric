// ---------------------------------------------------------------------------
// "Show Markdown syntax around the cursor" in page mode on the real backend
// (#5974).
//
// With the preference on, page mode draws a mark's `**` markers beside the
// caret as widgets. ProseMirror reads WebKitGTK's contenteditable DOM back
// into the one page document as the user types, so this WebView is where a
// marker could leak into a block's saved text, and where Backspace after a
// marker at a block's start could join the block into the one above instead
// of removing the mark. Type a bold word at the start of a second block,
// delete its opening marker with Backspace, leave the page and come back: the
// stored blocks are still two, the first untouched, the second's text with the
// bold gone and no marker.
//
// Globals (`$`, `$$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import {
  ACTION_TIMEOUT,
  NAV_TIMEOUT,
  blockStaticByMarker,
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
  typeInPageMode,
} from './page-mode'

const FIRST = runScopedMarker('wdio-pmr-first')
const SECOND = runScopedMarker('wdio-pmr-second')
const MARKERS = '[data-testid="md-reveal-marker"]'

async function turnRevealOn(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-editor')
  await tab.waitForClickable({ timeout: ACTION_TIMEOUT })
  await tab.click()
  const toggle = $('#reveal-markdown-toggle')
  await toggle.waitForClickable({ timeout: ACTION_TIMEOUT })
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click()
  await browser.waitUntil(async () => (await toggle.getAttribute('aria-checked')) === 'true', {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: 'the "Show Markdown syntax around the cursor" switch never turned on',
  })
}

async function waitForMarkers(count: number, when: string): Promise<void> {
  await browser.waitUntil(async () => (await $$(MARKERS).getElements()).length === count, {
    timeout: ACTION_TIMEOUT,
    timeoutMsg: `${when}, the page did not draw ${count} Markdown markers`,
  })
}

function boldCount(): Promise<number> {
  return browser.execute(
    (selector: string) => document.querySelectorAll(`${selector} strong`).length,
    PAGE_MODE,
  )
}

describe('Markdown syntax revealed around the cursor in page mode on the real backend (#5974) @editor @markdown @pages', () => {
  it('Backspace after a marker at a block’s start removes the bold without a join, and it is saved', async () => {
    await waitForAppReady()
    await turnRevealOn()
    await openNewPage()
    await typeMarkerVerified(FIRST)
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    await chooseEditMode('Page')

    // A second block, whose text opens with a bold word.
    await pageModeCaret(0, 'end')
    await browser.keys(['Enter'])
    await browser.waitUntil(async () => (await pageModeBlocks()).length === 2, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Enter did not make a second block',
    })
    await typeInPageMode(`**bold** ${SECOND}`, 1, `bold ${SECOND}`)
    expect(await boldCount()).toBe(1)

    // The caret at the second block's start is inside the bold: both markers show.
    await pageModeCaret(1, 0)
    await waitForMarkers(2, 'with the caret in the bold word')
    await browser.keys(['Backspace'])
    await browser.waitUntil(async () => (await boldCount()) === 0, {
      timeout: ACTION_TIMEOUT,
      timeoutMsg: 'Backspace after the opening marker did not remove the bold',
    })
    const blocks = await pageModeBlocks()
    expect(blocks.map((block) => block.text)).toEqual([FIRST, `bold ${SECOND}`])

    // Away and back: the backend holds two blocks, the second without the bold or any marker.
    await navigateTo('Journal')
    await reopenPageByTitle('Untitled')
    const second = blockStaticByMarker(SECOND)
    await second.waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(second).toHaveText(`bold ${SECOND}`)
    await expect(second.$('strong')).not.toExist()
    await blockStaticByMarker(FIRST).waitForDisplayed({ timeout: NAV_TIMEOUT })
    await expect(blockStaticByMarker(FIRST)).toHaveText(FIRST)
  })
})
